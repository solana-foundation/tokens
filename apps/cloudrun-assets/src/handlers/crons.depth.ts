import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { runJobPool } from '@tokens/effect/job-runner';
import { isSpotLikeVariantKind, listAssets } from '@tokens/asset-registry';

import type { CronResult } from './crons';

export const DEPTH_QUOTE_SOURCES = ['titan', 'jupiter_lite'] as const;
export type DepthQuoteSourceId = (typeof DEPTH_QUOTE_SOURCES)[number];

export const DEPTH_USDC_QUOTE_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DEPTH_SIZE_LADDER_USD = [10_000, 100_000, 1_000_000, 5_000_000] as const;
const USDC_DECIMALS_FACTOR = 1_000_000;

/** Stablecoin aggregates: USDC-quoted USD-variant curves are degenerate. */
const DEPTH_EXCLUDED_ASSET_IDS = new Set(['usd', 'eur']);

export interface DepthQuote {
    inAmount: number;
    outAmount: number;
    routeVenues: string[];
    contextSlot?: number;
}

export interface DepthQuoteClient {
    id: DepthQuoteSourceId;
    /** Resolves null for untradable pairs / no-route; throws on transport failures. */
    fetchQuote(args: {
        inputMint: string;
        outputMint: string;
        amount: number;
        slippageBps?: number;
    }): Promise<DepthQuote | null>;
    close(): Promise<void>;
}

export interface DepthLadderPoint {
    sizeUsd: number;
    inAmount: number;
    outAmount: number;
    priceImpactBps: number | null;
    effectivePrice: number;
    routeVenues: string[];
    contextSlot?: number;
}

export interface VariantDepthCurveUpsert {
    mint: string;
    quoteMint: string;
    side: 'buy' | 'sell';
    source: DepthQuoteSourceId;
    ladder: DepthLadderPoint[];
    points: number;
    failedPoints: number;
    asOf: number;
    lastComputedAt: number;
}

export interface DepthCronRepo {
    /** Stalest-first shard selection; mints without a row lead. */
    selectStalestDepthMints(args: {
        mints: readonly string[];
        quoteMint: string;
        side: 'buy' | 'sell';
        source: DepthQuoteSourceId;
        limit: number;
    }): Promise<string[]>;
    upsertVariantDepthCurve(row: VariantDepthCurveUpsert): Promise<void>;
}

export interface DepthCronDeps {
    quoteSource: DepthQuoteClient;
    repo: DepthCronRepo;
    now: () => number;
    env: () => NodeJS.ProcessEnv;
}

function asObject(raw: unknown): Record<string, unknown> {
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function isRefreshEnabled(env: NodeJS.ProcessEnv, key: string): boolean {
    return (env[key] ?? '').trim().toLowerCase() === 'true';
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function uniqueMints(values: readonly string[]): string[] {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const mint = value.trim();
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        unique.push(mint);
    }
    return unique;
}

/**
 * The sampling universe: every spot-like variant mint in the registry, minus
 * the stablecoin aggregates. Registry data is compiled into the image, so
 * this needs no DB round-trip. Single-variant assets are included — the
 * evaluation surface is per-mint, not per-comparison.
 */
export function listDepthUniverseMints(): string[] {
    const mints: string[] = [];
    for (const asset of listAssets()) {
        if (DEPTH_EXCLUDED_ASSET_IDS.has(asset.assetId)) continue;
        for (const variant of asset.variants) {
            if (isSpotLikeVariantKind(variant.kind)) mints.push(variant.mint);
        }
    }
    return uniqueMints(mints);
}

/**
 * Derive per-rung price impact from the ladder itself: effective price at
 * each rung vs. the smallest successful rung as baseline. Source-agnostic and
 * more robust than trusting an aggregator's impact-vs-mid field.
 */
export function computeLadderImpacts(
    points: Array<Omit<DepthLadderPoint, 'priceImpactBps'>>,
): DepthLadderPoint[] {
    const baseline = points.reduce<(typeof points)[number] | null>(
        (best, point) => (best === null || point.sizeUsd < best.sizeUsd ? point : best),
        null,
    );
    const baselinePrice = baseline && baseline.effectivePrice > 0 ? baseline.effectivePrice : null;

    return points.map(point => ({
        ...point,
        priceImpactBps:
            baselinePrice === null || point.effectivePrice <= 0
                ? null
                : Math.max(0, Math.round((1 - point.effectivePrice / baselinePrice) * 10_000)),
    }));
}

export async function sampleMintLadder(args: {
    quoteSource: DepthQuoteClient;
    mint: string;
    delayMs: number;
}): Promise<{ ladder: DepthLadderPoint[]; failedPoints: number }> {
    const rawPoints: Array<Omit<DepthLadderPoint, 'priceImpactBps'>> = [];
    let failedPoints = 0;

    for (const [index, sizeUsd] of DEPTH_SIZE_LADDER_USD.entries()) {
        if (index > 0 && args.delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, args.delayMs));
        }
        const inAmount = sizeUsd * USDC_DECIMALS_FACTOR;
        const quote = await args.quoteSource.fetchQuote({
            inputMint: DEPTH_USDC_QUOTE_MINT,
            outputMint: args.mint,
            amount: inAmount,
        });
        if (!quote || !(quote.outAmount > 0) || !(quote.inAmount > 0)) {
            failedPoints += 1;
            continue;
        }
        rawPoints.push({
            sizeUsd,
            inAmount: quote.inAmount,
            outAmount: quote.outAmount,
            effectivePrice: quote.outAmount / quote.inAmount,
            routeVenues: quote.routeVenues,
            ...(quote.contextSlot !== undefined ? { contextSlot: quote.contextSlot } : {}),
        });
    }

    return { ladder: computeLadderImpacts(rawPoints), failedPoints };
}

export async function refreshDepthCurves(deps: DepthCronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = asObject(rawArgs);
    const start = deps.now();
    const requireRefreshEnabled = args.requireRefreshEnabled !== false;
    if (requireRefreshEnabled && !isRefreshEnabled(deps.env(), 'DEPTH_REFRESH_ENABLED')) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            requested: 0,
            refreshed: 0,
            noRoute: 0,
            failed: 0,
            disabled: true,
        };
    }

    const maxMints = clampNumber(args.maxMints, 60, 1, 500);
    const concurrency = clampNumber(args.concurrency, 1, 1, 4);
    const delayMs = clampNumber(args.delayMs, 500, 0, 10_000);
    const budgetMs = clampNumber(args.budgetMs, 0, 0, 3_600_000);

    const explicitMints = Array.isArray(args.mints) ? uniqueMints(args.mints as string[]) : [];
    const universe = explicitMints.length > 0 ? explicitMints : listDepthUniverseMints();
    const mints =
        explicitMints.length > 0
            ? explicitMints.slice(0, maxMints)
            : await deps.repo.selectStalestDepthMints({
                  mints: universe,
                  quoteMint: DEPTH_USDC_QUOTE_MINT,
                  side: 'buy',
                  source: deps.quoteSource.id,
                  limit: maxMints,
              });

    if (mints.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            requested: 0,
            refreshed: 0,
            noRoute: 0,
            failed: 0,
            disabled: false,
        };
    }

    let refreshed = 0;
    let noRoute = 0;
    let failed = 0;

    try {
        await Effect.runPromise(
            runJobPool({
                label: 'refreshDepthCurves',
                items: mints,
                concurrency,
                delayMs,
                ...(budgetMs > 0 ? { budgetMs } : {}),
                shouldStop: isShuttingDown,
                process: mint =>
                    Effect.tryPromise(async () => {
                        const { ladder, failedPoints } = await sampleMintLadder({
                            quoteSource: deps.quoteSource,
                            mint,
                            delayMs,
                        });
                        // Every rung returned "no route" (transport failures throw
                        // and land in onItemError instead): record the empty ladder —
                        // "verified untradable right now" is a finding, not a miss.
                        await deps.repo.upsertVariantDepthCurve({
                            mint,
                            quoteMint: DEPTH_USDC_QUOTE_MINT,
                            side: 'buy',
                            source: deps.quoteSource.id,
                            ladder,
                            points: ladder.length,
                            failedPoints,
                            asOf: Math.floor(deps.now() / 1000),
                            lastComputedAt: deps.now(),
                        });
                        if (ladder.length === 0) noRoute += 1;
                        else refreshed += 1;
                    }),
                onItemError: () =>
                    Effect.sync(() => {
                        failed += 1;
                    }),
            }),
        );
    } finally {
        await deps.quoteSource.close().catch(() => undefined);
    }

    return {
        ok: failed < mints.length,
        processed: mints.length,
        durationMs: deps.now() - start,
        requested: mints.length,
        refreshed,
        noRoute,
        failed,
        disabled: false,
        source: deps.quoteSource.id,
    };
}

export type DepthJobHandler = (deps: DepthCronDeps, args: unknown) => Promise<CronResult>;

export const depthJobs: Record<string, DepthJobHandler> = {
    'refresh-depth-curves': refreshDepthCurves,
};
