import {
    CURATED_LIST_FALLBACK_NAMES,
    CURATED_LIST_SLUGS,
    isCuratedListSlug,
    type CuratedListSlug,
} from '@tokens/asset-registry/curated-lists';

import { CURATED_CATEGORY_SLUGS, asArgsObject, type CuratedCategorySlug } from './shared';
import { InvalidArgsError } from './errors';
import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import type { CallerIdentity } from '../server';

export { CURATED_CATEGORY_SLUGS, type CuratedCategorySlug };

export interface CategorySummary {
    id: CuratedListSlug;
    name: string;
    /** Public list description (`asset_collections.description`); null when unset. */
    description: string | null;
    count: number;
    lastAddedAssetId: string | null;
}

export interface AdminRepo {
    listCategorySummaries(slugs: readonly CuratedListSlug[]): Promise<CategorySummary[]>;
}

export interface CuratedTokensDeps {
    repo: AdminRepo;
    adminAllowlist: AdminAllowlist;
}

/**
 * Category summaries for the curation UI.
 *
 * Defaults to the six admin-assignable slugs (the membership filter's scope).
 * Pass `{ slugs: [...] }` to widen — the metadata editor asks for all seven,
 * since `lsts` has editable display text even though its membership is
 * Sanctum-driven.
 */
export async function listCategories(
    deps: CuratedTokensDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<CategorySummary[]> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);

    let requested: readonly CuratedListSlug[] = CURATED_CATEGORY_SLUGS;
    if (obj.slugs !== undefined) {
        if (!Array.isArray(obj.slugs) || obj.slugs.some(s => typeof s !== 'string' || !isCuratedListSlug(s))) {
            throw new InvalidArgsError(`slugs must be a subset of: ${CURATED_LIST_SLUGS.join(',')}`);
        }
        const unique = [...new Set(obj.slugs as CuratedListSlug[])];
        requested = CURATED_LIST_SLUGS.filter(slug => unique.includes(slug));
    }

    const summaries = await deps.repo.listCategorySummaries(requested);
    const bySlug = new Map(summaries.map(s => [s.id, s]));
    return requested.map(slug => {
        const summary = bySlug.get(slug);
        const name = (summary?.name ?? '').trim() || CURATED_LIST_FALLBACK_NAMES[slug];
        return {
            id: slug,
            name,
            description: summary?.description ?? null,
            count: summary?.count ?? 0,
            lastAddedAssetId: summary?.lastAddedAssetId ?? null,
        };
    });
}
