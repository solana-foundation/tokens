import type { CanonicalAsset, LiquidityTier } from '@tokens/asset-registry';
import { normalizeAddressForChain } from '@tokens/asset-registry/chains';

import { normalizeAdvisory } from '@/lib/asset-advisory';

/**
 * v1 still serves mints that have no v2 variant row: approved launch coins and
 * Sanctum-only LSTs (the v1 registered-only tiers). Until v2 grows a tier for
 * those, the asset page falls back to the v1 resolver for them, shaped like a
 * compiled-registry asset so the shell renders the same Solana sections.
 */
export interface V1AssetsResolveResponse {
    assetId: string;
    asset: {
        assetId: string;
        name?: string | null;
        symbol?: string | null;
        category: CanonicalAsset['category'];
        aliases: string[];
    };
    variant: {
        mint: string;
        kind: CanonicalAsset['variants'][number]['kind'];
        liquidityTier?: LiquidityTier;
        trustTier: CanonicalAsset['variants'][number]['trustTier'];
        tags: string[];
        issuer?: string;
        issuerUrl?: string;
        label?: string;
        symbol?: string;
        name?: string;
        /** `{ status, reason, url, since } | null`; direct mint lookups still resolve flagged mints. */
        advisory?: unknown;
    } | null;
}

export function canonicalAssetFromV1Resolve(response: V1AssetsResolveResponse): CanonicalAsset {
    const name = (response.asset.name ?? '').trim();
    const symbol = (response.asset.symbol ?? '').trim();
    const variant = response.variant;
    const variantAdvisory = variant ? normalizeAdvisory(variant.advisory) : null;

    return {
        assetId: response.asset.assetId,
        ...(name ? { name } : {}),
        ...(symbol ? { symbol } : {}),
        category: response.asset.category,
        aliases: response.asset.aliases,
        variants: variant
            ? [
                  {
                      variantId: `${response.asset.assetId}:${variant.mint.slice(0, 8)}`,
                      mint: variant.mint,
                      kind: variant.kind,
                      trustTier: variant.trustTier,
                      tags: variant.tags,
                      ...(variant.issuer ? { issuer: variant.issuer } : {}),
                      ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
                      ...(variant.label ? { label: variant.label } : {}),
                      ...(variant.symbol ? { symbol: variant.symbol } : {}),
                      ...(variant.name ? { name: variant.name } : {}),
                      ...(variantAdvisory ? { advisory: variantAdvisory } : {}),
                  },
              ]
            : [],
    };
}

const SINGLETON_PREFIX = 'solana-';

/** The mint behind a v1 singleton asset id (`solana-<mint>`), or null for any other ref. */
export function singletonMintOf(ref: string): string | null {
    const trimmed = ref.trim();
    if (!trimmed.startsWith(SINGLETON_PREFIX)) return null;
    return normalizeAddressForChain('solana', trimmed.slice(SINGLETON_PREFIX.length));
}
