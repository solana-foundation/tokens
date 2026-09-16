import { Effect, Schema } from 'effect';
import { fetchJsonWithRetry } from '@tokens/effect';
import { decodeUpstreamOrWarn } from '@tokens/effect/schema';
import { withExternalTiming } from './externalTiming';
import type {
    BirdeyeClient,
    BirdeyeInterval,
    BirdeyeOhlcvClient,
    BirdeyeOverview,
    NormalizedSanctumItem,
    OhlcvCandle,
    RwaXyzAssetSnapshot,
    RwaXyzClient,
    RwaXyzTokenSnapshot,
    SanctumClient,
    SanctumFetchResult,
    WebacyClient,
} from './handlers/crons';
import type { CoingeckoClient, CoingeckoCoinListItem, CoingeckoMarketChartRange } from './handlers/crons.coingecko';
import { parseCoinListPayload } from './handlers/crons.coingecko';
import type {
    ClickhouseClient,
    ClickhouseMintSnapshot,
    ClickhouseSharesOutstandingRow,
    ClickhouseStockInstrumentRow,
    ClickhouseStockSnapshot,
} from './handlers/crons.clickhouse';
import type { BirdeyeMarketsClient, TokenMarketEntry } from './handlers/crons.misc';
import type { PreStocksApiSnapshot, PreStocksClient } from './handlers/crons.prestocks';
import type { StructuralHealthBatchEntry, WebacyDepegClient } from './handlers/crons.depeg';
import { extractDepegListItems, normalizeDepegItem, type WebacyDepegItem } from './handlers/depegNormalize';

// Shadow-mode envelope schemas (warn on mismatch, pass through) — the two
// highest-traffic blind casts. Row shapes stay unknown/T on purpose.
const BirdeyeEnvelopeSchema = Schema.Struct({
    success: Schema.optionalKey(Schema.Unknown),
    data: Schema.optionalKey(Schema.NullishOr(Schema.Record(Schema.String, Schema.Unknown))),
});

const EXTERNAL_FETCH_TIMEOUT_MS = 30_000;

const GatewayEnvelopeSchema = Schema.Struct({
    data: Schema.optionalKey(Schema.NullishOr(Schema.Array(Schema.Unknown))),
});

interface MakeBirdeyeOptions {
    apiKey: string;
    origin?: string;
    baseUrl?: string;
    /** Test seam for `fetchMultiPrice`. */
    fetchImpl?: typeof fetch;
}

export interface BirdeyeMultiPriceEntry {
    mint: string;
    priceUsd: number;
    /** Unix ms of Birdeye's price timestamp. */
    updatedAt: number;
    liquidityUsd: number | null;
    isScaledUiToken: boolean;
}

export type BirdeyeMultiPriceResult =
    | { ok: true; byMint: Map<string, BirdeyeMultiPriceEntry>; missing: string[] }
    | { ok: false; status: number; message: string };

/** The one-call-per-batch price feed the peg guard uses; kept off `BirdeyeClient` so its fakes stay small. */
export interface BirdeyeMultiPriceClient {
    fetchMultiPrice(mints: readonly string[]): Promise<BirdeyeMultiPriceResult>;
}

const BIRDEYE_MULTI_PRICE_MAX = 100;

/**
 * `GET /defi/multi_price` answers `{ success, data: { [mint]: { value,
 * updateUnixTime (seconds), liquidity, isScaledUiToken } | null } }`. Unknown
 * mints come back as `null` and land in `missing`.
 */
export function parseBirdeyeMultiPrice(json: unknown, requested: readonly string[]): BirdeyeMultiPriceResult {
    const rec = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
    if (!rec || rec.success !== true) {
        const message = rec && typeof rec.message === 'string' ? rec.message : 'unexpected multi_price payload';
        return { ok: false, status: 200, message };
    }
    const data = rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : {};
    const byMint = new Map<string, BirdeyeMultiPriceEntry>();
    const missing: string[] = [];
    for (const mint of requested) {
        const entry = data[mint];
        const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
        const priceUsd = e ? toFiniteNumberOrNull(e.value) : null;
        if (!e || priceUsd === null) {
            missing.push(mint);
            continue;
        }
        const rawTs = toFiniteNumberOrNull(e.updateUnixTime) ?? 0;
        const updatedAt = rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : rawTs;
        byMint.set(mint, {
            mint,
            priceUsd,
            updatedAt,
            liquidityUsd: toFiniteNumberOrNull(e.liquidity),
            isScaledUiToken: e.isScaledUiToken === true,
        });
    }
    return { ok: true, byMint, missing };
}

export function makeBirdeyeClient(opts: MakeBirdeyeOptions): BirdeyeClient & BirdeyeMultiPriceClient {
    const baseUrl = (opts.baseUrl ?? 'https://public-api.birdeye.so').replace(/\/+$/, '');
    const fetchImpl = opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
        'X-API-KEY': opts.apiKey,
        'x-chain': 'solana',
        Accept: 'application/json',
    };
    if (opts.origin) {
        headers.Origin = opts.origin;
        headers.Referer = opts.origin.endsWith('/') ? opts.origin : `${opts.origin}/`;
    }

    async function multiPriceChunk(chunk: readonly string[]): Promise<BirdeyeMultiPriceResult> {
        const url = `${baseUrl}/defi/multi_price?list_address=${encodeURIComponent(chunk.join(','))}&include_liquidity=true`;
        let lastFailure: { status: number; message: string } = { status: 0, message: 'no attempt' };
        // One retry on 429/5xx; the peg guard runs every 5 minutes so anything
        // longer just waits for the next tick.
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const res = await withExternalTiming('birdeye', url, () =>
                    fetchImpl(url, { headers, signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS) }),
                );
                const text = await res.text().catch(() => '');
                let json: unknown = null;
                try {
                    json = text ? JSON.parse(text) : null;
                } catch {
                    json = null;
                }
                if (!res.ok) {
                    lastFailure = { status: res.status, message: text.slice(0, 300) || res.statusText || 'Request failed' };
                    if (res.status === 429 || res.status >= 500) continue;
                    return { ok: false, ...lastFailure };
                }
                if (json === null) return { ok: false, status: res.status, message: 'non-JSON response' };
                return parseBirdeyeMultiPrice(json, chunk);
            } catch (err) {
                lastFailure = { status: 0, message: err instanceof Error ? err.message : String(err) };
            }
        }
        return { ok: false, ...lastFailure };
    }

    return {
        async fetchMultiPrice(mints) {
            const unique = [...new Set(mints.map(m => m.trim()).filter(Boolean))];
            if (unique.length === 0) return { ok: true, byMint: new Map(), missing: [] };
            const byMint = new Map<string, BirdeyeMultiPriceEntry>();
            const missing: string[] = [];
            for (let i = 0; i < unique.length; i += BIRDEYE_MULTI_PRICE_MAX) {
                const chunk = unique.slice(i, i + BIRDEYE_MULTI_PRICE_MAX);
                const res = await multiPriceChunk(chunk);
                if (!res.ok) return res;
                for (const [mint, entry] of res.byMint) byMint.set(mint, entry);
                missing.push(...res.missing);
            }
            return { ok: true, byMint, missing };
        },

        async fetchTokenOverview(mint: string): Promise<BirdeyeOverview | null> {
            const url = `${baseUrl}/defi/token_overview?address=${encodeURIComponent(mint)}`;
            const json = await Effect.runPromise(
                fetchJsonWithRetry<{ success?: unknown; data?: BirdeyeOverview } | null>({
                    url,
                    service: 'birdeye',
                    init: { headers },
                    maxRetries: 2,
                    timeout: '15 seconds',
                    schema: BirdeyeEnvelopeSchema,
                }).pipe(
                    // Non-2xx keeps the historical null-degrade contract; network
                    // failures / timeouts still throw (tagged) after retries.
                    Effect.catchTag('UpstreamHttpError', () => Effect.succeed(null)),
                ),
            );
            if (!json || json.success !== true || !json.data) return null;
            return json.data;
        },
    };
}

interface MakeBirdeyeOhlcvOptions {
    apiKey: string;
    origin?: string;
    baseUrl?: string;
}

function toFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function normalizeBirdeyeOhlcvItem(item: unknown): OhlcvCandle | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const rawTime = toFiniteNumber(record.unixTime ?? record.unix_time ?? record.time);
    if (rawTime === null) return null;
    const time = rawTime > 1e12 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
    const open = toFiniteNumber(record.o ?? record.open);
    const high = toFiniteNumber(record.h ?? record.high);
    const low = toFiniteNumber(record.l ?? record.low);
    const close = toFiniteNumber(record.c ?? record.close);
    if (open === null || high === null || low === null || close === null) return null;
    const volumeUsd = toFiniteNumber(record.v_usd ?? record.volumeUsd ?? record.volume_usd ?? record.volumeUSD);
    const tokenVolume = toFiniteNumber(record.v ?? record.volume);
    const volume = volumeUsd ?? (tokenVolume !== null ? tokenVolume * close : 0);
    return { time, open, high, low, close, volume };
}

export function makeBirdeyeOhlcvClient(opts: MakeBirdeyeOhlcvOptions): BirdeyeOhlcvClient {
    const baseUrl = (opts.baseUrl ?? 'https://public-api.birdeye.so').replace(/\/+$/, '');
    const headers: Record<string, string> = {
        'X-API-KEY': opts.apiKey,
        'x-chain': 'solana',
        Accept: 'application/json',
    };
    if (opts.origin) {
        headers.Origin = opts.origin;
        headers.Referer = opts.origin.endsWith('/') ? opts.origin : `${opts.origin}/`;
    }
    return {
        async fetchOhlcv(args: {
            address: string;
            interval: BirdeyeInterval;
            from: number;
            to: number;
        }): Promise<OhlcvCandle[]> {
            const params = new URLSearchParams({
                address: args.address,
                type: args.interval,
                time_from: String(args.from),
                time_to: String(args.to),
            });
            const url = `${baseUrl}/defi/v3/ohlcv?${params.toString()}`;
            const json = await Effect.runPromise(
                fetchJsonWithRetry<{ success?: unknown; data?: { items?: unknown[] } } | null>({
                    url,
                    service: 'birdeye',
                    init: { headers },
                    maxRetries: 2,
                    timeout: '30 seconds',
                }).pipe(Effect.catchTag('UpstreamHttpError', () => Effect.succeed(null))),
            );
            if (!json || json.success !== true || !json.data || !Array.isArray(json.data.items)) {
                return [];
            }
            const out: OhlcvCandle[] = [];
            for (const raw of json.data.items) {
                const candle = normalizeBirdeyeOhlcvItem(raw);
                if (candle) out.push(candle);
            }
            return out;
        },
    };
}

interface MakeSanctumOptions {
    apiKey: string | undefined;
    baseUrl?: string;
}

export function makeSanctumClient(opts: MakeSanctumOptions): SanctumClient {
    const baseUrl = (opts.baseUrl ?? 'https://sanctum-api.ironforge.network').replace(/\/+$/, '');
    return {
        async fetchAndNormalizeLsts(): Promise<SanctumFetchResult> {
            const apiKey = opts.apiKey?.trim();
            if (!apiKey) return { ok: false, reason: 'missing_env' };
            const url = new URL(`${baseUrl}/lsts`);
            const primaryHeaders: Record<string, string> = {
                Accept: 'application/json',
                'x-api-key': apiKey,
            };
            let res: Response;
            try {
                res = await withExternalTiming('sanctum', url.toString(), () =>
                    fetch(url, { headers: primaryHeaders, signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS) }),
                );
                if (!res.ok && (res.status === 400 || res.status === 401 || res.status === 403)) {
                    res = await withExternalTiming('sanctum', url.toString(), () =>
                        fetch(url, {
                            headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
                            signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
                        }),
                    );
                }
                if (!res.ok && (res.status === 400 || res.status === 401 || res.status === 403)) {
                    const fallback = new URL(url.toString());
                    fallback.searchParams.set('apiKey', apiKey);
                    res = await withExternalTiming('sanctum', fallback.toString(), () =>
                        fetch(fallback, {
                            headers: { Accept: 'application/json' },
                            signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
                        }),
                    );
                }
            } catch (err) {
                return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
            }
            if (res.status === 429 || res.status >= 500 || !res.ok) {
                return { ok: false, reason: 'http_error', status: res.status };
            }
            let payload: unknown;
            try {
                payload = await res.json();
            } catch {
                return { ok: false, reason: 'invalid_payload' };
            }
            const items = normalizeSanctumPayload(payload);
            return { ok: true, items };
        },
    };
}

interface MakeWebacyOptions {
    apiKey: string | undefined;
    baseUrl?: string;
}

export function makeWebacyClient(opts: MakeWebacyOptions): WebacyClient {
    const baseUrl = (opts.baseUrl ?? 'https://api.webacy.com').replace(/\/+$/, '');
    const apiKeyTrimmed = opts.apiKey?.trim() ?? '';
    async function get(url: string): Promise<{ ok: boolean; status: number; data?: unknown; message?: string }> {
        const apiKey = apiKeyTrimmed;
        if (!apiKey) return { ok: false, status: 0, message: 'WEBACY_API_KEY not configured' };
        try {
            const res = await withExternalTiming('webacy', url, () =>
                fetch(url, {
                    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
                    signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
                }),
            );
            const json = await res.json().catch(() => null);
            if (!res.ok || !json) {
                return {
                    ok: false,
                    status: res.status,
                    message: json ? JSON.stringify(json) : res.statusText || 'Request failed',
                };
            }
            return { ok: true, status: res.status, data: json };
        } catch (err) {
            return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
        }
    }
    return {
        isConfigured: () => apiKeyTrimmed.length > 0,
        async fetchAll(mint: string) {
            const enc = encodeURIComponent(mint);
            const [token, trading, holder] = await Promise.all([
                get(`${baseUrl}/tokens/${enc}?chain=sol`),
                get(`${baseUrl}/trading-lite/${enc}?chain=sol`),
                get(`${baseUrl}/holder-analysis/${enc}?chain=sol`),
            ]);
            return { token, trading, holder };
        },
    };
}

interface MakeWebacyDepegOptions {
    apiKey: string | undefined;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
}

/**
 * Webacy depeg monitor (`/rwa`) and structural health (`/v3/rwa`) client.
 * Separate from `makeWebacyClient` so the token-risk fixtures stay untouched.
 * Never throws: every method reports failures in its result so the jobs can
 * cache them per token.
 */
export function makeWebacyDepegClient(opts: MakeWebacyDepegOptions): WebacyDepegClient {
    const baseUrl = (opts.baseUrl ?? 'https://api.webacy.com').replace(/\/+$/, '');
    const apiKey = opts.apiKey?.trim() ?? '';
    const fetchImpl = opts.fetchImpl ?? fetch;

    type Raw = { ok: true; status: number; data: unknown } | { ok: false; status: number; message: string };

    async function request(url: string, init?: { method: 'POST'; body: unknown }): Promise<Raw> {
        if (!apiKey) return { ok: false, status: 0, message: 'WEBACY_API_KEY not configured' };
        try {
            const res = await withExternalTiming('webacy', url, () =>
                fetchImpl(url, {
                    method: init?.method ?? 'GET',
                    headers: {
                        'x-api-key': apiKey,
                        Accept: 'application/json',
                        ...(init ? { 'content-type': 'application/json' } : {}),
                    },
                    ...(init ? { body: JSON.stringify(init.body) } : {}),
                    signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
                }),
            );
            const text = await res.text().catch(() => '');
            let json: unknown = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch {
                json = null;
            }
            if (!res.ok) {
                return {
                    ok: false,
                    status: res.status,
                    message: json ? JSON.stringify(json).slice(0, 500) : res.statusText || 'Request failed',
                };
            }
            if (json === null) return { ok: false, status: res.status, message: 'non-JSON response' };
            return { ok: true, status: res.status, data: json };
        } catch (err) {
            return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
        }
    }

    /** All graded tokens on `chain`, keyed by lowercased address (how Webacy stores them). */
    async function fetchGradesIndex(
        chain: string,
    ): Promise<{ ok: true; byLowerAddress: Map<string, unknown> } | { ok: false; status: number; message: string }> {
        const byLowerAddress = new Map<string, unknown>();
        for (let page = 1; page <= 10; page++) {
            const res = await request(
                `${baseUrl}/v3/rwa/grades?chain=${encodeURIComponent(chain)}&pageSize=200&page=${page}`,
            );
            if (!res.ok) {
                if (page === 1) return { ok: false, status: res.status, message: res.message ?? 'Request failed' };
                break;
            }
            const rows = extractDepegListItems(res.data);
            for (const row of rows) {
                const rec = row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
                const address = rec && typeof rec.address === 'string' ? rec.address.trim().toLowerCase() : null;
                if (address) byLowerAddress.set(address, row);
            }
            const totalPages = readTotalPages(res.data);
            if (rows.length === 0 || (totalPages !== null && page >= totalPages) || rows.length < 200) break;
        }
        return { ok: true, byLowerAddress };
    }

    return {
        isConfigured: () => apiKey.length > 0,

        async fetchDepegToken({ chain: chainArg, address }) {
            const chain = toWebacyChainSlug(chainArg);
            const url = `${baseUrl}/rwa/${encodeURIComponent(address)}?chain=${encodeURIComponent(chain)}`;
            const res = await request(url);
            if (!res.ok) return res;
            // Single-token responses may come bare or wrapped like the list.
            const candidate = extractDepegListItems(res.data)[0] ?? res.data;
            const item = normalizeDepegItem(candidate);
            if (!item) return { ok: false, status: res.status, message: 'unrecognised depeg payload' };
            // Webacy may echo a checksummed/renamed address; trust what we asked for.
            return { ok: true, status: res.status, item: { ...item, address } };
        },

        async fetchDepegList({ chain: chainArg, pageSize, maxPages }) {
            const chain = toWebacyChainSlug(chainArg);
            const items: WebacyDepegItem[] = [];
            const seen = new Set<string>();
            let pages = 0;
            let truncated = false;
            let previousFirst: string | null = null;
            for (let page = 1; page <= maxPages; page++) {
                const url = `${baseUrl}/rwa?chain=${encodeURIComponent(chain)}&pageSize=${pageSize}&page=${page}`;
                const res = await request(url);
                if (!res.ok) {
                    // A failed later page after a good first page is a partial list,
                    // not a failed poll; the shrink guard decides what to do with it.
                    if (pages === 0) return res;
                    truncated = true;
                    break;
                }
                pages += 1;
                const rawItems = extractDepegListItems(res.data);
                if (rawItems.length === 0) break;
                // Verified envelope: { items, pagination: { total, page, pageSize, totalPages } }.
                const totalPages = readTotalPages(res.data);
                const normalized = rawItems.map(normalizeDepegItem).filter((i): i is WebacyDepegItem => i !== null);
                const first = normalized[0]?.address ?? null;
                // Endpoints that ignore `page` return the same page forever.
                if (first !== null && first === previousFirst) break;
                previousFirst = first;
                let added = 0;
                for (const item of normalized) {
                    if (seen.has(item.address)) continue;
                    seen.add(item.address);
                    items.push(item);
                    added += 1;
                }
                if (added === 0) break;
                if (rawItems.length < pageSize) break;
                if (totalPages !== null && page >= totalPages) break;
                if (page === maxPages) truncated = true;
            }
            return { ok: true, items, pages, truncated };
        },

        async fetchStructuralHealthBatch(requested) {
            if (requested.length === 0) return [];
            const addresses = requested.map(({ address, chain }) => ({ address, chain: toWebacyChainSlug(chain) }));
            if (!apiKey) {
                // Same shape as the other unconfigured paths; no network call.
                const res = await request(`${baseUrl}/v3/rwa/grades`);
                const message = res.ok ? 'not configured' : res.message;
                return addresses.map(({ address }) => ({ address, ok: false, status: 0, message }));
            }

            // Verified 2026-09-14: the v3 grade store keys Solana mints in
            // LOWERCASE (an EVM habit), so GET /v3/rwa/{mint} with the real
            // base58 casing answers 404 "Grade data not found" while the
            // lowercased form answers 200. POST /v3/rwa/batch/structural-health
            // returns criteria only (no composite grade). So: discover coverage
            // from the paginated grades list (1 call per chain), then fetch the
            // full per-token detail (drivers + criteria) with the lowercased
            // address, falling back to the list row if the detail call fails.
            const out: StructuralHealthBatchEntry[] = [];
            const byChain = new Map<string, Array<{ address: string }>>();
            for (const entry of addresses) {
                const list = byChain.get(entry.chain) ?? [];
                list.push(entry);
                byChain.set(entry.chain, list);
            }
            for (const [chain, entries] of byChain) {
                const graded = await fetchGradesIndex(chain);
                if (!graded.ok) {
                    for (const { address } of entries) {
                        out.push({ address, ok: false, status: graded.status, message: graded.message });
                    }
                    continue;
                }
                for (const { address } of entries) {
                    const listRow = graded.byLowerAddress.get(address.toLowerCase());
                    if (!listRow) {
                        out.push({ address, ok: false, status: 404, message: 'NOT_FOUND' });
                        continue;
                    }
                    const detail = await request(
                        `${baseUrl}/v3/rwa/${encodeURIComponent(address.toLowerCase())}?chain=${encodeURIComponent(chain)}`,
                    );
                    out.push(
                        detail.ok
                            ? { address, ok: true, status: detail.status, data: detail.data }
                            : { address, ok: true, status: 200, data: listRow },
                    );
                }
            }
            return out;
        },
    };
}

/**
 * Webacy's chain slug for Solana is `sol` (verified 2026-09-14 against
 * /rwa, /v3/rwa and the batch endpoint; `solana` is tolerated by /rwa only).
 * Our own tables key Solana rows by 'solana', so translate at the edge.
 */
export function toWebacyChainSlug(chain: string): string {
    const lower = chain.trim().toLowerCase();
    return lower === 'solana' ? 'sol' : lower;
}

function readTotalPages(payload: unknown): number | null {
    if (!payload || typeof payload !== 'object') return null;
    const pagination = (payload as Record<string, unknown>).pagination;
    if (!pagination || typeof pagination !== 'object') return null;
    const total = (pagination as Record<string, unknown>).totalPages;
    return typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : null;
}

function toFiniteNumberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function optionalText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function extractSanctumItem(raw: unknown): NormalizedSanctumItem['parsed'] | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const mint = optionalText(r.mint ?? r.address ?? r.tokenMint ?? r.token_mint);
    if (!mint || !looksLikeSolanaMintAddress(mint)) return null;
    const symbol = optionalText(r.symbol ?? r.ticker);
    const name = optionalText(r.name);
    const logoURI = optionalText(r.logoURI ?? r.logoUri ?? r.logo_url ?? r.image ?? r.icon);
    const websiteUrl = optionalText(r.websiteUrl ?? r.website ?? r.url);
    const tvlUsd = toFiniteNumberOrNull(r.tvlUsd ?? r.tvl_usd ?? r.tvl ?? r.tvlUSD);
    const apy = toFiniteNumberOrNull(r.apy ?? r.apyPct ?? r.apy_pct ?? r.apyPercent ?? r.apy_percent);
    return {
        mint,
        symbol,
        name,
        logoURI,
        websiteUrl,
        ...(tvlUsd !== null ? { tvlUsd } : {}),
        ...(apy !== null ? { apy } : {}),
    };
}

function normalizeSanctumPayload(payload: unknown): NormalizedSanctumItem[] {
    if (!payload) return [];
    let raws: unknown[] = [];
    if (Array.isArray(payload)) {
        raws = payload;
    } else if (typeof payload === 'object' && payload !== null) {
        const obj = payload as { data?: unknown; lsts?: unknown };
        if (Array.isArray(obj.data)) raws = obj.data;
        else if (Array.isArray(obj.lsts)) raws = obj.lsts;
    }
    const out: NormalizedSanctumItem[] = [];
    for (const raw of raws) {
        const parsed = extractSanctumItem(raw);
        if (!parsed) continue;
        out.push({ parsed, raw });
    }
    return out;
}

interface MakeCoingeckoOptions {
    apiKey?: string | undefined;
    baseUrl?: string;
}

const COINGECKO_PRO_BASE_URL = 'https://pro-api.coingecko.com/api/v3';
const COINGECKO_PUBLIC_BASE_URL = 'https://api.coingecko.com/api/v3';

export function makeCoingeckoClient(opts: MakeCoingeckoOptions): CoingeckoClient {
    const apiKey = opts.apiKey?.trim();
    const baseUrl = (opts.baseUrl ?? (apiKey ? COINGECKO_PRO_BASE_URL : COINGECKO_PUBLIC_BASE_URL)).replace(/\/+$/, '');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

    async function fetchJson(url: URL | string): Promise<unknown> {
        // Tagged failures (UpstreamHttpError / RateLimitedError / FetchFailedError)
        // propagate to per-item catches; adds 429/5xx retry + a timeout, which
        // these calls previously lacked entirely.
        return Effect.runPromise(
            fetchJsonWithRetry<unknown>({
                url: url.toString(),
                service: 'coingecko',
                init: { headers },
                maxRetries: 2,
                timeout: '30 seconds',
            }),
        );
    }

    return {
        async fetchCoinList(): Promise<CoingeckoCoinListItem[]> {
            const url = new URL(`${baseUrl}/coins/list`);
            url.searchParams.set('include_platform', 'true');
            const json = await fetchJson(url);
            return parseCoinListPayload(json);
        },

        async fetchCoinById(id: string, params: Record<string, string>): Promise<unknown> {
            const url = new URL(`${baseUrl}/coins/${encodeURIComponent(id)}`);
            for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
            return fetchJson(url);
        },

        async fetchCoinTickersPage(args) {
            const url = new URL(`${baseUrl}/coins/${encodeURIComponent(args.coinId)}/tickers`);
            url.searchParams.set('page', String(args.page));
            url.searchParams.set('order', args.order);
            url.searchParams.set('include_exchange_logo', 'true');
            url.searchParams.set('dex_pair_format', 'symbol');
            const json = (await fetchJson(url)) as { name?: unknown; tickers?: unknown; total?: unknown } | null;
            return {
                ...(typeof json?.name === 'string' ? { name: json.name } : {}),
                tickers: Array.isArray(json?.tickers) ? (json.tickers as unknown[]) : [],
                ...(typeof json?.total === 'number' ? { total: json.total } : {}),
            };
        },

        async fetchSimplePrice(coinIds) {
            const ids = Array.from(new Set(coinIds.map(s => s.trim()).filter(Boolean)));
            if (ids.length === 0) return {};
            const url = new URL(`${baseUrl}/simple/price`);
            url.searchParams.set('ids', ids.join(','));
            url.searchParams.set('vs_currencies', 'usd');
            url.searchParams.set('include_market_cap', 'true');
            url.searchParams.set('include_24hr_vol', 'true');
            url.searchParams.set('include_24hr_change', 'true');
            url.searchParams.set('include_last_updated_at', 'true');
            const json = await fetchJson(url);
            if (!json || typeof json !== 'object' || Array.isArray(json)) {
                throw new Error(`CoinGecko simple/price returned unexpected payload`);
            }
            return json as Record<
                string,
                {
                    usd?: unknown;
                    usd_market_cap?: unknown;
                    usd_24h_vol?: unknown;
                    usd_24h_change?: unknown;
                    last_updated_at?: unknown;
                }
            >;
        },

        async fetchMarketChartRange(args): Promise<CoingeckoMarketChartRange> {
            const url = new URL(`${baseUrl}/coins/${encodeURIComponent(args.coinId)}/market_chart/range`);
            url.searchParams.set('vs_currency', 'usd');
            url.searchParams.set('from', String(args.from));
            url.searchParams.set('to', String(args.to));
            url.searchParams.set('precision', 'full');
            const json = await fetchJson(url);
            if (!json || typeof json !== 'object' || Array.isArray(json)) {
                return { prices: [], totalVolumes: [] };
            }
            const data = json as { prices?: unknown; total_volumes?: unknown };
            const prices = Array.isArray(data.prices)
                ? (data.prices as unknown[])
                      .map(p => {
                          if (!Array.isArray(p) || p.length < 2) return null;
                          const [time, value] = p as [unknown, unknown];
                          if (typeof time !== 'number' || typeof value !== 'number') return null;
                          return { time: time / 1000, value };
                      })
                      .filter((p): p is { time: number; value: number } => p !== null)
                : [];
            const totalVolumes = Array.isArray(data.total_volumes)
                ? (data.total_volumes as unknown[])
                      .map(p => {
                          if (!Array.isArray(p) || p.length < 2) return null;
                          const [time, value] = p as [unknown, unknown];
                          if (typeof time !== 'number' || typeof value !== 'number') return null;
                          return { time: time / 1000, value };
                      })
                      .filter((p): p is { time: number; value: number } => p !== null)
                : [];
            return { prices, totalVolumes };
        },
    };
}

const DEFAULT_TRADING_API_URL = 'https://trading-api.solana.com/v1/query';

/** clickhouse-api returned non-2xx. 4xx never heals by retrying (unknown
 * preset, bad params) — callers should abort the run, not hammer. */
export class ClickhouseApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = 'ClickhouseApiError';
    }
    get permanent(): boolean {
        // 429 (rate limit) and 408 (timeout) are transient despite being 4xx.
        return this.status >= 400 && this.status < 500 && this.status !== 429 && this.status !== 408;
    }
}
const GATEWAY_TIMEOUT_MS = 30_000;

export interface MakeClickhouseOptions {
    url: string;
    username: string;
    password: string;
    database: string;
    stockTradesTable?: string;
    stockInstrumentsTable?: string;
    solanaTradesTable?: string;
    priceScale?: number;
    fetchImpl?: typeof fetch;
    tradingApiUrl?: string;
}

function quoteIdent(value: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new Error(`Invalid ClickHouse identifier: ${value}`);
    }
    return `\`${value}\``;
}

interface ClickhouseQueryRequest {
    sql: string;
    params?: Record<string, string | number>;
}

function buildClickhouseUrl(baseUrl: string, params: Record<string, string | number>): URL {
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return url;
}

async function runClickhouseQuery<T>(opts: MakeClickhouseOptions, request: ClickhouseQueryRequest): Promise<T[]> {
    const f = opts.fetchImpl ?? fetch;
    const params: Record<string, string | number> = {
        database: opts.database,
        default_format: 'JSONEachRow',
    };
    for (const [k, v] of Object.entries(request.params ?? {})) params[`param_${k}`] = v;
    const url = buildClickhouseUrl(opts.url, params);
    const auth = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`;
    const res = await withExternalTiming('clickhouse', url.toString(), () =>
        f(url.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain',
                Accept: 'application/json',
                Authorization: auth,
            },
            body: request.sql,
        }),
    );
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ClickHouse HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const body = await res.text();
    if (!body) return [];
    const lines = body.split('\n').filter(Boolean);
    const out: T[] = [];
    for (const line of lines) {
        try {
            out.push(JSON.parse(line) as T);
        } catch {
            continue;
        }
    }
    return out;
}

function toFiniteOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function pctChange(current: number | null, previous: number | null): number | null {
    if (current === null || previous === null || previous <= 0) return null;
    return ((current - previous) / previous) * 100;
}

export function makeClickhouseClient(opts: MakeClickhouseOptions): ClickhouseClient {
    const database = quoteIdent(opts.database);
    const stockTradesTable = opts.stockTradesTable ? quoteIdent(opts.stockTradesTable) : null;
    const stockInstrumentsTable = opts.stockInstrumentsTable ? quoteIdent(opts.stockInstrumentsTable) : null;
    const solanaTradesTable = opts.solanaTradesTable ? quoteIdent(opts.solanaTradesTable) : null;
    const priceScale = opts.priceScale && opts.priceScale > 0 ? opts.priceScale : 1;
    const tradingApiUrl = (opts.tradingApiUrl ?? DEFAULT_TRADING_API_URL).replace(/\/+$/, '');

    async function queryPreset<T>(name: string, params: Record<string, unknown>): Promise<T[]> {
        const f = opts.fetchImpl ?? fetch;
        const res = await withExternalTiming('clickhouse-api', tradingApiUrl, () =>
            f(tradingApiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ name, params }),
                signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
            }),
        );
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new ClickhouseApiError(`clickhouse-api HTTP ${res.status}: ${text.slice(0, 500)}`, res.status);
        }
        const payload: unknown = await res.json();
        const decoded = await Effect.runPromise(decodeUpstreamOrWarn(GatewayEnvelopeSchema, 'clickhouse-api')(payload));
        return ((decoded as { data?: T[] }).data ?? []) as T[];
    }

    return {
        queryPreset,

        async fetchStockInstruments(params: { limit: number }): Promise<ClickhouseStockInstrumentRow[]> {
            if (!stockInstrumentsTable && !stockTradesTable) return [];
            const lim = Math.min(Math.max(Math.floor(params.limit), 1), 10_000);
            if (stockInstrumentsTable) {
                interface InstrumentRow {
                    symbol?: string;
                    name?: string | null;
                    assetId?: string | null;
                    instrumentId?: number | string | null;
                    dataset?: string | null;
                }
                const rows = await runClickhouseQuery<InstrumentRow>(opts, {
                    sql: `
                        SELECT toString(symbol) AS symbol,
                               NULL AS name,
                               NULL AS assetId,
                               NULL AS instrumentId,
                               NULL AS dataset
                        FROM ${database}.${stockInstrumentsTable}
                        WHERE length(trim(toString(symbol))) > 0
                        LIMIT {limit:UInt32}
                    `,
                    params: { limit: lim },
                });
                return rows
                    .filter(r => typeof r.symbol === 'string' && r.symbol.trim().length > 0)
                    .map(r => ({
                        symbol: String(r.symbol).trim().toUpperCase(),
                        name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : null,
                        assetId: typeof r.assetId === 'string' && r.assetId.trim() ? r.assetId.trim() : null,
                        instrumentId: toFiniteOrNull(r.instrumentId),
                        dataset: typeof r.dataset === 'string' && r.dataset.trim() ? r.dataset.trim() : null,
                    }));
            }
            interface TradeSymbolRow {
                symbol?: string;
            }
            const rows = await runClickhouseQuery<TradeSymbolRow>(opts, {
                sql: `
                    SELECT DISTINCT toString(symbol) AS symbol
                    FROM ${database}.${stockTradesTable}
                    WHERE length(trim(toString(symbol))) > 0
                    ORDER BY symbol ASC
                    LIMIT {limit:UInt32}
                `,
                params: { limit: lim },
            });
            return rows
                .filter(r => typeof r.symbol === 'string' && r.symbol.trim().length > 0)
                .map(r => ({
                    symbol: String(r.symbol).trim().toUpperCase(),
                    name: null,
                    assetId: null,
                    instrumentId: null,
                    dataset: null,
                }));
        },

        async fetchStockSnapshot(symbol: string): Promise<ClickhouseStockSnapshot | null> {
            if (!stockTradesTable) return null;
            interface LatestRow {
                time?: number | string;
                price?: number | string;
            }
            interface VolumeRow {
                volume?: number | string | null;
            }
            const normSymbol = symbol.trim().toUpperCase();
            if (!normSymbol) return null;
            const latestRows = await queryPreset<LatestRow>('stock_price_latest', { symbol: normSymbol });
            const latest = latestRows[0];
            const latestPrice = toFiniteOrNull(latest?.price);
            const asOf = toFiniteOrNull(latest?.time);
            if (latestPrice === null || asOf === null) return null;
            const prevRows = await queryPreset<LatestRow>('stock_price_asof', {
                symbol: normSymbol,
                asOfSec: Math.max(0, Math.floor(asOf - 24 * 60 * 60)),
            });
            const prevPrice = toFiniteOrNull(prevRows[0]?.price);
            const volumeRows = await runClickhouseQuery<VolumeRow>(opts, {
                sql: `
                    SELECT sum((toFloat64(price) / {priceScale:Float64}) * toFloat64(size)) AS volume
                    FROM ${database}.${stockTradesTable}
                    WHERE symbol = {symbol:String}
                      AND ts_event >= toDateTime({from:UInt32})
                      AND ts_event <= toDateTime({to:UInt32})
                `,
                params: {
                    symbol: normSymbol,
                    priceScale,
                    from: Math.max(0, Math.floor(asOf - 24 * 60 * 60)),
                    to: Math.floor(asOf),
                },
            });
            const volume24hUsd = toFiniteOrNull(volumeRows[0]?.volume);
            const priceChange24hPercent =
                prevPrice !== null && prevPrice > 0 ? ((latestPrice - prevPrice) / prevPrice) * 100 : null;
            return { priceUsd: latestPrice, volume24hUsd, priceChange24hPercent, asOf };
        },

        async fetchSharesOutstanding(symbols: readonly string[]): Promise<ClickhouseSharesOutstandingRow[]> {
            interface SharesRow {
                symbol?: string;
                sharesOutstanding?: number | string | null;
                impliedSharesOutstanding?: number | string | null;
                lastSuccessAtMs?: number | string | null;
            }
            const wanted = symbols.map(s => s.trim().toUpperCase()).filter(s => s.length > 0);
            if (wanted.length === 0) return [];
            const rows = await queryPreset<SharesRow>('yfinance_shares_outstanding_latest', { symbols: wanted });
            const out: ClickhouseSharesOutstandingRow[] = [];
            for (const row of rows) {
                if (typeof row.symbol !== 'string' || row.symbol.trim().length === 0) continue;
                out.push({
                    symbol: row.symbol.trim().toUpperCase(),
                    sharesOutstanding:
                        toFiniteOrNull(row.sharesOutstanding) ?? toFiniteOrNull(row.impliedSharesOutstanding),
                    asOfMs: toFiniteOrNull(row.lastSuccessAtMs),
                });
            }
            return out;
        },

        async fetchSolanaTradesAsOfMs(): Promise<number | null> {
            const rows = await queryPreset<{ lastTradeAtMs?: number | string | null }>('latest_trade', {});
            return toFiniteOrNull(rows[0]?.lastTradeAtMs);
        },

        async fetchSolanaMintSnapshots(args: {
            mints: readonly string[];
            stableMints: readonly string[];
            asOfMs?: number;
        }): Promise<ClickhouseMintSnapshot[]> {
            if (!solanaTradesTable) return [];
            if (args.mints.length === 0) return [];
            interface MintSnapshotRow {
                mint?: string;
                priceUsd?: number | string | null;
                volume1hUsd?: number | string | null;
                volume24hUsd?: number | string | null;
                trade1h?: number | string | null;
                trade24h?: number | string | null;
                uniqueTrader1h?: number | string | null;
                uniqueTrader24h?: number | string | null;
                price1hAgo?: number | string | null;
                price24hAgo?: number | string | null;
                lastTradeAtMs?: number | string | null;
            }
            const rows = await queryPreset<MintSnapshotRow>('tokens_summary', {
                mints: Array.from(args.mints),
                stables: Array.from(args.stableMints),
            });
            const asOf = args.asOfMs !== undefined ? Math.floor(args.asOfMs / 1000) : null;
            return rows
                .filter(r => typeof r.mint === 'string' && r.mint.trim().length > 0)
                .map(r => {
                    const mint = String(r.mint);
                    const priceUsd = toFiniteOrNull(r.priceUsd);
                    const lastTradeAtMs = toFiniteOrNull(r.lastTradeAtMs);
                    return {
                        mint,
                        priceUsd,
                        volume1hUsd: toFiniteOrNull(r.volume1hUsd) ?? 0,
                        volume24hUsd: toFiniteOrNull(r.volume24hUsd) ?? 0,
                        trade1h: toFiniteOrNull(r.trade1h) ?? 0,
                        trade24h: toFiniteOrNull(r.trade24h) ?? 0,
                        uniqueTrader1h: toFiniteOrNull(r.uniqueTrader1h) ?? 0,
                        uniqueTrader24h: toFiniteOrNull(r.uniqueTrader24h) ?? 0,
                        priceChange1hPercent: pctChange(priceUsd, toFiniteOrNull(r.price1hAgo)),
                        priceChange24hPercent: pctChange(priceUsd, toFiniteOrNull(r.price24hAgo)),
                        lastTradeAt: lastTradeAtMs,
                        asOf,
                    };
                });
        },

        async query(args) {
            return runClickhouseQuery(opts, { sql: args.sql, ...(args.params ? { params: args.params } : {}) });
        },

        tables() {
            return {
                database: opts.database,
                stockTradesTable: opts.stockTradesTable ?? null,
                stockInstrumentsTable: opts.stockInstrumentsTable ?? null,
                solanaTradesTable: opts.solanaTradesTable ?? null,
                priceScale,
            };
        },
    };
}

interface MakeBirdeyeMarketsOptions {
    apiKey: string;
    origin?: string;
    baseUrl?: string;
}

function asNonEmptyStringField(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function asFiniteNumberField(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function sanitizeMarketTokenField(value: unknown): TokenMarketEntry['base'] | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const r = value as Record<string, unknown>;
    const address = asNonEmptyStringField(r.address);
    if (!address) return undefined;
    const decimals = asFiniteNumberField(r.decimals);
    const symbol = asNonEmptyStringField(r.symbol);
    const icon = asNonEmptyStringField(r.icon);
    const name = asNonEmptyStringField(r.name);
    const out: NonNullable<TokenMarketEntry['base']> = { address };
    if (decimals !== undefined) out.decimals = decimals;
    if (symbol) out.symbol = symbol;
    if (icon) out.icon = icon;
    if (name) out.name = name;
    return out;
}

function sanitizeMarketEntry(value: unknown): TokenMarketEntry | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    const address = asNonEmptyStringField(r.address);
    if (!address) return null;
    const out: TokenMarketEntry = { address };
    const name = asNonEmptyStringField(r.name);
    if (name) out.name = name;
    const base = sanitizeMarketTokenField(r.base);
    if (base) out.base = base;
    const quote = sanitizeMarketTokenField(r.quote);
    if (quote) out.quote = quote;
    const source = asNonEmptyStringField(r.source);
    if (source) out.source = source;
    const createdAt = asNonEmptyStringField(r.createdAt);
    if (createdAt) out.createdAt = createdAt;
    const liquidity = asFiniteNumberField(r.liquidity);
    if (liquidity !== undefined) out.liquidity = liquidity;
    const volume24h = asFiniteNumberField(r.volume24h);
    if (volume24h !== undefined) out.volume24h = volume24h;
    const trade24h = asFiniteNumberField(r.trade24h);
    if (trade24h !== undefined) out.trade24h = trade24h;
    const trade24hChangePercent = asFiniteNumberField(r.trade24hChangePercent);
    if (trade24hChangePercent !== undefined) out.trade24hChangePercent = trade24hChangePercent;
    const uniqueWallet24h = asFiniteNumberField(r.uniqueWallet24h);
    if (uniqueWallet24h !== undefined) out.uniqueWallet24h = uniqueWallet24h;
    const uniqueWallet24hChangePercent = asFiniteNumberField(r.uniqueWallet24hChangePercent);
    if (uniqueWallet24hChangePercent !== undefined) out.uniqueWallet24hChangePercent = uniqueWallet24hChangePercent;
    const price = asFiniteNumberField(r.price);
    if (price !== undefined) out.price = price;
    return out;
}

interface MakeRwaXyzOptions {
    apiKey: string;
    baseUrl?: string;
    apiVersion?: string;
}

interface RwaXyzListResponseShape<T> {
    results?: T[];
}

interface RwaXyzTokenRaw {
    id?: unknown;
    token_id?: unknown;
    asset_id?: unknown;
    name?: unknown;
    decimals?: unknown;
    price_dollar?: unknown;
    market_value_dollar?: unknown;
    net_asset_value_dollar?: unknown;
    total_asset_value_dollar?: unknown;
    circulating_asset_value_dollar?: unknown;
    circulating_market_value_dollar?: unknown;
    apy_7_day?: unknown;
    apy_30_day?: unknown;
    total_supply_token?: unknown;
    circulating_supply_token?: unknown;
    holding_addresses_count?: unknown;
}

interface RwaXyzAssetRaw {
    id?: unknown;
    asset_id?: unknown;
    name?: unknown;
    slug?: unknown;
    ticker?: unknown;
    website?: unknown;
    icon_url?: unknown;
    asset_class_id?: unknown;
    asset_class_name?: unknown;
    asset_class_slug?: unknown;
    issuer_id?: unknown;
    issuer_name?: unknown;
}

function rwaAsFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function rwaAsNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function rwaExtractMeasureNumber(value: unknown, depth = 0): number | null {
    const direct = rwaAsFiniteNumber(value);
    if (direct !== null) return direct;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (depth >= 4) return null;
    const obj = value as Record<string, unknown>;
    const candidates: Array<unknown> = [
        obj.value,
        obj.current,
        obj.amount,
        obj.dollar,
        obj.usd,
        obj.price,
        obj.market_value,
        obj.marketValue,
        obj.latest,
        obj.data,
        obj.measure,
        obj.result,
    ];
    for (const candidate of candidates) {
        const n = rwaExtractMeasureNumber(candidate, depth + 1);
        if (n !== null) return n;
    }
    for (const key of Object.keys(obj)) {
        const n = rwaAsFiniteNumber(obj[key]);
        if (n !== null) return n;
    }
    return null;
}

function buildRwaXyzTokenSnapshot(raw: RwaXyzTokenRaw, payloadJson: string): RwaXyzTokenSnapshot {
    const snap: RwaXyzTokenSnapshot = { payloadJson };
    const rwaId = rwaAsFiniteNumber(raw.id);
    if (rwaId !== null) snap.rwaId = rwaId;
    const rwaTokenId = rwaAsFiniteNumber(raw.token_id);
    if (rwaTokenId !== null) snap.rwaTokenId = rwaTokenId;
    const assetId = rwaAsFiniteNumber(raw.asset_id);
    if (assetId !== null) snap.assetId = assetId;
    const name = rwaAsNonEmptyString(raw.name);
    if (name) snap.name = name;
    const decimals = rwaAsFiniteNumber(raw.decimals);
    if (decimals !== null) snap.decimals = decimals;
    const priceDollar = rwaExtractMeasureNumber(raw.price_dollar);
    if (priceDollar !== null) snap.priceDollar = priceDollar;
    const marketValueDollar = rwaExtractMeasureNumber(raw.market_value_dollar);
    if (marketValueDollar !== null) snap.marketValueDollar = marketValueDollar;
    const netAssetValueDollar = rwaExtractMeasureNumber(raw.net_asset_value_dollar);
    if (netAssetValueDollar !== null) snap.netAssetValueDollar = netAssetValueDollar;
    const totalAssetValueDollar = rwaExtractMeasureNumber(raw.total_asset_value_dollar);
    if (totalAssetValueDollar !== null) snap.totalAssetValueDollar = totalAssetValueDollar;
    const circulatingAssetValueDollar = rwaExtractMeasureNumber(raw.circulating_asset_value_dollar);
    if (circulatingAssetValueDollar !== null) snap.circulatingAssetValueDollar = circulatingAssetValueDollar;
    const circulatingMarketValueDollar = rwaExtractMeasureNumber(raw.circulating_market_value_dollar);
    if (circulatingMarketValueDollar !== null) snap.circulatingMarketValueDollar = circulatingMarketValueDollar;
    const apy7Day = rwaExtractMeasureNumber(raw.apy_7_day);
    if (apy7Day !== null) snap.apy7Day = apy7Day;
    const apy30Day = rwaExtractMeasureNumber(raw.apy_30_day);
    if (apy30Day !== null) snap.apy30Day = apy30Day;
    const totalSupplyToken = rwaExtractMeasureNumber(raw.total_supply_token);
    if (totalSupplyToken !== null) snap.totalSupplyToken = totalSupplyToken;
    const circulatingSupplyToken = rwaExtractMeasureNumber(raw.circulating_supply_token);
    if (circulatingSupplyToken !== null) snap.circulatingSupplyToken = circulatingSupplyToken;
    const holdingAddressesCount = rwaExtractMeasureNumber(raw.holding_addresses_count);
    if (holdingAddressesCount !== null) snap.holdingAddressesCount = holdingAddressesCount;
    return snap;
}

function buildRwaXyzAssetSnapshot(raw: RwaXyzAssetRaw, payloadJson: string): RwaXyzAssetSnapshot | null {
    const assetId = rwaAsFiniteNumber(raw.asset_id) ?? rwaAsFiniteNumber(raw.id);
    if (assetId === null) return null;
    const snap: RwaXyzAssetSnapshot = { assetId, payloadJson };
    const name = rwaAsNonEmptyString(raw.name);
    if (name) snap.name = name;
    const ticker = rwaAsNonEmptyString(raw.ticker);
    if (ticker) snap.ticker = ticker;
    const slug = rwaAsNonEmptyString(raw.slug);
    if (slug) snap.slug = slug;
    const iconUrl = rwaAsNonEmptyString(raw.icon_url);
    if (iconUrl) snap.iconUrl = iconUrl;
    const website = rwaAsNonEmptyString(raw.website);
    if (website) snap.website = website;
    const issuerId = rwaAsNonEmptyString(raw.issuer_id);
    if (issuerId) snap.issuerId = issuerId;
    const issuerName = rwaAsNonEmptyString(raw.issuer_name);
    if (issuerName) snap.issuerName = issuerName;
    const assetClassId = rwaAsFiniteNumber(raw.asset_class_id);
    if (assetClassId !== null) snap.assetClassId = assetClassId;
    const assetClassName = rwaAsNonEmptyString(raw.asset_class_name);
    if (assetClassName) snap.assetClassName = assetClassName;
    const assetClassSlug = rwaAsNonEmptyString(raw.asset_class_slug);
    if (assetClassSlug) snap.assetClassSlug = assetClassSlug;
    return snap;
}

export function makeRwaXyzClient(opts: MakeRwaXyzOptions): RwaXyzClient {
    const baseUrl = (opts.baseUrl ?? 'https://api.rwa.xyz').replace(/\/+$/, '');
    const apiVersion = opts.apiVersion ?? 'v4';
    const apiKey = opts.apiKey.trim();
    if (!apiKey) throw new Error('RWA API key is required');
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
    };

    async function fetchJson(path: string): Promise<unknown> {
        const url = `${baseUrl}/${apiVersion}${path}`;
        return Effect.runPromise(
            fetchJsonWithRetry<unknown>({
                url,
                service: 'rwaxyz',
                init: { headers },
                maxRetries: 2,
                timeout: '30 seconds',
            }),
        );
    }

    async function fetchTokenByMint(mint: string): Promise<RwaXyzTokenRaw | null> {
        const address = mint.trim();
        if (!address) return null;
        const query = {
            filter: {
                operator: 'and',
                filters: [
                    { operator: 'equals', field: 'network_slug', value: 'solana' },
                    { operator: 'equals', field: 'address', value: address },
                ],
            },
            pagination: { page: 1, perPage: 1 },
        };
        const json = await fetchJson(`/tokens?query=${encodeURIComponent(JSON.stringify(query))}`);
        const results = (json as RwaXyzListResponseShape<RwaXyzTokenRaw>)?.results;
        if (!Array.isArray(results) || results.length === 0) return null;
        return results[0] ?? null;
    }

    async function fetchAssetById(assetId: number): Promise<RwaXyzAssetRaw | null> {
        if (!Number.isFinite(assetId)) return null;
        const json = await fetchJson(`/assets/${encodeURIComponent(String(assetId))}`);
        const maybeResults = (json as RwaXyzListResponseShape<RwaXyzAssetRaw>)?.results;
        if (Array.isArray(maybeResults)) return maybeResults[0] ?? null;
        return json as RwaXyzAssetRaw;
    }

    return {
        async fetchSolanaTokenAndAssetByMint(mint) {
            const tokenRaw = await fetchTokenByMint(mint);
            if (!tokenRaw) return null;
            const tokenSnapshot = buildRwaXyzTokenSnapshot(tokenRaw, JSON.stringify(tokenRaw));

            const assetIdNum = rwaAsFiniteNumber(tokenRaw.asset_id);
            if (assetIdNum === null) return { token: tokenSnapshot, asset: null };

            const assetRaw = await fetchAssetById(assetIdNum);
            if (!assetRaw) return { token: tokenSnapshot, asset: null };
            const assetSnapshot = buildRwaXyzAssetSnapshot(assetRaw, JSON.stringify(assetRaw));
            return { token: tokenSnapshot, asset: assetSnapshot };
        },
    };
}

interface MakePreStocksOptions {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
}

const PRESTOCKS_TIMEOUT_MS = 10_000;

function preStocksFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function preStocksNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function makePreStocksClient(opts: MakePreStocksOptions = {}): PreStocksClient {
    const baseUrl = (opts.baseUrl ?? 'https://prestocks.com').replace(/\/+$/, '');
    const fetchImpl = opts.fetchImpl ?? fetch;

    return {
        async fetchBySymbol(symbol: string): Promise<PreStocksApiSnapshot | null> {
            const cleaned = symbol.trim().toUpperCase();
            if (!/^[A-Z0-9]+$/.test(cleaned)) return null;
            const url = `${baseUrl}/api/${cleaned}`;
            const res = await withExternalTiming('prestocks', url, () =>
                fetchImpl(url, {
                    headers: { Accept: 'application/json' },
                    signal: AbortSignal.timeout(PRESTOCKS_TIMEOUT_MS),
                }),
            );
            if (res.status === 404) return null;
            const text = await res.text().catch(() => '');
            if (!res.ok || !text) {
                throw new Error(`PreStocks request failed: HTTP ${res.status} ${res.statusText}`);
            }
            // Descriptions contain raw control characters, which strict JSON
            // rejects — replace them before parsing.
            let json: unknown;
            try {
                // eslint-disable-next-line no-control-regex
                json = JSON.parse(text.replace(/[\u0000-\u001f]/g, ' '));
            } catch {
                throw new Error(`PreStocks response is not valid JSON for ${cleaned}`);
            }
            if (typeof json !== 'object' || json === null) return null;
            const raw = json as Record<string, unknown>;
            const mint = preStocksNonEmptyString(raw.contract_address);
            const symbolOut = preStocksNonEmptyString(raw.symbol);
            if (!mint || !symbolOut) return null;
            return {
                symbol: symbolOut,
                name: preStocksNonEmptyString(raw.name),
                mint,
                markPriceUsd: preStocksFiniteNumber(raw.markPrice),
                markValuationUsd: preStocksFiniteNumber(raw.markValuation),
                tokenPriceUsd: preStocksFiniteNumber(raw.tokenPrice),
                impliedValuationUsd: preStocksFiniteNumber(raw.impliedValuation),
                supply: preStocksFiniteNumber(raw.supply),
                imageUrl: preStocksNonEmptyString(raw.image),
                externalUrl: preStocksNonEmptyString(raw.external_url),
            };
        },
    };
}

export function makeBirdeyeMarketsClient(opts: MakeBirdeyeMarketsOptions): BirdeyeMarketsClient {
    const baseUrl = (opts.baseUrl ?? 'https://public-api.birdeye.so').replace(/\/+$/, '');
    const headers: Record<string, string> = {
        'X-API-KEY': opts.apiKey,
        'x-chain': 'solana',
        Accept: 'application/json',
    };
    if (opts.origin) {
        headers.Origin = opts.origin;
        headers.Referer = opts.origin.endsWith('/') ? opts.origin : `${opts.origin}/`;
    }
    return {
        async fetchTokenMarkets(args: { address: string; limit: number }): Promise<TokenMarketEntry[]> {
            const limit = Math.min(Math.max(Math.floor(args.limit), 1), 20);
            const params = new URLSearchParams({
                address: args.address,
                time_frame: '24h',
                sort_type: 'desc',
                sort_by: 'liquidity',
                offset: '0',
                limit: String(limit),
            });
            const url = `${baseUrl}/defi/v2/markets?${params.toString()}`;
            const res = await withExternalTiming('birdeye', url, () => fetch(url, { headers }));
            const json = (await res.json().catch(() => null)) as {
                success?: unknown;
                data?: { items?: unknown[]; markets?: unknown[] };
            } | null;
            if (!res.ok || !json || json.success !== true || !json.data) {
                throw new Error(`Birdeye markets failed: HTTP ${res.status} ${res.statusText}`);
            }
            const rawItems = Array.isArray(json.data.items)
                ? json.data.items
                : Array.isArray(json.data.markets)
                  ? json.data.markets
                  : [];
            const byAddress = new Map<string, TokenMarketEntry>();
            for (const raw of rawItems) {
                const market = sanitizeMarketEntry(raw);
                if (!market) continue;
                byAddress.set(market.address, market);
            }
            return Array.from(byAddress.values());
        },
    };
}
