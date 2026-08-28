import type { CuratedListSlug } from '@tokens/asset-registry/curated-lists';

import type { CuratedMintsSource } from './crons';

/**
 * Effective curated-membership snapshot — the single DB-backed view of "which
 * mints are in which curated list right now".
 *
 * Semantics (see the source implementation in `db.ts`):
 * - Membership is asset-level (`asset_collection_members`); every ACTIVE
 *   sibling variant of a member asset inherits the membership on mint surfaces.
 * - Yield/LST variants route ONLY to `lsts` (they never inherit e.g. solana's
 *   `majors` membership — the solana asset alone has >1400 of them).
 * - `lsts` follows the capped Sanctum-backed default variants view, with
 *   active DB yield variants as fallback.
 * - `all` is a live union of the seven lists, never persisted.
 */
export interface CuratedMembershipEntry {
    assetId: string | null;
    listSlugs: CuratedListSlug[];
    symbol: string | null;
}

export interface CuratedMembershipSnapshot {
    /** Unix ms the snapshot was loaded from the DB. */
    loadedAt: number;
    mintsByList: Record<CuratedListSlug, string[]>;
    /** Ordered, deduplicated union of the seven lists (canonical slug order). */
    allMints: string[];
    entriesByMint: Record<string, CuratedMembershipEntry>;
}

export interface CuratedMembershipSource extends CuratedMintsSource {
    /** Load the snapshot if never loaded; safe to call repeatedly. */
    warmup(): Promise<void>;
    /**
     * Current snapshot (refreshing in the background when stale). Serves the
     * last good snapshot on refresh failure; a cold load with no prior
     * snapshot THROWS rather than returning an empty successful snapshot.
     */
    getSnapshot(): Promise<CuratedMembershipSnapshot>;
    /** Mint → curated list slugs, from the same snapshot. Empty until warm. */
    getListSlugsByMint(): Map<string, CuratedListSlug[]>;
}

/** RPC: `curatedMembershipGetSnapshot` — the full effective-membership snapshot. */
export async function getSnapshot(source: CuratedMembershipSource, _args: unknown): Promise<CuratedMembershipSnapshot> {
    void _args;
    return await source.getSnapshot();
}
