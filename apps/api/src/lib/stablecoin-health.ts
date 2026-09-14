import { Effect } from 'effect';

import {
    STRUCTURAL_CATEGORY_LABELS,
    isPegProvider,
    isPegReferenceKind,
    type CompactPegHealth,
    type PegHealth,
    type StablecoinHealth,
    type StructuralHealth,
} from '@tokens/asset-registry';

import {
    stablecoinHealthGetByMints,
    type CloudRunError,
    type PegHealthRead,
    type StablecoinHealthGetByMintsResult,
    type StructuralHealthRead,
} from '@/lib/cloudrun';

/**
 * Serving-side view of stablecoin health (depeg tier + structural grade).
 * The worker writes `webacy_depeg_latest` / `webacy_structural_health_latest`
 * (webhook-driven, with a 4h reconciliation sweep) and `peg_guard_latest`
 * (in-house peg guard, 5 min); cloudrun-assets picks one peg observer per
 * mint via `stablecoinHealthGetByMints`; this module decides staleness,
 * carries `provider` through, attaches category labels, and fails open.
 *
 * No API-side cache: the RPC is an indexed read on a tiny table and every
 * caller already runs it concurrently with a market read.
 */

/**
 * Two missed Webacy sweeps; also the bound the worker uses to decide whether
 * Webacy still covers a mint before falling back to the peg guard. Webhooks
 * (Webacy) and the 5 min job (peg guard) keep rows fresher than this.
 */
export const PEG_STALE_AFTER_MS = 9 * 60 * 60_000;

/** Structural grades refresh daily; three missed runs before we say so. */
export const STRUCTURAL_STALE_AFTER_MS = 3 * 24 * 60 * 60_000;

/** Upstream `STABLECOIN_HEALTH_MAX_MINTS`; larger inputs are chunked. */
export const STABLECOIN_HEALTH_RPC_MAX_MINTS = 200;

const EMPTY_BY_MINT: ReadonlyMap<string, StablecoinHealth> = new Map();

type StablecoinHealthLoader = (args: {
    mints: readonly string[];
}) => Effect.Effect<StablecoinHealthGetByMintsResult, CloudRunError>;

let loader: StablecoinHealthLoader = stablecoinHealthGetByMints;

function isStale(updatedAt: number, nowMs: number, staleAfterMs: number): boolean {
    return nowMs - updatedAt > staleAfterMs;
}

/**
 * Public peg block. Drops the worker-internal `ok` / `errorMessage`: a failed
 * refresh keeps serving the last good tier, and `stale` (driven by the
 * observation age) is the only freshness signal clients should branch on.
 * `provider` defaults to `webacy` for worker builds that predate the peg guard;
 * `referenceKind` defaults to `fixed` for rows that predate peg guard phase 2
 * (every such row was judged against a fixed 1.00).
 */
export function toPegHealth(read: PegHealthRead | null | undefined, nowMs: number): PegHealth | null {
    if (!read) return null;
    return {
        provider: isPegProvider(read.provider) ? read.provider : 'webacy',
        pegCurrency: typeof read.pegCurrency === 'string' && read.pegCurrency.length > 0 ? read.pegCurrency : null,
        referenceKind: isPegReferenceKind(read.referenceKind) ? read.referenceKind : 'fixed',
        tier: read.tier,
        overallRisk: read.overallRisk,
        deviationPct: read.deviationPct,
        priceUsd: read.priceUsd,
        pegUsd: read.pegUsd,
        liquidityUsd: read.liquidityUsd ?? null,
        tierSince: read.tierSince,
        updatedAt: read.updatedAt,
        stale: isStale(read.updatedAt, nowMs, PEG_STALE_AFTER_MS),
    };
}

/** Public structural block with human labels attached to each category. */
export function toStructuralHealth(
    read: StructuralHealthRead | null | undefined,
    nowMs: number,
): StructuralHealth | null {
    if (!read) return null;
    return {
        provider: 'webacy',
        grade: read.grade,
        score: read.score,
        categories: read.categories.map(category => ({
            key: category.key,
            label: STRUCTURAL_CATEGORY_LABELS[category.key],
            score: category.score,
            weight: category.weight,
            status: category.status,
        })),
        updatedAt: read.updatedAt,
        stale: isStale(read.updatedAt, nowMs, STRUCTURAL_STALE_AFTER_MS),
    };
}

/** Per-variant projection for `GET /v1/assets/{id}` on stablecoin-category assets. */
export function toCompactPegHealth(peg: PegHealth | null | undefined): CompactPegHealth | null {
    if (!peg) return null;
    return {
        provider: peg.provider,
        referenceKind: isPegReferenceKind(peg.referenceKind) ? peg.referenceKind : 'fixed',
        tier: peg.tier,
        deviationPct: peg.deviationPct,
        updatedAt: peg.updatedAt,
        stale: peg.stale,
    };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function logLoadFailure(mintCount: number, err: unknown): void {
    console.error(
        JSON.stringify({
            event: 'stablecoin_health_load_failed',
            side: 'api',
            mints: mintCount,
            error: errorMessage(err),
        }),
    );
}

/**
 * Mint -> health for the requested mints. Fail-open: any RPC failure logs
 * `stablecoin_health_load_failed` and yields an empty map, so a provider or
 * worker outage degrades to "unmonitored" rather than a 500 on the asset
 * page. Mints are deduped and chunked to the upstream cap.
 */
export function loadStablecoinHealthOrEmpty(
    mints: readonly string[],
    options: { nowMs?: number } = {},
): Effect.Effect<ReadonlyMap<string, StablecoinHealth>, never> {
    const unique = Array.from(new Set(mints.map(mint => mint.trim()).filter(mint => mint.length > 0)));
    if (unique.length === 0) return Effect.succeed(EMPTY_BY_MINT);

    return Effect.all(
        chunk(unique, STABLECOIN_HEALTH_RPC_MAX_MINTS).map(part => loader({ mints: part })),
        { concurrency: 'unbounded' },
    ).pipe(
        Effect.map(results => {
            const nowMs = options.nowMs ?? Date.now();
            const byMint = new Map<string, StablecoinHealth>();
            for (const entries of results) {
                for (const entry of entries) {
                    if (!entry || typeof entry.mint !== 'string') continue;
                    byMint.set(entry.mint, {
                        pegHealth: toPegHealth(entry.pegHealth, nowMs),
                        structuralHealth: toStructuralHealth(entry.structuralHealth, nowMs),
                    });
                }
            }
            return byMint as ReadonlyMap<string, StablecoinHealth>;
        }),
        Effect.catch(err => {
            logLoadFailure(unique.length, err);
            return Effect.succeed(EMPTY_BY_MINT);
        }),
    );
}

/** Test seam: replace the RPC (pass `null` to restore the real one). */
export function __setStablecoinHealthLoaderForTests(next: StablecoinHealthLoader | null): void {
    loader = next ?? stablecoinHealthGetByMints;
}
