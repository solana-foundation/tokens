import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { isTotalFailure, runJobPool } from '@tokens/effect/job-runner';
import type { AssetCategory } from '@tokens/asset-registry';
import { getVariantByMint } from '@tokens/asset-registry';

import type { CronResult } from './crons';

export type TrendingMarketSource = 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';

export const FRESH_TRENDING_SCORING_VERSION = 'birdeye-selected-fresh-v1';

export const TRENDING_EXCLUDED_ASSET_IDS = new Set<string>(['solana']);
export const TRENDING_EXCLUDED_CATEGORIES = new Set<AssetCategory>(['stablecoin']);

const FRESH_TRENDING_MAX_AGE_MS = 10 * 60_000;
const WORKER_STARTUP_STAGGER_MS = 100;

export interface VariantMarketSnapshot {
    mint: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    logoURI: string | null;
    source: TrendingMarketSource | null;
    metricsSource: TrendingMarketSource | null;
    price: number | null;
    liquidity: number | null;
    volume1hUSD: number | null;
    volume24hUSD: number | null;
    trade1h: number | null;
    trade24h: number | null;
    uniqueWallet1h: number | null;
    uniqueWallet24h: number | null;
    priceChange1hPercent: number | null;
    priceChange24hPercent: number | null;
    lastTradeAt: number | null;
    asOf: number | null;
    lastFetchedAt: number;
}

export interface FlowTrendingMarketRow {
    mint: string;
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
}

export interface FreshTrendingMarketRow {
    mint: string;
    assetId: string;
    variantId: string;
    category: AssetCategory;
    symbol: string;
    name: string;
    decimals?: number;
    logoURI?: string;
    source: TrendingMarketSource;
    metricsSource: TrendingMarketSource;
    scoringVersion: string;
    price?: number;
    liquidity?: number;
    volume5mUSD?: number;
    volume15mUSD?: number;
    volume1hUSD?: number;
    volume6hUSD?: number;
    volume24hUSD?: number;
    trade5m?: number;
    trade15m?: number;
    trade1h?: number;
    trade6h?: number;
    trade24h?: number;
    uniqueWallet5m?: number;
    uniqueWallet1h?: number;
    uniqueWallet24h?: number;
    priceChange1hPercent?: number;
    priceChange24hPercent?: number;
    lastTradeAt?: number;
    asOf?: number;
    lastFetchedAt: number;
    trendingScore: number;
    rank: number;
    categoryRank: number;
    lastComputedAt: number;
}

export interface TrendingRepo {
    listFlowTrendingMints(limit: number): Promise<string[]>;
    findVariantMarketSnapshotsByMints(mints: readonly string[]): Promise<VariantMarketSnapshot[]>;
    findFlowTrendingMarketsByMints(mints: readonly string[]): Promise<FlowTrendingMarketRow[]>;
    replaceFreshTrendingMarkets(rows: readonly FreshTrendingMarketRow[]): Promise<{ upserted: number; deleted: number }>;
}

export interface TrendingCronDeps {
    repo: TrendingRepo;
    now: () => number;
    /** DB-backed curated universe (effective membership snapshot). */
    listCanonicalCuratedMints: () => string[];
    isRefreshEnabled?: () => boolean;
}

function defaultIsRefreshEnabled(): boolean {
    const explicit = (process.env.FRESH_TRENDING_REFRESH_ENABLED ?? '').trim().toLowerCase();
    if (explicit) return explicit === 'true';
    return (process.env.CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED ?? '').trim().toLowerCase() === 'true';
}

function uniqueStrings(values: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
        const value = raw.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function finiteNumber(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
}

function logScore(value: number | null | undefined, scale: number): number {
    return clamp(Math.log1p(Math.max(finiteNumber(value), 0)) / Math.log1p(scale), 0, 1);
}

function ratioScore(ratio: number): number {
    return clamp(Math.log2(Math.max(finiteNumber(ratio), 1)) / 4, 0, 1);
}

function ratio(numerator: number | null | undefined, denominator: number): number {
    return finiteNumber(numerator) / Math.max(finiteNumber(denominator), 1);
}

function normalizeTimestampMs(value: number | null | undefined): number {
    const timestamp = finiteNumber(value);
    if (timestamp <= 0) return 0;
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function recencyScore(lastActivityAt: number | null | undefined, nowMs: number): number {
    const last = normalizeTimestampMs(lastActivityAt);
    const current = normalizeTimestampMs(nowMs);
    if (last <= 0 || current <= 0 || last > current) return 0;
    const ageMs = current - last;
    const freshMs = 5 * 60_000;
    const staleMs = 60 * 60_000;
    if (ageMs <= freshMs) return 1;
    if (ageMs >= staleMs) return 0;
    return 1 - (ageMs - freshMs) / (staleMs - freshMs);
}

export interface FreshTrendingScoreInput {
    volume1hUSD: number | null;
    volume24hUSD: number | null;
    trade1h: number | null;
    trade24h: number | null;
    uniqueWallet1h: number | null;
    uniqueWallet24h: number | null;
    priceChange1hPercent: number | null;
    priceChange24hPercent: number | null;
    lastTradeAt: number | null;
    lastFetchedAt: number | null;
    nowMs: number;
}

export function computeFreshTrendingScore(input: FreshTrendingScoreInput): number {
    const hasActivity =
        finiteNumber(input.volume1hUSD) > 0 ||
        finiteNumber(input.volume24hUSD) > 0 ||
        finiteNumber(input.trade1h) > 0 ||
        finiteNumber(input.trade24h) > 0 ||
        finiteNumber(input.uniqueWallet1h) > 0 ||
        finiteNumber(input.uniqueWallet24h) > 0;
    if (!hasActivity) return 0;
    const lastActivityAt = input.lastTradeAt ?? input.lastFetchedAt ?? null;
    const score =
        100 *
        (0.24 * logScore(input.volume1hUSD, 1_000_000) +
            0.14 * logScore(input.volume24hUSD, 10_000_000) +
            0.16 * logScore(input.trade1h, 5_000) +
            0.08 * logScore(input.trade24h, 50_000) +
            0.12 * logScore(input.uniqueWallet1h, 1_000) +
            0.06 * logScore(input.uniqueWallet24h, 10_000) +
            0.08 * ratioScore(ratio(input.volume1hUSD, finiteNumber(input.volume24hUSD) / 24)) +
            0.06 * ratioScore(ratio(input.trade1h, finiteNumber(input.trade24h) / 24)) +
            0.04 * clamp(Math.abs(finiteNumber(input.priceChange1hPercent)) / 10, 0, 1) +
            0.02 * recencyScore(lastActivityAt, input.nowMs));
    return Math.round(clamp(score, 0, 100) * 10_000) / 10_000;
}

function includesText(haystack: string, needle: string): boolean {
    return haystack.toLowerCase().includes(needle.toLowerCase());
}

function displayVariantLabel(label: string): string {
    return label.replace(/\bBackpack Securities\b/gi, 'BP Securities');
}

function displayTrendingName(name: string): string {
    return name.replace(/\bBackpack Securities\b/gi, 'BP Securities');
}

export function getRegistryTrendingIdentity(mint: string): {
    assetId: string;
    variantId: string;
    category: AssetCategory;
    symbol: string;
    name: string;
} | null {
    const match = getVariantByMint(mint);
    if (!match) return null;
    const symbol = (match.variant.symbol ?? match.asset.symbol ?? match.variant.label ?? '').trim();
    const baseName = (match.variant.name ?? match.asset.name ?? '').trim();
    const variantLabel = displayVariantLabel((match.variant.label ?? '').trim());
    const name =
        baseName && variantLabel && !includesText(baseName, variantLabel)
            ? `${baseName} - ${variantLabel}`
            : baseName || variantLabel || symbol;
    if (!symbol || !name) return null;
    return {
        assetId: match.asset.assetId,
        variantId: match.variant.variantId,
        category: match.asset.category,
        symbol,
        name,
    };
}

function hasMeaningfulActivity(market: VariantMarketSnapshot): boolean {
    return (
        (market.volume1hUSD ?? 0) >= 100 ||
        (market.volume24hUSD ?? 0) >= 1_000 ||
        (market.trade1h ?? 0) >= 3 ||
        (market.trade24h ?? 0) >= 10
    );
}

function isFreshEnough(
    source: TrendingMarketSource,
    metricsSource: TrendingMarketSource,
    lastFetchedAt: number,
    nowMs: number,
): boolean {
    if (source === 'clickhouse_trades' || metricsSource === 'clickhouse_trades') return true;
    return nowMs - lastFetchedAt <= FRESH_TRENDING_MAX_AGE_MS;
}

function pickFullerText(primary: string | null | undefined, fallback: string): string {
    if (!primary) return fallback;
    return primary.length >= fallback.length ? primary : fallback;
}

export interface FreshTrendingRefreshResult extends CronResult {
    requested: number;
    scored: number;
    skippedNoMarket: number;
    skippedIneligible: number;
    disabled: boolean;
    asOf: number | null;
}

export async function refreshFreshTrendingMarkets(
    deps: TrendingCronDeps,
    rawArgs: unknown,
): Promise<FreshTrendingRefreshResult> {
    const args = (rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {});
    const start = deps.now();
    const requireRefreshEnabled = args.requireRefreshEnabled === false ? false : true;
    const isEnabled = (deps.isRefreshEnabled ?? defaultIsRefreshEnabled)();
    if (requireRefreshEnabled && !isEnabled) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            requested: 0,
            scored: 0,
            skippedNoMarket: 0,
            skippedIneligible: 0,
            disabled: true,
            asOf: null,
        };
    }
    const maxMints = Math.min(Math.max(Math.floor(typeof args.maxMints === 'number' ? args.maxMints : 1500), 1), 1500);
    const limit = Math.min(Math.max(Math.floor(typeof args.limit === 'number' ? args.limit : 50), 1), 50);
    const concurrency = Math.min(
        Math.max(Math.floor(typeof args.concurrency === 'number' ? args.concurrency : 3), 1),
        8,
    );

    const nowMs = deps.now();
    const flowMints = await deps.repo.listFlowTrendingMints(maxMints);
    const curatedMints = deps.listCanonicalCuratedMints();
    const mints = uniqueStrings([...curatedMints, ...flowMints]).slice(0, maxMints);
    if (mints.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            requested: 0,
            scored: 0,
            skippedNoMarket: 0,
            skippedIneligible: 0,
            disabled: false,
            asOf: null,
        };
    }
    const marketRows = new Map<string, VariantMarketSnapshot>();
    const flowRows = new Map<string, FlowTrendingMarketRow>();
    const chunks = chunkArray(mints, 250);
    const poolSummary = await Effect.runPromise(
        runJobPool({
            label: 'refreshFreshTrendingMarkets',
            items: chunks,
            concurrency,
            staggerMs: WORKER_STARTUP_STAGGER_MS,
            shouldStop: isShuttingDown,
            process: mintsChunk =>
                Effect.tryPromise(async () => {
                    const [markets, flow] = await Promise.all([
                        deps.repo.findVariantMarketSnapshotsByMints(mintsChunk),
                        deps.repo.findFlowTrendingMarketsByMints(mintsChunk),
                    ]);
                    for (const row of markets) marketRows.set(row.mint, row);
                    for (const row of flow) flowRows.set(row.mint, row);
                }),
        }),
    );
    // Previously any chunk failure aborted the whole job with an opaque 500;
    // now failed chunks degrade the ranking input instead — but a run where
    // every chunk failed must not overwrite rankings with an empty scoreboard.
    if (isTotalFailure(poolSummary)) {
        throw new Error(
            `[refreshFreshTrendingMarkets] all ${poolSummary.attempted} market-snapshot chunks failed`,
        );
    }

    type Candidate = Omit<FreshTrendingMarketRow, 'rank' | 'categoryRank' | 'scoringVersion' | 'lastComputedAt'>;
    const candidates: Candidate[] = [];
    let skippedNoMarket = 0;
    let skippedIneligible = 0;
    for (const mint of mints) {
        const market = marketRows.get(mint);
        const flow = flowRows.get(mint);
        if (!market) {
            skippedNoMarket += 1;
            continue;
        }
        const identity = getRegistryTrendingIdentity(mint);
        const source = market.source;
        const metricsSource = market.metricsSource ?? source;
        const lastFetchedAt = market.lastFetchedAt;
        if (
            !identity ||
            !source ||
            !metricsSource ||
            !Number.isFinite(lastFetchedAt) ||
            TRENDING_EXCLUDED_ASSET_IDS.has(identity.assetId) ||
            TRENDING_EXCLUDED_CATEGORIES.has(identity.category) ||
            !hasMeaningfulActivity(market) ||
            !isFreshEnough(source, metricsSource, lastFetchedAt, nowMs)
        ) {
            skippedIneligible += 1;
            continue;
        }
        const trendingScore = computeFreshTrendingScore({
            volume1hUSD: market.volume1hUSD,
            volume24hUSD: market.volume24hUSD,
            trade1h: market.trade1h,
            trade24h: market.trade24h,
            uniqueWallet1h: market.uniqueWallet1h,
            uniqueWallet24h: market.uniqueWallet24h,
            priceChange1hPercent: market.priceChange1hPercent,
            priceChange24hPercent: market.priceChange24hPercent,
            lastTradeAt: market.lastTradeAt,
            lastFetchedAt,
            nowMs,
        });
        if (trendingScore <= 0) {
            skippedIneligible += 1;
            continue;
        }
        const candidate: Candidate = {
            mint,
            assetId: identity.assetId,
            variantId: identity.variantId,
            category: identity.category,
            symbol: identity.symbol,
            name: displayTrendingName(pickFullerText(market.name, identity.name)),
            source,
            metricsSource,
            lastFetchedAt,
            trendingScore,
        };
        if (market.decimals !== null) candidate.decimals = market.decimals;
        if (market.logoURI) candidate.logoURI = market.logoURI;
        if (market.price !== null) candidate.price = market.price;
        if (market.liquidity !== null) candidate.liquidity = market.liquidity;
        if (flow) {
            candidate.volume5mUSD = flow.volume5mUSD;
            candidate.volume15mUSD = flow.volume15mUSD;
            candidate.volume6hUSD = flow.volume6hUSD;
            candidate.trade5m = flow.trade5m;
            candidate.trade15m = flow.trade15m;
            candidate.trade6h = flow.trade6h;
            candidate.uniqueWallet5m = flow.uniqueWallet5m;
        }
        if (market.volume1hUSD !== null) candidate.volume1hUSD = market.volume1hUSD;
        if (market.volume24hUSD !== null) candidate.volume24hUSD = market.volume24hUSD;
        if (market.trade1h !== null) candidate.trade1h = market.trade1h;
        if (market.trade24h !== null) candidate.trade24h = market.trade24h;
        if (market.uniqueWallet1h !== null) candidate.uniqueWallet1h = market.uniqueWallet1h;
        if (market.uniqueWallet24h !== null) candidate.uniqueWallet24h = market.uniqueWallet24h;
        if (market.priceChange1hPercent !== null) candidate.priceChange1hPercent = market.priceChange1hPercent;
        if (market.priceChange24hPercent !== null) candidate.priceChange24hPercent = market.priceChange24hPercent;
        if (market.lastTradeAt !== null) candidate.lastTradeAt = market.lastTradeAt;
        if (market.asOf !== null) candidate.asOf = market.asOf;
        candidates.push(candidate);
    }
    candidates.sort(
        (a, b) =>
            b.trendingScore - a.trendingScore ||
            (b.volume1hUSD ?? 0) - (a.volume1hUSD ?? 0) ||
            (b.trade1h ?? 0) - (a.trade1h ?? 0) ||
            a.symbol.localeCompare(b.symbol),
    );
    const categoryRankByCategory = new Map<AssetCategory, number>();
    const rows: FreshTrendingMarketRow[] = candidates.slice(0, limit).map((row, index) => {
        const nextCategoryRank = (categoryRankByCategory.get(row.category) ?? 0) + 1;
        categoryRankByCategory.set(row.category, nextCategoryRank);
        return {
            ...row,
            rank: index + 1,
            categoryRank: nextCategoryRank,
            scoringVersion: FRESH_TRENDING_SCORING_VERSION,
            lastComputedAt: nowMs,
        };
    });
    if (rows.length === 0) {
        console.warn('[refreshFreshTrendingMarkets] skipping replacement with no candidates', {
            requested: mints.length,
            skippedNoMarket,
            skippedIneligible,
        });
        return {
            ok: true,
            processed: mints.length,
            durationMs: deps.now() - start,
            requested: mints.length,
            scored: 0,
            skippedNoMarket,
            skippedIneligible,
            disabled: false,
            asOf: null,
        };
    }
    await deps.repo.replaceFreshTrendingMarkets(rows);
    const asOf = rows.reduce<number | null>(
        (max, row) => (max === null ? row.lastFetchedAt : Math.max(max, row.lastFetchedAt)),
        null,
    );
    return {
        ok: true,
        processed: mints.length,
        durationMs: deps.now() - start,
        requested: mints.length,
        scored: rows.length,
        skippedNoMarket,
        skippedIneligible,
        disabled: false,
        asOf,
    };
}

export type TrendingJobHandler = (deps: TrendingCronDeps, args: unknown) => Promise<CronResult>;

export const trendingJobs: Record<string, TrendingJobHandler> = {
    'refresh-fresh-trending-markets': refreshFreshTrendingMarkets,
};
