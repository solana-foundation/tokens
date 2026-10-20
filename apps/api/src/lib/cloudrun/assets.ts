import type {
    AssetResult,
    AssetCoinGeckoEntry,
    GetByAssetIdsEntry,
    ResolveAssetRefResult as HandlerResolveAssetRefResult,
    ResolveAssetRefForApiResult as HandlerResolveAssetRefForApiResult,
} from '../../../../cloudrun-assets/src/handlers/assets';

import type { Effect } from 'effect';

import type { AssetIndustry, AssetRegion } from '@tokens/asset-registry';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

export type AssetCategory =
    | 'crypto'
    | 'stablecoin'
    | 'lst'
    | 'rwa'
    | 'commodity'
    | 'equity'
    | 'etf'
    | 'index';

export type GetByAssetIdArgs = {
    assetId: string;
    includeInactive?: boolean;
};

export type GetByAssetIdResult = AssetResult | null;

export function getByAssetId(args: GetByAssetIdArgs): Effect.Effect<GetByAssetIdResult, CloudRunError> {
    return cloudRunQuery<GetByAssetIdResult>('assets', 'getByAssetId', { ...args });
}

export type GetByAssetIdsArgs = {
    assetIds: string[];
    includeInactive?: boolean;
};

export type GetByAssetIdsResult = GetByAssetIdsEntry[];

export function getByAssetIds(args: GetByAssetIdsArgs): Effect.Effect<GetByAssetIdsResult, CloudRunError> {
    return cloudRunQuery<GetByAssetIdsResult>('assets', 'getByAssetIds', { ...args });
}

export type SearchArgs = {
    query: string;
    category?: AssetCategory;
    /** Admin-curated tag filters (exact match, AND-combined). */
    region?: AssetRegion;
    industry?: AssetIndustry;
    limit?: number;
    includeInactive?: boolean;
};

export type SearchResult = AssetResult[];

export function search(args: SearchArgs): Effect.Effect<SearchResult, CloudRunError> {
    return cloudRunQuery<SearchResult>('assets', 'search', { ...args });
}

export type ResolveAssetRefArgs = {
    ref: string;
    includeInactive?: boolean;
};

export type ResolveAssetRefResult = HandlerResolveAssetRefResult | null;

export function resolveAssetRef(args: ResolveAssetRefArgs): Effect.Effect<ResolveAssetRefResult, CloudRunError> {
    return cloudRunQuery<ResolveAssetRefResult>('assets', 'resolveAssetRef', { ...args });
}

export type ResolveAssetRefForApiArgs = {
    ref: string;
    includeInactive?: boolean;
};

export type ResolveAssetRefForApiResult = HandlerResolveAssetRefForApiResult | null;

export function resolveAssetRefForApi(
    args: ResolveAssetRefForApiArgs,
): Effect.Effect<ResolveAssetRefForApiResult, CloudRunError> {
    return cloudRunQuery<ResolveAssetRefForApiResult>(
        'assets',
        'resolveAssetRefForApi',
        { ...args },
    );
}

export type ListActiveWithCoinGeckoIdsArgs = {
    limit?: number;
};

export type ListActiveWithCoinGeckoIdsResult = AssetCoinGeckoEntry[];

export function listActiveWithCoinGeckoIds(
    args: ListActiveWithCoinGeckoIdsArgs = {},
): Effect.Effect<ListActiveWithCoinGeckoIdsResult, CloudRunError> {
    return cloudRunQuery<ListActiveWithCoinGeckoIdsResult>(
        'assets',
        'listActiveWithCoinGeckoIds',
        { ...args },
    );
}

export type ListByCategoryArgs = {
    category: AssetCategory;
    limit?: number;
    includeInactive?: boolean;
};

export type ListByCategoryResult = AssetResult[];

export function listByCategory(args: ListByCategoryArgs): Effect.Effect<ListByCategoryResult, CloudRunError> {
    return cloudRunQuery<ListByCategoryResult>('assets', 'listByCategory', { ...args });
}
