import { Effect } from 'effect';

import { HOME_CATEGORY_SLUGS, CURATED_LIST_FALLBACK_NAMES } from '@tokens/asset-registry/curated-lists';
import type { CuratedListSlug } from '@tokens/asset-registry/curated-lists';

import { route } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { assetCollectionsGetSummaries } from '@/lib/cloudrun';

interface CuratedListSummary {
    id: CuratedListSlug;
    name: string;
    /** Active canonical assets in the collection (v2 tokenCount counts effective mints instead). */
    count: number;
    lastAddedAssetId: string | null;
    lastAddedAt: number | null;
}

/**
 * The DB is authoritative: counts, names, and "Latest Added" come straight
 * from `asset_collections(_members)`, so admin adds/removes surface without a
 * registry PR or seed run. Outages serve the last good response via
 * `withStaleFallback`; only display names have a static fallback.
 */
export const GET = route(() =>
    withStaleFallback(
        {
            operation: 'v1.assetsCuratedLists',
            cacheKey: 'v1:assets:curated:lists',
            ttlSeconds: 10 * 60,
            // An all-zero-counts rollup means the DB answered but membership is
            // hollow — don't overwrite the last good entry with it.
            isHealthy: payload =>
                Array.isArray((payload as { lists?: Array<{ count?: number }> }).lists) &&
                (payload as { lists: Array<{ count?: number }> }).lists.some(list => (list.count ?? 0) > 0),
        },
        Effect.gen(function* () {
            const dbSummaries = yield* assetCollectionsGetSummaries({ slugs: [...HOME_CATEGORY_SLUGS] });
            const dbBySlug = new Map(dbSummaries.map(summary => [summary.slug, summary] as const));
            const lists = HOME_CATEGORY_SLUGS.map((id): CuratedListSummary => {
                const db = dbBySlug.get(id);
                return {
                    id,
                    name: db?.title?.trim() || CURATED_LIST_FALLBACK_NAMES[id],
                    count: db?.count ?? 0,
                    lastAddedAssetId: db?.lastAddedAssetId ?? null,
                    lastAddedAt: db?.lastAddedAt ?? null,
                };
            });
            // Public contract is a bare array; the stale cache needs an object.
            return { lists };
        }),
    ).pipe(Effect.map(({ lists }) => lists)),
);
