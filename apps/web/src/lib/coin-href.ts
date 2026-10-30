import { isChainKind, normalizeAddressForChain, type ChainKind } from '@tokens/asset-registry/chains';

/**
 * `/{assetId}?{chain}={address}` — the one URL form for a variant on any
 * chain. A missing chain means Solana (legacy callers); an address that is not
 * valid for the chain drops the selection and links the canonical page.
 */
export function buildVariantHref(
    assetId: string,
    variant: { chain?: ChainKind | string | null; address: string | undefined | null },
): string {
    const id = assetId.trim();
    if (!id) return '/';
    const chain = isChainKind(variant.chain) ? variant.chain : 'solana';
    const address = variant.address ? normalizeAddressForChain(chain, variant.address) : null;
    if (!address) return `/${encodeURIComponent(id)}`;
    return `/${encodeURIComponent(id)}?${chain}=${encodeURIComponent(address)}`;
}

/** Solana-only convenience kept for the home / heatmap tables. */
export function buildCoinHref(coinId: string, solanaAddress: string | undefined): string {
    return buildVariantHref(coinId, { chain: 'solana', address: solanaAddress });
}
