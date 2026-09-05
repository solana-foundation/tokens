import type { Effect } from 'effect';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

export type AssetCollectionsGetSummariesArgs = { slugs: string[] };
export type AssetCollectionSummary = {
    slug: string;
    title: string | null;
    description: string | null;
    count: number;
    lastAddedAssetId: string | null;
    lastAddedAt: number | null;
};

export function assetCollectionsGetSummaries(
    args: AssetCollectionsGetSummariesArgs,
): Effect.Effect<AssetCollectionSummary[], CloudRunError> {
    return cloudRunQuery<AssetCollectionSummary[]>('assets', 'assetCollectionsGetSummaries', {
        ...args,
    });
}

export type AssetCollectionsGetMemberMintsArgs = { slug: string; limit?: number };

export function assetCollectionsGetMemberMints(
    args: AssetCollectionsGetMemberMintsArgs,
): Effect.Effect<string[], CloudRunError> {
    return cloudRunQuery<string[]>('assets', 'assetCollectionsGetMemberMints', { ...args });
}
