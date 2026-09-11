import { normalizeAdvisory, type AssetAdvisory } from '@/lib/asset-advisory';
import { getMintLogoOverride } from '@/lib/logo-overrides';
import { looksLikeSolanaMintAddress } from '@/lib/solana-address';

// Bumped whenever the rendered card changes so CDN-cached cards repaint.
// '4': advisory strip.
export const TOKEN_SOCIAL_IMAGE_VERSION = '4';

export type ApiVariantGroupKey =
    | 'spot'
    | 'etf'
    | 'yield'
    | 'leveraged'
    | 'basket'
    | 'lst'
    | 'tokenizedEquity';

export interface TokenSocialMarket {
    price?: number | null;
    priceChange24hPercent?: number | null;
    logoURI?: string | null;
    symbol?: string | null;
    name?: string | null;
}

export interface TokenSocialVariant {
    mint: string;
    name?: string | null;
    symbol?: string | null;
    label?: string | null;
    market?: TokenSocialMarket | null;
    /** `{ status, reason, url, since } | null`; decoded via `normalizeAdvisory`. */
    advisory?: unknown;
}

export type TokenSocialVariantGroups = Partial<Record<ApiVariantGroupKey, TokenSocialVariant[]>>;

export interface TokenSocialAssetResponse {
    asset: {
        assetId: string;
        name?: string | null;
        symbol?: string | null;
        coingeckoId?: string | null;
        imageUrl?: string | null;
        primaryVariant?: TokenSocialVariant | null;
        variantGroups?: TokenSocialVariantGroups;
        /** Asset-level summary, `[]` when none. */
        advisories?: unknown;
    };
}

/**
 * The advisory the share card / metadata is about. A selected variant wins
 * outright (even when it has none: the viewed token isn't flagged); otherwise
 * the primary variant's advisory applies.
 */
export function resolveSocialAdvisory({
    selectedVariant,
    primaryVariant,
}: {
    selectedVariant: TokenSocialVariant | null | undefined;
    primaryVariant: TokenSocialVariant | null | undefined;
}): AssetAdvisory | null {
    if (selectedVariant) return normalizeAdvisory(selectedVariant.advisory);
    return normalizeAdvisory(primaryVariant?.advisory);
}

export interface ResolvedVariantSocialData {
    displayName: string;
    symbol: string;
    logoURI?: string;
    price: number | null;
    priceChange: number | null;
    priceChangeLabel: string | null;
}

export function normalizeOptionalSocialText(value: string | undefined | null): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '';
    if (trimmed === '—') return '';
    if (trimmed === '???') return '';
    if (looksLikeSolanaMintAddress(trimmed)) return '';
    return trimmed;
}

export function normalizeRequestedSolanaMint(value: string | undefined | null): string | null {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;
    return looksLikeSolanaMintAddress(trimmed) ? trimmed : null;
}

export function getApiVariantRows(groups: TokenSocialVariantGroups | undefined | null): TokenSocialVariant[] {
    if (!groups) return [];

    return [
        ...(groups.spot ?? []),
        ...(groups.etf ?? []),
        ...(groups.yield ?? []),
        ...(groups.leveraged ?? []),
        ...(groups.basket ?? []),
        ...(groups.lst ?? []),
        ...(groups.tokenizedEquity ?? []),
    ];
}

export function selectVariantForMint(
    groups: TokenSocialVariantGroups | undefined | null,
    mint: string | undefined | null,
): TokenSocialVariant | null {
    const normalizedMint = normalizeRequestedSolanaMint(mint);
    if (!normalizedMint) return null;
    return getApiVariantRows(groups).find(variant => variant.mint === normalizedMint) ?? null;
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
        normalizeOptionalSocialText(variant.market?.name) ||
        normalizeOptionalSocialText(variant.label) ||
        normalizeOptionalSocialText(canonicalDisplayName) ||
        normalizeOptionalSocialText(canonicalSymbol) ||
        'Unknown';
    const symbol =
        normalizeOptionalSocialText(variant.symbol) ||
        normalizeOptionalSocialText(variant.market?.symbol) ||
        normalizeOptionalSocialText(canonicalSymbol) ||
        displayName;
    const mintLogo = getMintLogoOverride(variant.mint);
    const marketLogo = normalizeOptionalSocialText(variant.market?.logoURI);
    const canonicalLogo = normalizeOptionalSocialText(canonicalLogoURI);
    const variantSevenDayChangeValue = finiteNumberOrNull(variantSevenDayChange);
    const variantMarketChange = finiteNumberOrNull(variant.market?.priceChange24hPercent);
    const canonicalChange = finiteNumberOrNull(canonicalPriceChange);

    return {
        displayName,
        symbol,
        ...(mintLogo || marketLogo || canonicalLogo ? { logoURI: mintLogo || marketLogo || canonicalLogo } : {}),
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
    selectedMint,
    minuteBucket,
    version = TOKEN_SOCIAL_IMAGE_VERSION,
}: {
    metadataBase: URL;
    requestedName: string;
    selectedMint?: string | null;
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
    const normalizedMint = normalizeRequestedSolanaMint(selectedMint);

    if (normalizedMint) {
        canonicalUrl.searchParams.set('solana', normalizedMint);
        ogImageUrl.searchParams.set('solana', normalizedMint);
        twitterImageUrl.searchParams.set('solana', normalizedMint);
    }

    ogImageUrl.searchParams.set('v', version);
    ogImageUrl.searchParams.set('t', minuteBucket);
    twitterImageUrl.searchParams.set('v', version);
    twitterImageUrl.searchParams.set('t', minuteBucket);

    return { canonicalUrl, ogImageUrl, twitterImageUrl };
}
