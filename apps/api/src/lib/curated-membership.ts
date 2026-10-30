import { Cause, Effect } from 'effect';

import { CURATED_LIST_ORDER, getCuratedTokenAddresses, getCuratedTokenList } from '@tokens/asset-registry/compat';

import { makeSnapshotCache } from '@/effect/snapshot-cache';
import { curatedMembershipGetSnapshot, type CloudRunError, type CuratedMembershipSnapshot } from '@/lib/cloudrun';

/**
 * API-side cache over the effective curated-membership snapshot (the DB is the
 * single membership authority; see cloudrun-assets `curatedMembershipReads`).
 *
 * 60s TTL, single-flight refresh, stale-forever-on-error: the last good
 * snapshot is never evicted, so transient RPC failures degrade to slightly
 * stale membership instead of hollow-empty responses. A cold load with no
 * prior snapshot fails (callers decide how to degrade — e.g. the
 * primary-variant rank tiebreaker falls back to an empty map, while list
 * surfaces surface the failure to `withStaleFallback`).
 */
const SNAPSHOT_TTL_MS = 60_000;

interface CuratedIndexes {
    snapshot: CuratedMembershipSnapshot;
    listSlugsByMint: Map<string, string[]>;
    mintRank: Map<string, number>;
}

function deriveIndexes(snapshot: CuratedMembershipSnapshot): CuratedIndexes {
    const listSlugsByMint = new Map<string, string[]>();
    for (const [mint, entry] of Object.entries(snapshot.entriesByMint)) {
        listSlugsByMint.set(mint, entry.listSlugs);
    }
    const mintRank = new Map<string, number>();
    for (let i = 0; i < snapshot.allMints.length; i += 1) mintRank.set(snapshot.allMints[i]!, i);
    return { snapshot, listSlugsByMint, mintRank };
}

const cache = makeSnapshotCache<CuratedIndexes, CloudRunError>({
    name: 'curated_membership',
    ttlMs: SNAPSHOT_TTL_MS,
    load: Effect.suspend(() => curatedMembershipGetSnapshot()).pipe(Effect.map(deriveIndexes)),
    // Stale-forever: keep serving the last good snapshot — but loudly and
    // with staleness age, so a frozen snapshot is alertable (same event name
    // as the cloudrun-assets side; `cold` marks a failed first load).
    onFailure: ({ error, hadSnapshot, stalenessMs }) =>
        console.error(
            JSON.stringify({
                event: 'curated_snapshot_refresh_failed',
                side: 'api',
                cold: !hadSnapshot,
                staleness_ms: stalenessMs,
                stale_over_30m: stalenessMs !== null && stalenessMs > 30 * 60 * 1000,
                error: error instanceof Error ? error.message : String(error),
            }),
        ),
});

/** Current snapshot; awaits the first load (fails with the CloudRunError on a cold failure). */
export function getCuratedMembershipSnapshot(): Effect.Effect<CuratedMembershipSnapshot, CloudRunError> {
    return Effect.map(cache.get, indexes => indexes.snapshot);
}

/** Mint → curated list slugs. Awaits the first load (fails on a cold failure). */
export function getCuratedListSlugsByMint(): Effect.Effect<Map<string, string[]>, CloudRunError> {
    return Effect.map(cache.get, indexes => indexes.listSlugsByMint);
}

/**
 * Mint → curated rank (union order) — the primary-variant tiebreaker.
 * Synchronous last-good read: cold start serves an empty map (selection falls
 * through to liquidity/fill-quality) and triggers a background load.
 */
export function getCuratedMintRankSync(): Map<string, number> {
    return cache.peekSync()?.mintRank ?? new Map();
}

/**
 * Curated slugs for one mint — the risk-input annotation helper. Never
 * fails: membership unavailability degrades to the compiled registry's
 * membership (conservative), matching `MarketScoreInput.curatedListSlugs`
 * semantics.
 */
export function getCuratedListSlugsForMint(mint: string): Effect.Effect<string[], never> {
    return cache
        .getOrElse(cause => {
            // Compiled-registry fallback (the pre-cutover source): on cold start or
            // membership outage, curated stablecoins/stocks must not lose their
            // risk exemptions and visibly drop in score.
            console.error(
                '[api] curated membership unavailable for risk input — using compiled registry',
                Cause.squash(cause),
            );
            return null;
        })
        .pipe(
            Effect.map(indexes =>
                indexes ? (indexes.listSlugsByMint.get(mint) ?? []) : compiledRegistrySlugsForMint(mint),
            ),
        );
}

let compiledSlugsByMint: Map<string, string[]> | null = null;

/** Static membership from the compiled registry — never throws, built once. */
function compiledRegistrySlugsForMint(mint: string): string[] {
    if (!compiledSlugsByMint) {
        const map = new Map<string, string[]>();
        for (const id of CURATED_LIST_ORDER) {
            for (const address of getCuratedTokenAddresses(getCuratedTokenList(id))) {
                const slugs = map.get(address);
                if (slugs) {
                    if (!slugs.includes(id)) slugs.push(id);
                } else {
                    map.set(address, [id]);
                }
            }
        }
        compiledSlugsByMint = map;
    }
    return compiledSlugsByMint.get(mint) ?? [];
}

/** Test seam: inject or clear the cached snapshot. */
export function __setCuratedMembershipSnapshotForTests(next: CuratedMembershipSnapshot | null): void {
    cache.setForTests(next ? deriveIndexes(next) : null);
}
