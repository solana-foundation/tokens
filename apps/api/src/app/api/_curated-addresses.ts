import { ALL_PSEUDO_SLUG, normalizeCuratedListSlug, type CuratedListSlug } from '@tokens/asset-registry/curated-lists';

import { getCuratedMembershipSnapshot } from '@/lib/curated-membership';

export type CuratedTokenCategoryId = 'all' | CuratedListSlug;

/**
 * Effective curated membership per list, from the DB-backed snapshot (the
 * single membership authority — admin edits surface here within the snapshot
 * cache TTL, no registry PR or seed run involved).
 *
 * `lsts` follows the capped Sanctum-backed view (computed inside the
 * snapshot), and `all` is the snapshot's live union — the materialized `all`
 * collection is gone.
 *
 * Failure semantics: no silent-empty. A cold snapshot failure rejects so the
 * route's `withStaleFallback` (or the module's own last-good cache) serves
 * stale data instead of a hollow response.
 */
export async function getEffectiveCuratedAddresses(
    listId: CuratedTokenCategoryId,
): Promise<{ addresses: string[]; sanctumLstMints: Set<string> }> {
    const snapshot = await getCuratedMembershipSnapshot();
    const sanctumLstMints = new Set(snapshot.mintsByList.lsts ?? []);

    if (listId === ALL_PSEUDO_SLUG) {
        return { addresses: [...snapshot.allMints], sanctumLstMints };
    }

    const slug = normalizeCuratedListSlug(listId);
    if (!slug) return { addresses: [], sanctumLstMints };
    return { addresses: [...(snapshot.mintsByList[slug] ?? [])], sanctumLstMints };
}
