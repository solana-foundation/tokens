import { cache } from 'react';

import type { ChainKind } from '@tokens/asset-registry/chains';

import type { V2AssetResponse, V2VariantResponse } from '@/lib/api-v2-types';
import { fetchApiAppJsonOrNull } from '@/lib/api-app';

/** Enrichments the asset page renders per variant (Solana-only pipelines; `null` elsewhere). */
export const V2_ASSET_PAGE_INCLUDES = 'executionQuality,pegHealth,preStocks';

/**
 * `GET /api/v2/assets/{ref}` for the asset page, deduped per request across
 * generateMetadata, the page body and the streamed content. `ref` must be an
 * asset id or alias — never an address or `<chain>:<address>` (v2 answers 400).
 */
export const loadV2Asset = cache(async (ref: string): Promise<V2AssetResponse | null> => {
    const id = ref.trim();
    if (!id) return null;
    return fetchApiAppJsonOrNull<V2AssetResponse>(
        `/api/v2/assets/${encodeURIComponent(id)}?include=${V2_ASSET_PAGE_INCLUDES}`,
        { next: { revalidate: 60 } },
    );
});

/** `GET /api/v2/variants/{chain}/{address}`: the owning asset of a token, or null when unregistered. */
export const loadV2VariantOwner = cache(async (chain: ChainKind, address: string): Promise<V2VariantResponse | null> =>
    fetchApiAppJsonOrNull<V2VariantResponse>(`/api/v2/variants/${chain}/${encodeURIComponent(address.trim())}`, {
        next: { revalidate: 60 },
    }),
);
