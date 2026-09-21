import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { runJobPool } from '@tokens/effect/job-runner';
import type { CronDeps, CronResult } from './crons';
import { InvalidArgsError, parseExplicitTargets } from './crons';

export interface TokenUpsertFromBirdeye {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logoUri?: string;
    price?: number;
    priceChange24hPercent?: number;
    priceChange1hPercent?: number;
    volume24hUSD?: number;
    liquidity?: number;
    marketCap?: number;
    lastFetchedAt: number;
}

export interface TokenMarketEntry {
    address: string;
    name?: string;
    base?: {
        address: string;
        decimals?: number;
        symbol?: string;
        icon?: string;
        name?: string;
    };
    quote?: {
        address: string;
        decimals?: number;
        symbol?: string;
        icon?: string;
        name?: string;
    };
    source?: string;
    createdAt?: string;
    liquidity?: number;
    volume24h?: number;
    trade24h?: number;
    trade24hChangePercent?: number;
    uniqueWallet24h?: number;
    uniqueWallet24hChangePercent?: number;
    price?: number;
}

export interface TokenMarketsUpsert {
    mint: string;
    markets: TokenMarketEntry[];
    lastFetchedAt: number;
}

export interface MiscJobsRepo {
    listStaleTokenAddresses(beforeLastFetchedAt: number, limit: number): Promise<string[]>;
    upsertTokenFromBirdeye(args: TokenUpsertFromBirdeye): Promise<void>;

    getTokenMarketsLastFetchedAtByMint(mint: string): Promise<number | null>;
    upsertTokenMarketsLatest(args: TokenMarketsUpsert): Promise<void>;
    touchTokenMarketsLatest(mint: string, lastFetchedAt: number): Promise<void>;
}

export interface BirdeyeMarketsClient {
    fetchTokenMarkets(args: { address: string; limit: number }): Promise<TokenMarketEntry[]>;
}

export interface MiscCronDeps {
    base: CronDeps;
    repo: MiscJobsRepo;
    birdeyeMarkets: BirdeyeMarketsClient;
}

export type MiscJobHandler = (deps: MiscCronDeps, args: unknown) => Promise<CronResult>;

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

function cleanTokenName(name: string | undefined): string {
    if (!name) return 'Unknown';
    return (
        name
            .replace(/\s*xStock\s*$/i, '')
            .replace(/\s*\(\s*(wormhole|bridged|wrapped|omnibridge|coinbase|ondo\s+tokenized)\s*\)\s*/gi, ' ')
            .replace(/\s*\(\s*mSOL\s*\)\s*/gi, ' ')
            .replace(/^\s*coinbase\s+wrapped\s+/i, '')
            .replace(/^\s*wrapped\s+/i, '')
            .replace(/\s+wrapped\s+/gi, ' ')
            .replace(/\s+wrapped\s*$/i, '')
            .replace(/\s+staked\s+sol(?=\s*(\(|$))/i, '')
            .replace(/\s{2,}/g, ' ')
            .trim() || 'Unknown'
    );
}

export function birdeyeOverviewToTokenUpsert(
    address: string,
    overview: Record<string, unknown>,
    lastFetchedAt: number,
): TokenUpsertFromBirdeye | null {
    const symbol = typeof overview.symbol === 'string' ? overview.symbol.trim() : '';
    const rawName = typeof overview.name === 'string' ? overview.name.trim() : '';
    const name = cleanTokenName(rawName);
    if (!symbol) return null;
    if (!name || name === 'Unknown') return null;
    const decimals =
        typeof overview.decimals === 'number' && Number.isFinite(overview.decimals) ? overview.decimals : 9;
    const out: TokenUpsertFromBirdeye = { address, symbol, name, decimals, lastFetchedAt };
    const logo = typeof overview.logoURI === 'string' ? overview.logoURI.trim() : '';
    if (logo) out.logoUri = logo;
    if (typeof overview.price === 'number' && Number.isFinite(overview.price)) out.price = overview.price;
    if (typeof overview.priceChange24hPercent === 'number' && Number.isFinite(overview.priceChange24hPercent))
        out.priceChange24hPercent = overview.priceChange24hPercent;
    if (typeof overview.priceChange1hPercent === 'number' && Number.isFinite(overview.priceChange1hPercent))
        out.priceChange1hPercent = overview.priceChange1hPercent;
    if (typeof overview.v24hUSD === 'number' && Number.isFinite(overview.v24hUSD))
        out.volume24hUSD = overview.v24hUSD;
    if (typeof overview.liquidity === 'number' && Number.isFinite(overview.liquidity))
        out.liquidity = overview.liquidity;
    if (typeof overview.marketCap === 'number' && Number.isFinite(overview.marketCap))
        out.marketCap = overview.marketCap;
    return out;
}

export async function refreshStaleTokens(deps: MiscCronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = asObject(rawArgs);
    const maxTokens = clampInt(args.maxTokens, 50, 1, 250);
    const minAgeMs = clampInt(args.minAgeMs, 60_000, 10_000, 24 * 60 * 60_000);
    const concurrency = clampInt(args.concurrency, 2, 1, 5);
    const delayMs = clampInt(args.delayMs, 200, 0, 5_000);
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);

    const start = deps.base.now();
    const beforeLastFetchedAt = start - minAgeMs;
    const addresses = await deps.repo.listStaleTokenAddresses(beforeLastFetchedAt, maxTokens);

    let refreshed = 0;
    let softFailed = 0;

    if (addresses.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.base.now() - start, refreshed, failed: 0 };
    }

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'refreshStaleTokens',
            items: addresses,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: address =>
                Effect.tryPromise(async () => {
                    const overview = await deps.base.birdeye.fetchTokenOverview(address);
                    if (!overview) {
                        softFailed += 1;
                        return;
                    }
                    const upsert = birdeyeOverviewToTokenUpsert(
                        address,
                        overview as unknown as Record<string, unknown>,
                        start,
                    );
                    if (!upsert) {
                        softFailed += 1;
                        return;
                    }
                    await deps.repo.upsertTokenFromBirdeye(upsert);
                    refreshed += 1;
                }),
        }),
    );

    const failed = softFailed + summary.failed;
    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && failed >= summary.attempted),
        processed: addresses.length,
        durationMs: deps.base.now() - start,
        refreshed,
        failed,
        ...(summary.partial ? { partial: true } : {}),
    };
}

export async function refreshCuratedTokenMarkets(deps: MiscCronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = asObject(rawArgs);
    const priorityCount = clampInt(args.priorityCount, 25, 0, 100);
    const maxMints = clampInt(args.maxMints, 25, 1, 250);
    const minAgeMs = clampInt(args.minAgeMs, 5 * 60_000, 10_000, 24 * 60 * 60_000);
    const concurrency = clampInt(args.concurrency, 2, 1, 5);
    const delayMs = clampInt(args.delayMs, 200, 0, 5_000);
    const maxMarketsPerMint = clampInt(args.maxMarketsPerMint, 20, 1, 20);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 60_000, 10_000, 24 * 60 * 60_000);
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);

    const explicitMints = parseExplicitTargets(args.mints, 'mints');

    const start = deps.base.now();
    let mints: string[];
    if (explicitMints) {
        mints = explicitMints;
    } else {
        const allMints = deps.base.curated.getAllCuratedMintsInOrder();
        const priorityMints = priorityCount > 0 ? allMints.slice(0, priorityCount) : [];
        const selectedMints = pickDeterministicBatch(allMints, maxMints, selectionWindowMs, start);
        mints = uniqueStrings([...priorityMints, ...selectedMints]).slice(0, 250);
    }

    let refreshed = 0;
    let skipped = 0;

    if (mints.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.base.now() - start, refreshed, skipped, failed: 0 };
    }

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'refreshCuratedTokenMarkets',
            items: mints,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: mint =>
                Effect.tryPromise(async () => {
                    const last = await deps.repo.getTokenMarketsLastFetchedAtByMint(mint);
                    if (last !== null && start - last < minAgeMs) {
                        skipped += 1;
                        return;
                    }
                    const markets = await deps.birdeyeMarkets.fetchTokenMarkets({
                        address: mint,
                        limit: maxMarketsPerMint,
                    });
                    await deps.repo.upsertTokenMarketsLatest({ mint, markets, lastFetchedAt: start });
                    refreshed += 1;
                }),
            onItemError: mint =>
                Effect.tryPromise(() => deps.repo.touchTokenMarketsLatest(mint, start)),
        }),
    );

    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && skipped === 0 && summary.failed >= summary.attempted),
        processed: mints.length,
        durationMs: deps.base.now() - start,
        refreshed,
        skipped,
        failed: summary.failed,
        ...(summary.partial ? { partial: true } : {}),
    };
}

export const miscJobs: Record<string, MiscJobHandler> = {
    'refresh-token-prices': refreshStaleTokens,
    'refresh-curated-token-markets': refreshCuratedTokenMarkets,
};

export const __testing = {
    cleanTokenName,
    birdeyeOverviewToTokenUpsert,
    pickDeterministicBatch,
    uniqueStrings,
};
