import { normalizeCuratedListSlug } from '@tokens/asset-registry/curated-lists';

import { InvalidArgsError } from './assets';

export interface AssetCollectionMemberRow {
    asset_id: string;
}

export interface AssetCollectionMemberMintRow {
    mint: string;
}

export interface AssetCollectionSummaryRow {
    collection_slug: string;
    title: string | null;
    description: string | null;
    member_count: number;
    last_added_asset_id: string | null;
    last_added_at: number | null;
}

export interface AssetCollectionsReadsRepo {
    listMembersBySlug(slug: string, limit: number): Promise<AssetCollectionMemberRow[]>;
    /**
     * Active-variant mints for a collection's members, rank order. Deliberately
     * includes the ~1.5k Sanctum yield variants hanging off `solana`: they keep the
     * prefetch's market coverage complete for `groupBy=mint` callers. Consumers must
     * not assume one mint per member (see `addMemberFallbackAssets` in the API).
     */
    listMemberMintsBySlug(slug: string, limit: number): Promise<AssetCollectionMemberMintRow[]>;
    /**
     * Per-slug count + latest-added member, active-assets only, tombstone-filtered.
     * Latest-added also reflects a new variant on an existing member (the admin
     * add-variant flow leaves membership untouched).
     */
    getSummariesBySlugs(slugs: readonly string[]): Promise<AssetCollectionSummaryRow[]>;
}

export interface AssetCollectionSummary {
    slug: string;
    title: string | null;
    description: string | null;
    count: number;
    lastAddedAssetId: string | null;
    lastAddedAt: number | null;
}

export async function getMembers(
    repo: AssetCollectionsReadsRepo,
    args: unknown,
): Promise<string[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { slug?: unknown; limit?: unknown };
    if (typeof a.slug !== 'string') {
        throw new InvalidArgsError('slug must be a string');
    }
    if (a.limit !== undefined && typeof a.limit !== 'number') {
        throw new InvalidArgsError('limit must be a number when present');
    }
    const rawSlug = a.slug.trim();
    if (!rawSlug) return [];
    const slug = normalizeCuratedListSlug(rawSlug) ?? rawSlug;
    const limit = Math.min(Math.max(typeof a.limit === 'number' ? a.limit : 500, 1), 2000);
    const rows = await repo.listMembersBySlug(slug, limit);
    return rows.map(r => r.asset_id);
}

export async function getMemberMints(
    repo: AssetCollectionsReadsRepo,
    args: unknown,
): Promise<string[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { slug?: unknown; limit?: unknown };
    if (typeof a.slug !== 'string') {
        throw new InvalidArgsError('slug must be a string');
    }
    if (a.limit !== undefined && typeof a.limit !== 'number') {
        throw new InvalidArgsError('limit must be a number when present');
    }
    const rawSlug = a.slug.trim();
    if (!rawSlug) return [];
    const slug = normalizeCuratedListSlug(rawSlug) ?? rawSlug;
    const limit = Math.min(Math.max(typeof a.limit === 'number' ? a.limit : 2000, 1), 5000);
    const rows = await repo.listMemberMintsBySlug(slug, limit);
    return rows.map(r => r.mint);
}

export async function getSummaries(
    repo: AssetCollectionsReadsRepo,
    args: unknown,
): Promise<AssetCollectionSummary[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { slugs?: unknown };
    if (!Array.isArray(a.slugs)) {
        throw new InvalidArgsError('slugs must be an array of strings');
    }
    for (const item of a.slugs) {
        if (typeof item !== 'string') {
            throw new InvalidArgsError('slugs must be an array of strings');
        }
    }
    const requested: string[] = [];
    const normalizedByRequested = new Map<string, string>();
    for (const raw of (a.slugs as string[]).slice(0, 50)) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        requested.push(trimmed);
        normalizedByRequested.set(trimmed, normalizeCuratedListSlug(trimmed) ?? trimmed);
    }
    if (requested.length === 0) return [];

    const rows = await repo.getSummariesBySlugs([...new Set(normalizedByRequested.values())]);
    const bySlug = new Map(rows.map(r => [r.collection_slug, r] as const));
    // Requested order preserved; unknown slugs report as empty rather than erroring
    // so one bad slug cannot take down the whole summaries response.
    return requested.map(slug => {
        const row = bySlug.get(normalizedByRequested.get(slug) ?? slug);
        return {
            slug,
            title: row?.title ?? null,
            description: row?.description ?? null,
            count: row?.member_count ?? 0,
            lastAddedAssetId: row?.last_added_asset_id ?? null,
            lastAddedAt: row?.last_added_at ?? null,
        };
    });
}
