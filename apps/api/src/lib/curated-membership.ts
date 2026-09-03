import { Effect } from 'effect';

import { CURATED_LIST_ORDER, getCuratedTokenAddresses, getCuratedTokenList } from '@tokens/asset-registry/compat';

import { curatedMembershipGetSnapshot, type CuratedMembershipSnapshot } from '@/lib/cloudrun';

/**
 * API-side cache over the effective curated-membership snapshot (the DB is the
 * single membership authority; see cloudrun-assets `curatedMembershipReads`).
 *
 * 60s TTL, single-flight refresh, stale-forever-on-error: the last good
 * snapshot is never evicted, so transient RPC failures degrade to slightly
 * stale membership instead of hollow-empty responses. A cold load with no
 * prior snapshot rejects (callers decide how to degrade — e.g. the
 * primary-variant rank tiebreaker falls back to an empty map, while list
 * surfaces surface the failure to `withStaleFallback`).
 */
const SNAPSHOT_TTL_MS = 60_000;

let snapshot: CuratedMembershipSnapshot | null = null;
let listSlugsByMint: Map<string, string[]> | null = null;
let mintRank: Map<string, number> | null = null;
let loadedAtMs = 0;
let inflight: Promise<CuratedMembershipSnapshot> | null = null;

function deriveIndexes(next: CuratedMembershipSnapshot): void {
    const slugs = new Map<string, string[]>();
    for (const [mint, entry] of Object.entries(next.entriesByMint)) {
        slugs.set(mint, entry.listSlugs);
    }
    const rank = new Map<string, number>();
    for (let i = 0; i < next.allMints.length; i += 1) rank.set(next.allMints[i]!, i);
    listSlugsByMint = slugs;
    mintRank = rank;
}

async function load(): Promise<CuratedMembershipSnapshot> {
    const next = await Effect.runPromise(curatedMembershipGetSnapshot());
    snapshot = next;
    deriveIndexes(next);
    loadedAtMs = Date.now();
    return next;
}

function refreshInBackground(): void {
    if (inflight) return;
    if (snapshot && Date.now() - loadedAtMs < SNAPSHOT_TTL_MS) return;
    inflight = load()
        .catch(err => {
            // Stale-forever: keep serving the last good snapshot.
            console.error('[api] curated membership refresh failed', err);
            if (!snapshot) throw err;
            return snapshot;
        })
        .finally(() => {
            inflight = null;
        });
    // Detached refresh: rejection is already logged above.
    inflight.catch(() => {});
}

/** Current snapshot; awaits the first load (rejects on cold failure). */
export async function getCuratedMembershipSnapshot(): Promise<CuratedMembershipSnapshot> {
    if (!snapshot) {
        if (!inflight) {
            inflight = load().finally(() => {
                inflight = null;
            });
        }
        return await inflight;
    }
    refreshInBackground();
    return snapshot;
}

/** Mint → curated list slugs. Awaits the first load (rejects on cold failure). */
export async function getCuratedListSlugsByMint(): Promise<Map<string, string[]>> {
    await getCuratedMembershipSnapshot();
    return listSlugsByMint ?? new Map();
}

/**
 * Mint → curated rank (union order) — the primary-variant tiebreaker.
 * Synchronous last-good read: cold start serves an empty map (selection falls
 * through to liquidity/fill-quality) and triggers a background load.
 */
export function getCuratedMintRankSync(): Map<string, number> {
    refreshInBackground();
    if (!snapshot && !inflight) {
        // Cold start: kick off the first load without blocking the caller.
        inflight = load()
            .catch(err => {
                console.error('[api] curated membership cold load failed', err);
                throw err;
            })
            .finally(() => {
                inflight = null;
            });
        inflight.catch(() => {});
    }
    return mintRank ?? new Map();
}

/**
 * Curated slugs for one mint — the risk-input annotation helper. Never
 * throws: membership unavailability degrades to no curated exemptions
 * (conservative), matching `MarketScoreInput.curatedListSlugs` semantics.
 */
export async function getCuratedListSlugsForMint(mint: string): Promise<string[]> {
    try {
        const map = await getCuratedListSlugsByMint();
        return map.get(mint) ?? [];
    } catch (error) {
        // Compiled-registry fallback (the pre-cutover source): on cold start or
        // membership outage, curated stablecoins/stocks must not lose their
        // risk exemptions and visibly drop in score.
        console.error('[api] curated membership unavailable for risk input — using compiled registry', error);
        return compiledRegistrySlugsForMint(mint);
    }
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
    snapshot = next;
    loadedAtMs = next ? Date.now() : 0;
    if (next) deriveIndexes(next);
    else {
        listSlugsByMint = null;
        mintRank = null;
    }
}
