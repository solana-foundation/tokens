import { cache } from 'react';

import type { ChainKind } from '@tokens/asset-registry/chains';

import type { CanonicalAsset } from '@tokens/asset-registry';

import type { V2AssetResponse, V2VariantResponse } from '@/lib/api-v2-types';
import { fetchApiAppJsonOrNull, fetchApiAppLookup, type ApiAppLookup } from '@/lib/api-app';
import {
    canonicalAssetFromV1Resolve,
    singletonMintOf,
    v1DetailToFallback,
    type V1AssetDetailResponse,
    type V1AssetsResolveResponse,
    type V1FallbackDetail,
} from '@/lib/v1-asset-fallback';

/** Enrichments the asset page renders per variant (Solana-only pipelines; `null` elsewhere). */
export const V2_ASSET_PAGE_INCLUDES = 'executionQuality,pegHealth,preStocks';

/**
 * `GET /api/v2/assets/{ref}` for the asset page, deduped per request across
 * generateMetadata, the page body and the streamed content. `ref` must be an
 * asset id or alias — never an address or `<chain>:<address>` (v2 answers 400).
 */
export const lookupV2Asset = cache(async (ref: string): Promise<ApiAppLookup<V2AssetResponse>> => {
    const id = ref.trim();
    // v1 singleton ids (`solana-<mint>`) are not v2 asset ids (v2 answers 400); they are served by the v1 fallback.
    if (!id || singletonMintOf(id)) return { status: 'not_found' };
    return fetchApiAppLookup<V2AssetResponse>(
        `/api/v2/assets/${encodeURIComponent(id)}?include=${V2_ASSET_PAGE_INCLUDES}`,
        { next: { revalidate: 60 } },
    );
});

export const loadV2Asset = cache(async (ref: string): Promise<V2AssetResponse | null> => {
    const lookup = await lookupV2Asset(ref);
    return lookup.status === 'ok' ? lookup.value : null;
});

/**
 * A compiled-registry asset an admin has since deleted is tombstoned, and v2 answers 404 for
 * it. Only that answer means "removed"; an API outage keeps the registry identity usable.
 */
export async function isRemovedRegistryAsset(assetId: string): Promise<boolean> {
    return (await lookupV2Asset(assetId)).status === 'not_found';
}

/** `GET /api/v2/variants/{chain}/{address}`: the owning asset of a token, or null when unregistered. */
export const loadV2VariantOwner = cache(async (chain: ChainKind, address: string): Promise<V2VariantResponse | null> =>
    fetchApiAppJsonOrNull<V2VariantResponse>(`/api/v2/variants/${chain}/${encodeURIComponent(address.trim())}`, {
        next: { revalidate: 60 },
    }),
);

/**
 * v1 resolver fallback for a Solana mint v2 has no variant row for (approved launch coins,
 * Sanctum-only LSTs). Returns the owning asset shaped like a compiled-registry asset, or null.
 */
export const loadV1MintFallback = cache(async (mint: string): Promise<CanonicalAsset | null> => {
    const resolved = await fetchApiAppJsonOrNull<V1AssetsResolveResponse>(
        `/api/v1/assets/resolve?mint=${encodeURIComponent(mint.trim())}`,
        { next: { revalidate: 60 } },
    );
    if (!resolved?.asset?.assetId) return null;
    return canonicalAssetFromV1Resolve(resolved);
});

/** Market data for a v1-fallback page: `GET /v1/assets/{assetId}?mint=` mapped to the v2 shapes the page renders. */
export const loadV1MintDetail = cache(async (assetId: string, mint: string): Promise<V1FallbackDetail | null> => {
    const detail = await fetchApiAppJsonOrNull<V1AssetDetailResponse>(
        `/api/v1/assets/${encodeURIComponent(assetId.trim())}?mint=${encodeURIComponent(mint.trim())}`,
        { next: { revalidate: 60 } },
    );
    return detail ? v1DetailToFallback(detail) : null;
});
