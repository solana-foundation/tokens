import type {
    V2AssetDetailResult,
    V2ChainRollupResult,
    V2ChainsResult,
    V2CuratedPrefetchResult,
    V2MarketResult,
    V2MarketsByKeysEntry,
    V2VariantLookupResult,
    V2VariantResult,
    V2VariantsByAssetIdsEntry,
} from '../../../../cloudrun-assets/src/handlers/v2AssetsReads';

import type { Effect } from 'effect';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

export type {
    V2AssetDetailResult,
    V2ChainRollupResult,
    V2ChainsResult,
    V2CuratedPrefetchResult,
    V2MarketResult,
    V2MarketsByKeysEntry,
    V2VariantLookupResult,
    V2VariantResult,
    V2VariantsByAssetIdsEntry,
};

export type V2ChainId = 'solana' | 'ethereum' | 'base' | 'arbitrum' | 'polygon' | 'bnb';

/** Per-chain row counts for every registry chain (`v2_asset_variants` / `v2_variant_markets_latest`). */
export function v2AssetsChains(): Effect.Effect<V2ChainsResult, CloudRunError> {
    return cloudRunQuery<V2ChainsResult>('assets', 'v2AssetsChains', {});
}

export type V2AssetsCuratedPrefetchArgs = {
    listId: string;
    chain?: V2ChainId;
    includeInactive?: boolean;
};

/** One-round-trip composite for /api/v2/assets: membership, assets, variants on every chain, markets, rollups, reference inputs. */
export function v2AssetsCuratedPrefetch(
    args: V2AssetsCuratedPrefetchArgs,
): Effect.Effect<V2CuratedPrefetchResult, CloudRunError> {
    return cloudRunQuery<V2CuratedPrefetchResult>(
        'assets',
        'v2AssetsCuratedPrefetch',
        { ...args },
        { timeoutMs: 20_000 },
    );
}

export type V2AssetsGetDetailArgs = { ref: string; includeInactive?: boolean };

/** One asset by id or alias with its variants on every chain; null when unknown or tombstoned. */
export function v2AssetsGetDetail(
    args: V2AssetsGetDetailArgs,
): Effect.Effect<V2AssetDetailResult | null, CloudRunError> {
    return cloudRunQuery<V2AssetDetailResult | null>('assets', 'v2AssetsGetDetail', { ...args });
}

export type V2AssetsListVariantsByAssetIdsArgs = { assetIds: string[]; chain?: V2ChainId; includeInactive?: boolean };

export function v2AssetsListVariantsByAssetIds(
    args: V2AssetsListVariantsByAssetIdsArgs,
): Effect.Effect<V2VariantsByAssetIdsEntry[], CloudRunError> {
    return cloudRunQuery<V2VariantsByAssetIdsEntry[]>('assets', 'v2AssetsListVariantsByAssetIds', { ...args });
}

export type V2AssetsGetVariantArgs = { chain: V2ChainId; address: string; includeInactive?: boolean };

/** One (chain, address): the assets that claim it (canonical first) and its market; null when unknown. */
export function v2AssetsGetVariant(
    args: V2AssetsGetVariantArgs,
): Effect.Effect<V2VariantLookupResult | null, CloudRunError> {
    return cloudRunQuery<V2VariantLookupResult | null>('assets', 'v2AssetsGetVariant', { ...args });
}

export type V2AssetsGetMarketsByKeysArgs = { keys: Array<{ chain: V2ChainId; address: string }> };

/** Batch identity + market lookup (≤250 keys), request order preserved. */
export function v2AssetsGetMarketsByKeys(
    args: V2AssetsGetMarketsByKeysArgs,
): Effect.Effect<V2MarketsByKeysEntry[], CloudRunError> {
    return cloudRunQuery<V2MarketsByKeysEntry[]>('assets', 'v2AssetsGetMarketsByKeys', { ...args });
}
