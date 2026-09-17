import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { runJobPool } from '@tokens/effect/job-runner';

import type { CronDeps, CronResult } from './crons';
import { InvalidArgsError, birdeyeOverviewToUpsert } from './crons';
import { birdeyeOverviewToTokenUpsert, type TokenUpsertFromBirdeye } from './crons.misc';

// Launchpad coins (stonk.fun first). Every stonk.fun coin is launched against a
// *quote token* other than SOL; when that quote token is one we curate, the coin
// is surfaced on the quote asset's page. The coin's own tokens.xyz page is the
// existing singleton-asset path (`solana-<mint>`), which reads identity from
// `tokens` and the market snapshot from `variant_markets_latest` — so a
// launchpad row is only activated once both rows exist (see migration 0021).

export const STONKFUN_LAUNCHPAD = 'stonkfun' as const;
/** Image/logo paths in the payload are often site-relative (`/api/asset/...`). */
export const STONKFUN_ORIGIN = 'https://www.stonkfun.xyz';

export interface StonkfunTokenMarket {
    priceUsd: number | null;
    marketCapUsd: number | null;
    fdvUsd: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    priceChange24h: number | null;
}

export interface StonkfunToken {
    mint: string;
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    pool: string | null;
    status: string | null;
    mode: string | null;
    creator: string | null;
    launchpad: string | null;
    quoteMint: string;
    quoteSymbol: string | null;
    market: StonkfunTokenMarket;
    createdAt: number | null;
    graduatedAt: number | null;
    links: Record<string, string>;
    raw: unknown;
}

/** One launchable quote token from `GET /pairs`. */
export interface StonkfunPair {
    mint: string;
    symbol: string | null;
    name: string | null;
    category: string | null;
    logoUrl: string | null;
    launchable: boolean;
}

export type StonkfunPairsResult =
    | { ok: true; pairs: StonkfunPair[] }
    | { ok: false; reason: 'error'; message?: string }
    | { ok: false; reason: 'http_error'; status: number }
    | { ok: false; reason: 'invalid_payload' };

export type StonkfunFetchResult =
    | { ok: true; items: StonkfunToken[] }
    | { ok: false; reason: 'error'; message?: string }
    | { ok: false; reason: 'http_error'; status: number }
    | { ok: false; reason: 'invalid_payload' };

export interface StonkfunClient {
    fetchGraduatedTokens(opts: { maxPages: number }): Promise<StonkfunFetchResult>;
    /** Every graduated coin quoted in `quoteMint` (admin browse; includes sub-threshold coins). */
    fetchGraduatedTokensByQuote(quoteMint: string, opts: { maxPages: number }): Promise<StonkfunFetchResult>;
    /** One coin by mint; `{ ok: true, items: [] }` when stonk.fun does not know it. */
    fetchToken(mint: string): Promise<StonkfunFetchResult>;
    /** Launchable quote tokens (`GET /pairs?launchable=true`). */
    fetchPairs(): Promise<StonkfunPairsResult>;
}

export interface LaunchpadTokenUpsert {
    launchpad: string;
    mint: string;
    quoteMint: string;
    quoteSymbol?: string;
    symbol?: string;
    name?: string;
    logoURI?: string;
    pool?: string;
    status?: string;
    mode?: string;
    creator?: string;
    priceUsd?: number;
    marketCapUsd?: number;
    fdvUsd?: number;
    liquidityUsd?: number;
    volume24hUsd?: number;
    priceChange24h?: number;
    launchedAt?: number;
    graduatedAt?: number;
    linksJson?: string;
    sourceRank: number;
    rawJson: string;
    isActive: boolean;
    lastSeenAt: number;
    lastSyncedAt: number;
}

export interface LaunchpadJobsRepo {
    listActiveLaunchpadCount(launchpad: string): Promise<number>;
    /** Admin-approved mints (`launchpad_mint_approvals`); always selected when the provider returns them. */
    listApprovedMints(launchpad: string): Promise<string[]>;
    /** Admin lookups: sync state per mint, one approval, and the canonical asset owning a quote mint. */
    listSyncedStates(launchpad: string, mints: readonly string[]): Promise<Map<string, { isActive: boolean }>>;
    findApproval(launchpad: string, mint: string): Promise<{ note: string | null; approvedAt: number } | null>;
    findQuoteAssetByMint(
        mint: string,
    ): Promise<{ assetId: string; symbol: string | null; name: string | null; imageUrl: string | null } | null>;
    upsertLaunchpadTokenLatest(args: LaunchpadTokenUpsert): Promise<void>;
    deactivateMissingLaunchpadTokens(
        launchpad: string,
        activeMints: readonly string[],
        lastSyncedAt: number,
    ): Promise<number>;
    /** Mints that already have a `tokens` (identity) row. */
    filterMintsKnownTokens(mints: readonly string[]): Promise<string[]>;
    /** Mints that already have a `variant_markets_latest` row. */
    filterMintsWithVariantMarket(mints: readonly string[]): Promise<string[]>;
    upsertTokenFromBirdeye(args: TokenUpsertFromBirdeye): Promise<void>;
}

export interface LaunchpadCronDeps {
    base: CronDeps;
    repo: LaunchpadJobsRepo;
    stonkfun: StonkfunClient;
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

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function asEpochMsOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value < 1_000_000_000_000 ? Math.floor(value * 1000) : Math.floor(value);
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function absolutizeStonkfunUrl(value: string | null): string | null {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('//')) return `https:${value}`;
    if (value.startsWith('/')) return `${STONKFUN_ORIGIN}${value}`;
    return null;
}

/** Normalizes one `GET /tokens` item; returns null when mint/quote are unusable. */
export function parseStonkfunToken(raw: unknown): StonkfunToken | null {
    if (!isRecord(raw)) return null;
    const mint = asNonEmptyString(raw.mint);
    if (!mint || !looksLikeSolanaMintAddress(mint)) return null;
    const quote = isRecord(raw.quote) ? raw.quote : null;
    const quoteMint = asNonEmptyString(quote?.mint);
    if (!quoteMint || !looksLikeSolanaMintAddress(quoteMint)) return null;

    const market = isRecord(raw.market) ? raw.market : {};
    const links: Record<string, string> = {};
    if (isRecord(raw.links)) {
        for (const [key, value] of Object.entries(raw.links)) {
            const url = asNonEmptyString(value);
            if (url) links[key] = url;
        }
    }

    return {
        mint,
        symbol: asNonEmptyString(raw.symbol),
        name: asNonEmptyString(raw.name),
        imageUrl: absolutizeStonkfunUrl(asNonEmptyString(raw.imageUrl)),
        pool: asNonEmptyString(raw.pool),
        status: asNonEmptyString(raw.status),
        mode: asNonEmptyString(raw.mode),
        creator: asNonEmptyString(raw.creator),
        launchpad: asNonEmptyString(raw.launchpad),
        quoteMint,
        quoteSymbol: asNonEmptyString(quote?.symbol),
        market: {
            priceUsd: asFiniteNumberOrNull(market.priceUsd),
            marketCapUsd: asFiniteNumberOrNull(market.marketCapUsd),
            fdvUsd: asFiniteNumberOrNull(market.fdvUsd),
            liquidityUsd: asFiniteNumberOrNull(market.liquidityUsd),
            volume24hUsd: asFiniteNumberOrNull(market.volume24hUsd),
            priceChange24h: asFiniteNumberOrNull(market.priceChange24h),
        },
        createdAt: asEpochMsOrNull(raw.createdAt),
        graduatedAt: asEpochMsOrNull(raw.graduatedAt),
        links,
        raw,
    };
}

/** Parses `GET /api/public/v1/pairs` (`{ data: { pairs: [...] } }`). */
export function parseStonkfunPairsPayload(payload: unknown): StonkfunPair[] | null {
    if (!isRecord(payload)) return null;
    const data = payload.data;
    const raws = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.pairs) ? data.pairs : null;
    if (!raws) return null;
    const out: StonkfunPair[] = [];
    for (const raw of raws) {
        if (!isRecord(raw)) continue;
        const mint = asNonEmptyString(raw.mint);
        if (!mint || !looksLikeSolanaMintAddress(mint)) continue;
        out.push({
            mint,
            symbol: asNonEmptyString(raw.symbol),
            name: asNonEmptyString(raw.name),
            category: asNonEmptyString(raw.category),
            logoUrl: absolutizeStonkfunUrl(asNonEmptyString(raw.logoUrl)),
            launchable: raw.launchable !== false,
        });
    }
    return out;
}

/**
 * Parses one page of `GET /api/public/v1/tokens`. The live envelope is
 * `{ data: { tokens: [...], pagination: { page, pageSize, total, totalPages } }, meta }`;
 * a bare `data: [...]` array is accepted too. Returns null for anything else so
 * the client aborts the whole run instead of syncing a truncated list.
 */
export function parseStonkfunTokensPayload(
    payload: unknown,
): { items: StonkfunToken[]; totalPages: number | null } | null {
    if (!isRecord(payload)) return null;
    const data = payload.data;
    let raws: unknown[];
    let pagination: Record<string, unknown> | null = null;
    if (Array.isArray(data)) {
        raws = data;
        pagination = isRecord(payload.meta) ? payload.meta : null;
    } else if (isRecord(data) && Array.isArray(data.tokens)) {
        raws = data.tokens;
        pagination = isRecord(data.pagination) ? data.pagination : null;
    } else {
        return null;
    }
    const items: StonkfunToken[] = [];
    for (const raw of raws) {
        const parsed = parseStonkfunToken(raw);
        if (parsed) items.push(parsed);
    }
    const totalPagesRaw = asFiniteNumberOrNull(pagination?.totalPages);
    const totalPages = totalPagesRaw !== null && totalPagesRaw >= 0 ? Math.floor(totalPagesRaw) : null;
    return { items, totalPages };
}

export interface LaunchpadSyncArgs {
    minMarketCapUsd: number;
    minVolume24hUsd: number;
    maxPerQuote: number;
    newMintBirdeyeBudget: number;
    maxPages: number;
    concurrency: number;
    delayMs: number;
}

export function parseLaunchpadSyncArgs(rawArgs: unknown): LaunchpadSyncArgs {
    const args = asObject(rawArgs);
    return {
        minMarketCapUsd: clampInt(args.minMarketCapUsd, 25_000, 0, 1_000_000_000),
        minVolume24hUsd: clampInt(args.minVolume24hUsd, 10_000, 0, 1_000_000_000),
        maxPerQuote: clampInt(args.maxPerQuote, 50, 1, 500),
        newMintBirdeyeBudget: clampInt(args.newMintBirdeyeBudget, 25, 0, 250),
        maxPages: clampInt(args.maxPages, 30, 1, 100),
        concurrency: clampInt(args.concurrency, 2, 1, 5),
        delayMs: clampInt(args.delayMs, 200, 0, 5_000),
    };
}

export function passesThreshold(token: StonkfunToken, args: LaunchpadSyncArgs): boolean {
    const marketCap = token.market.marketCapUsd ?? 0;
    const volume = token.market.volume24hUsd ?? 0;
    return marketCap >= args.minMarketCapUsd || volume >= args.minVolume24hUsd;
}

function volumeOf(token: StonkfunToken): number {
    return token.market.volume24hUsd ?? 0;
}

function marketCapOf(token: StonkfunToken): number {
    return token.market.marketCapUsd ?? 0;
}

function compareByActivity(a: StonkfunToken, b: StonkfunToken): number {
    return volumeOf(b) - volumeOf(a) || marketCapOf(b) - marketCapOf(a) || a.mint.localeCompare(b.mint);
}

/**
 * Pure selection step: dedupe, keep coins quoted in a curated mint, apply the
 * display threshold, cap per quote, and rank by activity. Approved mints skip
 * the threshold and the per-quote cap (and never consume cap slots) but must
 * still be quoted in a curated mint, since that is the page they appear on.
 * Exported for tests.
 */
export function selectLaunchpadTokens(
    items: readonly StonkfunToken[],
    curatedMints: ReadonlySet<string>,
    args: LaunchpadSyncArgs,
    approvedMints: ReadonlySet<string> = new Set(),
): StonkfunToken[] {
    const byMint = new Map<string, StonkfunToken>();
    for (const item of items) {
        if (byMint.has(item.mint)) continue;
        if (!curatedMints.has(item.quoteMint)) continue;
        if (!approvedMints.has(item.mint) && !passesThreshold(item, args)) continue;
        byMint.set(item.mint, item);
    }

    const selected: StonkfunToken[] = [];
    const byQuote = new Map<string, StonkfunToken[]>();
    for (const token of byMint.values()) {
        if (approvedMints.has(token.mint)) {
            selected.push(token);
            continue;
        }
        const bucket = byQuote.get(token.quoteMint);
        if (bucket) bucket.push(token);
        else byQuote.set(token.quoteMint, [token]);
    }

    for (const bucket of byQuote.values()) {
        bucket.sort(compareByActivity);
        selected.push(...bucket.slice(0, args.maxPerQuote));
    }
    selected.sort(compareByActivity);
    return selected;
}

export function launchpadTokenToUpsert(
    token: StonkfunToken,
    sourceRank: number,
    isActive: boolean,
    now: number,
): LaunchpadTokenUpsert {
    const out: LaunchpadTokenUpsert = {
        launchpad: STONKFUN_LAUNCHPAD,
        mint: token.mint,
        quoteMint: token.quoteMint,
        sourceRank,
        rawJson: JSON.stringify(token.raw),
        isActive,
        lastSeenAt: now,
        lastSyncedAt: now,
    };
    if (token.quoteSymbol) out.quoteSymbol = token.quoteSymbol;
    if (token.symbol) out.symbol = token.symbol;
    if (token.name) out.name = token.name;
    if (token.imageUrl) out.logoURI = token.imageUrl;
    if (token.pool) out.pool = token.pool;
    if (token.status) out.status = token.status;
    if (token.mode) out.mode = token.mode;
    if (token.creator) out.creator = token.creator;
    if (token.market.priceUsd !== null) out.priceUsd = token.market.priceUsd;
    if (token.market.marketCapUsd !== null) out.marketCapUsd = token.market.marketCapUsd;
    if (token.market.fdvUsd !== null) out.fdvUsd = token.market.fdvUsd;
    if (token.market.liquidityUsd !== null) out.liquidityUsd = token.market.liquidityUsd;
    if (token.market.volume24hUsd !== null) out.volume24hUsd = token.market.volume24hUsd;
    if (token.market.priceChange24h !== null) out.priceChange24h = token.market.priceChange24h;
    if (token.createdAt !== null) out.launchedAt = token.createdAt;
    if (token.graduatedAt !== null) out.graduatedAt = token.graduatedAt;
    if (Object.keys(token.links).length > 0) out.linksJson = JSON.stringify(token.links);
    return out;
}

export async function syncStonkfunLaunches(deps: LaunchpadCronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = parseLaunchpadSyncArgs(rawArgs);
    const start = deps.base.now();

    const result = await deps.stonkfun.fetchGraduatedTokens({ maxPages: args.maxPages });
    if (!result.ok) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.base.now() - start,
            skipped: true,
            reason: result.reason,
            ...(result.reason === 'http_error' ? { status: result.status } : {}),
        };
    }

    const curatedMints = new Set(deps.base.curated.getAllCuratedMintsInOrder());
    const approvedMints = new Set(await deps.repo.listApprovedMints(STONKFUN_LAUNCHPAD));
    const selected = selectLaunchpadTokens(result.items, curatedMints, args, approvedMints);
    const approvedSelected = selected.filter(t => approvedMints.has(t.mint)).length;

    if (selected.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.base.now() - start,
            skipped: true,
            reason: 'no_matches',
            fetched: result.items.length,
        };
    }

    const existingActive = await deps.repo.listActiveLaunchpadCount(STONKFUN_LAUNCHPAD);
    if (existingActive > 0 && selected.length < existingActive * 0.7) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.base.now() - start,
            skipped: true,
            reason: 'suspicious_drop',
            existingActiveCount: existingActive,
            nextActiveCount: selected.length,
        };
    }

    // Identity ensure: the singleton page needs `tokens` + `variant_markets_latest`.
    const mints = selected.map(t => t.mint);
    const [knownTokens, withMarket] = await Promise.all([
        deps.repo.filterMintsKnownTokens(mints),
        deps.repo.filterMintsWithVariantMarket(mints),
    ]);
    const hasIdentity = new Set<string>();
    const knownSet = new Set(knownTokens);
    const marketSet = new Set(withMarket);
    for (const mint of mints) if (knownSet.has(mint) && marketSet.has(mint)) hasIdentity.add(mint);

    // Approved mints get first claim on the Birdeye budget so a fresh approval
    // is never starved by higher-volume unapproved candidates.
    const needsIdentity = mints
        .filter(mint => !hasIdentity.has(mint))
        .sort((a, b) => Number(approvedMints.has(b)) - Number(approvedMints.has(a)));
    const toFetch = needsIdentity.slice(0, args.newMintBirdeyeBudget);
    let birdeyeCalls = 0;
    let identityFailed = 0;

    if (toFetch.length > 0) {
        await Effect.runPromise(
            runJobPool({
                label: 'syncStonkfunLaunches.identity',
                items: toFetch,
                concurrency: args.concurrency,
                delayMs: args.delayMs,
                shouldStop: isShuttingDown,
                process: mint =>
                    Effect.tryPromise(async () => {
                        birdeyeCalls += 1;
                        const overview = await deps.base.birdeye.fetchTokenOverview(mint);
                        if (!overview) {
                            identityFailed += 1;
                            return;
                        }
                        const tokenUpsert = birdeyeOverviewToTokenUpsert(
                            mint,
                            overview as unknown as Record<string, unknown>,
                            start,
                        );
                        const marketUpsert = birdeyeOverviewToUpsert(mint, overview, start);
                        if (!tokenUpsert || !marketUpsert) {
                            identityFailed += 1;
                            return;
                        }
                        await deps.repo.upsertTokenFromBirdeye(tokenUpsert);
                        await deps.base.repo.upsertVariantMarketFromBirdeye(marketUpsert);
                        hasIdentity.add(mint);
                    }),
                onItemError: mint =>
                    Effect.sync(() => {
                        identityFailed += 1;
                        console.error(`[syncStonkfunLaunches] identity mint=${mint} failed`);
                    }),
            }),
        );
    }

    let synced = 0;
    let failed = 0;
    const activeMints: string[] = [];
    for (let i = 0; i < selected.length; i++) {
        const token = selected[i]!;
        const isActive = hasIdentity.has(token.mint);
        try {
            await deps.repo.upsertLaunchpadTokenLatest(launchpadTokenToUpsert(token, i, isActive, start));
            synced += 1;
            if (isActive) activeMints.push(token.mint);
        } catch (err) {
            failed += 1;
            console.error(
                `[syncStonkfunLaunches] mint=${token.mint}`,
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    const deactivated = await deps.repo.deactivateMissingLaunchpadTokens(STONKFUN_LAUNCHPAD, activeMints, start);

    return {
        ok: !(selected.length > 0 && synced === 0 && failed >= selected.length),
        processed: synced,
        durationMs: deps.base.now() - start,
        fetched: result.items.length,
        selected: selected.length,
        approvedSelected,
        synced,
        activated: activeMints.length,
        pendingIdentity: selected.length - activeMints.length,
        deactivated,
        birdeyeCalls,
        identityFailed,
        failed,
    };
}

export type LaunchpadJobHandler = (deps: LaunchpadCronDeps, args: unknown) => Promise<CronResult>;

export const launchpadJobs: Record<string, LaunchpadJobHandler> = {
    'sync-stonkfun-launches': syncStonkfunLaunches,
};
