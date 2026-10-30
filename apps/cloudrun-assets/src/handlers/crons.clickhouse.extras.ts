import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { runJobPool } from '@tokens/effect/job-runner';
import { ClickhouseApiError } from '../clients';
import {
    computeVariantExecutionScore,
    isFillQualityEligibleForPrimary,
    type AssetCategory,
} from '@tokens/asset-registry';

import type { ClickhouseClient, ClickhouseMintSnapshot } from './crons.clickhouse';
import type { CronResult, CuratedMintsSource } from './crons';
import { InvalidArgsError, parseExplicitTargets } from './crons';
import { getRegistryTrendingIdentity, TRENDING_EXCLUDED_ASSET_IDS, TRENDING_EXCLUDED_CATEGORIES } from './crons.trending';

const FILL_QUALITY_RANGE_IDENTIFIER = '24h';
const FILL_QUALITY_HORIZON = '5s';
const FILL_QUALITY_USDC_QUOTE_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TRENDING_SCORING_VERSION = 'solana-direct-stable-v1';
const TRENDING_MIN_CHUNK_SIZE = 1;
const WORKER_STARTUP_STAGGER_MS = 250;

export interface TrendingMarketUpsert {
    mint: string;
    assetId: string;
    variantId: string;
    category: string;
    symbol: string;
    name: string;
    decimals?: number;
    logoURI?: string;
    scoringVersion: string;
    price?: number;
    volume5mUSD: number;
    volume15mUSD: number;
    volume1hUSD: number;
    volume6hUSD: number;
    volume24hUSD: number;
    trade5m: number;
    trade15m: number;
    trade1h: number;
    trade6h: number;
    trade24h: number;
    uniqueWallet5m: number;
    uniqueWallet1h: number;
    uniqueWallet24h: number;
    priceChange1hPercent?: number;
    priceChange24hPercent?: number;
    trendingScore: number;
    rank: number;
    categoryRank: number;
    lastTradeAt: number | null;
    asOf: number;
    lastComputedAt: number;
}

export interface VariantFillQualityUpsert {
    mint: string;
    quoteMint: string;
    volume24hUSD: number;
    trade24h: number;
    botVolume24hUSD: number;
    botTrade24h: number;
    botVolumeRatio: number;
    fee24hUSD: number;
    feeBps: number;
    flowSourceCount: number;
    markoutPnl24hUSD?: number;
    markoutCount?: number;
    markoutBps?: number;
    executionScore: number;
    isEligibleForPrimary: boolean;
    asOf: number;
    lastComputedAt: number;
}

export interface OhlcvUpsertEntry {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    tradeCount: number;
}

export interface SolanaOhlcvUpsert {
    address: string;
    interval: string;
    source: 'clickhouse_trades';
    candles: OhlcvUpsertEntry[];
}

export interface StockOhlcvUpsert {
    assetId: string;
    symbol: string;
    interval: string;
    source: 'clickhouse_stock';
    candles: OhlcvUpsertEntry[];
}

export interface TrendingMarketRegistryRow {
    mint: string;
    logoURI: string | null;
    name: string | null;
    decimals: number | null;
}

export interface ClickhouseExtrasRepo {
    replaceTrendingFromClickHouse(args: {
        rows: readonly TrendingMarketUpsert[];
        replaceMissing: boolean;
    }): Promise<{ upserted: number; deleted: number }>;
    replaceVariantFillQualityFromClickHouse(args: {
        rows: readonly VariantFillQualityUpsert[];
        replaceMissing: boolean;
        replacementMints: readonly string[];
    }): Promise<{ upserted: number; deleted: number }>;
    upsertSolanaOhlcv(args: SolanaOhlcvUpsert): Promise<{ inserted: number; updated: number; skipped: number }>;
    upsertStockOhlcv(args: StockOhlcvUpsert): Promise<{ inserted: number; updated: number; skipped: number }>;
    getSolanaOhlcvBounds(address: string, interval: string): Promise<{ minTime: number | null; maxTime: number | null }>;
    getStockOhlcvBounds(assetId: string, interval: string): Promise<{ minTime: number | null; maxTime: number | null }>;
    listActiveStockMappings(limit: number): Promise<Array<{ assetId: string; symbol: string; normalizedSymbol: string }>>;
    getStableMints(): Promise<string[]>;
    findVariantMarketRegistryRowsByMints(mints: readonly string[]): Promise<TrendingMarketRegistryRow[]>;
    updateVariantMarketMetricsFromClickhouse(args: {
        rows: readonly ClickhouseMintSnapshot[];
        lastFetchedAt: number;
    }): Promise<{ updated: number }>;
}

export interface ClickhouseExtrasCronDeps {
    clickhouse: ClickhouseClient;
    repo: ClickhouseExtrasRepo;
    curated: Pick<CuratedMintsSource, 'getAllCuratedMintsInOrder'>;
    now: () => number;
    env: () => NodeJS.ProcessEnv;
}

function asObject(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object') throw new InvalidArgsError('args must be an object');
    return raw as Record<string, unknown>;
}

function isRefreshEnabled(env: NodeJS.ProcessEnv, key: string): boolean {
    return (env[key] ?? '').trim().toLowerCase() === 'true';
}

function sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkArr<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined) return Math.min(max, Math.max(min, fallback));
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError('numeric arg must be a finite number');
    }
    return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeMint(value: string): string | null {
    const mint = value.trim();
    if (!mint) return null;
    if (mint.startsWith('__basket__')) return null;
    if (!/^[1-9A-HJ-NP-Za-km-z]{20,80}$/.test(mint)) return null;
    return mint;
}

function uniqueMints(values: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const mint = normalizeMint(value);
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        out.push(mint);
    }
    return out;
}

function toFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function toNonNegativeNumber(value: unknown): number {
    const number = toFiniteNumber(value);
    return number !== null && number > 0 ? number : 0;
}

function clampScore(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
}

function logScoreNorm(value: number, scale: number): number {
    const v = Number.isFinite(value) ? Math.max(0, value) : 0;
    return clampScore(Math.log1p(v) / Math.log1p(scale), 0, 1);
}

function ratioScoreNorm(ratio: number): number {
    const v = Number.isFinite(ratio) ? Math.max(1, ratio) : 1;
    return clampScore(Math.log2(v) / 4, 0, 1);
}

function recencyScoreNorm(lastTradeAt: number | null, asOf: number | null): number {
    const last = typeof lastTradeAt === 'number' && Number.isFinite(lastTradeAt) ? lastTradeAt : 0;
    const current = typeof asOf === 'number' && Number.isFinite(asOf) ? asOf : 0;
    if (last <= 0 || current <= 0 || last > current) return 0;
    const ageSeconds = current - last;
    const freshSeconds = 5 * 60;
    const staleSeconds = 60 * 60;
    if (ageSeconds <= freshSeconds) return 1;
    if (ageSeconds >= staleSeconds) return 0;
    return 1 - (ageSeconds - freshSeconds) / (staleSeconds - freshSeconds);
}

function ratioWith(numerator: number, denominator: number): number {
    const num = Number.isFinite(numerator) ? numerator : 0;
    const denom = Math.max(Number.isFinite(denominator) ? denominator : 1, 1);
    return num / denom;
}

interface TrendingScoreInput {
    volume5mUSD: number;
    volume15mUSD: number;
    volume1hUSD: number;
    volume24hUSD: number;
    trade5m: number;
    trade15m: number;
    trade1h: number;
    trade24h: number;
    uniqueWallet5m: number;
    uniqueWallet1h: number;
    priceChange1hPercent: number | null;
    lastTradeAt: number | null;
    asOf: number | null;
}

function computeTrendingScore(input: TrendingScoreInput): number {
    const score =
        100 *
        (0.12 * logScoreNorm(input.volume5mUSD, 100_000) +
            0.1 * logScoreNorm(input.volume15mUSD, 250_000) +
            0.1 * logScoreNorm(input.volume1hUSD, 1_000_000) +
            0.08 * logScoreNorm(input.trade5m, 500) +
            0.08 * logScoreNorm(input.trade15m, 1_500) +
            0.06 * logScoreNorm(input.trade1h, 5_000) +
            0.08 * logScoreNorm(input.uniqueWallet5m, 150) +
            0.06 * logScoreNorm(input.uniqueWallet1h, 1_000) +
            0.08 * ratioScoreNorm(ratioWith(input.volume5mUSD, input.volume1hUSD / 12)) +
            0.06 * ratioScoreNorm(ratioWith(input.volume15mUSD, input.volume1hUSD / 4)) +
            0.04 * ratioScoreNorm(ratioWith(input.volume1hUSD, input.volume24hUSD / 24)) +
            0.04 * ratioScoreNorm(ratioWith(input.trade15m, input.trade1h / 4)) +
            0.05 * clampScore(Math.abs(input.priceChange1hPercent ?? 0) / 10, 0, 1) +
            0.05 * recencyScoreNorm(input.lastTradeAt, input.asOf));
    return Math.round(clampScore(score, 0, 100) * 10_000) / 10_000;
}

function priceChangePct(current: number | null, previous: number | null): number | null {
    if (current === null || previous === null || previous <= 0) return null;
    return ((current - previous) / previous) * 100;
}

function uniqueStringsRaw(values: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of values) {
        const t = v.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

function deriveFillQualityRatios(input: {
    volume24hUSD: number;
    botVolume24hUSD: number;
    fee24hUSD: number;
    markoutPnl24hUSD: number | null;
}): { botVolumeRatio: number; feeBps: number; markoutBps: number | null } {
    const volume = Math.max(toNonNegativeNumber(input.volume24hUSD), 1);
    const markoutPnl = toFiniteNumber(input.markoutPnl24hUSD);
    return {
        botVolumeRatio: toNonNegativeNumber(input.botVolume24hUSD) / volume,
        feeBps: (toNonNegativeNumber(input.fee24hUSD) / volume) * 10_000,
        markoutBps: markoutPnl === null ? null : (markoutPnl / volume) * 10_000,
    };
}

interface FillQualityAsOfRow {
    asOfMs?: number | string | null;
}

interface FillQualitySnapshotRow {
    mint?: string;
    quoteMint?: string;
    volume24hUSD?: number | string | null;
    trade24h?: number | string | null;
    botVolume24hUSD?: number | string | null;
    botTrade24h?: number | string | null;
    fee24hUSD?: number | string | null;
    flowSourceCount?: number | string | null;
    markoutPnl24hUSD?: number | string | null;
    markoutCount?: number | string | null;
    asOfMs?: number | string | null;
}

interface FillQualitySnapshot {
    mint: string;
    quoteMint: string;
    volume24hUSD: number;
    trade24h: number;
    botVolume24hUSD: number;
    botTrade24h: number;
    fee24hUSD: number;
    flowSourceCount: number;
    markoutPnl24hUSD: number | null;
    markoutCount: number | null;
    asOf: number | null;
}

async function fetchFillQualityAsOfMs(clickhouse: ClickhouseClient): Promise<number | null> {
    const rows = await clickhouse.queryPreset<FillQualityAsOfRow>('tokens_fill_quality_latest', {
        quoteMint: FILL_QUALITY_USDC_QUOTE_MINT,
        rangeIdentifier: FILL_QUALITY_RANGE_IDENTIFIER,
        horizon: FILL_QUALITY_HORIZON,
    });
    return toFiniteNumber(rows[0]?.asOfMs ?? null);
}

interface TrendingSnapshotRow {
    mint?: string;
    priceUsd?: number | string | null;
    volume5mUsd?: number | string | null;
    volume15mUsd?: number | string | null;
    volume1hUsd?: number | string | null;
    volume6hUsd?: number | string | null;
    volume24hUsd?: number | string | null;
    trade5m?: number | string | null;
    trade15m?: number | string | null;
    trade1h?: number | string | null;
    trade6h?: number | string | null;
    trade24h?: number | string | null;
    uniqueTrader5m?: number | string | null;
    uniqueTrader1h?: number | string | null;
    uniqueTrader24h?: number | string | null;
    price1hAgo?: number | string | null;
    price24hAgo?: number | string | null;
    lastTradeAtMs?: number | string | null;
}

interface TrendingSnapshot {
    mint: string;
    priceUsd: number | null;
    volume5mUsd: number;
    volume15mUsd: number;
    volume1hUsd: number;
    volume6hUsd: number;
    volume24hUsd: number;
    trade5m: number;
    trade15m: number;
    trade1h: number;
    trade6h: number;
    trade24h: number;
    uniqueTrader5m: number;
    uniqueTrader1h: number;
    uniqueTrader24h: number;
    priceChange1hPercent: number | null;
    priceChange24hPercent: number | null;
    lastTradeAt: number | null;
    asOf: number | null;
}

async function fetchTrendingSnapshotsChunk(params: {
    clickhouse: ClickhouseClient;
    mints: readonly string[];
    stableMints: readonly string[];
    asOfMs: number;
}): Promise<TrendingSnapshot[]> {
    const mints = uniqueMints(params.mints);
    const stableMints = uniqueMints(params.stableMints);
    if (mints.length === 0 || stableMints.length === 0) return [];
    const rows = await params.clickhouse.queryPreset<TrendingSnapshotRow>('tokens_trending', {
        mints,
        stables: stableMints,
    });
    return rows.flatMap(row => {
        const mint = typeof row.mint === 'string' ? normalizeMint(row.mint) : null;
        if (!mint) return [];
        const priceUsd = toFiniteNumber(row.priceUsd ?? null);
        const price1hAgo = toFiniteNumber(row.price1hAgo ?? null);
        const price24hAgo = toFiniteNumber(row.price24hAgo ?? null);
        const lastTradeAtMs = toFiniteNumber(row.lastTradeAtMs ?? null);
        return [
            {
                mint,
                priceUsd,
                volume5mUsd: toNonNegativeNumber(row.volume5mUsd),
                volume15mUsd: toNonNegativeNumber(row.volume15mUsd),
                volume1hUsd: toNonNegativeNumber(row.volume1hUsd),
                volume6hUsd: toNonNegativeNumber(row.volume6hUsd),
                volume24hUsd: toNonNegativeNumber(row.volume24hUsd),
                trade5m: Math.floor(toNonNegativeNumber(row.trade5m)),
                trade15m: Math.floor(toNonNegativeNumber(row.trade15m)),
                trade1h: Math.floor(toNonNegativeNumber(row.trade1h)),
                trade6h: Math.floor(toNonNegativeNumber(row.trade6h)),
                trade24h: Math.floor(toNonNegativeNumber(row.trade24h)),
                uniqueTrader5m: Math.floor(toNonNegativeNumber(row.uniqueTrader5m)),
                uniqueTrader1h: Math.floor(toNonNegativeNumber(row.uniqueTrader1h)),
                uniqueTrader24h: Math.floor(toNonNegativeNumber(row.uniqueTrader24h)),
                priceChange1hPercent: priceChangePct(priceUsd, price1hAgo),
                priceChange24hPercent: priceChangePct(priceUsd, price24hAgo),
                lastTradeAt: lastTradeAtMs === null ? null : Math.floor(lastTradeAtMs / 1000),
                asOf: Math.floor(params.asOfMs / 1000),
            },
        ];
    });
}

function pickFullerText(primary: string | null | undefined, fallback: string): string {
    if (!primary) return fallback;
    return primary.length >= fallback.length ? primary : fallback;
}

function displayTrendingName(name: string): string {
    return name.replace(/\bBackpack Securities\b/gi, 'BP Securities');
}

async function fetchFillQualitySnapshotsChunk(params: {
    clickhouse: ClickhouseClient;
    mints: readonly string[];
    quoteMint: string;
    asOfMs: number;
}): Promise<FillQualitySnapshot[]> {
    const mints = uniqueMints(params.mints);
    if (mints.length === 0) return [];
    const rows = await params.clickhouse.queryPreset<FillQualitySnapshotRow>('tokens_fill_quality', {
        mints,
        quoteMint: params.quoteMint,
        rangeIdentifier: FILL_QUALITY_RANGE_IDENTIFIER,
        horizon: FILL_QUALITY_HORIZON,
        endTimeMs: Math.floor(params.asOfMs),
    });
    return rows.flatMap(row => {
        const mint = typeof row.mint === 'string' ? normalizeMint(row.mint) : null;
        const rowQuoteMint = typeof row.quoteMint === 'string' ? normalizeMint(row.quoteMint) : null;
        if (!mint || !rowQuoteMint) return [];
        const rowAsOfMs = toFiniteNumber(row.asOfMs ?? null);
        return [
            {
                mint,
                quoteMint: rowQuoteMint,
                volume24hUSD: toNonNegativeNumber(row.volume24hUSD),
                trade24h: Math.floor(toNonNegativeNumber(row.trade24h)),
                botVolume24hUSD: toNonNegativeNumber(row.botVolume24hUSD),
                botTrade24h: Math.floor(toNonNegativeNumber(row.botTrade24h)),
                fee24hUSD: toNonNegativeNumber(row.fee24hUSD),
                flowSourceCount: Math.floor(toNonNegativeNumber(row.flowSourceCount)),
                markoutPnl24hUSD: toFiniteNumber(row.markoutPnl24hUSD ?? null),
                markoutCount: toFiniteNumber(row.markoutCount ?? null),
                asOf: rowAsOfMs === null ? null : Math.floor(rowAsOfMs / 1000),
            },
        ];
    });
}

export async function refreshSolanaClickhouseTrendingMarkets(
    deps: ClickhouseExtrasCronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const args = asObject(rawArgs);
    const start = deps.now();
    const requireRefreshEnabled = args.requireRefreshEnabled !== false;
    if (requireRefreshEnabled && !isRefreshEnabled(deps.env(), 'CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED')) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            requested: 0,
            scored: 0,
            skippedNoTrades: 0,
            skippedIneligible: 0,
            failed: 0,
            disabled: true,
            asOf: null,
        };
    }
    const maxMints = clampNumber(args.maxMints, 1000, 1, 1000);
    const concurrency = clampNumber(args.concurrency, 3, 1, 8);
    const delayMs = clampNumber(args.delayMs, 25, 0, 5_000);
    const budgetMs = clampNumber(args.budgetMs, 0, 0, 3_600_000);

    const explicitMints = Array.isArray(args.mints) ? uniqueStringsRaw(args.mints as string[]) : [];
    const mints =
        explicitMints.length > 0
            ? explicitMints.slice(0, maxMints)
            : uniqueStringsRaw(deps.curated.getAllCuratedMintsInOrder()).slice(0, maxMints);
    if (mints.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            requested: 0,
            scored: 0,
            skippedNoTrades: 0,
            skippedIneligible: 0,
            failed: 0,
            disabled: false,
            asOf: null,
        };
    }

    const asOfMsRaw = await deps.clickhouse.fetchSolanaTradesAsOfMs();
    if (asOfMsRaw === null) {
        return {
            ok: true,
            processed: mints.length,
            durationMs: deps.now() - start,
            requested: mints.length,
            scored: 0,
            skippedNoTrades: mints.length,
            skippedIneligible: 0,
            failed: 0,
            disabled: false,
            asOf: null,
        };
    }
    const asOfMs: number = asOfMsRaw;

    const stableMints = await deps.repo.getStableMints();
    const chunks = chunkArr(mints, 50);
    const snapshotsByMint = new Map<string, TrendingSnapshot>();
    let failed = 0;

    async function fetchChunkRecursive(mintsChunk: string[]): Promise<void> {
        try {
            const snapshots = await fetchTrendingSnapshotsChunk({
                clickhouse: deps.clickhouse,
                mints: mintsChunk,
                stableMints,
                asOfMs,
            });
            for (const snapshot of snapshots) snapshotsByMint.set(snapshot.mint, snapshot);
        } catch (err) {
            if (mintsChunk.length > TRENDING_MIN_CHUNK_SIZE) {
                console.warn('[refreshSolanaClickhouseTrendingMarkets] splitting failed chunk', {
                    size: mintsChunk.length,
                    error: err instanceof Error ? err.message : String(err),
                });
                const halfSize = Math.ceil(mintsChunk.length / 2);
                for (const subChunk of chunkArr(mintsChunk, halfSize)) {
                    await fetchChunkRecursive(subChunk);
                }
                return;
            }
            failed += mintsChunk.length;
            console.error(
                '[refreshSolanaClickhouseTrendingMarkets] failed chunk',
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    await Effect.runPromise(
        runJobPool({
            label: 'refreshSolanaClickhouseTrendingMarkets',
            items: chunks,
            concurrency,
            delayMs,
            staggerMs: WORKER_STARTUP_STAGGER_MS,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            // fetchChunkRecursive owns bisect-on-failure and per-mint failure
            // accounting; it never throws, so the pool only paces and drains.
            process: mintsChunk => Effect.tryPromise(() => fetchChunkRecursive(mintsChunk)),
        }),
    );

    if (failed > 0 && snapshotsByMint.size === 0) {
        return {
            ok: false,
            processed: mints.length,
            durationMs: deps.now() - start,
            requested: mints.length,
            scored: 0,
            skippedNoTrades: 0,
            skippedIneligible: 0,
            failed,
            disabled: false,
            asOf: Math.floor(asOfMs / 1000),
        };
    }

    const registryRows = await deps.repo.findVariantMarketRegistryRowsByMints(
        Array.from(snapshotsByMint.keys()),
    );
    const logoUriByMint = new Map<string, string>();
    const decimalsByMint = new Map<string, number>();
    const nameByMint = new Map<string, string>();
    for (const row of registryRows) {
        if (row.logoURI) logoUriByMint.set(row.mint, row.logoURI);
        if (row.name) nameByMint.set(row.mint, row.name);
        if (typeof row.decimals === 'number' && Number.isFinite(row.decimals)) {
            decimalsByMint.set(row.mint, row.decimals);
        }
    }

    interface RankedCandidate extends Omit<TrendingMarketUpsert, 'rank' | 'categoryRank' | 'scoringVersion' | 'asOf' | 'lastComputedAt'> {
        category: AssetCategory;
    }
    const rankedCandidates: RankedCandidate[] = [];
    let skippedIneligible = 0;
    const ineligibleReasonCounts: Record<string, number> = {};
    const ineligibleSamples: Array<Record<string, unknown>> = [];

    const recordIneligible = (
        reason: string,
        snapshot: { mint: string; volume24hUsd: number; trade24h: number; lastTradeAt: number | null },
        identity: { assetId: string; category: AssetCategory } | null,
    ): void => {
        skippedIneligible += 1;
        ineligibleReasonCounts[reason] = (ineligibleReasonCounts[reason] ?? 0) + 1;
        if (ineligibleSamples.length < 3) {
            ineligibleSamples.push({
                reason,
                mint: snapshot.mint,
                volume24hUsd: snapshot.volume24hUsd,
                trade24h: snapshot.trade24h,
                lastTradeAt: snapshot.lastTradeAt,
                identityPresent: identity !== null,
                assetId: identity?.assetId ?? null,
                category: identity?.category ?? null,
            });
        }
    };

    for (const snapshot of snapshotsByMint.values()) {
        const identity = getRegistryTrendingIdentity(snapshot.mint);
        if (!identity) {
            recordIneligible('noIdentity', snapshot, null);
            continue;
        }
        const ineligibleReason = TRENDING_EXCLUDED_ASSET_IDS.has(identity.assetId)
            ? 'excludedAssetId'
            : TRENDING_EXCLUDED_CATEGORIES.has(identity.category)
              ? 'excludedCategory'
              : snapshot.lastTradeAt === null
                ? 'nullLastTradeAt'
                : snapshot.volume24hUsd < 100
                  ? 'lowVolume24h'
                  : snapshot.trade24h < 5
                    ? 'lowTrade24h'
                    : null;
        if (ineligibleReason !== null) {
            recordIneligible(ineligibleReason, snapshot, identity);
            continue;
        }
        const trendingScore = computeTrendingScore({
            volume5mUSD: snapshot.volume5mUsd,
            volume15mUSD: snapshot.volume15mUsd,
            volume1hUSD: snapshot.volume1hUsd,
            volume24hUSD: snapshot.volume24hUsd,
            trade5m: snapshot.trade5m,
            trade15m: snapshot.trade15m,
            trade1h: snapshot.trade1h,
            trade24h: snapshot.trade24h,
            uniqueWallet5m: snapshot.uniqueTrader5m,
            uniqueWallet1h: snapshot.uniqueTrader1h,
            priceChange1hPercent: snapshot.priceChange1hPercent,
            lastTradeAt: snapshot.lastTradeAt,
            asOf: snapshot.asOf,
        });
        const candidate: RankedCandidate = {
            mint: snapshot.mint,
            assetId: identity.assetId,
            variantId: identity.variantId,
            category: identity.category,
            symbol: identity.symbol,
            name: displayTrendingName(pickFullerText(nameByMint.get(snapshot.mint), identity.name)),
            decimals: decimalsByMint.get(snapshot.mint) ?? 9,
            volume5mUSD: snapshot.volume5mUsd,
            volume15mUSD: snapshot.volume15mUsd,
            volume1hUSD: snapshot.volume1hUsd,
            volume6hUSD: snapshot.volume6hUsd,
            volume24hUSD: snapshot.volume24hUsd,
            trade5m: snapshot.trade5m,
            trade15m: snapshot.trade15m,
            trade1h: snapshot.trade1h,
            trade6h: snapshot.trade6h,
            trade24h: snapshot.trade24h,
            uniqueWallet5m: snapshot.uniqueTrader5m,
            uniqueWallet1h: snapshot.uniqueTrader1h,
            uniqueWallet24h: snapshot.uniqueTrader24h,
            trendingScore,
            lastTradeAt: snapshot.lastTradeAt,
        };
        const logo = logoUriByMint.get(snapshot.mint);
        if (logo) candidate.logoURI = logo;
        if (snapshot.priceUsd !== null) candidate.price = snapshot.priceUsd;
        if (snapshot.priceChange1hPercent !== null) candidate.priceChange1hPercent = snapshot.priceChange1hPercent;
        if (snapshot.priceChange24hPercent !== null) candidate.priceChange24hPercent = snapshot.priceChange24hPercent;
        rankedCandidates.push(candidate);
    }

    rankedCandidates.sort(
        (a, b) =>
            b.trendingScore - a.trendingScore ||
            b.volume1hUSD - a.volume1hUSD ||
            b.trade1h - a.trade1h ||
            a.symbol.localeCompare(b.symbol),
    );

    const categoryRankByCategory = new Map<AssetCategory, number>();
    const asOfSeconds = Math.floor(asOfMs / 1000);
    const lastComputedAt = deps.now();
    const rows: TrendingMarketUpsert[] = rankedCandidates.slice(0, 50).map((row, index) => {
        const nextCategoryRank = (categoryRankByCategory.get(row.category) ?? 0) + 1;
        categoryRankByCategory.set(row.category, nextCategoryRank);
        const upsertRow: TrendingMarketUpsert = {
            mint: row.mint,
            assetId: row.assetId,
            variantId: row.variantId,
            category: row.category,
            symbol: row.symbol,
            name: row.name,
            scoringVersion: TRENDING_SCORING_VERSION,
            volume5mUSD: row.volume5mUSD,
            volume15mUSD: row.volume15mUSD,
            volume1hUSD: row.volume1hUSD,
            volume6hUSD: row.volume6hUSD,
            volume24hUSD: row.volume24hUSD,
            trade5m: row.trade5m,
            trade15m: row.trade15m,
            trade1h: row.trade1h,
            trade6h: row.trade6h,
            trade24h: row.trade24h,
            uniqueWallet5m: row.uniqueWallet5m,
            uniqueWallet1h: row.uniqueWallet1h,
            uniqueWallet24h: row.uniqueWallet24h,
            trendingScore: row.trendingScore,
            rank: index + 1,
            categoryRank: nextCategoryRank,
            lastTradeAt: row.lastTradeAt,
            asOf: asOfSeconds,
            lastComputedAt,
        };
        if (row.decimals !== undefined) upsertRow.decimals = row.decimals;
        if (row.logoURI) upsertRow.logoURI = row.logoURI;
        if (row.price !== undefined) upsertRow.price = row.price;
        if (row.priceChange1hPercent !== undefined) upsertRow.priceChange1hPercent = row.priceChange1hPercent;
        if (row.priceChange24hPercent !== undefined) upsertRow.priceChange24hPercent = row.priceChange24hPercent;
        return upsertRow;
    });

    if (explicitMints.length === 0 && rows.length === 0) {
        console.warn('[refreshSolanaClickhouseTrendingMarkets] skipping global replacement with no candidates', {
            requested: mints.length,
            scored: 0,
            snapshots: snapshotsByMint.size,
            skippedIneligible,
            ineligibleReasonCounts,
            ineligibleSamples,
            failed,
            asOf: asOfSeconds,
        });
        return {
            ok: true,
            processed: mints.length,
            durationMs: deps.now() - start,
            requested: mints.length,
            scored: 0,
            skippedNoTrades: Math.max(0, mints.length - snapshotsByMint.size - failed),
            skippedIneligible,
            failed,
            disabled: false,
            asOf: asOfSeconds,
        };
    }

    if (explicitMints.length === 0 && !rows.some(row => row.category === 'crypto')) {
        console.warn('[refreshSolanaClickhouseTrendingMarkets] skipping global replacement with no crypto candidates', {
            requested: mints.length,
            scored: rows.length,
            categories: Object.fromEntries(categoryRankByCategory.entries()),
            asOf: asOfSeconds,
        });
        return {
            ok: true,
            processed: mints.length,
            durationMs: deps.now() - start,
            requested: mints.length,
            scored: 0,
            skippedNoTrades: Math.max(0, mints.length - snapshotsByMint.size - failed),
            skippedIneligible,
            failed,
            disabled: false,
            asOf: asOfSeconds,
        };
    }

    const replaceMissing = failed === 0 && explicitMints.length === 0;
    await deps.repo.replaceTrendingFromClickHouse({ rows, replaceMissing });

    return {
        ok: true,
        processed: mints.length,
        durationMs: deps.now() - start,
        requested: mints.length,
        scored: rows.length,
        skippedNoTrades: Math.max(0, mints.length - snapshotsByMint.size - failed),
        skippedIneligible,
        failed,
        disabled: false,
        asOf: asOfSeconds,
    };
}

export async function refreshClickhouseFillQualityVariants(
    deps: ClickhouseExtrasCronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const args = asObject(rawArgs);
    const start = deps.now();
    const requireRefreshEnabled = args.requireRefreshEnabled !== false;
    if (requireRefreshEnabled && !isRefreshEnabled(deps.env(), 'CLICKHOUSE_FILL_QUALITY_REFRESH_ENABLED')) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            requested: 0,
            refreshed: 0,
            skippedMissing: 0,
            skippedIneligible: 0,
            failed: 0,
            disabled: true,
            asOf: null,
        };
    }

    const maxMints = clampNumber(args.maxMints, 1000, 1, 1000);
    const concurrency = clampNumber(args.concurrency, 3, 1, 8);
    const delayMs = clampNumber(args.delayMs, 25, 0, 5_000);
    const budgetMs = clampNumber(args.budgetMs, 0, 0, 3_600_000);

    const explicitMints = Array.isArray(args.mints) ? uniqueMints(args.mints as string[]) : [];
    const mints =
        explicitMints.length > 0
            ? explicitMints.slice(0, maxMints)
            : uniqueMints(deps.curated.getAllCuratedMintsInOrder()).slice(0, maxMints);

    if (mints.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            requested: 0,
            refreshed: 0,
            skippedMissing: 0,
            skippedIneligible: 0,
            failed: 0,
            disabled: false,
            asOf: null,
        };
    }

    const resolvedAsOfMs = await fetchFillQualityAsOfMs(deps.clickhouse);
    if (resolvedAsOfMs === null) {
        console.warn('[refreshClickhouseFillQualityVariants] no asOf resolved from ClickHouse; skipping refresh', {
            requested: mints.length,
        });
        return {
            ok: true,
            processed: mints.length,
            durationMs: deps.now() - start,
            requested: mints.length,
            refreshed: 0,
            skippedMissing: mints.length,
            skippedIneligible: 0,
            failed: 0,
            disabled: false,
            asOf: null,
        };
    }

    const asOfMs = resolvedAsOfMs;
    const chunks = chunkArr(mints, 100);
    const snapshotsByMint = new Map<string, FillQualitySnapshot>();
    let failed = 0;

    await Effect.runPromise(
        runJobPool({
            label: 'refreshClickhouseFillQualityVariants',
            items: chunks,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: mintsChunk =>
                Effect.tryPromise(async () => {
                    const snapshots = await fetchFillQualitySnapshotsChunk({
                        clickhouse: deps.clickhouse,
                        mints: mintsChunk,
                        quoteMint: FILL_QUALITY_USDC_QUOTE_MINT,
                        asOfMs,
                    });
                    for (const snapshot of snapshots) snapshotsByMint.set(snapshot.mint, snapshot);
                }),
            onItemError: mintsChunk =>
                Effect.sync(() => {
                    failed += mintsChunk.length;
                }),
        }),
    );

    const asOf = Math.floor(asOfMs / 1000);
    const lastComputedAt = deps.now();
    const rows = Array.from(snapshotsByMint.values()).map(snapshot => {
        const ratios = deriveFillQualityRatios({
            volume24hUSD: snapshot.volume24hUSD,
            botVolume24hUSD: snapshot.botVolume24hUSD,
            fee24hUSD: snapshot.fee24hUSD,
            markoutPnl24hUSD: snapshot.markoutPnl24hUSD,
        });
        const executionScore = computeVariantExecutionScore({
            volume24hUSD: snapshot.volume24hUSD,
            trade24h: snapshot.trade24h,
            flowSourceCount: snapshot.flowSourceCount,
            botVolumeRatio: ratios.botVolumeRatio,
            feeBps: ratios.feeBps,
        });
        const isEligibleForPrimary = isFillQualityEligibleForPrimary(
            {
                volume24hUSD: snapshot.volume24hUSD,
                trade24h: snapshot.trade24h,
                flowSourceCount: snapshot.flowSourceCount,
                executionScore,
                asOf,
            },
            Math.floor(lastComputedAt / 1000),
        );
        const row: VariantFillQualityUpsert = {
            mint: snapshot.mint,
            quoteMint: snapshot.quoteMint,
            volume24hUSD: snapshot.volume24hUSD,
            trade24h: snapshot.trade24h,
            botVolume24hUSD: snapshot.botVolume24hUSD,
            botTrade24h: snapshot.botTrade24h,
            botVolumeRatio: ratios.botVolumeRatio,
            fee24hUSD: snapshot.fee24hUSD,
            feeBps: ratios.feeBps,
            flowSourceCount: snapshot.flowSourceCount,
            executionScore,
            isEligibleForPrimary,
            asOf,
            lastComputedAt,
        };
        if (snapshot.markoutPnl24hUSD !== null) row.markoutPnl24hUSD = snapshot.markoutPnl24hUSD;
        if (snapshot.markoutCount !== null) row.markoutCount = snapshot.markoutCount;
        if (ratios.markoutBps !== null) row.markoutBps = ratios.markoutBps;
        return row;
    });

    if (rows.length === 0 && failed === 0) {
        // failed > 0 already produces per-chunk error logs; this warn covers the
        // silent case where ClickHouse responded but returned no matching rows.
        console.warn('[refreshClickhouseFillQualityVariants] no snapshots returned from ClickHouse', {
            requested: mints.length,
            snapshots: snapshotsByMint.size,
            failed,
            asOf,
        });
    }

    if (failed > 0 && rows.length === 0) {
        return {
            ok: true,
            processed: mints.length,
            durationMs: deps.now() - start,
            requested: mints.length,
            refreshed: 0,
            skippedMissing: Math.max(0, mints.length - failed),
            skippedIneligible: 0,
            failed,
            disabled: false,
            asOf,
        };
    }

    const replaceMissing = failed === 0 && explicitMints.length === 0;
    await deps.repo.replaceVariantFillQualityFromClickHouse({
        rows,
        replaceMissing,
        replacementMints: mints,
    });

    const skippedMissing = Math.max(0, mints.length - snapshotsByMint.size - failed);
    const skippedIneligible = rows.filter(row => !row.isEligibleForPrimary).length;

    return {
        ok: true,
        processed: mints.length,
        durationMs: deps.now() - start,
        requested: mints.length,
        refreshed: rows.length,
        skippedMissing,
        skippedIneligible,
        failed,
        disabled: false,
        asOf,
    };
}

export async function refreshClickhouseVariantMarketMetrics(
    deps: ClickhouseExtrasCronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const args = asObject(rawArgs);
    const start = deps.now();
    const requireRefreshEnabled = args.requireRefreshEnabled !== false;
    if (requireRefreshEnabled && !isRefreshEnabled(deps.env(), 'CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED')) {
        return { ok: true, processed: 0, durationMs: deps.now() - start, updated: 0, failed: 0, disabled: true };
    }
    const maxMints = clampNumber(args.maxMints, 500, 1, 1000);
    const chunkSize = clampNumber(args.chunkSize, 100, 10, 250);
    const delayMs = clampNumber(args.delayMs, 100, 0, 5_000);
    const budgetMs = clampNumber(args.budgetMs, 0, 0, 3_600_000);

    const mints = uniqueMints(deps.curated.getAllCuratedMintsInOrder()).slice(0, maxMints);
    if (mints.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.now() - start, updated: 0, failed: 0, disabled: false };
    }

    const stableMints = await deps.repo.getStableMints();
    let updated = 0;
    let failed = 0;
    let fetched = 0;

    let budgetExhausted = false;
    for (const chunk of chunkArr(mints, chunkSize)) {
        if ((budgetMs > 0 && deps.now() - start >= budgetMs) || isShuttingDown()) {
            budgetExhausted = true;
            break;
        }
        try {
            const snapshots = await deps.clickhouse.fetchSolanaMintSnapshots({ mints: chunk, stableMints });
            fetched += snapshots.length;
            if (snapshots.length > 0) {
                const result = await deps.repo.updateVariantMarketMetricsFromClickhouse({
                    rows: snapshots,
                    lastFetchedAt: start,
                });
                updated += result.updated;
            }
        } catch (err) {
            failed += chunk.length;
            console.error(
                '[refreshClickhouseVariantMarketMetrics] failed chunk',
                err instanceof Error ? err.message : String(err),
            );
            if (err instanceof ClickhouseApiError && err.permanent) {
                return {
                    ok: true,
                    processed: mints.length,
                    durationMs: deps.now() - start,
                    updated,
                    failed,
                    aborted: true,
                    disabled: false,
                };
            }
        }
        await sleep(delayMs);
    }

    const result = {
        ok: !(failed >= mints.length && updated === 0),
        processed: mints.length,
        durationMs: deps.now() - start,
        fetched,
        updated,
        failed,
        disabled: false,
        ...(budgetExhausted ? { partial: true } : {}),
    };
    console.log('[refreshClickhouseVariantMarketMetrics] run complete', JSON.stringify(result));
    return result;
}

const OHLCV_VALID_INTERVALS = new Set(['1m', '5m', '15m', '1H', '4H', '1D', '1W']);

function intervalToSeconds(interval: string): number {
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

function pickDeterministicBatch<T>(items: readonly T[], maxItems: number, windowMs: number, nowMs: number): T[] {
    if (items.length === 0) return [];
    const batchSize = Math.min(Math.max(maxItems, 1), items.length);
    const slot = Math.floor(nowMs / Math.max(windowMs, 1));
    const start = (slot * batchSize) % items.length;
    const out: T[] = [];
    for (let i = 0; i < batchSize; i++) out.push(items[(start + i) % items.length]!);
    return out;
}

interface SolanaCandleRow {
    time?: number | string;
    open?: number | string;
    high?: number | string;
    low?: number | string;
    close?: number | string;
    volume?: number | string;
    tradeCount?: number | string;
}

async function fetchSolanaCandlesForMint(params: {
    clickhouse: ClickhouseClient;
    mint: string;
    stableMints: readonly string[];
    interval: string;
    fromSec: number;
    toSec: number;
}): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number; tradeCount: number }>> {
    const stables = uniqueMints(params.stableMints);
    if (stables.length === 0) return [];
    const fromSec = Math.max(0, Math.floor(params.fromSec));
    const toSec = Math.max(0, Math.floor(params.toSec));
    if (fromSec > toSec) return [];
    const rows = await params.clickhouse.queryPreset<SolanaCandleRow>('tokens_ohlcv', {
        mint: params.mint,
        stables,
        interval: params.interval,
        fromSec,
        toSec,
    });
    return rows
        .map(row => ({
            time: Math.floor(toNonNegativeNumber(row.time)),
            open: toNonNegativeNumber(row.open),
            high: toNonNegativeNumber(row.high),
            low: toNonNegativeNumber(row.low),
            close: toNonNegativeNumber(row.close),
            volume: toNonNegativeNumber(row.volume),
            tradeCount: Math.floor(toNonNegativeNumber(row.tradeCount)),
        }))
        .filter(c => c.time > 0 && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0);
}

export async function refreshSolanaClickhouseOhlcv(
    deps: ClickhouseExtrasCronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const args = asObject(rawArgs);
    const start = deps.now();
    const interval = typeof args.interval === 'string' ? args.interval : '1H';
    if (!OHLCV_VALID_INTERVALS.has(interval)) {
        throw new InvalidArgsError(`interval must be one of: ${Array.from(OHLCV_VALID_INTERVALS).join(',')}`);
    }
    const requireRefreshEnabled = args.requireRefreshEnabled !== false;
    if (requireRefreshEnabled && !isRefreshEnabled(deps.env(), 'CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED')) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            interval,
            requested: 0,
            refreshed: 0,
            failed: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
            disabled: true,
        };
    }
    const days = clampNumber(args.days, interval === '1D' ? 365 : 7, 1, 3650);
    const maxMints = clampNumber(args.maxMints, 100, 1, 250);
    const priorityCount = clampNumber(args.priorityCount, 25, 0, 100);
    const concurrency = clampNumber(args.concurrency, 2, 1, 5);
    const delayMs = clampNumber(args.delayMs, 50, 0, 5_000);
    const budgetMs = clampNumber(args.budgetMs, 0, 0, 3_600_000);
    const selectionWindowMs = clampNumber(args.selectionWindowMs, 60 * 60_000, 10_000, 24 * 60 * 60_000);
    const upsertChunkSize = clampNumber(args.upsertChunkSize, 500, 50, 2000);

    const asOfMs = await deps.clickhouse.fetchSolanaTradesAsOfMs();
    const nowSec = Math.floor((asOfMs ?? deps.now()) / 1000);
    const requestedFrom = nowSec - days * 24 * 60 * 60;
    const requestedTo = nowSec;
    const intervalSeconds = intervalToSeconds(interval);

    const stableMints = await deps.repo.getStableMints();
    const explicitMints = parseExplicitTargets(args.mints, 'mints') ?? [];
    const allCurated = uniqueStringsRaw(deps.curated.getAllCuratedMintsInOrder());
    const priority = priorityCount > 0 ? allCurated.slice(0, priorityCount) : [];
    const selected = explicitMints.length > 0
        ? explicitMints.slice(0, Math.min(maxMints, 500))
        : pickDeterministicBatch(allCurated, maxMints, selectionWindowMs, deps.now());
    const mints = uniqueStringsRaw([...(explicitMints.length > 0 ? [] : priority), ...selected]).slice(0, maxMints);

    if (mints.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            interval,
            requested: 0,
            refreshed: 0,
            failed: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
            disabled: false,
        };
    }

    let refreshed = 0;
    let failed = 0;
    let inserted = 0;
    let updated = 0;
    let skippedTotal = 0;
    // 4xx (unknown preset / bad params) fails identically for every mint —
    // abort the run instead of hammering.
    let abortedPermanently = false;

    const summary = await Effect.runPromise(
        runJobPool({
            label: `refreshSolanaClickhouseOhlcv:${interval}`,
            items: mints,
            concurrency,
            delayMs,
            staggerMs: WORKER_STARTUP_STAGGER_MS,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: () => abortedPermanently || isShuttingDown(),
            process: mint =>
                Effect.tryPromise(async () => {
                const bounds = await deps.repo.getSolanaOhlcvBounds(mint, interval);
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
                    skippedTotal += 1;
                    return;
                }
                for (const segment of segments) {
                    const candles = await fetchSolanaCandlesForMint({
                        clickhouse: deps.clickhouse,
                        mint,
                        stableMints,
                        interval,
                        fromSec: segment.from,
                        toSec: segment.to,
                    });
                    for (const candlesChunk of chunkArr(candles, upsertChunkSize)) {
                        const result = await deps.repo.upsertSolanaOhlcv({
                            address: mint,
                            interval,
                            source: 'clickhouse_trades',
                            candles: candlesChunk,
                        });
                        inserted += result.inserted;
                        updated += result.updated;
                        skippedTotal += result.skipped;
                    }
                }
                refreshed += 1;
                }),
            onItemError: (_mint, err) =>
                Effect.sync(() => {
                    if (err instanceof ClickhouseApiError && err.permanent) {
                        abortedPermanently = true;
                    }
                }),
        }),
    );

    // Aborted runs count the drained remainder as failed (parity with the old
    // `failed += remaining; nextIndex = mints.length` fast-exit).
    failed = summary.failed + (abortedPermanently ? summary.deadlineSkipped : 0);
    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && skippedTotal === 0 && failed >= summary.attempted),
        processed: mints.length,
        durationMs: deps.now() - start,
        interval,
        requested: mints.length,
        refreshed,
        failed,
        inserted,
        updated,
        skipped: skippedTotal,
        disabled: false,
        ...(summary.partial && !abortedPermanently ? { partial: true } : {}),
    };
}

interface StockCandleRow {
    time?: number | string;
    open?: number | string;
    high?: number | string;
    low?: number | string;
    close?: number | string;
    volume?: number | string;
}

function normalizeStockCandles(rows: StockCandleRow[]): Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}> {
    return rows
        .map(row => ({
            time: Math.floor(toNonNegativeNumber(row.time)),
            open: toFiniteNumber(row.open) ?? 0,
            high: toFiniteNumber(row.high) ?? 0,
            low: toFiniteNumber(row.low) ?? 0,
            close: toFiniteNumber(row.close) ?? 0,
            volume: toFiniteNumber(row.volume) ?? 0,
        }))
        .filter(c => c.time > 0 && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0);
}

async function fetchStockCandlesFromTrades(params: {
    clickhouse: ClickhouseClient;
    symbol: string;
    interval: string;
    fromSec: number;
    toSec: number;
}): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
    const rows = await params.clickhouse.queryPreset<StockCandleRow>('stock_candles_trades', {
        symbol: params.symbol.toUpperCase(),
        interval: params.interval,
        fromSec: Math.max(0, Math.floor(params.fromSec)),
        toSec: Math.max(0, Math.floor(params.toSec)),
    });
    return normalizeStockCandles(rows);
}

async function fetchStockCandlesFromBbo(params: {
    clickhouse: ClickhouseClient;
    symbol: string;
    interval: string;
    fromSec: number;
    toSec: number;
}): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> | null> {
    try {
        const rows = await params.clickhouse.queryPreset<StockCandleRow>('stock_candles_bbo', {
            symbol: params.symbol.toUpperCase(),
            interval: params.interval,
            fromSec: Math.max(0, Math.floor(params.fromSec)),
            toSec: Math.max(0, Math.floor(params.toSec)),
        });
        return normalizeStockCandles(rows);
    } catch (err) {
        console.warn(
            '[refreshPublicEquityStockOhlcv] BBO candle query failed',
            err instanceof Error ? err.message : String(err),
        );
        return null;
    }
}

async function fetchStockCandles(params: {
    clickhouse: ClickhouseClient;
    symbol: string;
    interval: string;
    fromSec: number;
    toSec: number;
}): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
    const tradeCandles = await fetchStockCandlesFromTrades(params);
    if (tradeCandles.length > 0) return tradeCandles;
    const bboCandles = await fetchStockCandlesFromBbo(params);
    return bboCandles ?? [];
}

export async function refreshPublicEquityStockOhlcv(
    deps: ClickhouseExtrasCronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const args = asObject(rawArgs);
    const start = deps.now();
    const interval = typeof args.interval === 'string' ? args.interval : '1H';
    if (!OHLCV_VALID_INTERVALS.has(interval)) {
        throw new InvalidArgsError(`interval must be one of: ${Array.from(OHLCV_VALID_INTERVALS).join(',')}`);
    }
    const requireRefreshEnabled = args.requireRefreshEnabled !== false;
    if (requireRefreshEnabled && !isRefreshEnabled(deps.env(), 'CLICKHOUSE_STOCK_REFRESH_ENABLED')) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            interval,
            requested: 0,
            refreshed: 0,
            failed: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
            disabled: true,
        };
    }
    const days = clampNumber(args.days, interval === '1D' ? 365 : 7, 1, 3650);
    const maxAssets = clampNumber(args.maxAssets, 250, 1, 1000);
    const concurrency = clampNumber(args.concurrency, 2, 1, 5);
    const delayMs = clampNumber(args.delayMs, 0, 0, 5_000);
    const budgetMs = clampNumber(args.budgetMs, 0, 0, 3_600_000);
    const selectionWindowMs = clampNumber(args.selectionWindowMs, 60 * 60_000, 10_000, 24 * 60 * 60_000);
    const upsertChunkSize = clampNumber(args.upsertChunkSize, 1000, 50, 2000);
    const explicitAssetIds = parseExplicitTargets(args.assetIds, 'assetIds');

    const mappings = await deps.repo.listActiveStockMappings(1000);
    if (mappings.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            interval,
            requested: 0,
            refreshed: 0,
            failed: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
            disabled: false,
        };
    }
    let selected: Array<{ assetId: string; symbol: string; normalizedSymbol: string }>;
    if (explicitAssetIds) {
        const wanted = new Set(explicitAssetIds);
        selected = mappings.filter(m => wanted.has(m.assetId));
    } else {
        selected = pickDeterministicBatch(mappings, maxAssets, selectionWindowMs, deps.now());
    }

    const nowSec = Math.floor(deps.now() / 1000);
    const requestedFrom = nowSec - days * 24 * 60 * 60;
    const requestedTo = nowSec;
    const intervalSeconds = intervalToSeconds(interval);

    let refreshed = 0;
    let failed = 0;
    let inserted = 0;
    let updated = 0;
    let skippedTotal = 0;
    const summary = await Effect.runPromise(
        runJobPool({
            label: `refreshPublicEquityStockOhlcv:${interval}`,
            items: selected,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: mapping =>
                Effect.tryPromise(async () => {
                const bounds = await deps.repo.getStockOhlcvBounds(mapping.assetId, interval);
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
                    skippedTotal += 1;
                    return;
                }
                for (const segment of segments) {
                    const candles = await fetchStockCandles({
                        clickhouse: deps.clickhouse,
                        symbol: mapping.symbol,
                        interval,
                        fromSec: segment.from,
                        toSec: segment.to,
                    });
                    for (const candlesChunk of chunkArr(candles, upsertChunkSize)) {
                        const result = await deps.repo.upsertStockOhlcv({
                            assetId: mapping.assetId,
                            symbol: mapping.symbol,
                            interval,
                            source: 'clickhouse_stock',
                            candles: candlesChunk.map(c => ({ ...c, tradeCount: 0 })),
                        });
                        inserted += result.inserted;
                        updated += result.updated;
                        skippedTotal += result.skipped;
                    }
                }
                refreshed += 1;
                }),
        }),
    );

    failed = summary.failed;
    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && skippedTotal === 0 && failed >= summary.attempted),
        processed: selected.length,
        durationMs: deps.now() - start,
        interval,
        requested: selected.length,
        refreshed,
        failed,
        inserted,
        updated,
        skipped: skippedTotal,
        disabled: false,
        ...(summary.partial ? { partial: true } : {}),
    };
}

export type ClickhouseExtrasJobHandler = (
    deps: ClickhouseExtrasCronDeps,
    args: unknown,
) => Promise<CronResult>;

export const clickhouseExtrasJobs: Record<string, ClickhouseExtrasJobHandler> = {
    'refresh-solana-clickhouse-trending-markets': refreshSolanaClickhouseTrendingMarkets,
    'refresh-clickhouse-variant-market-metrics': refreshClickhouseVariantMarketMetrics,
    'refresh-clickhouse-fill-quality-variants': refreshClickhouseFillQualityVariants,
    'refresh-solana-clickhouse-ohlcv-15m': refreshSolanaClickhouseOhlcv,
    'refresh-solana-clickhouse-ohlcv-1h': refreshSolanaClickhouseOhlcv,
    'refresh-solana-clickhouse-ohlcv-4h': refreshSolanaClickhouseOhlcv,
    'refresh-solana-clickhouse-ohlcv-1d': refreshSolanaClickhouseOhlcv,
    'refresh-solana-clickhouse-ohlcv-1w': refreshSolanaClickhouseOhlcv,
    'refresh-public-equity-stock-ohlcv-1h': refreshPublicEquityStockOhlcv,
    'refresh-public-equity-stock-ohlcv-4h': refreshPublicEquityStockOhlcv,
    'refresh-public-equity-stock-ohlcv-1d': refreshPublicEquityStockOhlcv,
};
