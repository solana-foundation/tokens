import type { ChainKind } from '@tokens/asset-registry/chains';
import { CHAINS, inferAddressFamily } from '@tokens/asset-registry/chains';
import { normalizeAdvisory, type AssetAdvisory } from '@/lib/asset-advisory';
import { getMintLogoOverride } from '@/lib/logo-overrides';
import type { V2AssetResponse, V2Market, V2Variant } from '@/lib/api-v2-types';

export { readRequestedVariant, type RequestedVariantRef } from '@/lib/requested-variant';

// Bumped whenever the rendered card changes so CDN-cached cards repaint.
// '4': advisory strip.
// '5': chain caption + v2 data.
export const TOKEN_SOCIAL_IMAGE_VERSION = '5';

/** The slice of a v2 variant the share card / metadata reads. */
export type TokenSocialVariant = Pick<
    V2Variant,
    'key' | 'chain' | 'address' | 'name' | 'symbol' | 'label' | 'logoURI' | 'advisory'
> & {
    market: Pick<V2Market, 'price' | 'priceChange24hPercent'> | null;
};

/** The slice of `GET /api/v2/assets/{ref}` the share card / metadata reads. */
export type TokenSocialAsset = Pick<
    V2AssetResponse,
    | 'assetId'
    | 'name'
    | 'symbol'
    | 'category'
    | 'coingeckoId'
    | 'imageUrl'
    | 'primaryVariant'
    | 'variants'
    | 'advisories'
>;

/**
 * The advisory the share card / metadata is about. A selected variant wins
 * outright (even when it has none: the viewed token isn't flagged); otherwise
 * the primary variant's advisory applies.
 */
export function resolveSocialAdvisory({
    selectedVariant,
    primaryVariant,
}: {
    selectedVariant: Pick<TokenSocialVariant, 'advisory'> | null | undefined;
    primaryVariant: Pick<TokenSocialVariant, 'advisory'> | null | undefined;
}): AssetAdvisory | null {
    if (selectedVariant) return normalizeAdvisory(selectedVariant.advisory);
    return normalizeAdvisory(primaryVariant?.advisory);
}

export interface ResolvedVariantSocialData {
    displayName: string;
    symbol: string;
    logoURI?: string;
    /** Human label of the variant's chain (`CHAINS[chain].label`). */
    chainLabel: string;
    price: number | null;
    priceChange: number | null;
    priceChangeLabel: string | null;
}

/** Trimmed text, or '' for placeholders and anything shaped like an address (Solana or EVM). */
export function normalizeOptionalSocialText(value: string | undefined | null): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '';
    if (trimmed === '—') return '';
    if (trimmed === '???') return '';
    if (inferAddressFamily(trimmed) !== null) return '';
    return trimmed;
}

/** The variant with `key` (`<chain>:<address>`), or null. */
export function selectVariantForKey<T extends Pick<TokenSocialVariant, 'key'>>(
    variants: readonly T[] | undefined | null,
    key: string | undefined | null,
): T | null {
    const normalizedKey = (key ?? '').trim();
    if (!normalizedKey || !variants) return null;
    return variants.find(variant => variant.key === normalizedKey) ?? null;
}

/**
 * The requested variant from the asset's variant list, or, when the (capped)
 * list left it out, loaded on its own via `loadOwner` and accepted only if it
 * belongs to this asset. Keeps the page body, metadata and share image in
 * agreement about which token is selected.
 */
export async function selectOrLoadVariantForKey<T extends Pick<TokenSocialVariant, 'key'>>(args: {
    variants: readonly T[] | undefined | null;
    assetId: string;
    requested: { chain: ChainKind; address: string; key: string } | null;
    loadOwner: (chain: ChainKind, address: string) => Promise<{ asset: { assetId: string }; variant: T } | null>;
}): Promise<T | null> {
    if (!args.requested) return null;
    const listed = selectVariantForKey(args.variants, args.requested.key);
    if (listed) return listed;
    const owner = await args.loadOwner(args.requested.chain, args.requested.address);
    if (!owner || owner.asset.assetId !== args.assetId) return null;
    return owner.variant;
}

function finiteNumberOrNull(value: number | undefined | null): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function resolveVariantSocialData({
    variant,
    canonicalDisplayName,
    canonicalSymbol,
    canonicalLogoURI,
    latestVariantClose,
    variantSevenDayChange,
    canonicalPrice,
    canonicalPriceChange,
    canonicalPriceChangeLabel,
}: {
    variant: TokenSocialVariant;
    canonicalDisplayName?: string | null;
    canonicalSymbol?: string | null;
    canonicalLogoURI?: string | null;
    latestVariantClose?: number | null;
    variantSevenDayChange?: number | null;
    canonicalPrice?: number | null;
    canonicalPriceChange?: number | null;
    canonicalPriceChangeLabel?: string | null;
}): ResolvedVariantSocialData {
    const displayName =
        normalizeOptionalSocialText(variant.name) ||
        normalizeOptionalSocialText(variant.label) ||
        normalizeOptionalSocialText(canonicalDisplayName) ||
        normalizeOptionalSocialText(canonicalSymbol) ||
        'Unknown';
    const symbol =
        normalizeOptionalSocialText(variant.symbol) || normalizeOptionalSocialText(canonicalSymbol) || displayName;
    const overrideLogo = variant.chain === 'solana' ? getMintLogoOverride(variant.address) : undefined;
    const variantLogo = normalizeOptionalSocialText(variant.logoURI);
    const canonicalLogo = normalizeOptionalSocialText(canonicalLogoURI);
    const logoURI = overrideLogo || variantLogo || canonicalLogo;
    const variantSevenDayChangeValue = finiteNumberOrNull(variantSevenDayChange);
    const variantMarketChange = finiteNumberOrNull(variant.market?.priceChange24hPercent);
    const canonicalChange = finiteNumberOrNull(canonicalPriceChange);

    return {
        displayName,
        symbol,
        ...(logoURI ? { logoURI } : {}),
        chainLabel: CHAINS[variant.chain].label,
        price:
            finiteNumberOrNull(variant.market?.price) ??
            finiteNumberOrNull(latestVariantClose) ??
            finiteNumberOrNull(canonicalPrice),
        priceChange: variantSevenDayChangeValue ?? variantMarketChange ?? canonicalChange,
        priceChangeLabel:
            variantSevenDayChangeValue !== null
                ? '7D'
                : variantMarketChange !== null
                  ? '24H'
                  : canonicalChange !== null
                    ? (canonicalPriceChangeLabel ?? null)
                    : null,
    };
}

export function buildShareUrls({
    metadataBase,
    requestedName,
    selected,
    minuteBucket,
    version = TOKEN_SOCIAL_IMAGE_VERSION,
}: {
    metadataBase: URL;
    requestedName: string;
    /** The variant the page is about: `?{chain}={address}` on every URL. */
    selected?: Pick<TokenSocialVariant, 'chain' | 'address'> | null;
    minuteBucket: string;
    version?: string;
}): {
    canonicalUrl: URL;
    ogImageUrl: URL;
    twitterImageUrl: URL;
} {
    const canonicalUrl = new URL(`/${encodeURIComponent(requestedName)}`, metadataBase);
    const ogImageUrl = new URL(`/${encodeURIComponent(requestedName)}/opengraph-image`, metadataBase);
    const twitterImageUrl = new URL(`/${encodeURIComponent(requestedName)}/twitter-image`, metadataBase);

    if (selected?.address) {
        canonicalUrl.searchParams.set(selected.chain, selected.address);
        ogImageUrl.searchParams.set(selected.chain, selected.address);
        twitterImageUrl.searchParams.set(selected.chain, selected.address);
    }

    ogImageUrl.searchParams.set('v', version);
    ogImageUrl.searchParams.set('t', minuteBucket);
    twitterImageUrl.searchParams.set('v', version);
    twitterImageUrl.searchParams.set('t', minuteBucket);

    return { canonicalUrl, ogImageUrl, twitterImageUrl };
}
