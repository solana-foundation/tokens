import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import type { Metadata } from 'next';

import { getAsset, getAssetByCoingeckoId, getVariantByMint, resolveAlias } from '@tokens/asset-registry';
import type { CanonicalAsset, LiquidityTier } from '@tokens/asset-registry';
import { advisoryMetadataPrefix, normalizeAdvisory } from '@/lib/asset-advisory';
import { cleanTokenName } from '@/lib/logo-overrides';
import { looksLikeSolanaMintAddress } from '@/lib/solana-address';
import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import {
    buildShareUrls,
    normalizeRequestedSolanaMint,
    resolveSocialAdvisory,
    resolveVariantSocialData,
    selectVariantForMint,
    type TokenSocialAssetResponse,
} from '@/lib/token-social-image-data';
import { AssetPage } from './asset-page';
import { pickFirstDisplayName, pickFirstSymbol } from './lib/asset-display';

interface CoinPageProps {
    params: Promise<{ name: string }>;
    searchParams?: Promise<{
        solana?: string | string[] | undefined;
        view?: string | string[] | undefined;
    }>;
}

interface AssetsResolveResponse {
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

function canonicalAssetFromResolveResponse(response: AssetsResolveResponse): CanonicalAsset {
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

function firstString(value: string | string[] | undefined): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[0] ?? null;
    return null;
}

// Static so generateMetadata never touches request headers (keeps the route cacheable/ISR).
function getMetadataBase(): URL {
    try {
        return new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://tokens.xyz');
    } catch {
        return new URL('https://tokens.xyz');
    }
}

async function buildAssetMetadata(
    requestedName: string,
    asset: CanonicalAsset,
    requestedMint?: string | null,
): Promise<Metadata> {
    const normalizedRequestedMint = normalizeRequestedSolanaMint(requestedMint);
    const assetDetailPath = normalizedRequestedMint
        ? `/api/v1/assets/${encodeURIComponent(asset.assetId)}?mint=${encodeURIComponent(normalizedRequestedMint)}`
        : `/api/v1/assets/${encodeURIComponent(asset.assetId)}`;
    let apiAsset = await fetchApiAppJsonOrNull<TokenSocialAssetResponse>(assetDetailPath, {
        next: { revalidate: 60 },
    });
    let selectedVariant = normalizedRequestedMint
        ? selectVariantForMint(apiAsset?.asset.variantGroups, normalizedRequestedMint)
        : null;

    if (normalizedRequestedMint && !selectedVariant) {
        apiAsset = await fetchApiAppJsonOrNull<TokenSocialAssetResponse>(
            `/api/v1/assets/${encodeURIComponent(asset.assetId)}`,
            { next: { revalidate: 60 } },
        );
        selectedVariant = null;
    }

    const displayNameRaw =
        pickFirstDisplayName(apiAsset?.asset.name, apiAsset?.asset.primaryVariant?.name, asset.name, requestedName) ||
        asset.name ||
        requestedName;
    const canonicalDisplayName = cleanTokenName(displayNameRaw);
    const canonicalSymbol =
        pickFirstSymbol(apiAsset?.asset.symbol, apiAsset?.asset.primaryVariant?.symbol, asset.symbol) || undefined;
    const variantSocialData = selectedVariant
        ? resolveVariantSocialData({
              variant: selectedVariant,
              canonicalDisplayName,
              canonicalSymbol,
              canonicalLogoURI: apiAsset?.asset.imageUrl ?? apiAsset?.asset.primaryVariant?.market?.logoURI,
          })
        : null;
    const displayName = cleanTokenName(variantSocialData?.displayName ?? canonicalDisplayName);
    const symbol = pickFirstSymbol(variantSocialData?.symbol, canonicalSymbol) || undefined;
    const title = symbol ? `${displayName} (${symbol}) | Tokens` : `${displayName} | Tokens`;
    // Text-only previews (Slack, iMessage, search snippets) never see the OG
    // strip, so the description itself carries the warning.
    const advisory = resolveSocialAdvisory({
        selectedVariant,
        primaryVariant: apiAsset?.asset.primaryVariant ?? null,
    });
    const baseDescription = `View Solana variants for ${displayName}.`;
    const description = advisory ? `${advisoryMetadataPrefix(advisory, symbol)} ${baseDescription}` : baseDescription;
    const metadataBase = getMetadataBase();
    // The minute bucket busts share-image caches, so it must read the request-time
    // clock; connection() keeps this metadata out of the prerendered shell.
    await connection();
    const minuteBucket = Math.floor(Date.now() / 60_000).toString();
    const { canonicalUrl, ogImageUrl, twitterImageUrl } = buildShareUrls({
        metadataBase,
        requestedName,
        selectedMint: selectedVariant ? normalizedRequestedMint : null,
        minuteBucket,
    });
    const imageAlt = symbol ? `${displayName} (${symbol})` : displayName;

    return {
        metadataBase,
        title,
        description,
        keywords: [displayName, symbol ?? '', 'Solana', 'Assets', 'Tokens'].filter(Boolean),
        alternates: {
            canonical: canonicalUrl,
        },
        openGraph: {
            type: 'website',
            title,
            description,
            url: canonicalUrl,
            siteName: 'Tokens',
            images: [
                {
                    url: ogImageUrl,
                    width: 1200,
                    height: 630,
                    alt: imageAlt,
                },
            ],
        },
        twitter: {
            card: 'summary_large_image',
            title,
            description,
            images: [
                {
                    url: twitterImageUrl,
                    width: 1200,
                    height: 630,
                    alt: imageAlt,
                },
            ],
        },
    };
}

async function resolveCanonicalAsset(requestedName: string, requestedMint?: string): Promise<CanonicalAsset | null> {
    const url = requestedMint
        ? `/api/v1/assets/resolve?mint=${encodeURIComponent(requestedMint)}`
        : `/api/v1/assets/resolve?ref=${encodeURIComponent(requestedName)}`;
    const resolved = await fetchApiAppJsonOrNull<AssetsResolveResponse>(url, { next: { revalidate: 60 } });
    if (!resolved?.asset?.assetId) return null;
    return canonicalAssetFromResolveResponse(resolved);
}

export async function generateMetadata({ params, searchParams }: CoinPageProps): Promise<Metadata> {
    const { name } = await params;
    const resolvedSearchParams = await searchParams;
    const requestedMint = normalizeRequestedSolanaMint(firstString(resolvedSearchParams?.solana));

    const asset =
        (await resolveCanonicalAsset(name)) ?? (requestedMint ? await resolveCanonicalAsset(name, requestedMint) : null);
    if (asset) return await buildAssetMetadata(name, asset, requestedMint);

    return {
        title: 'Token Not Found',
        description: 'The requested token could not be found.',
        robots: { index: false, follow: false },
    };
}

export default async function CoinPage({ params, searchParams }: CoinPageProps) {
    const { name } = await params;
    const resolvedSearchParams = await searchParams;

    // Hard-canonicalize legacy route to avoid any xstock/CoinGecko fallbacks.
    if (name === 'sui-xstock') {
        const next = new URLSearchParams();
        const requestedSolana = firstString(resolvedSearchParams?.solana)?.trim();
        if (requestedSolana) next.set('solana', requestedSolana);
        const requestedView = firstString(resolvedSearchParams?.view)?.trim();
        if (requestedView) next.set('view', requestedView);
        redirect(`/sui${next.size ? `?${next.toString()}` : ''}`);
    }

    const requestedSolanaRaw = firstString(resolvedSearchParams?.solana)?.trim() ?? '';

    const requestedMint =
        requestedSolanaRaw.length > 0 && looksLikeSolanaMintAddress(requestedSolanaRaw)
            ? requestedSolanaRaw
            : looksLikeSolanaMintAddress(name)
              ? name
              : undefined;

    const assetFromName = getAssetByCoingeckoId(name) ?? resolveAlias(name) ?? getAsset(name);
    const assetFromRequestedMint =
        requestedMint && requestedMint.trim().length > 0
            ? (getVariantByMint(requestedMint)?.asset ?? resolveAlias(requestedMint) ?? getAsset(requestedMint))
            : null;
    const asset = assetFromName ?? assetFromRequestedMint;
    if (asset) {
        if (looksLikeSolanaMintAddress(name) && asset.category === 'equity' && asset.variants.length === 1) {
            redirect(`/${encodeURIComponent(asset.assetId)}`);
        }

        return <AssetPage asset={asset} requestedName={name} requestedMint={requestedMint} />;
    }

    const resolvedAsset = await resolveCanonicalAsset(name, requestedMint);
    if (resolvedAsset) {
        if (
            looksLikeSolanaMintAddress(name) &&
            resolvedAsset.category === 'equity' &&
            resolvedAsset.variants.length === 1
        ) {
            redirect(`/${encodeURIComponent(resolvedAsset.assetId)}`);
        }

        return <AssetPage asset={resolvedAsset} requestedName={name} requestedMint={requestedMint} />;
    }

    notFound();
}
