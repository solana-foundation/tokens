/**
 * Warm-on-miss cache warming, ported from `convex/cacheWarm.ts`.
 *
 * Auth note: the Convex `secret` / `keyHash` checks are replaced by the shared
 * bearer token on `/mutation/*` (apps/api authenticates callers upstream), so
 * these handlers accept and ignore `secret` / `keyHash` args.
 *
 * Where Convex used `ctx.scheduler.runAfter(0, ...)`, these handlers AWAIT the
 * refresh job handlers inline (Cloud Run throttles CPU after the response is
 * sent, so fire-and-forget work would starve). Refresh failures are logged and
 * swallowed — warming is best-effort, matching Convex semantics where a
 * successfully *enqueued* job already counted as "scheduled".
 */

import { normalizeCuratedListSlug } from '@tokens/asset-registry/curated-lists';

import {
    InvalidArgsError,
    refreshCuratedAssetRisk,
    refreshCuratedOhlcv,
    refreshCuratedVariantMarkets,
    type BirdeyeInterval,
    type CronDeps,
    type CronResult,
} from './crons';
import { refreshCuratedTokenMarkets, type MiscCronDeps } from './crons.misc';
import {
    refreshCuratedCoingeckoMetadata,
    refreshCuratedCoingeckoOhlcv,
    refreshCuratedCoingeckoPrices,
    refreshCuratedCoingeckoTickers,
    type CoingeckoRepo,
} from './crons.coingecko';
import { refreshPublicEquityStockPrices, type ClickhouseCronDeps } from './crons.clickhouse';
import {
    refreshPublicEquityStockOhlcv,
    refreshSolanaClickhouseOhlcv,
    type ClickhouseExtrasCronDeps,
} from './crons.clickhouse.extras';
import { seedCanonicalAssetsRegistry, type SeedCronDeps } from './crons.seed';
import type { StockReadsRepo } from './stockReads';

export type TimeInterval = BirdeyeInterval;

const TIME_INTERVALS: readonly TimeInterval[] = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'];

export interface CacheWarmAssetsRepo {
    /** UPDATEs `assets.image_url`; returns true when a row actually changed. */
    setImageUrlByAssetId(assetId: string, imageUrl: string, updatedAt: Date): Promise<boolean>;
}

export interface CacheWarmDeps {
    /** Base cron deps (jobs repo, Birdeye clients, optional coingecko attachments). */
    cron: CronDeps;
    misc: MiscCronDeps;
    clickhouse?: ClickhouseCronDeps;
    clickhouseExtras?: ClickhouseExtrasCronDeps;
    seed: SeedCronDeps;
    stockReadsRepo: StockReadsRepo;
    assetsRepo: CacheWarmAssetsRepo;
    env: () => NodeJS.ProcessEnv;
    now: () => number;
}

export interface MintWarmResult {
    mint: string;
    scheduled: string[];
    skipped: string[];
}

export interface CoinWarmResult {
    coinId: string;
    scheduled: string[];
    skipped: string[];
}

export interface StockWarmResult {
    assetId: string;
    scheduled: string[];
    skipped: string[];
}

function asObject(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object') throw new InvalidArgsError('args must be an object');
    return raw as Record<string, unknown>;
}

function readRequiredString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string`);
    return value;
}

function readOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new InvalidArgsError(`${key} must be a boolean`);
    return value;
}

function readOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError(`${key} must be a finite number`);
    }
    return value;
}

function readOptionalInterval(args: Record<string, unknown>, key: string): TimeInterval | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !(TIME_INTERVALS as readonly string[]).includes(value)) {
        throw new InvalidArgsError(`${key} must be one of: ${TIME_INTERVALS.join(',')}`);
    }
    return value as TimeInterval;
}

function readRequiredStringArray(args: Record<string, unknown>, key: string): string[] {
    const value = args[key];
    if (!Array.isArray(value)) throw new InvalidArgsError(`${key} must be an array of strings`);
    for (const item of value) {
        if (typeof item !== 'string') throw new InvalidArgsError(`${key} must be an array of strings`);
    }
    return value as string[];
}

function clampInt(value: number, min: number, max: number): number {
    const n = Math.floor(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(Math.max(n, min), max);
}

function intervalToSeconds(interval: TimeInterval): number {
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
        default:
            return 60 * 60;
    }
}

function ohlcvDaysDefault(interval: TimeInterval): number {
    return interval === '15m' ? 1 : interval === '1H' ? 90 : 365;
}

function uniqueStrings(values: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const n = Math.max(1, Math.floor(size));
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
    return out;
}

function isClickHouseSolanaTradesRefreshEnabled(env: NodeJS.ProcessEnv): boolean {
    return (env.CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/** Warming is best-effort: log refresh failures, never fail the request. */
async function runRefresh(label: string, fn: () => Promise<CronResult>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        console.error(`[cacheWarm] ${label} refresh failed`, err);
    }
}

function requireCoingeckoRepo(deps: CacheWarmDeps): CoingeckoRepo {
    const repo = deps.cron.coingeckoRepo;
    if (!repo) throw new InvalidArgsError('coingecko deps not configured');
    return repo;
}

async function scheduleMintWarm(
    deps: CacheWarmDeps,
    params: {
        mint: string;
        variantMarket?: boolean | undefined;
        markets?: boolean | undefined;
        ohlcv?: boolean | undefined;
        ohlcvInterval?: TimeInterval | undefined;
        ohlcvDays?: number | undefined;
        minAgeMs?: number | undefined;
    },
): Promise<MintWarmResult> {
    const mint = params.mint.trim();
    if (!mint) return { mint: '', scheduled: [], skipped: ['invalid_mint'] };

    const shouldWarmVariantMarket = params.variantMarket ?? true;
    const shouldWarmMarkets = params.markets ?? true;
    const shouldWarmOhlcv = params.ohlcv ?? false;

    const minAgeMs = Math.max(params.minAgeMs ?? 10 * 60_000, 0);
    const nowMs = deps.now();

    const scheduled: string[] = [];
    const skipped: string[] = [];

    // Only warm tokens we can resolve to an asset variant.
    const variant = await deps.cron.repo.findVariantByMint(mint);
    if (!variant) return { mint, scheduled: [], skipped: ['unknown_mint'] };

    if (shouldWarmVariantMarket) {
        const lastFetchedAt = await deps.cron.repo.getOverviewLastFetchedAtByMint(mint);

        if (lastFetchedAt !== null && nowMs - lastFetchedAt < minAgeMs) {
            skipped.push('variantMarket:fresh');
        } else {
            await runRefresh('variantMarket', () =>
                refreshCuratedVariantMarkets(deps.cron, {
                    mints: [mint],
                    priorityCount: 0,
                    maxMints: 1,
                    minAgeMs: 0,
                    concurrency: 1,
                    delayMs: 0,
                    selectionWindowMs: 60_000,
                }),
            );
            scheduled.push('variantMarket');
        }
    }

    if (shouldWarmMarkets) {
        const lastFetchedAt = await deps.misc.repo.getTokenMarketsLastFetchedAtByMint(mint);

        if (lastFetchedAt !== null && nowMs - lastFetchedAt < minAgeMs) {
            skipped.push('markets:fresh');
        } else {
            await runRefresh('markets', () =>
                refreshCuratedTokenMarkets(deps.misc, {
                    mints: [mint],
                    priorityCount: 0,
                    maxMints: 1,
                    minAgeMs: 0,
                    concurrency: 1,
                    delayMs: 0,
                    maxMarketsPerMint: 20,
                    selectionWindowMs: 60_000,
                }),
            );
            scheduled.push('markets');
        }
    }

    if (shouldWarmOhlcv) {
        const interval: TimeInterval = params.ohlcvInterval ?? '1H';
        const intervalSeconds = intervalToSeconds(interval);
        const days = clampInt(params.ohlcvDays ?? ohlcvDaysDefault(interval), 1, 3650);
        const nowSeconds = Math.floor(nowMs / 1000);
        const maxStalenessSeconds = clampInt(2 * intervalSeconds, intervalSeconds, 24 * intervalSeconds);

        const bounds = await deps.cron.repo.getOhlcvBounds(mint, interval);
        const earliestTime = bounds.minTime;
        const latestTime = bounds.maxTime;

        const requestedFrom = nowSeconds - days * 24 * 60 * 60;
        const hasStartCoverage = earliestTime !== null && earliestTime <= requestedFrom + intervalSeconds;
        const isFresh = latestTime !== null && nowSeconds - latestTime < maxStalenessSeconds;

        if (isFresh && hasStartCoverage) {
            skipped.push(`ohlcv:${interval}:fresh`);
        } else {
            const refreshArgs = {
                mints: [mint],
                interval,
                days,
                priorityCount: 0,
                maxMints: 1,
                concurrency: 1,
                delayMs: 0,
                selectionWindowMs: 60_000,
            };
            const clickhouseExtras = deps.clickhouseExtras;
            if (isClickHouseSolanaTradesRefreshEnabled(deps.env()) && clickhouseExtras) {
                // Backstop ClickHouse with Birdeye so sparse or lagging direct-stable
                // trade coverage does not leave variant charts empty. The OHLCV
                // upsert preserves ClickHouse rows.
                await Promise.all([
                    runRefresh('ohlcv:clickhouse', () =>
                        refreshSolanaClickhouseOhlcv(clickhouseExtras, {
                            ...refreshArgs,
                            requireRefreshEnabled: true,
                        }),
                    ),
                    runRefresh('ohlcv:birdeye', () => refreshCuratedOhlcv(deps.cron, refreshArgs)),
                ]);
            } else {
                await runRefresh('ohlcv:birdeye', () => refreshCuratedOhlcv(deps.cron, refreshArgs));
            }
            scheduled.push(`ohlcv:${interval}`);
        }
    }

    return { mint, scheduled, skipped };
}

/** Replaces `cacheWarm.request` / `cacheWarm.requestFromKeyHash`. */
export async function cacheWarmRequest(deps: CacheWarmDeps, rawArgs: unknown): Promise<MintWarmResult> {
    const args = asObject(rawArgs);
    const mint = readRequiredString(args, 'mint');
    return scheduleMintWarm(deps, {
        mint,
        variantMarket: readOptionalBoolean(args, 'variantMarket'),
        markets: readOptionalBoolean(args, 'markets'),
        ohlcv: readOptionalBoolean(args, 'ohlcv'),
        ohlcvInterval: readOptionalInterval(args, 'ohlcvInterval'),
        ohlcvDays: readOptionalNumber(args, 'ohlcvDays'),
        minAgeMs: readOptionalNumber(args, 'minAgeMs'),
    });
}

export async function cacheWarmRequestCoingeckoOhlcv(
    deps: CacheWarmDeps,
    rawArgs: unknown,
): Promise<CoinWarmResult> {
    const args = asObject(rawArgs);
    const coinId = readRequiredString(args, 'coinId').trim();
    const interval = readOptionalInterval(args, 'interval') ?? '1H';
    const daysArg = readOptionalNumber(args, 'days');
    if (!coinId) return { coinId: '', scheduled: [], skipped: ['invalid_coinId'] };

    const coingeckoRepo = requireCoingeckoRepo(deps);
    const intervalSeconds = intervalToSeconds(interval);
    const days = clampInt(daysArg ?? ohlcvDaysDefault(interval), 1, 3650);

    const nowSeconds = Math.floor(deps.now() / 1000);
    const maxStalenessSeconds = clampInt(2 * intervalSeconds, intervalSeconds, 24 * intervalSeconds);

    const latestTime = (await coingeckoRepo.getOhlcvBounds(coinId, interval)).maxTime;
    const isFresh = latestTime !== null && nowSeconds - latestTime < maxStalenessSeconds;
    if (isFresh) {
        return { coinId, scheduled: [], skipped: [`ohlcv:${interval}:fresh`] };
    }

    await runRefresh('coingeckoOhlcv', () =>
        refreshCuratedCoingeckoOhlcv(deps.cron, {
            coinIds: [coinId],
            interval,
            days,
            maxCoins: 1,
            concurrency: 1,
            delayMs: 0,
            selectionWindowMs: 60_000,
        }),
    );

    return { coinId, scheduled: [`ohlcv:${interval}`], skipped: [] };
}

export async function cacheWarmRequestCoinPrice(deps: CacheWarmDeps, rawArgs: unknown): Promise<CoinWarmResult> {
    const args = asObject(rawArgs);
    const coinId = readRequiredString(args, 'coinId').trim();
    const minAgeMs = Math.max(readOptionalNumber(args, 'minAgeMs') ?? 10 * 60_000, 0);
    if (!coinId) return { coinId: '', scheduled: [], skipped: ['invalid_coinId'] };

    const coingeckoRepo = requireCoingeckoRepo(deps);
    const nowMs = deps.now();

    const lastFetchedAt = (await coingeckoRepo.listPriceLastFetchedAtByCoinIds([coinId])).get(coinId) ?? null;
    if (lastFetchedAt !== null && nowMs - lastFetchedAt < minAgeMs) {
        return { coinId, scheduled: [], skipped: ['price:fresh'] };
    }

    await runRefresh('coinPrice', () =>
        refreshCuratedCoingeckoPrices(deps.cron, {
            coinIds: [coinId],
            minAgeMs: 0,
            chunkSize: 200,
            delayMs: 0,
        }),
    );

    return { coinId, scheduled: ['price'], skipped: [] };
}

export async function cacheWarmRequestCoinMetadata(deps: CacheWarmDeps, rawArgs: unknown): Promise<CoinWarmResult> {
    const args = asObject(rawArgs);
    const coinId = readRequiredString(args, 'coinId').trim();
    const minAgeMs = Math.max(readOptionalNumber(args, 'minAgeMs') ?? 24 * 60 * 60_000, 0);
    if (!coinId) return { coinId: '', scheduled: [], skipped: ['invalid_coinId'] };

    const coingeckoRepo = requireCoingeckoRepo(deps);
    const nowMs = deps.now();

    const lastFetchedAt = await coingeckoRepo.getCoinMetadataLastFetchedAt(coinId);
    if (lastFetchedAt !== null && nowMs - lastFetchedAt < minAgeMs) {
        return { coinId, scheduled: [], skipped: ['metadata:fresh'] };
    }

    await runRefresh('coinMetadata', () =>
        refreshCuratedCoingeckoMetadata(deps.cron, {
            coinIds: [coinId],
            minAgeMs: 0,
            concurrency: 1,
            delayMs: 0,
            localization: false,
            marketData: true,
        }),
    );

    return { coinId, scheduled: ['metadata'], skipped: [] };
}

export async function cacheWarmRequestCoingeckoTickers(
    deps: CacheWarmDeps,
    rawArgs: unknown,
): Promise<CoinWarmResult> {
    const args = asObject(rawArgs);
    const coinId = readRequiredString(args, 'coinId').trim();
    const minAgeMs = Math.max(readOptionalNumber(args, 'minAgeMs') ?? 6 * 60 * 60_000, 0);
    if (!coinId) return { coinId: '', scheduled: [], skipped: ['invalid_coinId'] };

    const coingeckoRepo = requireCoingeckoRepo(deps);
    const nowMs = deps.now();

    const lastFetchedAt = await coingeckoRepo.getTickersLastFetchedAt(coinId);
    if (lastFetchedAt !== null && nowMs - lastFetchedAt < minAgeMs) {
        return { coinId, scheduled: [], skipped: ['tickers:fresh'] };
    }

    await runRefresh('coingeckoTickers', () =>
        refreshCuratedCoingeckoTickers(deps.cron, {
            coinIds: [coinId],
            maxCoins: 1,
            minAgeMs: 0,
            concurrency: 1,
            delayMs: 0,
            selectionWindowMs: 60_000,
            maxTickers: 200,
        }),
    );

    return { coinId, scheduled: ['tickers'], skipped: [] };
}

export async function cacheWarmRequestStockPrice(deps: CacheWarmDeps, rawArgs: unknown): Promise<StockWarmResult> {
    const args = asObject(rawArgs);
    const assetId = readRequiredString(args, 'assetId').trim();
    const minAgeMs = Math.max(readOptionalNumber(args, 'minAgeMs') ?? 5 * 60_000, 0);
    if (!assetId) return { assetId: '', scheduled: [], skipped: ['invalid_assetId'] };

    const instrument = await deps.stockReadsRepo.findInstrumentByAssetId(assetId);
    if (!instrument || !instrument.is_active) {
        return { assetId, scheduled: [], skipped: ['unknown_stock_asset'] };
    }

    const nowMs = deps.now();
    const snapshot = await deps.stockReadsRepo.findPriceByAssetId(assetId);
    if (snapshot && nowMs - snapshot.last_fetched_at < minAgeMs) {
        return { assetId, scheduled: [], skipped: ['stockPrice:fresh'] };
    }

    const clickhouse = deps.clickhouse;
    if (!clickhouse) {
        return { assetId, scheduled: [], skipped: ['stock_refresh_unavailable'] };
    }

    // The Convex warm path (`refreshStockPricesByAssetIds`) had no enable-flag
    // gate, so bypass CLICKHOUSE_STOCK_REFRESH_ENABLED here too.
    await runRefresh('stockPrice', () =>
        refreshPublicEquityStockPrices(clickhouse, {
            assetIds: [assetId],
            concurrency: 1,
            delayMs: 0,
            requireRefreshEnabled: false,
        }),
    );

    return { assetId, scheduled: ['stockPrice'], skipped: [] };
}

export async function cacheWarmRequestStockOhlcv(deps: CacheWarmDeps, rawArgs: unknown): Promise<StockWarmResult> {
    const args = asObject(rawArgs);
    const assetId = readRequiredString(args, 'assetId').trim();
    const interval = readOptionalInterval(args, 'interval') ?? '1H';
    const daysArg = readOptionalNumber(args, 'days');
    if (!assetId) return { assetId: '', scheduled: [], skipped: ['invalid_assetId'] };

    const instrument = await deps.stockReadsRepo.findInstrumentByAssetId(assetId);
    if (!instrument || !instrument.is_active) {
        return { assetId, scheduled: [], skipped: ['unknown_stock_asset'] };
    }

    const clickhouseExtras = deps.clickhouseExtras;
    if (!clickhouseExtras) {
        return { assetId, scheduled: [], skipped: ['stock_refresh_unavailable'] };
    }

    const intervalSeconds = intervalToSeconds(interval);
    const days = clampInt(daysArg ?? ohlcvDaysDefault(interval), 1, 3650);

    const nowSeconds = Math.floor(deps.now() / 1000);
    const maxStalenessSeconds = clampInt(2 * intervalSeconds, intervalSeconds, 24 * intervalSeconds);

    const latestTime = (await clickhouseExtras.repo.getStockOhlcvBounds(assetId, interval)).maxTime;
    const isFresh = latestTime !== null && nowSeconds - latestTime < maxStalenessSeconds;
    if (isFresh) {
        return { assetId, scheduled: [], skipped: [`stockOhlcv:${interval}:fresh`] };
    }

    await runRefresh('stockOhlcv', () =>
        refreshPublicEquityStockOhlcv(clickhouseExtras, {
            assetIds: [assetId],
            interval,
            days,
            concurrency: 1,
            delayMs: 0,
            requireRefreshEnabled: false,
        }),
    );

    return { assetId, scheduled: [`stockOhlcv:${interval}`], skipped: [] };
}

export async function cacheWarmRequestAssetRisk(deps: CacheWarmDeps, rawArgs: unknown): Promise<MintWarmResult> {
    const args = asObject(rawArgs);
    const mint = readRequiredString(args, 'mint').trim();
    const minAgeMs = Math.max(readOptionalNumber(args, 'minAgeMs') ?? 6 * 60 * 60_000, 0);
    if (!mint) return { mint: '', scheduled: [], skipped: ['invalid_mint'] };

    // Only warm tokens we can resolve to an asset variant.
    const variant = await deps.cron.repo.findVariantByMint(mint);
    if (!variant) return { mint, scheduled: [], skipped: ['unknown_mint'] };

    const nowMs = deps.now();
    const lastFetchedAt = await deps.cron.repo.getAssetRiskLastFetchedAtByMint(mint);
    if (lastFetchedAt !== null && nowMs - lastFetchedAt < minAgeMs) {
        return { mint, scheduled: [], skipped: ['risk:fresh'] };
    }

    await runRefresh('assetRisk', () =>
        refreshCuratedAssetRisk(deps.cron, {
            mints: [mint],
            maxMints: 1,
            minAgeMs: 0,
            concurrency: 1,
            delayMs: 0,
            selectionWindowMs: 60_000,
        }),
    );

    return { mint, scheduled: ['risk'], skipped: [] };
}

async function warmMintsInChunks(
    deps: CacheWarmDeps,
    params: {
        mints: readonly string[];
        variantMarket: boolean;
        markets: boolean;
        minAgeMs: number;
    },
): Promise<{ scheduled: string[]; skipped: string[] }> {
    const scheduled: string[] = [];
    const skipped: string[] = [];
    const chunks = chunk(params.mints, 250);

    if (params.variantMarket) {
        for (const mintsChunk of chunks) {
            await runRefresh('bulk:variantMarket', () =>
                refreshCuratedVariantMarkets(deps.cron, {
                    mints: mintsChunk,
                    priorityCount: 0,
                    maxMints: Math.min(mintsChunk.length, 250),
                    minAgeMs: params.minAgeMs,
                    concurrency: 2,
                    delayMs: 200,
                    selectionWindowMs: 60_000,
                }),
            );
        }
        scheduled.push('variantMarket');
    } else {
        skipped.push('variantMarket:disabled');
    }

    if (params.markets) {
        for (const mintsChunk of chunks) {
            await runRefresh('bulk:markets', () =>
                refreshCuratedTokenMarkets(deps.misc, {
                    mints: mintsChunk,
                    priorityCount: 0,
                    maxMints: Math.min(mintsChunk.length, 250),
                    minAgeMs: params.minAgeMs,
                    concurrency: 2,
                    delayMs: 200,
                    maxMarketsPerMint: 20,
                    selectionWindowMs: 60_000,
                }),
            );
        }
        scheduled.push('markets');
    } else {
        skipped.push('markets:disabled');
    }

    return { scheduled, skipped };
}

export interface MintsWarmResult {
    totalMints: number;
    scheduled: string[];
    skipped: string[];
}

/** Operator bulk warm (replaces `cacheWarm.requestMintsWarm`). */
export async function cacheWarmRequestMintsWarm(deps: CacheWarmDeps, rawArgs: unknown): Promise<MintsWarmResult> {
    const args = asObject(rawArgs);
    const rawMints = readRequiredStringArray(args, 'mints');
    const variantMarket = readOptionalBoolean(args, 'variantMarket') ?? true;
    const markets = readOptionalBoolean(args, 'markets') ?? true;
    const minAgeMs = Math.max(readOptionalNumber(args, 'minAgeMs') ?? 30 * 60_000, 0);

    const mints = uniqueStrings(rawMints).slice(0, 5000);
    if (mints.length === 0) return { totalMints: 0, scheduled: [], skipped: ['empty_mints'] };

    const { scheduled, skipped } = await warmMintsInChunks(deps, { mints, variantMarket, markets, minAgeMs });
    return { totalMints: mints.length, scheduled, skipped };
}

async function getCuratedMints(deps: CacheWarmDeps, listId: string): Promise<string[]> {
    // Effective DB-backed membership: admin adds/removes warm without a deploy.
    const snapshot = await deps.cron.curated.getSnapshot();
    if (listId === 'all') return [...snapshot.allMints];
    const slug = normalizeCuratedListSlug(listId);
    if (!slug) return [];
    return [...(snapshot.mintsByList[slug] ?? [])];
}

export interface CuratedListWarmResult {
    listId: string;
    totalMints: number;
    scheduled: string[];
    skipped: string[];
}

export async function cacheWarmRequestCuratedListWarm(
    deps: CacheWarmDeps,
    rawArgs: unknown,
): Promise<CuratedListWarmResult> {
    const args = asObject(rawArgs);
    const listId = readRequiredString(args, 'listId').trim();
    const variantMarket = readOptionalBoolean(args, 'variantMarket') ?? true;
    const markets = readOptionalBoolean(args, 'markets') ?? true;
    const minAgeMs = Math.max(readOptionalNumber(args, 'minAgeMs') ?? 30 * 60_000, 0);

    if (!listId) return { listId: '', totalMints: 0, scheduled: [], skipped: ['invalid_listId'] };

    const mints = uniqueStrings(await getCuratedMints(deps, listId)).slice(0, 5000);
    if (mints.length === 0) return { listId, totalMints: 0, scheduled: [], skipped: ['unknown_listId'] };

    const { scheduled, skipped } = await warmMintsInChunks(deps, { mints, variantMarket, markets, minAgeMs });
    return { listId, totalMints: mints.length, scheduled, skipped };
}

export interface RegistrySeedResult {
    scheduled: boolean;
    includeCuratedCollections: boolean;
}

export async function cacheWarmRequestRegistrySeed(
    deps: CacheWarmDeps,
    rawArgs: unknown,
): Promise<RegistrySeedResult> {
    const args = asObject(rawArgs);
    const includeCuratedCollections = readOptionalBoolean(args, 'includeCuratedCollections') ?? true;

    // The seed maintains registry identity only — curated collections are
    // DB-authoritative and never written here. The arg is accepted for
    // compatibility and echoed back like the Convex mutation did.
    await runRefresh('registrySeed', () => seedCanonicalAssetsRegistry(deps.seed, {}));

    return { scheduled: true, includeCuratedCollections };
}

/** Port of `cacheWarm.setAssetLogoUrl`: validates + UPDATEs `assets.image_url`. */
export async function cacheWarmSetAssetLogoUrl(deps: CacheWarmDeps, rawArgs: unknown): Promise<null> {
    const args = asObject(rawArgs);
    const assetId = readRequiredString(args, 'assetId').trim();
    if (!assetId) throw new InvalidArgsError('assetId is required');
    const imageUrl = readRequiredString(args, 'imageUrl').trim();
    if (!imageUrl) throw new InvalidArgsError('imageUrl is required');

    const updated = await deps.assetsRepo.setImageUrlByAssetId(assetId, imageUrl, new Date(deps.now()));
    if (updated) {
        console.log(JSON.stringify({ event: 'mutation', mutation: 'cacheWarmSetAssetLogoUrl', assetId }));
    }
    return null;
}

export const __testing = {
    intervalToSeconds,
    ohlcvDaysDefault,
    uniqueStrings,
    chunk,
    getCuratedMints,
    isClickHouseSolanaTradesRefreshEnabled,
};
