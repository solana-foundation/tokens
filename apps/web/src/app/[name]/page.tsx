import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import type { Metadata } from 'next';

import { getAsset, getAssetByCoingeckoId, getVariantByMint, resolveAlias } from '@tokens/asset-registry';
import type { CanonicalAsset } from '@tokens/asset-registry';
import { CHAINS, CHAIN_KINDS, inferAddressFamily, type ChainKind } from '@tokens/asset-registry/chains';

import { advisoryMetadataPrefix } from '@/lib/asset-advisory';
import { formatChainList } from '@/lib/format-chain-list';
import { cleanTokenName } from '@/lib/logo-overrides';
import { singletonMintOf } from '@/lib/v1-asset-fallback';
import {
    firstString,
    readRequestedVariant,
    requestedVariantFromPathName,
    type RequestedVariantRef,
} from '@/lib/requested-variant';
import {
    buildShareUrls,
    resolveSocialAdvisory,
    resolveVariantSocialData,
    selectVariantForKey,
} from '@/lib/token-social-image-data';
import { AssetPage, type AssetShellIdentity } from './asset-page';
import { pickFirstDisplayName, pickFirstSymbol } from './lib/asset-display';
import { isRemovedRegistryAsset, loadV1MintFallback, loadV2Asset, loadV2VariantOwner } from './lib/load-v2-asset';

type ChainSearchParams = Partial<Record<ChainKind | 'view', string | string[] | undefined>>;

interface CoinPageProps {
    params: Promise<{ name: string }>;
    searchParams?: Promise<ChainSearchParams>;
}

// Static so generateMetadata never touches request headers (keeps the route cacheable/ISR).
function getMetadataBase(): URL {
    try {
        return new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://tokens.xyz');
    } catch {
        return new URL('https://tokens.xyz');
    }
}

interface ResolvedAssetRef {
    assetId: string;
    shell: AssetShellIdentity;
}

/**
 * Registry first (synchronous, Solana identity), then v2 as the resolver:
 * a base58 `name` is a Solana token (owner via /v2/variants), a chainless `0x`
 * is not resolvable, anything else is an asset id or alias (/v2/assets).
 */
async function resolveAssetRef(name: string, requested: RequestedVariantRef | null): Promise<ResolvedAssetRef | null> {
    const registryAsset: CanonicalAsset | null =
        getAssetByCoingeckoId(name) ??
        resolveAlias(name) ??
        getAsset(name) ??
        (requested?.chain === 'solana' ? (getVariantByMint(requested.address)?.asset ?? null) : null);
    if (registryAsset) {
        return {
            assetId: registryAsset.assetId,
            shell: {
                assetId: registryAsset.assetId,
                ...(registryAsset.name ? { name: registryAsset.name } : {}),
                ...(registryAsset.symbol ? { symbol: registryAsset.symbol } : {}),
                category: registryAsset.category,
                ...(registryAsset.coingeckoId ? { coingeckoId: registryAsset.coingeckoId } : {}),
                registryAsset,
            },
        };
    }

    const family = inferAddressFamily(name);
    if (family === 'evm') return null;
    if (family === 'svm') {
        const owner = await loadV2VariantOwner('solana', name);
        if (!owner) return await resolveV1MintFallback(name);
        const asset = await loadV2Asset(owner.asset.assetId);
        if (!asset) return null;
        return { assetId: asset.assetId, shell: shellFromV2(asset) };
    }

    // `/solana-<mint>` (the v1 singleton id main redirected launch coins to) is served by the same fallback.
    const singletonMint = singletonMintOf(name);
    if (singletonMint) return await resolveV1MintFallback(singletonMint);

    const asset = await loadV2Asset(name);
    if (!asset) return null;
    return { assetId: asset.assetId, shell: shellFromV2(asset) };
}

/**
 * Mints v1 serves but v2 has no variant row for (approved launch coins, Sanctum-only LSTs)
 * keep their page through the v1 resolver until v2 grows a tier for them.
 */
async function resolveV1MintFallback(mint: string): Promise<ResolvedAssetRef | null> {
    const asset = await loadV1MintFallback(mint);
    if (!asset) return null;
    return {
        assetId: asset.assetId,
        shell: {
            assetId: asset.assetId,
            ...(asset.name ? { name: asset.name } : {}),
            ...(asset.symbol ? { symbol: asset.symbol } : {}),
            category: asset.category,
            ...(asset.coingeckoId ? { coingeckoId: asset.coingeckoId } : {}),
            registryAsset: asset,
            v1Fallback: true,
        },
    };
}

function shellFromV2(asset: NonNullable<Awaited<ReturnType<typeof loadV2Asset>>>): AssetShellIdentity {
    return {
        assetId: asset.assetId,
        ...(asset.name ? { name: asset.name } : {}),
        ...(asset.symbol ? { symbol: asset.symbol } : {}),
        category: asset.category,
        ...(asset.coingeckoId ? { coingeckoId: asset.coingeckoId } : {}),
        registryAsset: null,
    };
}

async function buildAssetMetadata(
    requestedName: string,
    resolved: ResolvedAssetRef,
    requested: RequestedVariantRef | null,
): Promise<Metadata> {
    const apiAsset = await loadV2Asset(resolved.assetId);
    const selectedVariant = requested && apiAsset ? selectVariantForKey(apiAsset.variants, requested.key) : null;

    const displayNameRaw =
        pickFirstDisplayName(apiAsset?.name, apiAsset?.primaryVariant?.name, resolved.shell.name, requestedName) ||
        resolved.shell.name ||
        requestedName;
    const canonicalDisplayName = cleanTokenName(displayNameRaw);
    const canonicalSymbol =
        pickFirstSymbol(apiAsset?.symbol, apiAsset?.primaryVariant?.symbol, resolved.shell.symbol) || undefined;
    const variantSocialData = selectedVariant
        ? resolveVariantSocialData({
              variant: selectedVariant,
              canonicalDisplayName,
              canonicalSymbol,
              canonicalLogoURI: apiAsset?.imageUrl ?? apiAsset?.primaryVariant?.logoURI ?? undefined,
          })
        : null;
    const displayName = cleanTokenName(variantSocialData?.displayName ?? canonicalDisplayName);
    const symbol = pickFirstSymbol(variantSocialData?.symbol, canonicalSymbol) || undefined;
    const title = symbol ? `${displayName} (${symbol}) | Tokens` : `${displayName} | Tokens`;
    // Text-only previews (Slack, iMessage, search snippets) never see the OG
    // strip, so the description itself carries the warning.
    const advisory = resolveSocialAdvisory({
        selectedVariant,
        primaryVariant: apiAsset?.primaryVariant ?? null,
    });
    const chains = apiAsset?.chains ?? ['solana'];
    const baseDescription = selectedVariant
        ? `View ${symbol ?? displayName} on ${CHAINS[selectedVariant.chain].label}.`
        : `View ${displayName} variants on ${formatChainList(chains)}.`;
    const description = advisory ? `${advisoryMetadataPrefix(advisory, symbol)} ${baseDescription}` : baseDescription;
    const metadataBase = getMetadataBase();
    // The minute bucket busts share-image caches, so it must read the request-time
    // clock; connection() keeps this metadata out of the prerendered shell.
    await connection();
    const minuteBucket = Math.floor(Date.now() / 60_000).toString();
    const { canonicalUrl, ogImageUrl, twitterImageUrl } = buildShareUrls({
        metadataBase,
        requestedName,
        selected: selectedVariant ? { chain: selectedVariant.chain, address: selectedVariant.address } : null,
        minuteBucket,
    });
    const imageAlt = symbol ? `${displayName} (${symbol})` : displayName;

    return {
        metadataBase,
        title,
        description,
        keywords: [displayName, symbol ?? '', ...chains.map(chain => CHAINS[chain].label), 'Assets', 'Tokens'].filter(
            Boolean,
        ),
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

export async function generateMetadata({ params, searchParams }: CoinPageProps): Promise<Metadata> {
    const { name } = await params;
    const resolvedSearchParams = await searchParams;
    const requested = readRequestedVariant(resolvedSearchParams) ?? requestedVariantFromPathName(name);

    const resolved = await resolveAssetRef(name, requested);
    // The compiled registry can still carry an asset an admin deleted; v2 (tombstone-aware)
    // is the authority on whether it may be indexed, as the v1 resolver was before.
    const removed =
        resolved?.shell.registryAsset && !resolved.shell.v1Fallback
            ? await isRemovedRegistryAsset(resolved.assetId)
            : false;
    if (resolved && !removed) return await buildAssetMetadata(name, resolved, requested);

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
        for (const key of [...CHAIN_KINDS, 'view'] as const) {
            const value = firstString(resolvedSearchParams?.[key])?.trim();
            if (value) next.set(key, value);
        }
        redirect(`/sui${next.size ? `?${next.toString()}` : ''}`);
    }

    const requested = readRequestedVariant(resolvedSearchParams) ?? requestedVariantFromPathName(name);
    const resolved = await resolveAssetRef(name, requested);
    if (!resolved) notFound();

    // A bare mint path for a single-variant equity canonicalizes to the asset page.
    if (inferAddressFamily(name) === 'svm' && resolved.shell.category === 'equity') {
        const variantCount = resolved.shell.registryAsset
            ? resolved.shell.registryAsset.variants.length
            : ((await loadV2Asset(resolved.assetId))?.variants.length ?? 0);
        if (variantCount === 1) redirect(`/${encodeURIComponent(resolved.assetId)}`);
    }

    return <AssetPage assetId={resolved.assetId} requestedName={name} requested={requested} shell={resolved.shell} />;
}
