import { Cause, Effect } from 'effect';

import {
    isAdvisorySource,
    isAdvisoryStatus,
    isHiddenAdvisory,
    isTradeRestrictedAdvisory,
    type AdvisoryStatus,
    type CanonicalAsset,
    type VariantAdvisory,
} from '@tokens/asset-registry';
import { AssetAdvisoryError } from '@tokens/effect';

import { makeSnapshotCache } from '@/effect/snapshot-cache';
import {
    assetAdvisoriesList,
    type AssetAdvisoriesListResult,
    type AssetAdvisoryRow,
    type CloudRunError,
} from '@/lib/cloudrun';

/**
 * API-side cache over the active asset advisories (`asset_variant_advisories`,
 * served by cloudrun-assets `assetAdvisoriesList`). Modeled on
 * `curated-membership.ts`: short TTL, single-flight refresh, stale-forever on
 * error — the last good set is never evicted, so a transient RPC failure
 * degrades to a slightly stale advisory set instead of silently unflagging
 * a compromised mint.
 *
 * Two consumption modes:
 * - Read routes annotate with `loadAdvisoriesOrEmpty()` — fail-open with a
 *   loud log (a missing badge is recoverable; a 500 on every asset page is not).
 * - Execution endpoints call `requireTradeable(mint)`, which does NOT fail
 *   open: a cold-cache outage surfaces as the CloudRunError (5xx), never as
 *   "tradeable".
 */
const TTL_MS = Number(process.env.ASSET_ADVISORIES_TTL_MS) || 15_000;

/**
 * After a cold load fails, don't re-attempt the RPC on every request for a
 * few seconds: read routes await the cold load, so a sustained outage would
 * otherwise add the RPC's latency to every asset request.
 */
const COLD_RETRY_BACKOFF_MS = 5_000;

interface AdvisorySnapshot {
    revision: number;
    byMint: ReadonlyMap<string, VariantAdvisory>;
}

type AdvisoriesLoader = () => Effect.Effect<AssetAdvisoriesListResult, CloudRunError>;

const EMPTY_BY_MINT: ReadonlyMap<string, VariantAdvisory> = new Map();

let loader: AdvisoriesLoader = assetAdvisoriesList;

function toAdvisory(row: AssetAdvisoryRow): VariantAdvisory | null {
    if (!row || typeof row.mint !== 'string' || row.mint.length === 0) return null;
    if (!isAdvisoryStatus(row.status)) return null;
    return {
        status: row.status,
        reason: typeof row.reason === 'string' ? row.reason : '',
        url: typeof row.url === 'string' && row.url.length > 0 ? row.url : null,
        since: typeof row.since === 'number' && Number.isFinite(row.since) ? row.since : 0,
        source: isAdvisorySource(row.source) ? row.source : 'admin',
    };
}

function toSnapshot(result: AssetAdvisoriesListResult): AdvisorySnapshot {
    const byMint = new Map<string, VariantAdvisory>();
    for (const row of result.advisories ?? []) {
        const advisory = toAdvisory(row);
        if (advisory) byMint.set(row.mint, advisory);
    }
    const revision = typeof result.revision === 'number' && Number.isFinite(result.revision) ? result.revision : 0;
    return { revision, byMint };
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function logRefreshFailure(
    event: 'asset_advisories_refresh_failed' | 'asset_advisories_load_failed',
    err: unknown,
    stalenessMs: number | null,
): void {
    console.error(
        JSON.stringify({
            event,
            side: 'api',
            staleness_ms: stalenessMs,
            stale_over_30m: stalenessMs !== null && stalenessMs > 30 * 60 * 1000,
            error: errorMessage(err),
        }),
    );
}

const cache = makeSnapshotCache<AdvisorySnapshot, CloudRunError>({
    name: 'asset_advisories',
    ttlMs: TTL_MS,
    coldRetryBackoffMs: COLD_RETRY_BACKOFF_MS,
    load: Effect.suspend(() => loader()).pipe(Effect.map(toSnapshot)),
    onFailure: ({ error, hadSnapshot, stalenessMs }) =>
        logRefreshFailure(
            hadSnapshot ? 'asset_advisories_refresh_failed' : 'asset_advisories_load_failed',
            error,
            stalenessMs,
        ),
});

/**
 * Mint → active advisory. Awaits the first load (fails with the CloudRunError
 * on a cold failure; while in the post-failure backoff window it fails
 * immediately with the last one). Once a snapshot exists it is served
 * last-good and refreshed in the background.
 */
export function getAdvisoriesByMint(): Effect.Effect<ReadonlyMap<string, VariantAdvisory>, CloudRunError> {
    return Effect.map(cache.get, snapshot => snapshot.byMint);
}

/**
 * Synchronous last-good read for hot, non-awaitable paths (primary-variant
 * exclusion). A cold instance serves an empty map and kicks the first load.
 */
export function getAdvisoriesByMintSync(): ReadonlyMap<string, VariantAdvisory> {
    return cache.peekSync()?.byMint ?? EMPTY_BY_MINT;
}

/** Last-good revision (0 when cold). Cache-key ingredient for list payloads. */
export function getAdvisoryRevisionSync(): number {
    return cache.peekSync()?.revision ?? 0;
}

/**
 * Fail-open loader for read routes: a cold-cache outage yields an empty map
 * (no annotation, no hiding) and logs `asset_advisories_load_failed`.
 */
export function loadAdvisoriesOrEmpty(): Effect.Effect<ReadonlyMap<string, VariantAdvisory>, never> {
    return cache
        .getOrElse(cause => {
            logRefreshFailure('asset_advisories_load_failed', Cause.squash(cause), null);
            return null;
        })
        .pipe(Effect.map(snapshot => snapshot?.byMint ?? EMPTY_BY_MINT));
}

/** Mints whose advisory is `compromised` or `blocked` — never primary, never tradeable. */
export function tradeRestrictedMints(byMint: ReadonlyMap<string, VariantAdvisory>): ReadonlySet<string> {
    const out = new Set<string>();
    for (const [mint, advisory] of byMint) {
        if (isTradeRestrictedAdvisory(advisory)) out.add(mint);
    }
    return out;
}

/** New asset whose every variant carries `advisory` (map entry or `null`). */
export function annotateAssetAdvisories(
    asset: CanonicalAsset,
    byMint: ReadonlyMap<string, VariantAdvisory>,
): CanonicalAsset {
    return {
        ...asset,
        variants: asset.variants.map(variant => ({ ...variant, advisory: byMint.get(variant.mint) ?? null })),
    };
}

/**
 * Drops `blocked` variants (list/search surfaces). Returns `null` when nothing
 * remains so callers can drop the whole row. Reads the map first and the
 * variant's own `advisory` second, so un-annotated assets are handled too.
 */
export function filterHiddenVariants(
    asset: CanonicalAsset,
    byMint: ReadonlyMap<string, VariantAdvisory>,
): CanonicalAsset | null {
    const visible = asset.variants.filter(variant => !isHiddenAdvisory(byMint.get(variant.mint) ?? variant.advisory));
    if (visible.length === 0) return null;
    if (visible.length === asset.variants.length) return asset;
    return { ...asset, variants: visible };
}

export interface AssetAdvisorySummaryEntry extends VariantAdvisory {
    mint: string;
    variantId: string;
}

const STATUS_SEVERITY: Record<AdvisoryStatus, number> = { blocked: 0, compromised: 1, caution: 2 };

/**
 * `asset.advisories[]` — derived from the (annotated) variants, most severe
 * first, then by mint. Call this BEFORE `filterHiddenVariants` so the summary
 * still names hidden siblings (the page shows a notice for them).
 */
export function summarizeAssetAdvisories(asset: CanonicalAsset): AssetAdvisorySummaryEntry[] {
    const out: AssetAdvisorySummaryEntry[] = [];
    for (const variant of asset.variants) {
        const advisory = variant.advisory;
        if (!advisory) continue;
        out.push({
            mint: variant.mint,
            variantId: variant.variantId,
            status: advisory.status,
            reason: advisory.reason,
            url: advisory.url,
            since: advisory.since,
            source: advisory.source ?? 'admin',
        });
    }
    out.sort((a, b) => {
        const severity = STATUS_SEVERITY[a.status] - STATUS_SEVERITY[b.status];
        if (severity !== 0) return severity;
        return a.mint.localeCompare(b.mint);
    });
    return out;
}

/**
 * Execution gate: fails with `AssetAdvisoryError` (403) when the mint carries
 * a trade-restricting advisory. Does not fail open — a cold-cache outage
 * propagates the CloudRunError.
 */
export function requireTradeable(mint: string): Effect.Effect<void, AssetAdvisoryError | CloudRunError> {
    return Effect.gen(function* () {
        const byMint = yield* getAdvisoriesByMint();
        const advisory = byMint.get(mint);
        if (!advisory || !isTradeRestrictedAdvisory(advisory)) return;
        return yield* Effect.fail(
            new AssetAdvisoryError({
                message: `This mint has been flagged as ${advisory.status} and cannot be traded`,
                mint,
                status: advisory.status,
                reason: advisory.reason,
                url: advisory.url,
                details: {
                    code: `advisory_${advisory.status}`,
                    mint,
                    status: advisory.status,
                    reason: advisory.reason,
                    url: advisory.url,
                },
            }),
        );
    });
}

/**
 * Test seam: inject the cached set (fresh, revision defaults to the row count)
 * or clear everything back to cold.
 */
export function __setAdvisoriesForTests(
    rows: AssetAdvisoryRow[] | null,
    options: { revision?: number; loadedAtMs?: number } = {},
): void {
    cache.setForTests(
        rows ? toSnapshot({ revision: options.revision ?? rows.length, advisories: rows }) : null,
        options.loadedAtMs !== undefined ? { loadedAtMs: options.loadedAtMs } : {},
    );
}

/** Test seam: replace the RPC (pass `null` to restore the real one). */
export function __setAdvisoriesLoaderForTests(next: AdvisoriesLoader | null): void {
    loader = next ?? assetAdvisoriesList;
}
