import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { runJobPool } from '@tokens/effect/job-runner';
import { normalizeCoinGeckoCoinIdForAsset } from '@tokens/asset-registry/coingecko-id';
import type { CronResult } from './crons';
import { InvalidArgsError, parseExplicitTargets } from './crons';

declare module './crons' {
    interface CronDeps {
        coingeckoRepo?: CoingeckoRepo;
        coingeckoCurated?: CoingeckoCuratedSource;
        coingecko?: CoingeckoClient;
    }
}

export type CoingeckoOhlcvInterval = '1m' | '5m' | '15m' | '1H' | '4H' | '1D' | '1W';

const COINGECKO_OHLCV_INTERVALS: readonly CoingeckoOhlcvInterval[] = [
    '1m',
    '5m',
    '15m',
    '1H',
    '4H',
    '1D',
    '1W',
];

export interface CoingeckoCoinListItem {
    id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string>;
}

export interface CoingeckoCoinUpsert {
    id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string>;
    syncedAt: number;
}

export interface CoingeckoCoinMetadataUpsert {
    id: string;
    coin: Record<string, unknown>;
    fetchedAt: number;
}

export interface CoingeckoTickerMarket {
    name: string;
    identifier?: string;
    logo?: string;
    hasTradingIncentive?: boolean;
}

export interface CoingeckoTickerRow {
    base: string;
    target: string;
    market: CoingeckoTickerMarket;
    priceUsd: number | null;
    volume24hUsd: number | null;
    spreadPercent: number | null;
    tradeUrl: string | null;
    trustScore: string | null;
    isAnomaly: boolean;
    isStale: boolean;
    timestamp: string | null;
}

export interface CoingeckoTickersUpsert {
    coinId: string;
    name?: string;
    tickers: CoingeckoTickerRow[];
    total?: number;
    lastFetchedAt: number;
}

export interface CoingeckoPriceUpsert {
    coinId: string;
    priceUsd: number | null;
    marketCapUsd: number | null;
    volume24hUsd: number | null;
    priceChange24hPercent: number | null;
    providerLastUpdatedAt: number | null;
    lastFetchedAt: number;
    /** Canonical supply from `/coins/markets`; `null` leaves the stored value untouched (COALESCE). */
    circulatingSupply?: number | null;
    totalSupply?: number | null;
    /** `null` for uncapped assets as well as when unknown — CoinGecko has no separate "uncapped" signal. */
    maxSupply?: number | null;
    fdvUsd?: number | null;
}

/** Raw `/coins/markets` row; leaves are `unknown` until validated. */
export interface CoingeckoCoinsMarketsRow {
    id: string;
    current_price?: unknown;
    market_cap?: unknown;
    fully_diluted_valuation?: unknown;
    total_volume?: unknown;
    price_change_percentage_24h?: unknown;
    circulating_supply?: unknown;
    total_supply?: unknown;
    max_supply?: unknown;
    last_updated?: unknown;
}

export interface CoingeckoOhlcvCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface CoingeckoOhlcvUpsertResult {
    inserted: number;
    updated: number;
    skipped: number;
}

export interface CoingeckoRepo {
    upsertCoinListBatch(
        coins: readonly CoingeckoCoinUpsert[],
    ): Promise<{ inserted: number; updated: number; skipped: number }>;

    getCoinMetadataLastFetchedAt(id: string): Promise<number | null>;
    upsertCoinMetadata(args: CoingeckoCoinMetadataUpsert): Promise<void>;

    getTickersLastFetchedAt(coinId: string): Promise<number | null>;
    upsertTickersLatest(args: CoingeckoTickersUpsert): Promise<void>;
    touchTickersLatest(coinId: string, lastFetchedAt: number): Promise<void>;

    upsertPriceLatest(args: CoingeckoPriceUpsert): Promise<void>;
    listPriceLastFetchedAtByCoinIds(coinIds: readonly string[]): Promise<Map<string, number | null>>;

    /** Intersect with coingecko_coins rows whose last_synced_at is at or after
     * `syncedSinceMs`. Curated coins CoinGecko no longer lists 404 on every
     * per-coin endpoint forever (delisted xstocks), and the daily
     * sync-coingecko-coin-list only upserts — a row whose last_synced_at stops
     * advancing is our delisting signal. Skipping stale rows here self-heals
     * when a relisted coin gets re-synced. */
    filterKnownCoinIds(coinIds: readonly string[], syncedSinceMs: number): Promise<string[]>;
    hasFreshCoinListRows(syncedSinceMs: number): Promise<boolean>;

    /** Active, non-tombstoned assets (with or without a coin id) and their active Solana mints. */
    listAssetsForCoinIdValidation(limit: number): Promise<AssetCoinIdValidationRow[]>;
    /** Coin rows for the given ids: the coin's Solana contract when it lists one. */
    findKnownCoins(coinIds: readonly string[]): Promise<Map<string, { solanaMint: string | null }>>;
    /** Every coin whose `platforms.solana` is one of the mints (several coins may share a mint). */
    findCoinsBySolanaMints(mints: readonly string[]): Promise<Array<{ mint: string; coinId: string; lastSyncedAt: number | null }>>;
    /**
     * Set `assets.coingecko_id` and replace the asset's `coingeckoId` alias, only
     * while the asset has never been admin-edited. Returns false when skipped.
     */
    repairAssetCoinId(args: { assetId: string; coinId: string; nowMs: number }): Promise<boolean>;
    upsertCoinIdAudit(rows: readonly CoinIdAuditRow[]): Promise<void>;

    getOhlcvBounds(coinId: string, interval: CoingeckoOhlcvInterval): Promise<{ minTime: number | null; maxTime: number | null }>;
    upsertOhlcvCandles(
        coinId: string,
        interval: CoingeckoOhlcvInterval,
        candles: readonly CoingeckoOhlcvCandle[],
    ): Promise<CoingeckoOhlcvUpsertResult>;
}

/** Coin-list rows not re-synced within this window are treated as delisted.
 * sync-coingecko-coin-list runs weekly (terraform crons_coingecko.tf,
 * `0 4 * * 0`), so cover two cadences plus a day of slack: one missed or
 * failed run must not age the whole table into the fail-open path. */
const COIN_LIST_FRESHNESS_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

async function dropUnknownCoinIds(
    repo: Pick<CoingeckoRepo, 'filterKnownCoinIds' | 'hasFreshCoinListRows'>,
    coinIds: string[],
    job: string,
    nowMs: number,
): Promise<string[]> {
    const cutoff = nowMs - COIN_LIST_FRESHNESS_WINDOW_MS;
    const known = await repo.filterKnownCoinIds(coinIds, cutoff);
    if (known.length === 0 && coinIds.length > 0) {
        // Zero matches is ambiguous: either the coin-list sync is dead (fresh
        // env, truncated table, every row aged out) or this batch just happens
        // to be entirely delisted ids - crons that page through curated ids in
        // small batches hit the latter routinely. Only fail open when the
        // table has no fresh rows at all; a fresh table means the sync is
        // healthy and these ids are genuinely gone from CoinGecko.
        if (await repo.hasFreshCoinListRows(cutoff)) {
            console.log(`[${job}] skipping ${coinIds.length} coin id(s) not in the synced CoinGecko coin list`);
            return [];
        }
        console.error(`[${job}] coingecko_coins matched 0 of ${coinIds.length} ids - failing open (is the coin-list sync healthy?)`);
        return coinIds;
    }
    const dropped = coinIds.length - known.length;
    if (dropped > 0) {
        console.log(`[${job}] skipping ${dropped} coin id(s) not in the synced CoinGecko coin list`);
    }
    return known;
}

export interface CoingeckoCuratedSource {
    /** Reference coin ids of curated assets, curated order. Drives metadata / tickers / OHLCV. */
    getCuratedCoinIdsInOrder(): string[];
    /**
     * Every coin id a price is served under: curated ids first, then the
     * reference id of every other active asset, then the coin ids active
     * variants link to (issuers, LSTs, wrappers). Drives the price refresh only.
     */
    getPriceCoinIdsInOrder(): string[];
}

/** One active asset as seen by validate-coingecko-ids. */
export interface AssetCoinIdValidationRow {
    assetId: string;
    category: string;
    coingeckoId: string | null;
    adminEditedAt: number | null;
    /** Active Solana mints with their latest liquidity (tie-break between issuers). */
    solanaMints: Array<{ mint: string; liquidity: number | null }>;
}

export type CoinIdAuditStatus = 'ok' | 'suspect' | 'repaired' | 'assigned' | 'needsAdmin' | 'unresolved';

export interface CoinIdAuditRow {
    assetId: string;
    status: CoinIdAuditStatus;
    currentId: string | null;
    suggestedId: string | null;
    candidates: Array<{ coinId: string; mint: string; liquidity: number | null }>;
    note: string | null;
    checkedAt: number;
}

export interface CoingeckoMarketChartPoint {
    time: number;
    value: number;
}

export interface CoingeckoMarketChartRange {
    prices: CoingeckoMarketChartPoint[];
    totalVolumes: CoingeckoMarketChartPoint[];
}

export interface CoingeckoClient {
    fetchCoinList(): Promise<CoingeckoCoinListItem[]>;
    fetchCoinById(id: string, params: Record<string, string>): Promise<unknown>;
    fetchCoinTickersPage(args: { coinId: string; page: number; order: 'volume_desc' }): Promise<{
        name?: string;
        tickers: unknown[];
        total?: number;
    }>;
    fetchSimplePrice(coinIds: readonly string[]): Promise<Record<string, {
        usd?: unknown;
        usd_market_cap?: unknown;
        usd_24h_vol?: unknown;
        usd_24h_change?: unknown;
        last_updated_at?: unknown;
    }>>;
    /**
     * `/coins/markets` — same price/market-cap/volume/change as `/simple/price`
     * in one call per 250 ids, plus circulating/total/max supply and FDV.
     * CoinGecko omits some ids from this endpoint; callers fall back to
     * `fetchSimplePrice` for those.
     */
    fetchCoinsMarkets(coinIds: readonly string[]): Promise<CoingeckoCoinsMarketsRow[]>;
    fetchMarketChartRange(args: {
        coinId: string;
        from: number;
        to: number;
    }): Promise<CoingeckoMarketChartRange>;
}

export interface CoingeckoDepsResolved {
    coingeckoRepo: CoingeckoRepo;
    coingeckoCurated: CoingeckoCuratedSource;
    coingecko: CoingeckoClient;
    now: () => number;
}

function resolveCoingeckoDeps(deps: import('./crons').CronDeps): CoingeckoDepsResolved {
    if (!deps.coingeckoRepo || !deps.coingeckoCurated || !deps.coingecko) {
        throw new InvalidArgsError('coingecko deps not configured');
    }
    return {
        coingeckoRepo: deps.coingeckoRepo,
        coingeckoCurated: deps.coingeckoCurated,
        coingecko: deps.coingecko,
        now: deps.now,
    };
}

function sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

function asObject(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object') throw new InvalidArgsError('args must be an object');
    return raw as Record<string, unknown>;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined) return Math.min(max, Math.max(min, fallback));
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError('numeric arg must be a finite number');
    }
    return Math.min(max, Math.max(min, Math.floor(value)));
}

function readOptionalBoolean(value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new InvalidArgsError('boolean arg must be a boolean');
    return value;
}

function uniqueStrings(values: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function pickDeterministicBatch<T>(items: readonly T[], maxItems: number, windowMs: number, nowMs: number): T[] {
    if (items.length === 0) return [];
    const batchSize = Math.min(Math.max(maxItems, 1), items.length);
    const slot = Math.floor(nowMs / Math.max(windowMs, 1));
    const start = (slot * batchSize) % items.length;
    const out: T[] = [];
    for (let i = 0; i < batchSize; i++) out.push(items[(start + i) % items.length]!);
    return out;
}

function chunkArr<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function parseCoingeckoInterval(value: unknown): CoingeckoOhlcvInterval {
    if (typeof value !== 'string') {
        throw new InvalidArgsError('interval must be a string');
    }
    if (!(COINGECKO_OHLCV_INTERVALS as readonly string[]).includes(value)) {
        throw new InvalidArgsError(`interval must be one of: ${COINGECKO_OHLCV_INTERVALS.join(',')}`);
    }
    return value as CoingeckoOhlcvInterval;
}

function coingeckoIntervalToSeconds(interval: CoingeckoOhlcvInterval): number {
    switch (interval) {
        case '1m':
            return 60;
        case '5m':
            return 5 * 60;
        case '15m':
            return 15 * 60;
        case '1H':
            return 60 * 60;
        case '4H':
            return 4 * 60 * 60;
        case '1D':
            return 24 * 60 * 60;
        case '1W':
            return 7 * 24 * 60 * 60;
    }
}

function toFiniteNumberOrNull(value: unknown): number | null {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function sanitizePlatforms(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
        const key = asNonEmptyString(rawKey);
        if (!key) continue;
        const address = asNonEmptyString(rawValue);
        if (!address) continue;
        out[key] = address;
    }
    return out;
}

export function parseCoinListPayload(payload: unknown): CoingeckoCoinListItem[] {
    if (!Array.isArray(payload)) return [];
    const coins: CoingeckoCoinListItem[] = [];
    for (const item of payload) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const id = asNonEmptyString((item as { id?: unknown }).id);
        const symbol = asNonEmptyString((item as { symbol?: unknown }).symbol);
        const name = asNonEmptyString((item as { name?: unknown }).name);
        if (!id || !symbol || !name) continue;
        coins.push({
            id,
            symbol,
            name,
            platforms: sanitizePlatforms((item as { platforms?: unknown }).platforms),
        });
    }
    return coins;
}

interface RawTickerLike {
    base?: unknown;
    target?: unknown;
    market?: {
        name?: unknown;
        identifier?: unknown;
        logo?: unknown;
        has_trading_incentive?: unknown;
    };
    converted_last?: { usd?: unknown };
    converted_volume?: { usd?: unknown };
    bid_ask_spread_percentage?: unknown;
    trust_score?: unknown;
    is_anomaly?: unknown;
    is_stale?: unknown;
    trade_url?: unknown;
    timestamp?: unknown;
}

export function normalizeTickerRow(raw: unknown): CoingeckoTickerRow | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const ticker = raw as RawTickerLike;
    const base = asNonEmptyString(ticker.base);
    const target = asNonEmptyString(ticker.target);
    const marketName = asNonEmptyString(ticker.market?.name);
    if (!base || !target || !marketName) return null;

    const priceUsdRaw = ticker.converted_last?.usd;
    const volumeUsdRaw = ticker.converted_volume?.usd;
    const priceUsd = typeof priceUsdRaw === 'number' && Number.isFinite(priceUsdRaw) ? priceUsdRaw : null;
    const volume24hUsd = typeof volumeUsdRaw === 'number' && Number.isFinite(volumeUsdRaw) ? volumeUsdRaw : null;
    const spreadPercent =
        typeof ticker.bid_ask_spread_percentage === 'number' && Number.isFinite(ticker.bid_ask_spread_percentage)
            ? ticker.bid_ask_spread_percentage
            : null;
    const tradeUrl = asNonEmptyString(ticker.trade_url);
    const timestamp = asNonEmptyString(ticker.timestamp);

    const market: CoingeckoTickerMarket = {
        name: marketName,
        hasTradingIncentive: Boolean(ticker.market?.has_trading_incentive),
    };
    const identifier = asNonEmptyString(ticker.market?.identifier);
    if (identifier) market.identifier = identifier;
    const logo = asNonEmptyString(ticker.market?.logo);
    if (logo) market.logo = logo;

    return {
        base,
        target,
        market,
        priceUsd,
        volume24hUsd,
        spreadPercent,
        tradeUrl,
        trustScore: typeof ticker.trust_score === 'string' ? ticker.trust_score : null,
        isAnomaly: Boolean(ticker.is_anomaly),
        isStale: Boolean(ticker.is_stale),
        timestamp,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toStringOrNull(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string') return null;
    return value;
}

function sanitizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
}

function sanitizeStringRecordAllowEmptyValues(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {};
    const out: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
        const key = asNonEmptyString(rawKey);
        if (!key) continue;
        if (typeof rawValue !== 'string') continue;
        out[key] = rawValue;
    }
    return out;
}

/**
 * `detail_platforms`: per-platform `{ decimal_place, contract_address }`. Kept
 * because it is the only CoinGecko source of EVM token decimals; the v2 EVM
 * variant derivation reads it back from the stored coin jsonb. v1 never
 * forwards the stored coin verbatim (the detail route picks specific keys),
 * so storing one more key is wire-safe.
 */
export function sanitizeDetailPlatforms(value: unknown): Record<string, { decimal_place: number | null; contract_address: string }> {
    if (!isRecord(value)) return {};
    const out: Record<string, { decimal_place: number | null; contract_address: string }> = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
        const key = asNonEmptyString(rawKey);
        if (!key || !isRecord(rawValue)) continue;
        const contractAddress = typeof rawValue.contract_address === 'string' ? rawValue.contract_address : '';
        const decimalPlace =
            typeof rawValue.decimal_place === 'number' && Number.isFinite(rawValue.decimal_place)
                ? rawValue.decimal_place
                : null;
        out[key] = { decimal_place: decimalPlace, contract_address: contractAddress };
    }
    return out;
}

export function sanitizeCoinMetadata(value: unknown): { ok: true; coin: Record<string, unknown> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'CoinGecko coin response is not an object' };

    const id = asNonEmptyString(value.id);
    const symbol = asNonEmptyString(value.symbol);
    const name = asNonEmptyString(value.name);
    if (!id || !symbol || !name) return { ok: false, error: 'Missing id/symbol/name in CoinGecko response' };

    const coin: Record<string, unknown> = { id, symbol, name };

    if (typeof value.web_slug === 'string') coin.web_slug = value.web_slug;
    if (value.asset_platform_id === null || typeof value.asset_platform_id === 'string') {
        coin.asset_platform_id = value.asset_platform_id;
    }

    coin.platforms = sanitizeStringRecordAllowEmptyValues(value.platforms);
    coin.detail_platforms = sanitizeDetailPlatforms(value.detail_platforms);

    if (Array.isArray(value.categories)) coin.categories = sanitizeStringArray(value.categories);
    if (Array.isArray(value.additional_notices)) coin.additional_notices = sanitizeStringArray(value.additional_notices);

    coin.description = sanitizeStringRecordAllowEmptyValues(value.description);

    if (isRecord(value.image)) {
        const image: Record<string, string> = {};
        if (typeof value.image.thumb === 'string') image.thumb = value.image.thumb;
        if (typeof value.image.small === 'string') image.small = value.image.small;
        if (typeof value.image.large === 'string') image.large = value.image.large;
        coin.image = image;
    }

    if (value.genesis_date === null || typeof value.genesis_date === 'string') {
        coin.genesis_date = toStringOrNull(value.genesis_date);
    }
    if (value.last_updated === null || typeof value.last_updated === 'string') {
        coin.last_updated = toStringOrNull(value.last_updated);
    }

    if (isRecord(value.market_data)) {
        coin.market_data = value.market_data;
    }
    if (isRecord(value.links)) {
        coin.links = value.links;
    }
    if (isRecord(value.community_data)) {
        coin.community_data = value.community_data;
    }
    if (isRecord(value.developer_data)) {
        coin.developer_data = value.developer_data;
    }

    return { ok: true, coin };
}

function buildCandlesFromMarketChart(
    range: CoingeckoMarketChartRange,
    interval: CoingeckoOhlcvInterval,
): CoingeckoOhlcvCandle[] {
    const intervalSeconds = coingeckoIntervalToSeconds(interval);

    const volumeByBucket = new Map<number, { time: number; volume: number }>();
    for (const point of range.totalVolumes) {
        const time = Math.floor(point.time);
        const volume = point.value;
        if (!Number.isFinite(time) || !Number.isFinite(volume)) continue;
        const bucketStart = Math.floor(time / intervalSeconds) * intervalSeconds;
        const existing = volumeByBucket.get(bucketStart);
        if (!existing || time >= existing.time) {
            volumeByBucket.set(bucketStart, { time, volume });
        }
    }

    type Agg = { open: number; high: number; low: number; close: number; lastTime: number };
    const byBucket = new Map<number, Agg>();
    for (const point of range.prices) {
        const time = Math.floor(point.time);
        const price = point.value;
        if (!Number.isFinite(time) || !Number.isFinite(price)) continue;
        const bucketStart = Math.floor(time / intervalSeconds) * intervalSeconds;
        const current = byBucket.get(bucketStart);
        if (!current) {
            byBucket.set(bucketStart, { open: price, high: price, low: price, close: price, lastTime: time });
            continue;
        }
        current.high = Math.max(current.high, price);
        current.low = Math.min(current.low, price);
        if (time >= current.lastTime) {
            current.close = price;
            current.lastTime = time;
        }
    }

    return Array.from(byBucket.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([time, agg]) => ({
            time,
            open: agg.open,
            high: agg.high,
            low: agg.low,
            close: agg.close,
            volume: volumeByBucket.get(time)?.volume ?? 0,
        }));
}

export async function syncCoingeckoCoinList(rawDeps: import('./crons').CronDeps, rawArgs: unknown): Promise<CronResult> {
    const deps = resolveCoingeckoDeps(rawDeps);
    const args = asObject(rawArgs);
    const batchSize = clampInt(args.batchSize, 100, 25, 1000);

    const start = deps.now();
    const coins = await deps.coingecko.fetchCoinList();
    const syncedAt = start;

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let failedBatches = 0;
    let failedCoins = 0;

    if (coins.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            inserted,
            updated,
            skipped,
            failedBatches,
            failedCoins,
            total: 0,
        };
    }

    for (const batch of chunkArr(coins, batchSize)) {
        const upserts: CoingeckoCoinUpsert[] = batch.map(c => ({
            id: c.id,
            symbol: c.symbol,
            name: c.name,
            platforms: c.platforms,
            syncedAt,
        }));
        try {
            const result = await deps.coingeckoRepo.upsertCoinListBatch(upserts);
            inserted += result.inserted;
            updated += result.updated;
            skipped += result.skipped;
        } catch (err) {
            failedBatches += 1;
            console.error(
                '[syncCoingeckoCoinList] batch failed, retrying per-coin',
                err instanceof Error ? err.message : String(err),
            );
            // A whole-batch failure would leave every row in this batch with a
            // stale last_synced_at, which the freshness filter (see
            // filterKnownCoinIds / COIN_LIST_FRESHNESS_WINDOW_MS) later misreads
            // as a delisting and drops from every refresh family. Fall back to
            // per-coin upserts so a single bad row can't strand the rest.
            for (const upsert of upserts) {
                try {
                    const result = await deps.coingeckoRepo.upsertCoinListBatch([upsert]);
                    inserted += result.inserted;
                    updated += result.updated;
                    skipped += result.skipped;
                } catch (perCoinErr) {
                    failedCoins += 1;
                    console.error(
                        `[syncCoingeckoCoinList] coin upsert failed id=${upsert.id}`,
                        perCoinErr instanceof Error ? perCoinErr.message : String(perCoinErr),
                    );
                }
            }
        }
    }

    return {
        ok: true,
        processed: coins.length,
        durationMs: deps.now() - start,
        inserted,
        updated,
        skipped,
        failedBatches,
        failedCoins,
        total: coins.length,
    };
}

export async function refreshCuratedCoingeckoMetadata(
    rawDeps: import('./crons').CronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const deps = resolveCoingeckoDeps(rawDeps);
    const args = asObject(rawArgs);
    const maxCoins = clampInt(args.maxCoins, 25, 1, 250);
    const minAgeMs = clampInt(args.minAgeMs, 24 * 60 * 60 * 1000, 0, 30 * 24 * 60 * 60 * 1000);
    const concurrency = clampInt(args.concurrency, 2, 1, 5);
    const delayMs = clampInt(args.delayMs, 250, 0, 5_000);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 6 * 60 * 60_000, 10_000, 24 * 60 * 60_000);
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);
    const localization = readOptionalBoolean(args.localization, false);
    const marketData = readOptionalBoolean(args.marketData, true);
    const explicitCoinIds = parseExplicitTargets(args.coinIds, 'coinIds');

    const start = deps.now();
    const coinIds = explicitCoinIds
        ? explicitCoinIds
        : await dropUnknownCoinIds(
              deps.coingeckoRepo,
              pickDeterministicBatch(deps.coingeckoCurated.getCuratedCoinIdsInOrder(), maxCoins, selectionWindowMs, start),
              'refreshCuratedCoingeckoMetadata',
              start,
          );

    let refreshed = 0;
    let skipped = 0;
    let softFailed = 0;

    if (coinIds.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.now() - start, refreshed, skipped, failed: 0 };
    }

    const params: Record<string, string> = {
        localization: String(localization),
        tickers: 'false',
        market_data: String(marketData),
        community_data: 'false',
        developer_data: 'false',
        sparkline: 'false',
        include_categories_details: 'false',
    };

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'refreshCuratedCoingeckoMetadata',
            items: coinIds,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: coinId =>
                Effect.tryPromise(async () => {
                    const lastFetched = await deps.coingeckoRepo.getCoinMetadataLastFetchedAt(coinId);
                    if (minAgeMs > 0 && lastFetched !== null && start - lastFetched < minAgeMs) {
                        skipped += 1;
                        return;
                    }
                    const raw = await deps.coingecko.fetchCoinById(coinId, params);
                    const parsed = sanitizeCoinMetadata(raw);
                    if (!parsed.ok) {
                        softFailed += 1;
                        console.error(`[refreshCuratedCoingeckoMetadata] ${coinId}: ${parsed.error}`);
                        return;
                    }
                    await deps.coingeckoRepo.upsertCoinMetadata({ id: coinId, coin: parsed.coin, fetchedAt: start });
                    refreshed += 1;
                }),
        }),
    );

    const failed = softFailed + summary.failed;
    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && skipped === 0 && failed >= summary.attempted),
        processed: coinIds.length,
        durationMs: deps.now() - start,
        refreshed,
        skipped,
        failed,
        ...(summary.partial ? { partial: true } : {}),
    };
}

export async function refreshCuratedCoingeckoTickers(
    rawDeps: import('./crons').CronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const deps = resolveCoingeckoDeps(rawDeps);
    const args = asObject(rawArgs);
    const maxCoins = clampInt(args.maxCoins, 15, 1, 250);
    const minAgeMs = clampInt(args.minAgeMs, 6 * 60 * 60 * 1000, 0, 7 * 24 * 60 * 60 * 1000);
    const concurrency = clampInt(args.concurrency, 2, 1, 5);
    const delayMs = clampInt(args.delayMs, 250, 0, 5_000);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 6 * 60 * 60_000, 10_000, 24 * 60 * 60_000);
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);
    const maxTickers = clampInt(args.maxTickers, 200, 1, 250);
    const explicitCoinIds = parseExplicitTargets(args.coinIds, 'coinIds');

    const start = deps.now();
    const coinIds = explicitCoinIds
        ? explicitCoinIds
        : await dropUnknownCoinIds(
              deps.coingeckoRepo,
              pickDeterministicBatch(deps.coingeckoCurated.getCuratedCoinIdsInOrder(), maxCoins, selectionWindowMs, start),
              'refreshCuratedCoingeckoTickers',
              start,
          );

    let refreshed = 0;
    let skipped = 0;

    if (coinIds.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.now() - start, refreshed, skipped, failed: 0 };
    }

    const TICKERS_PAGE_SIZE = 100;
    const pagesNeeded = Math.max(1, Math.ceil(maxTickers / TICKERS_PAGE_SIZE));
    const pagesToFetch = Math.min(pagesNeeded + 1, 3);

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'refreshCuratedCoingeckoTickers',
            items: coinIds,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: coinId =>
                Effect.tryPromise(async () => {
                const lastFetched = await deps.coingeckoRepo.getTickersLastFetchedAt(coinId);
                if (minAgeMs > 0 && lastFetched !== null && start - lastFetched < minAgeMs) {
                    return void (skipped += 1);
                }
                const pageResults = await Promise.all(
                    Array.from({ length: pagesToFetch }, (_, i) => i + 1).map(page =>
                        deps.coingecko.fetchCoinTickersPage({ coinId, page, order: 'volume_desc' }),
                    ),
                );
                const name = pageResults.find(r => typeof r.name === 'string')?.name;
                const total = pageResults.find(r => typeof r.total === 'number')?.total;
                const rawTickers = pageResults.flatMap(r => (Array.isArray(r.tickers) ? r.tickers : []));
                const rows = rawTickers
                    .map(normalizeTickerRow)
                    .filter((row): row is CoingeckoTickerRow => row !== null);

                const upsert: CoingeckoTickersUpsert = {
                    coinId,
                    tickers: rows.slice(0, maxTickers),
                    lastFetchedAt: start,
                };
                if (name) upsert.name = name;
                if (typeof total === 'number') upsert.total = total;

                await deps.coingeckoRepo.upsertTickersLatest(upsert);
                refreshed += 1;
                }),
            onItemError: coinId =>
                Effect.tryPromise(() => deps.coingeckoRepo.touchTickersLatest(coinId, start)),
        }),
    );

    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && skipped === 0 && summary.failed >= summary.attempted),
        processed: coinIds.length,
        durationMs: deps.now() - start,
        refreshed,
        skipped,
        failed: summary.failed,
        ...(summary.partial ? { partial: true } : {}),
    };
}

/** ISO-8601 `last_updated` → unix seconds, matching `/simple/price`'s `last_updated_at`. */
function isoToUnixSeconds(value: unknown): number | null {
    if (typeof value !== 'string' || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function coinsMarketsRowToUpsert(
    coinId: string,
    row: CoingeckoCoinsMarketsRow,
    lastFetchedAt: number,
): CoingeckoPriceUpsert {
    return {
        coinId,
        priceUsd: toFiniteNumberOrNull(row.current_price ?? null),
        marketCapUsd: toFiniteNumberOrNull(row.market_cap ?? null),
        volume24hUsd: toFiniteNumberOrNull(row.total_volume ?? null),
        priceChange24hPercent: toFiniteNumberOrNull(row.price_change_percentage_24h ?? null),
        providerLastUpdatedAt: isoToUnixSeconds(row.last_updated),
        lastFetchedAt,
        circulatingSupply: toFiniteNumberOrNull(row.circulating_supply ?? null),
        totalSupply: toFiniteNumberOrNull(row.total_supply ?? null),
        maxSupply: toFiniteNumberOrNull(row.max_supply ?? null),
        fdvUsd: toFiniteNumberOrNull(row.fully_diluted_valuation ?? null),
    };
}

export async function refreshCuratedCoingeckoPrices(
    rawDeps: import('./crons').CronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const deps = resolveCoingeckoDeps(rawDeps);
    const args = asObject(rawArgs);
    const maxCoins = clampInt(args.maxCoins, 250, 1, 500);
    const minAgeMs = clampInt(args.minAgeMs, 0, 0, 24 * 60 * 60_000);
    const chunkSize = clampInt(args.chunkSize, 200, 1, 250);
    const delayMs = clampInt(args.delayMs, 150, 0, 5_000);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 5 * 60_000, 10_000, 24 * 60 * 60_000);
    const explicitCoinIds = parseExplicitTargets(args.coinIds, 'coinIds');

    const start = deps.now();
    const selected = explicitCoinIds
        ? explicitCoinIds
        : await dropUnknownCoinIds(
              deps.coingeckoRepo,
              uniqueStrings(
                  pickDeterministicBatch(deps.coingeckoCurated.getPriceCoinIdsInOrder(), maxCoins, selectionWindowMs, start),
              ),
              'refreshCuratedCoingeckoPrices',
              start,
          );

    if (selected.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.now() - start, refreshed: 0, skipped: 0, failed: 0 };
    }

    let refreshed = 0;
    let skipped = 0;
    let failed = 0;

    const lastFetchedByCoin = await deps.coingeckoRepo.listPriceLastFetchedAtByCoinIds(selected);
    const stale: string[] = [];
    for (const coinId of selected) {
        const last = lastFetchedByCoin.get(coinId) ?? null;
        if (minAgeMs > 0 && last !== null && start - last < minAgeMs) {
            skipped += 1;
        } else {
            stale.push(coinId);
        }
    }

    if (stale.length === 0) {
        return { ok: true, processed: selected.length, durationMs: deps.now() - start, refreshed, skipped, failed };
    }

    const chunks = chunkArr(stale, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(delayMs);
        const chunk = chunks[i] ?? [];

        // `/coins/markets` carries supply + FDV; `/simple/price` is the fallback
        // for ids it omits (and for the whole chunk if it fails outright).
        const marketsById = new Map<string, CoingeckoCoinsMarketsRow>();
        let marketsFailed = false;
        try {
            for (const row of await deps.coingecko.fetchCoinsMarkets(chunk)) marketsById.set(row.id, row);
        } catch (err) {
            marketsFailed = true;
            console.error(
                '[refreshCuratedCoingeckoPrices] coins/markets chunk failed',
                err instanceof Error ? err.message : String(err),
            );
        }

        const missing = chunk.filter(coinId => !marketsById.has(coinId));
        let simple: Awaited<ReturnType<CoingeckoClient['fetchSimplePrice']>> = {};
        let simpleFailed = false;
        if (missing.length > 0) {
            try {
                simple = await deps.coingecko.fetchSimplePrice(missing);
            } catch (err) {
                simpleFailed = true;
                console.error(
                    '[refreshCuratedCoingeckoPrices] simple/price chunk failed',
                    err instanceof Error ? err.message : String(err),
                );
            }
        }

        if (marketsFailed && simpleFailed) {
            failed += chunk.length;
            continue;
        }

        for (const coinId of chunk) {
            const market = marketsById.get(coinId) ?? null;
            if (!market && simpleFailed) {
                // Neither response covered this id; don't blank out the stored row.
                failed += 1;
                continue;
            }
            const row = market ? null : (simple[coinId] ?? null);
            try {
                await deps.coingeckoRepo.upsertPriceLatest(
                    market
                        ? coinsMarketsRowToUpsert(coinId, market, start)
                        : {
                              coinId,
                              priceUsd: toFiniteNumberOrNull(row?.usd ?? null),
                              marketCapUsd: toFiniteNumberOrNull(row?.usd_market_cap ?? null),
                              volume24hUsd: toFiniteNumberOrNull(row?.usd_24h_vol ?? null),
                              priceChange24hPercent: toFiniteNumberOrNull(row?.usd_24h_change ?? null),
                              providerLastUpdatedAt: toFiniteNumberOrNull(row?.last_updated_at ?? null),
                              lastFetchedAt: start,
                          },
                );
                refreshed += 1;
            } catch (err) {
                failed += 1;
                console.error(
                    `[refreshCuratedCoingeckoPrices] upsert ${coinId}`,
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
    }

    return {
        ok: !(stale.length > 0 && refreshed === 0 && failed >= stale.length),
        processed: selected.length,
        durationMs: deps.now() - start,
        refreshed,
        skipped,
        failed,
    };
}

export async function refreshCuratedCoingeckoOhlcv(
    rawDeps: import('./crons').CronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const deps = resolveCoingeckoDeps(rawDeps);
    const args = asObject(rawArgs);
    const interval = parseCoingeckoInterval(args.interval);
    const days = clampInt(args.days, 90, 1, 3650);
    const maxCoins = clampInt(args.maxCoins, 50, 1, 250);
    const priorityCount = clampInt(args.priorityCount, 0, 0, 250);
    const concurrency = clampInt(args.concurrency, 2, 1, 5);
    const delayMs = clampInt(args.delayMs, 250, 0, 5_000);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 60_000, 10_000, 24 * 60 * 60_000);
    const upsertChunkSize = clampInt(args.upsertChunkSize, 500, 50, 2_000);
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);
    const explicitCoinIds = parseExplicitTargets(args.coinIds, 'coinIds');

    const start = deps.now();
    let coinIds: string[];
    if (explicitCoinIds) {
        coinIds = explicitCoinIds;
    } else {
        const allCoinIds = await dropUnknownCoinIds(
            deps.coingeckoRepo,
            deps.coingeckoCurated.getCuratedCoinIdsInOrder(),
            'refreshCuratedCoingeckoOhlcv',
            start,
        );

        const effectivePriority = Math.min(priorityCount, maxCoins);
        const priority = allCoinIds.slice(0, effectivePriority);
        const remainder = allCoinIds.slice(effectivePriority);
        const rotatingCount = Math.max(0, maxCoins - priority.length);
        const rotating =
            rotatingCount > 0 ? pickDeterministicBatch(remainder, rotatingCount, selectionWindowMs, start) : [];
        coinIds = uniqueStrings([...priority, ...rotating]).slice(0, maxCoins);
    }

    let refreshed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    if (coinIds.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            interval,
            refreshed,
            failed: 0,
            inserted,
            updated,
            skipped,
        };
    }

    const intervalSeconds = coingeckoIntervalToSeconds(interval);
    const requestedFrom = Math.floor(start / 1000) - days * 24 * 60 * 60;
    const requestedTo = Math.floor(start / 1000);

    const summary = await Effect.runPromise(
        runJobPool({
            label: `refreshCuratedCoingeckoOhlcv:${interval}`,
            items: coinIds,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: coinId =>
                Effect.tryPromise(async () => {
                const bounds = await deps.coingeckoRepo.getOhlcvBounds(coinId, interval);
                const segments: Array<{ from: number; to: number }> = [];
                if (bounds.minTime === null || bounds.maxTime === null) {
                    segments.push({ from: requestedFrom, to: requestedTo });
                } else {
                    if (bounds.minTime > requestedFrom + intervalSeconds) {
                        segments.push({ from: requestedFrom, to: bounds.minTime });
                    }
                    if (bounds.maxTime < requestedTo - intervalSeconds) {
                        segments.push({ from: bounds.maxTime, to: requestedTo });
                    }
                }
                if (segments.length === 0) {
                    skipped += 1;
                    return;
                }
                for (const segment of segments) {
                    const range = await deps.coingecko.fetchMarketChartRange({
                        coinId,
                        from: segment.from,
                        to: segment.to,
                    });
                    const candles = buildCandlesFromMarketChart(range, interval);
                    for (const candlesChunk of chunkArr(candles, upsertChunkSize)) {
                        const result = await deps.coingeckoRepo.upsertOhlcvCandles(coinId, interval, candlesChunk);
                        inserted += result.inserted;
                        updated += result.updated;
                        skipped += result.skipped;
                    }
                }
                refreshed += 1;
                }),
        }),
    );

    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && skipped === 0 && summary.failed >= summary.attempted),
        processed: coinIds.length,
        durationMs: deps.now() - start,
        interval,
        refreshed,
        failed: summary.failed,
        inserted,
        updated,
        skipped,
        ...(summary.partial ? { partial: true } : {}),
    };
}

// ---------------------------------------------------------------------------
// validate-coingecko-ids
// ---------------------------------------------------------------------------

export const VALIDATE_COINGECKO_IDS_JOB = 'validate-coingecko-ids';
export const COINGECKO_ID_VALIDATION_EVENT = 'coingecko_id_validation';

/**
 * Which issuer's coin an asset links to when its mints map to several: the
 * owner's choice is xStock first, then Ondo, Backpack, bStocks, anything else.
 * Lower is better.
 */
export function rankCoinIdCandidate(coinId: string): number {
    if (/-xstock$/.test(coinId)) return 0;
    if (/-ondo-tokenized-stock$/.test(coinId)) return 1;
    if (/-backpack-securities$/.test(coinId)) return 2;
    if (/-bstock/.test(coinId)) return 3;
    return 4;
}

export function pickCoinIdCandidate(
    candidates: ReadonlyArray<{ coinId: string; mint: string; liquidity: number | null }>,
): { coinId: string; mint: string; liquidity: number | null } | null {
    if (candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => {
        const rank = rankCoinIdCandidate(a.coinId) - rankCoinIdCandidate(b.coinId);
        if (rank !== 0) return rank;
        const liquidity = (b.liquidity ?? -1) - (a.liquidity ?? -1);
        if (liquidity !== 0) return liquidity;
        return a.coinId.localeCompare(b.coinId);
    });
    return sorted[0] ?? null;
}

const SUSPECT_CATEGORIES: ReadonlySet<string> = new Set(['equity', 'etf']);

/**
 * `assets.coingecko_id` was never validated against CoinGecko: the registry
 * used to generate `${slug}-xstock` by convention and a third of those ids do
 * not exist. Weekly, after the coin-list sync: check every active asset's id
 * against `coingecko_coins`; for a missing or unknown id, resolve a coin by the
 * asset's Solana mints (`platforms.solana`), preferring xStock > Ondo >
 * Backpack > bStocks, tie-broken by liquidity; write it (and the coingeckoId
 * alias) unless the asset was ever admin-edited; never null an id; flag an
 * equity whose coin's Solana contract is not one of its mints as `suspect`
 * (a `chewy` meme coin under the Chewy equity). Everything lands in
 * `asset_coingecko_id_audit` for the admin app.
 */
export async function validateCoingeckoIds(rawDeps: import('./crons').CronDeps, rawArgs: unknown): Promise<CronResult> {
    const deps = resolveCoingeckoDeps(rawDeps);
    const args = asObject(rawArgs);
    const write = readOptionalBoolean(args.write, true);
    const maxAssets = clampInt(args.maxAssets, 5_000, 1, 50_000);
    const start = deps.now();

    const assets = await deps.coingeckoRepo.listAssetsForCoinIdValidation(maxAssets);
    const normalizedById = new Map<string, string | null>();
    for (const asset of assets) {
        normalizedById.set(asset.assetId, normalizeCoinGeckoCoinIdForAsset({ assetId: asset.assetId, coinId: asset.coingeckoId }));
    }
    const known = await deps.coingeckoRepo.findKnownCoins(
        uniqueStrings(Array.from(normalizedById.values()).flatMap(id => (id ? [id] : []))),
    );
    const mints = uniqueStrings(assets.flatMap(a => a.solanaMints.map(m => m.mint)));
    const coinsByMint = new Map<string, Array<{ coinId: string; lastSyncedAt: number | null }>>();
    for (const row of mints.length > 0 ? await deps.coingeckoRepo.findCoinsBySolanaMints(mints) : []) {
        const list = coinsByMint.get(row.mint) ?? [];
        list.push({ coinId: row.coinId, lastSyncedAt: row.lastSyncedAt });
        coinsByMint.set(row.mint, list);
    }

    const counts: Record<CoinIdAuditStatus, number> = { ok: 0, suspect: 0, repaired: 0, assigned: 0, needsAdmin: 0, unresolved: 0 };
    const audit: CoinIdAuditRow[] = [];
    let writeFailed = 0;
    for (const asset of assets) {
        const raw = (asset.coingeckoId ?? '').trim();
        const normalized = normalizedById.get(asset.assetId) ?? null;
        const mintSet = new Set(asset.solanaMints.map(m => m.mint));
        const candidates = asset.solanaMints.flatMap(m =>
            (coinsByMint.get(m.mint) ?? []).map(c => ({ coinId: c.coinId, mint: m.mint, liquidity: m.liquidity })),
        );
        const record = (status: CoinIdAuditStatus, suggestedId: string | null, note: string | null) => {
            counts[status] += 1;
            audit.push({ assetId: asset.assetId, status, currentId: raw || null, suggestedId, candidates, note, checkedAt: start });
        };

        if (raw && normalized === null) {
            // The remap deliberately suppresses this id (spacex ← PreStocks listing).
            record('ok', null, 'suppressed by normalizeCoinGeckoCoinIdForAsset');
            continue;
        }
        const coin = normalized ? known.get(normalized) : undefined;
        if (normalized && coin) {
            if (
                SUSPECT_CATEGORIES.has(asset.category) &&
                coin.solanaMint !== null &&
                mintSet.size > 0 &&
                !mintSet.has(coin.solanaMint)
            ) {
                const alt = pickCoinIdCandidate(candidates);
                record('suspect', alt?.coinId ?? null, `coin lists Solana contract ${coin.solanaMint}, not one of the asset's mints`);
                continue;
            }
            if (normalized !== raw && asset.adminEditedAt === null && write) {
                // The stored value needs the remap (bnb → binancecoin): persist the real id.
                try {
                    const ok = await deps.coingeckoRepo.repairAssetCoinId({ assetId: asset.assetId, coinId: normalized, nowMs: start });
                    record(ok ? 'repaired' : 'needsAdmin', normalized, 'normalized id persisted');
                } catch (err) {
                    writeFailed += 1;
                    record('needsAdmin', normalized, `write failed: ${err instanceof Error ? err.message : String(err)}`);
                }
                continue;
            }
            record('ok', null, null);
            continue;
        }

        // Missing or unknown id: resolve by mint.
        const best = pickCoinIdCandidate(candidates);
        if (!best) {
            record('unresolved', null, raw ? 'id unknown to CoinGecko and no mint maps to a coin' : 'no id and no mint maps to a coin');
            continue;
        }
        if (asset.adminEditedAt !== null) {
            record('needsAdmin', best.coinId, 'asset was admin-edited; not written automatically');
            continue;
        }
        if (!write) {
            record('needsAdmin', best.coinId, 'write disabled');
            continue;
        }
        try {
            const ok = await deps.coingeckoRepo.repairAssetCoinId({ assetId: asset.assetId, coinId: best.coinId, nowMs: start });
            if (!ok) record('needsAdmin', best.coinId, 'asset was admin-edited concurrently');
            else record(raw ? 'repaired' : 'assigned', best.coinId, `resolved by mint ${best.mint}`);
        } catch (err) {
            writeFailed += 1;
            record('needsAdmin', best.coinId, `write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    let auditWritten = 0;
    try {
        for (const chunk of chunkArr(audit, 200)) {
            await deps.coingeckoRepo.upsertCoinIdAudit(chunk);
            auditWritten += chunk.length;
        }
    } catch (err) {
        console.error('[validate-coingecko-ids] audit upsert failed', err instanceof Error ? err.message : String(err));
    }

    const durationMs = deps.now() - start;
    console.log(
        JSON.stringify({
            job: VALIDATE_COINGECKO_IDS_JOB,
            event: COINGECKO_ID_VALIDATION_EVENT,
            ok: writeFailed === 0,
            write,
            assets: assets.length,
            statuses: counts,
            writeFailed,
            auditWritten,
            duration_ms: durationMs,
        }),
    );
    return {
        ok: writeFailed === 0,
        processed: assets.length,
        durationMs,
        write,
        statuses: counts,
        writeFailed,
        auditWritten,
        ...(writeFailed > 0 ? { partial: true, reason: 'writes_failed' } : {}),
    };
}

type CoingeckoJobHandler = (rawDeps: import('./crons').CronDeps, args: unknown) => Promise<CronResult>;

export const coingeckoJobs: Record<string, CoingeckoJobHandler> = {
    'sync-coingecko-coin-list': syncCoingeckoCoinList,
    'refresh-curated-coingecko-metadata': refreshCuratedCoingeckoMetadata,
    'refresh-curated-coingecko-tickers': refreshCuratedCoingeckoTickers,
    'refresh-curated-coingecko-prices': refreshCuratedCoingeckoPrices,
    'validate-coingecko-ids': validateCoingeckoIds,
    'refresh-curated-coingecko-ohlcv-15m': refreshCuratedCoingeckoOhlcv,
    'refresh-curated-coingecko-ohlcv-1h': refreshCuratedCoingeckoOhlcv,
    'refresh-curated-coingecko-ohlcv-4h': refreshCuratedCoingeckoOhlcv,
    'refresh-curated-coingecko-ohlcv-1d': refreshCuratedCoingeckoOhlcv,
    'refresh-curated-coingecko-ohlcv-1w': refreshCuratedCoingeckoOhlcv,
};

export const __testing = {
    parseCoinListPayload,
    normalizeTickerRow,
    sanitizeCoinMetadata,
    buildCandlesFromMarketChart,
    pickDeterministicBatch,
    parseCoingeckoInterval,
    coingeckoIntervalToSeconds,
};
