import { Suspense, cache, type ComponentProps } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { connection } from 'next/server';

import type { AssetCategory, CanonicalAsset, VariantHub } from '@tokens/asset-registry';
import { getVariantHubById, issuanceFromKind } from '@tokens/asset-registry';
import { CHAINS, CHAIN_KINDS, explorerTokenUrl, type ChainKind } from '@tokens/asset-registry/chains';
import { Skeleton } from '@tokens/ui/skeleton';

import { TokenHeader } from '@/app/token/[address]/components/token-header';
import { AssetAdvisoryBanner, AssetAdvisorySiblingNotice } from '@/components/asset-advisory-banner';
import { Logo } from '@/components/logo';
import { TokenViewedEvent } from '@/components/token-viewed-event';
import type { V2AssetStats, V2ChainStats, V2ReferenceMarket, V2Variant } from '@/lib/api-v2-types';
import { formatChainList } from '@/lib/format-chain-list';
import {
    collectVariantAdvisories,
    getSiblingAdvisories,
    getViewedAdvisory,
    isTradeBlocked,
    type AssetAdvisory,
} from '@/lib/asset-advisory';
import { resolveAssetPageCapabilities } from '@/lib/asset-page-capabilities';
import { solanaMintOf, toAssetPageVariant, type AssetPageVariant } from '@/lib/asset-page-variant';
import { buildVariantHref } from '@/lib/coin-href';
import { cleanTokenName, getMintLogoOverride, getTokenLogoURLForMintWithSecondarySymbol } from '@/lib/logo-overrides';
import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import { formatLargeNumber } from '@/lib/format';
import { isStablecoinCategory } from '@/lib/stablecoin-health';
import { getGlobalTokenStats, type GlobalTokenStats } from '@/lib/coingecko';
import type { RequestedVariantRef } from '@/lib/requested-variant';
import { AssetPriceChartSection } from './components/asset-price-chart-section';
import { AssetMarketsSection } from './components/asset-markets-section';
import { AssetMarketsOverviewSection } from './components/asset-markets-overview-section';
import { AssetLaunchesSection } from './components/asset-launches-section';
import { AssetRiskSection } from './components/asset-risk-section';
import { AssetStatsSection } from './components/asset-stats-section';
import { AssetVariantsList } from './components/asset-variants-list';
import { TokenPageBackgroundBlur, TokenPageScaffold, TokenPageSidebar } from './components/token-page-shell';
import { normalizeOptionalText, pickFirstDisplayName, pickFirstSymbol } from './lib/asset-display';
import { selectOrLoadVariantForKey } from '@/lib/token-social-image-data';
import { loadV1MintDetail, loadV2Asset, loadV2VariantOwner } from './lib/load-v2-asset';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';

/** Identity the streamed shell renders before the v2 response lands (registry or already-cached v2). */
export interface AssetShellIdentity {
    assetId: string;
    name?: string;
    symbol?: string;
    category: AssetCategory;
    coingeckoId?: string;
    /** Compiled registry asset when the id is in the registry (supplies Solana variants for the fallback). */
    registryAsset?: CanonicalAsset | null;
    /** `registryAsset` came from the v1 resolver (a mint v2 has no variant row for); v2 is never consulted. */
    v1Fallback?: boolean;
}

interface AssetPageProps {
    assetId: string;
    /** The original `/[name]` param; can differ from `assetId` when using aliases / CoinGecko ids. */
    requestedName: string;
    /** The variant the URL selects (`?{chain}={address}` or a bare mint path), if any. */
    requested: RequestedVariantRef | null;
    shell: AssetShellIdentity;
}

interface AssetIncludeOk<T> {
    ok: true;
    data: T;
}

interface AssetIncludeError {
    ok: false;
    reason: string;
    message: string;
}

type AssetIncludeResult<T> = AssetIncludeOk<T> | AssetIncludeError;

/** v1 `include=profile` payload (CoinGecko profile: links, description, global stats); still v1-served. */
interface AssetsV1ProfileResponse {
    includes?: {
        profile?: AssetIncludeResult<GlobalTokenStats>;
    };
}

function shouldShowSingletonVariantBadge(category: AssetCategory, variantCount: number): boolean {
    return category === 'equity' && variantCount === 1;
}

function buildVariantGroup(
    assetId: string,
    displayName: string,
    variants: readonly AssetPageVariant[],
    registryHub?: VariantHub | null,
): VariantHub | null {
    if (variants.length === 0) return null;

    // API variants (registry ∪ DB, every chain) decide membership so admin-added
    // variants appear without a redeploy; the static registry hub only supplies
    // labels for Solana rows.
    const registryLabelByMint = new Map(
        (registryHub?.addresses ?? []).map(item => [item.address, item.label] as const),
    );

    const unique: VariantHub['addresses'] = [];
    const seen = new Set<string>();
    for (const variant of variants) {
        if (seen.has(variant.key)) continue;
        seen.add(variant.key);
        const registryLabel = variant.chain === 'solana' ? registryLabelByMint.get(variant.address) : undefined;
        const label = registryLabel ?? variant.label?.trim() ?? undefined;
        unique.push({ address: variant.address, chain: variant.chain, ...(label ? { label } : {}) });
    }

    return { id: assetId, label: `${displayName} variants`, addresses: unique };
}

function humanizeAssetRef(value: string | undefined | null): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) || /^0x[0-9a-fA-F]{40}$/.test(trimmed)) return '';

    const withoutProviderPrefix = trimmed.replace(/^xstock[-_]/i, '').replace(/^ondo[-_]/i, '');
    return withoutProviderPrefix
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map(part => (part.length <= 4 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`))
        .join(' ');
}

/** Registry fallback when the v2 fetch returns null: Solana identity only, no markets. */
function registryVariantToPageVariant(
    asset: CanonicalAsset,
    variant: CanonicalAsset['variants'][number],
): AssetPageVariant {
    const v2: V2Variant = {
        key: `solana:${variant.mint}`,
        chain: 'solana',
        address: variant.mint,
        assetId: asset.assetId,
        variantId: variant.variantId,
        kind: variant.kind,
        issuance: issuanceFromKind(variant.kind),
        symbol: variant.symbol ?? null,
        name: variant.name ?? null,
        label: variant.label ?? null,
        decimals: null,
        logoURI: null,
        issuer: variant.issuer ?? null,
        issuerUrl: variant.issuerUrl ?? null,
        trustTier: variant.trustTier,
        liquidityTier: variant.trustTier,
        stockVariantTier: variant.stockVariantTier ?? null,
        tags: [...variant.tags],
        // Compiled registry data never carries an advisory; the v1 fallback does, and it must survive.
        advisory: variant.advisory ? { ...variant.advisory, source: variant.advisory.source ?? 'admin' } : null,
        rank: null,
        explorerUrl: explorerTokenUrl('solana', variant.mint),
        market: null,
        coingeckoId: null,
        reference: null,
    };
    return toAssetPageVariant(v2, { symbol: asset.symbol, name: asset.name });
}

/** Liquidity-first fallback primary (the API picks the real one). */
function pickFallbackPrimary(variants: readonly AssetPageVariant[], category: AssetCategory): AssetPageVariant | null {
    if (variants.length === 0) return null;
    const candidates =
        category === 'equity'
            ? variants.filter(
                  v => v.stockVariantTier === 'share_redeemable' || v.stockVariantTier === 'cash_redeemable',
              )
            : variants;
    const pool = candidates.length > 0 ? candidates : variants;
    return pool.slice().sort((a, b) => (b.market?.liquidity ?? 0) - (a.market?.liquidity ?? 0))[0] ?? null;
}

const loadGlobalStats = cache(
    async (
        assetId: string,
        coingeckoId: string | null,
        enableCoinGeckoFallback: boolean,
    ): Promise<GlobalTokenStats | null> => {
        // Profile is optional (requires extra scopes). Load separately so `assets:read` can still render the page.
        const apiProfile = await fetchApiAppJsonOrNull<AssetsV1ProfileResponse>(
            `/api/v1/assets/${encodeURIComponent(assetId)}?${new URLSearchParams({ include: 'profile' }).toString()}`,
            { next: { revalidate: 300 } },
        );

        const profileInclude = apiProfile?.includes?.profile;
        const apiGlobalStats = profileInclude && profileInclude.ok ? profileInclude.data : null;
        if (apiGlobalStats) return apiGlobalStats;

        const resolvedCoinGeckoId = (coingeckoId ?? '').trim();
        if (enableCoinGeckoFallback && resolvedCoinGeckoId) {
            // The direct CoinGecko fallback reads the clock; under cacheComponents
            // that must happen at request time or a cold profile cache blocks the prerender.
            await connection();
            return await getGlobalTokenStats(resolvedCoinGeckoId);
        }

        return null;
    },
);

type TokenHeaderBaseProps = Omit<ComponentProps<typeof TokenHeader>, 'links'>;

function TokenHeaderWithLinks({
    assetId,
    coingeckoId,
    enableCoinGeckoFallback,
    baseProps,
}: {
    assetId: string;
    coingeckoId: string | null;
    enableCoinGeckoFallback: boolean;
    baseProps: TokenHeaderBaseProps;
}) {
    return (
        <Suspense fallback={<TokenHeader {...baseProps} />}>
            <TokenHeaderWithLinksLoader
                assetId={assetId}
                coingeckoId={coingeckoId}
                enableCoinGeckoFallback={enableCoinGeckoFallback}
                baseProps={baseProps}
            />
        </Suspense>
    );
}

async function TokenHeaderWithLinksLoader({
    assetId,
    coingeckoId,
    enableCoinGeckoFallback,
    baseProps,
}: {
    assetId: string;
    coingeckoId: string | null;
    enableCoinGeckoFallback: boolean;
    baseProps: TokenHeaderBaseProps;
}) {
    const globalStats = await loadGlobalStats(assetId, coingeckoId, enableCoinGeckoFallback);
    return <TokenHeader {...baseProps} links={globalStats?.links} />;
}

interface TokenSidebarWithDataProps {
    descriptionOverride?: string | null;
    assetId: string;
    coingeckoId: string | null;
    enableCoinGeckoFallback: boolean;
    buyAddress: string | null;
    buySymbol?: string;
    buyLogoURI?: string;
    displayName: string;
    /**
     * Threaded into BOTH the Suspense fallback and the loaded sidebar: the
     * fallback renders the live Buy button while the 300s profile fetch
     * streams, so omitting it there would flash an enabled CTA.
     */
    advisory: AssetAdvisory | null;
    tradeOnChainHref?: string | null;
    tradeOnChainLabel?: string | null;
}

function TokenSidebarWithData({
    descriptionOverride,
    assetId,
    coingeckoId,
    enableCoinGeckoFallback,
    buyAddress,
    buySymbol,
    buyLogoURI,
    displayName,
    advisory,
    tradeOnChainHref,
    tradeOnChainLabel,
}: TokenSidebarWithDataProps) {
    return (
        <Suspense
            fallback={
                <TokenPageSidebar
                    buyAddress={buyAddress}
                    buySymbol={buySymbol}
                    buyLogoURI={buyLogoURI}
                    displayName={displayName}
                    description={descriptionOverride ?? null}
                    advisory={advisory}
                    tradeOnChainHref={tradeOnChainHref}
                    tradeOnChainLabel={tradeOnChainLabel}
                />
            }
        >
            <TokenSidebarWithDataLoader
                descriptionOverride={descriptionOverride}
                assetId={assetId}
                coingeckoId={coingeckoId}
                enableCoinGeckoFallback={enableCoinGeckoFallback}
                buyAddress={buyAddress}
                buySymbol={buySymbol}
                buyLogoURI={buyLogoURI}
                displayName={displayName}
                advisory={advisory}
                tradeOnChainHref={tradeOnChainHref}
                tradeOnChainLabel={tradeOnChainLabel}
            />
        </Suspense>
    );
}

async function TokenSidebarWithDataLoader({
    descriptionOverride,
    assetId,
    coingeckoId,
    enableCoinGeckoFallback,
    buyAddress,
    buySymbol,
    buyLogoURI,
    displayName,
    advisory,
    tradeOnChainHref,
    tradeOnChainLabel,
}: TokenSidebarWithDataProps) {
    const globalStats = await loadGlobalStats(assetId, coingeckoId, enableCoinGeckoFallback);

    return (
        <TokenPageSidebar
            buyAddress={buyAddress}
            buySymbol={buySymbol}
            buyLogoURI={buyLogoURI}
            displayName={displayName}
            description={resolveAssetDescription(descriptionOverride, globalStats?.description)}
            tokenFeedCoinId={coingeckoId ?? undefined}
            tokenFeedTerms={buildTokenFeedTerms({ assetId, coingeckoId, buySymbol, displayName })}
            advisory={advisory}
            tradeOnChainHref={tradeOnChainHref}
            tradeOnChainLabel={tradeOnChainLabel}
        />
    );
}

function resolveAssetDescription(override?: string | null, coingeckoDescription?: string | null): string | null {
    const assetDescription = (override ?? '').trim();
    if (assetDescription) return assetDescription;

    const coingecko = (coingeckoDescription ?? '').trim();
    return coingecko || null;
}

function buildTokenFeedTerms(params: {
    assetId: string;
    coingeckoId: string | null;
    buySymbol?: string;
    displayName: string;
}): string[] {
    return Array.from(
        new Set(
            [params.displayName, params.buySymbol, params.assetId, params.coingeckoId]
                .map(value => value?.trim())
                .filter((value): value is string => Boolean(value)),
        ),
    );
}

function pickFiniteNumber(primary: number | undefined | null, fallback: number | undefined | null): number | null {
    if (typeof primary === 'number' && Number.isFinite(primary)) return primary;
    if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
    return null;
}

function canonicalVolumeLabel(source: V2ReferenceMarket['source'] | undefined): string | null {
    if (source === 'coingecko') return 'Canonical';
    return null;
}

function shouldShowCanonicalVolumePill(category: AssetCategory | undefined, referenceMarket: V2ReferenceMarket | null) {
    return category === 'crypto' && referenceMarket?.source === 'coingecko';
}

function buildCanonicalStatsMarket(
    stats: V2AssetStats | null | undefined,
    referenceMarket: V2ReferenceMarket | null,
    category?: AssetCategory,
): ComponentProps<typeof AssetStatsSection>['market'] {
    if (!stats && !referenceMarket) return null;

    if (referenceMarket?.source === 'stock') {
        // Prefer the underlying company's market cap (price × shares
        // outstanding) over the aggregated tokenized-supply mcap.
        const companyMarketCap = pickFiniteNumber(referenceMarket.marketCap ?? null, null);
        return {
            price: pickFiniteNumber(stats?.price, null),
            liquidity: pickFiniteNumber(stats?.liquidity, null),
            volume24hUSD: pickFiniteNumber(stats?.volume24hUSD, null),
            marketCap: companyMarketCap ?? pickFiniteNumber(stats?.marketCap, null),
            ...(companyMarketCap !== null ? { marketCapSource: 'company' as const } : {}),
            fdv: pickFiniteNumber(stats?.fdv, null),
            totalSupply: pickFiniteNumber(stats?.totalSupply, null),
            circulatingSupply: pickFiniteNumber(stats?.circulatingSupply, null),
            priceChange24hPercent: pickFiniteNumber(stats?.priceChange24hPercent, null),
            ...(stats?.source ? { statsSource: stats.source } : {}),
        };
    }

    if (referenceMarket?.source === 'prestocks') {
        // Tokenized pre-IPO exposure: `marketCap` stays the on-chain token
        // float; the implied company valuation and premium-to-mark render from
        // the dedicated `preStocks` block.
        return {
            price: pickFiniteNumber(stats?.price, referenceMarket.price),
            liquidity: pickFiniteNumber(stats?.liquidity, null),
            volume24hUSD: pickFiniteNumber(stats?.volume24hUSD, null),
            marketCap: pickFiniteNumber(stats?.marketCap, null),
            fdv: pickFiniteNumber(stats?.fdv, null),
            totalSupply: pickFiniteNumber(stats?.totalSupply, null),
            circulatingSupply: pickFiniteNumber(stats?.circulatingSupply, null),
            priceChange24hPercent: pickFiniteNumber(stats?.priceChange24hPercent, null),
            preStocks: {
                markPriceUsd: referenceMarket.markPriceUsd,
                markValuationUsd: referenceMarket.markValuationUsd,
                impliedValuationUsd: referenceMarket.impliedValuationUsd,
                premiumToMarkPercent: referenceMarket.premiumToMarkPercent,
            },
        };
    }

    const showCanonicalVolumePill = shouldShowCanonicalVolumePill(category, referenceMarket);
    const underlyingVolume24hUSD =
        showCanonicalVolumePill && referenceMarket ? pickFiniteNumber(referenceMarket.volume24hUSD, null) : null;
    const underlyingVolume24hLabel =
        underlyingVolume24hUSD !== null ? canonicalVolumeLabel(referenceMarket?.source) : null;

    return {
        price: pickFiniteNumber(stats?.price, referenceMarket?.price),
        liquidity: pickFiniteNumber(stats?.liquidity, null),
        volume24hUSD: pickFiniteNumber(stats?.volume24hUSD, referenceMarket?.volume24hUSD),
        ...(underlyingVolume24hUSD !== null ? { underlyingVolume24hUSD } : {}),
        ...(underlyingVolume24hLabel ? { underlyingVolume24hLabel } : {}),
        marketCap: pickFiniteNumber(stats?.marketCap, referenceMarket?.marketCap ?? null),
        fdv: pickFiniteNumber(stats?.fdv, null),
        totalSupply: pickFiniteNumber(stats?.totalSupply, null),
        circulatingSupply: pickFiniteNumber(stats?.circulatingSupply, null),
        priceChange24hPercent: pickFiniteNumber(stats?.priceChange24hPercent, referenceMarket?.priceChange24hPercent),
        ...(stats?.source ? { statsSource: stats.source } : {}),
    };
}

/** A variant's own CoinGecko figures as the stats fallback for a variant with no market row at all. */
function variantReferenceFallback(
    reference: AssetPageVariant['reference'] | null | undefined,
): ComponentProps<typeof AssetStatsSection>['globalStats'] {
    if (!reference) return null;
    return {
        price: reference.price,
        marketCap: reference.marketCap,
        fdv: null,
        circulatingSupply: reference.circulatingSupply,
        totalSupply: reference.totalSupply,
        priceChange24h: reference.priceChange24hPercent,
        volume24h: reference.volume24hUSD,
    };
}

export function AssetPage(props: AssetPageProps) {
    // No awaits before JSX: flush the page shell (breadcrumb, header identity,
    // section chrome) immediately and stream the `/api/v2/assets/:id`-dependent
    // content in via Suspense. `page.tsx` has already validated the asset
    // (registry or v2) and owns notFound(); `AssetPageContent` degrades
    // gracefully to shell identity when the fetch returns null, so no
    // notFound/error semantics cross the Suspense boundary.
    return (
        <Suspense fallback={<AssetPageShellFallback {...props} />}>
            <AssetPageContent {...props} />
        </Suspense>
    );
}

/**
 * Blurred logo backdrop shared by the streamed shell fallback and the full
 * page. Dimensions mirror the fixed 2000x1500 `TokenPageBackgroundBlur` frame
 * the image fills.
 */
function AssetPageBackground({ logoURI }: { logoURI: string }) {
    return (
        <TokenPageBackgroundBlur>
            <Image
                src={normalizeLogoSrc(logoURI)}
                alt=""
                width={2000}
                height={1500}
                className="absolute inset-0 size-full object-cover blur-[100px] opacity-[0.03]"
                aria-hidden="true"
            />
        </TokenPageBackgroundBlur>
    );
}

/**
 * Registry-only mirror of the shell that `AssetPageContent` renders once the
 * asset API response lands. Identity (name/symbol/logo/breadcrumb) is derived
 * from the same helpers, minus API-provided overrides, so in the common case
 * the streamed swap is visually seamless. Intentionally excludes
 * `TokenViewedEvent` and `TokenPageSidebar` (their client effects would fire
 * twice) and any buy CTA (the active mint isn't confirmed until the API
 * response arrives).
 */

/**
 * Shell that renders before the v2 response lands. Identity comes from the
 * registry (Solana variants, no markets) or the already-resolved shell
 * identity, through the same helpers as the full page, so in the common case
 * the streamed swap is visually seamless. Intentionally excludes
 * `TokenViewedEvent` and `TokenPageSidebar` (their client effects would fire
 * twice) and any buy CTA (the active variant isn't confirmed until the API
 * response arrives).
 */
function AssetPageShellFallback({ assetId, requestedName, requested, shell }: AssetPageProps) {
    const assetRef = requestedName.trim() || assetId;
    const registryAsset = shell.registryAsset ?? null;
    const variants = registryAsset
        ? registryAsset.variants.map(v => registryVariantToPageVariant(registryAsset, v))
        : [];
    const primary = pickFallbackPrimary(variants, shell.category);
    const requestedVariant = requested ? (variants.find(v => v.key === requested.key) ?? null) : null;
    const isVariantView = Boolean(requested);
    // A requested variant the compiled registry does not know (EVM, DB-only)
    // must not be stood in for by the Solana primary while v2 streams in.
    const active = requestedVariant ?? (requested ? null : primary);
    const activeChain: ChainKind | null = active?.chain ?? requested?.chain ?? null;

    const displayNameRaw =
        pickFirstDisplayName(
            shell.name,
            humanizeAssetRef(assetId),
            humanizeAssetRef(requestedName),
            active?.displayName,
        ) || 'Unknown';
    const displayName = cleanTokenName(displayNameRaw);
    const displaySymbol =
        (isVariantView
            ? pickFirstSymbol(active?.displaySymbol, shell.symbol)
            : pickFirstSymbol(shell.symbol, active?.displaySymbol)) || '???';

    const selectedVariantLogoURI = requestedVariant ? getMintLogoOverride(solanaMintOf(requestedVariant)) : undefined;
    const canonicalLogoURI = getTokenLogoURLForMintWithSecondarySymbol(
        solanaMintOf(active),
        displaySymbol,
        displayName,
        undefined,
    );
    const displayLogoURI = isVariantView ? selectedVariantLogoURI || canonicalLogoURI : canonicalLogoURI;

    const variantHubFromRegistry = getVariantHubById(assetId);
    const showSingletonVariantBadge = shouldShowSingletonVariantBadge(shell.category, variants.length);
    const variantGroup =
        (variants.length > 1 || showSingletonVariantBadge
            ? buildVariantGroup(assetId, displayName, variants, variantHubFromRegistry)
            : null) ?? variantHubFromRegistry;
    const caps = resolveAssetPageCapabilities({
        activeChain,
        isVariantView,
        assetChains: [...new Set([...(variants.length > 0 ? ['solana' as const] : []), ...(requested ? [requested.chain] : [])])],
        isStablecoin: isStablecoinCategory(shell.category),
        variantCount: variants.length,
    });

    return (
        <TokenPageScaffold
            background={displayLogoURI ? <AssetPageBackground logoURI={displayLogoURI} /> : null}
            displayName={displayName}
            breadcrumbCanonicalHref={requested ? `/${encodeURIComponent(assetRef)}` : undefined}
            breadcrumbVariantSymbol={requestedVariant ? requestedVariant.displaySymbol : undefined}
            buyAddress={null}
            header={
                <TokenHeader
                    // A requested EVM variant the compiled registry lacks still names its own address, so the
                    // explorer link is the contract's, never <chain explorer>/token/<assetId>.
                    address={active?.address ?? requested?.address ?? assetId}
                    chain={activeChain}
                    symbol={displaySymbol}
                    displayName={displayName}
                    displayLogoURI={displayLogoURI}
                    selectedVariant={
                        requestedVariant
                            ? {
                                  chain: requestedVariant.chain,
                                  address: requestedVariant.address,
                                  symbol: requestedVariant.displaySymbol,
                              }
                            : null
                    }
                    variantLinkMode="coingecko"
                    variantLinkCoinId={shell.coingeckoId ?? assetId}
                    variantGroup={variantGroup}
                    showSingletonVariantBadge={showSingletonVariantBadge}
                    variantCurrentKey={active?.key}
                    showRisk={caps.risk}
                />
            }
            sidebar={<AssetPageSidebarSkeleton showBuyButton={Boolean(active) && caps.swap} />}
        >
            <AssetPageSectionsSkeleton showChart={caps.chart !== 'none'} />
        </TokenPageScaffold>
    );
}

/** Mirrors the sidebar footprint in `loading.tsx` (house skeleton style). */
function AssetPageSidebarSkeleton({ showBuyButton }: { showBuyButton: boolean }) {
    return (
        <div className="space-y-8">
            {showBuyButton && (
                <div className="hidden lg:sticky lg:top-24 lg:z-20 lg:block">
                    <Skeleton className="h-10 w-full bg-gray-100 rounded-xl" />
                </div>
            )}

            <section>
                <Skeleton className="h-5 w-40 bg-gray-100 mb-4" />
                <Skeleton className="h-4 w-full bg-gray-100" />
                <Skeleton className="h-4 w-4/5 bg-gray-100 mt-2" />
                <Skeleton className="h-4 w-3/5 bg-gray-100 mt-2" />
            </section>
        </div>
    );
}

/** Mirrors the chart/stats/markets/variants blocks in `loading.tsx`. */
function AssetPageSectionsSkeleton({ showChart }: { showChart: boolean }) {
    return (
        <>
            {showChart && (
                <div className="bg-white rounded-[32px] border border-border-light shadow-[0_8px_40px_rgba(0,0,0,0.03)] p-6">
                    <Skeleton className="h-5 w-24 bg-gray-100" />
                    <Skeleton className="h-10 w-40 bg-gray-100 mt-4" />
                    <Skeleton className="h-64 w-full bg-gray-100 mt-6" />
                </div>
            )}

            <div>
                <Skeleton className="h-6 w-20 bg-gray-100 mb-6 mt-12" />
                <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border-light overflow-hidden mb-px [&>*:first-child]:pl-0">
                    {Array.from({ length: 4 }, (_, index) => (
                        <div key={index} className="px-6 py-5">
                            <Skeleton className="h-4 w-20 bg-gray-100 mb-3" />
                            <Skeleton className="h-6 w-24 bg-gray-100" />
                        </div>
                    ))}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border-light border-t border-border-light overflow-hidden [&>*:first-child]:pl-0">
                    {Array.from({ length: 4 }, (_, index) => (
                        <div key={index} className="px-6 py-5">
                            <Skeleton className="h-4 w-20 bg-gray-100 mb-3" />
                            <Skeleton className="h-6 w-24 bg-gray-100" />
                        </div>
                    ))}
                </div>
            </div>

            <div>
                <Skeleton className="h-6 w-24 bg-gray-100 mb-6 mt-12" />
                <div className="bg-white rounded-[32px] border border-border-medium shadow-[0_8px_40px_rgba(0,0,0,0.03)] overflow-hidden">
                    <div className="p-8 space-y-4">
                        {Array.from({ length: 6 }, (_, index) => (
                            <Skeleton key={index} className="h-8 w-full bg-gray-100" />
                        ))}
                    </div>
                </div>
            </div>

            <section className="mt-10">
                <Skeleton className="h-6 w-28 bg-gray-100" />
                <Skeleton className="h-4 w-80 bg-gray-100 mt-4" />
                <div className="mt-6 bg-white rounded-[32px] border border-border-light shadow-[0_8px_40px_rgba(0,0,0,0.03)] p-8 space-y-4">
                    {Array.from({ length: 5 }, (_, index) => (
                        <Skeleton key={index} className="h-10 w-full bg-gray-100" />
                    ))}
                </div>
            </section>
        </>
    );
}

/**
 * Fetch `/api/v2/assets/:id` and derive everything `AssetPageContent` renders:
 * the variants on every chain with their markets, the active/primary variant,
 * per-chain stats, the reference market, advisories and display identity.
 * Degrades gracefully to shell / registry identity when the fetch returns null.
 */
async function loadAssetPageModel({ assetId, requestedName, requested, shell }: AssetPageProps) {
    // v1-backed shells are mints v2 has no row for; the v2 asset they resolve to (`solana` for a
    // Sanctum-only LST) would replace the requested mint with the parent's variants.
    const api = shell.v1Fallback ? null : await loadV2Asset(assetId);
    const canonicalAssetId = (api?.assetId ?? assetId).trim() || assetId;
    const category: AssetCategory = api?.category ?? shell.category;
    const coingeckoId = api?.coingeckoId ?? shell.coingeckoId ?? null;
    const assetSymbol = api?.symbol ?? shell.symbol ?? null;
    const assetName = api?.name ?? shell.name ?? null;

    const registryAsset = shell.registryAsset ?? null;
    const variants: AssetPageVariant[] = api
        ? api.variants.map(v => toAssetPageVariant(v, { symbol: assetSymbol, name: assetName }))
        : registryAsset
          ? registryAsset.variants.map(v => registryVariantToPageVariant(registryAsset, v))
          : [];
    // v1-backed pages (mints v2 has no row for) take price/liquidity/supply from the v1 detail
    // so they are not identity-only shells.
    const v1Detail =
        !api && shell.v1Fallback && registryAsset
            ? await loadV1MintDetail(registryAsset.assetId, requested?.address ?? registryAsset.variants[0]?.mint ?? '')
            : null;
    if (v1Detail) {
        for (const variant of variants) {
            variant.market = v1Detail.marketByMint.get(variant.address) ?? variant.market;
            variant.logoURI ??= v1Detail.logoByMint.get(variant.address) ?? null;
        }
    }
    const byKey = new Map(variants.map(v => [v.key, v] as const));
    // The detail payload is capped (the `solana` asset drops thin yield variants), so a
    // `?{chain}={address}` link to a variant outside the cap is fetched on its own and added
    // to the page model instead of silently falling back to the canonical view.
    if (requested && api && !byKey.has(requested.key)) {
        const missing = await selectOrLoadVariantForKey({
            variants: api.variants,
            assetId: api.assetId,
            requested,
            loadOwner: loadV2VariantOwner,
        });
        if (missing) {
            const extra = toAssetPageVariant(missing, { symbol: assetSymbol, name: assetName });
            variants.push(extra);
            byKey.set(extra.key, extra);
        }
    }

    const primary =
        (api?.primaryVariant ? (byKey.get(api.primaryVariant.key) ?? null) : null) ??
        pickFallbackPrimary(variants, category);
    const requestedVariant = requested ? (byKey.get(requested.key) ?? null) : null;
    const isVariantView = Boolean(requestedVariant);
    const active = requestedVariant ?? primary;
    const activeChain: ChainKind | null = active?.chain ?? null;

    const assetChains: ChainKind[] = api?.chains ?? (variants.length > 0 ? ['solana'] : []);
    const chainStats: Partial<Record<ChainKind, V2ChainStats>> = api?.chainStats ?? {};
    const primaryVariantByChain = new Map<ChainKind, AssetPageVariant>();
    for (const chain of CHAIN_KINDS) {
        const key = api?.primaryVariantByChain[chain]?.key;
        const variant = key ? byKey.get(key) : undefined;
        if (variant) primaryVariantByChain.set(chain, variant);
    }

    const isStablecoin = isStablecoinCategory(category);
    const caps = resolveAssetPageCapabilities({
        activeChain,
        isVariantView,
        assetChains,
        isStablecoin,
        variantCount: variants.length,
    });

    const referenceMarket = api?.referenceMarket ?? null;
    const shouldUseCanonicalMarket = !isVariantView && referenceMarket !== null;
    const shouldEnableRealtimePrice = isVariantView || referenceMarket?.source !== 'stock';
    const canonicalStatsMarket = buildCanonicalStatsMarket(api?.stats ?? v1Detail?.stats, referenceMarket, category);
    // Variant view: merge the variant's PreStocks reference block into its
    // market snapshot so the stats section renders the same premium/implied
    // valuation treatment as the canonical view.
    const activePreStocks = active?.preStocks ?? null;
    const variantStatsMarket: ComponentProps<typeof AssetStatsSection>['market'] = active?.market
        ? {
              ...active.market,
              metricsSource: active.market.metricsSource ?? undefined,
              ...(activePreStocks
                  ? {
                        preStocks: {
                            markPriceUsd: activePreStocks.markPriceUsd,
                            markValuationUsd: activePreStocks.markValuationUsd,
                            impliedValuationUsd: activePreStocks.impliedValuationUsd,
                            premiumToMarkPercent: activePreStocks.premiumToMarkPercent,
                        },
                    }
                  : {}),
          }
        : null;

    const displayNameRaw =
        pickFirstDisplayName(
            assetName,
            shell.name,
            humanizeAssetRef(canonicalAssetId),
            humanizeAssetRef(requestedName),
            active?.displayName,
        ) || 'Unknown';
    const displayName = cleanTokenName(displayNameRaw);
    const displaySymbol =
        (isVariantView
            ? pickFirstSymbol(active?.displaySymbol, assetSymbol, shell.symbol)
            : pickFirstSymbol(assetSymbol, active?.displaySymbol, shell.symbol)) || '???';
    const canonicalSymbolForRealtime = pickFirstSymbol(assetSymbol, shell.symbol) || displaySymbol;
    const uploadedLogoURI = normalizeOptionalText(api?.imageUrl);
    const selectedVariantLogoURI = requestedVariant
        ? normalizeOptionalText(requestedVariant.logoURI) || getMintLogoOverride(solanaMintOf(requestedVariant))
        : undefined;
    const canonicalLogoURI =
        uploadedLogoURI ||
        getTokenLogoURLForMintWithSecondarySymbol(
            solanaMintOf(active),
            displaySymbol,
            displayName,
            active?.logoURI ?? undefined,
        );
    const displayLogoURI = isVariantView ? selectedVariantLogoURI || canonicalLogoURI : canonicalLogoURI;

    const activeKey = active?.key ?? null;
    const activeAddress = active?.address ?? null;
    const buyAddress = active && caps.swap ? active.address : null;
    const tradeOnChainVariant = caps.tradeOnChain ? (primaryVariantByChain.get(caps.tradeOnChain) ?? null) : null;
    const tradeOnChainHref =
        caps.tradeOnChain && tradeOnChainVariant ? buildVariantHref(canonicalAssetId, tradeOnChainVariant) : null;
    const tradeOnChainLabel = caps.tradeOnChain ? CHAINS[caps.tradeOnChain].label : null;

    const variantHubFromRegistry = getVariantHubById(canonicalAssetId);
    const showSingletonVariantBadge = shouldShowSingletonVariantBadge(category, variants.length);
    const variantGroup =
        (variants.length > 1 || showSingletonVariantBadge
            ? buildVariantGroup(canonicalAssetId, displayName, variants, variantHubFromRegistry)
            : null) ?? variantHubFromRegistry;

    // Advisory state: the viewed variant's advisory drives the banner, the
    // header links, and trade gating; sibling advisories (flagged variants
    // other than the viewed one) drive the compact notice on the canonical view.
    const viewedAdvisory = getViewedAdvisory({ requestedVariant, primary });
    const advisoryEntries = collectVariantAdvisories(variants, api?.advisories);
    const siblingAdvisories = getSiblingAdvisories(advisoryEntries, activeKey);
    const tradeBlocked = isTradeBlocked(viewedAdvisory);

    // Stablecoin health: the viewed variant's peg status drives the header
    // pill (single-variant views only) and unlocks the Security section on the
    // canonical view for single-variant stablecoins.
    const viewedPegHealth = (requestedVariant ?? primary)?.pegHealth ?? null;

    // The server already caps the `solana` asset's yield tail (≥ $250K
    // liquidity, max 500); the note reports how many it left out.
    const solanaRowCount = variants.filter(v => v.chain === 'solana').length;
    const solanaHiddenCount =
        canonicalAssetId === 'solana'
            ? Math.max(0, (chainStats.solana?.variantCount ?? solanaRowCount) - solanaRowCount)
            : 0;

    return {
        api,
        assetRef: requestedName.trim() || assetId,
        canonicalAssetId,
        category,
        coingeckoId,
        assetDescription: normalizeOptionalText(api?.description) || null,
        assetChains,
        variants,
        requestedVariant,
        isVariantView,
        active,
        activeKey,
        activeAddress,
        activeChain,
        caps,
        buyAddress,
        tradeOnChainHref,
        tradeOnChainLabel,
        viewedAdvisory,
        advisoryEntries,
        siblingAdvisories,
        tradeBlocked,
        isStablecoin,
        viewedPegHealth,
        referenceMarket,
        shouldUseCanonicalMarket,
        shouldEnableRealtimePrice,
        canonicalStatsMarket,
        variantStatsMarket,
        displayName,
        displaySymbol,
        canonicalSymbolForRealtime,
        selectedVariantLogoURI,
        displayLogoURI,
        variantGroup,
        showSingletonVariantBadge,
        solanaHiddenCount,
    };
}

async function AssetPageContent(props: AssetPageProps) {
    const {
        assetRef,
        canonicalAssetId,
        category,
        coingeckoId,
        assetDescription,
        assetChains,
        requestedVariant,
        isVariantView,
        active,
        activeKey,
        activeAddress,
        activeChain,
        caps,
        buyAddress,
        tradeOnChainHref,
        tradeOnChainLabel,
        referenceMarket,
        shouldUseCanonicalMarket,
        shouldEnableRealtimePrice,
        canonicalStatsMarket,
        variantStatsMarket,
        displayName,
        displaySymbol,
        canonicalSymbolForRealtime,
        selectedVariantLogoURI,
        displayLogoURI,
        variantGroup,
        showSingletonVariantBadge,
        variants,
        viewedAdvisory,
        siblingAdvisories,
        viewedPegHealth,
        solanaHiddenCount,
    } = await loadAssetPageModel(props);

    const activeSymbol = requestedVariant?.displaySymbol ?? displaySymbol;
    // The header describes exactly one token on a variant view or when the
    // asset has a single variant; otherwise the per-variant pills live in the
    // variants list so the canonical `usd` view never shows one token's peg
    // as if it were the asset's.
    const isSingleVariantView = isVariantView || variants.length === 1;
    const headerPegHealth = isSingleVariantView ? viewedPegHealth : null;
    const activeChainLabel = activeChain ? CHAINS[activeChain].label : 'Solana';
    const activeSolanaMint = solanaMintOf(active);

    return (
        <TokenPageScaffold
            viewedEvent={
                <TokenViewedEvent
                    tokenAddress={!isVariantView && coingeckoId ? coingeckoId : (activeAddress ?? canonicalAssetId)}
                    tokenAddressType={!isVariantView && coingeckoId ? 'coingecko' : (activeChain ?? 'solana')}
                    tokenChain={activeChain}
                    tokenSymbol={displaySymbol}
                    tokenName={displayName}
                    advisoryStatus={viewedAdvisory?.status ?? null}
                    tokenPrice={
                        shouldUseCanonicalMarket ? (referenceMarket?.price ?? null) : (active?.market?.price ?? null)
                    }
                    tokenPriceChange24h={
                        shouldUseCanonicalMarket
                            ? (referenceMarket?.priceChange24hPercent ?? null)
                            : (active?.market?.priceChange24hPercent ?? null)
                    }
                    tokenMarketCap={
                        shouldUseCanonicalMarket
                            ? (referenceMarket?.marketCap ?? null)
                            : (active?.market?.marketCap ?? null)
                    }
                    hasCoingeckoId={Boolean(coingeckoId)}
                    coingeckoId={coingeckoId ?? undefined}
                    source="assets"
                />
            }
            background={displayLogoURI ? <AssetPageBackground logoURI={displayLogoURI} /> : null}
            displayName={displayName}
            breadcrumbCanonicalHref={requestedVariant ? `/${encodeURIComponent(assetRef)}` : undefined}
            breadcrumbVariantSymbol={requestedVariant ? requestedVariant.displaySymbol : undefined}
            buyAddress={buyAddress}
            buySymbol={activeSymbol}
            buyLogoURI={displayLogoURI ?? undefined}
            advisory={viewedAdvisory}
            tradeOnChainHref={tradeOnChainHref}
            tradeOnChainLabel={tradeOnChainLabel}
            advisoryBanner={
                viewedAdvisory || siblingAdvisories.length > 0 ? (
                    <>
                        <AssetAdvisoryBanner advisory={viewedAdvisory} symbol={activeSymbol} mint={activeAddress} />
                        <AssetAdvisorySiblingNotice
                            entries={siblingAdvisories}
                            assetId={canonicalAssetId}
                            displayName={displayName}
                        />
                    </>
                ) : null
            }
            header={
                <TokenHeaderWithLinks
                    assetId={canonicalAssetId}
                    coingeckoId={coingeckoId ?? null}
                    enableCoinGeckoFallback={!isVariantView}
                    baseProps={{
                        address: activeAddress ?? canonicalAssetId,
                        chain: activeChain,
                        symbol: displaySymbol,
                        displayName,
                        displayLogoURI,
                        selectedVariant: requestedVariant
                            ? {
                                  chain: requestedVariant.chain,
                                  address: requestedVariant.address,
                                  symbol: requestedVariant.displaySymbol,
                              }
                            : null,
                        variantLinkMode: 'coingecko',
                        variantLinkCoinId: coingeckoId ?? canonicalAssetId,
                        variantGroup,
                        showSingletonVariantBadge,
                        variantCurrentKey: activeKey ?? undefined,
                        advisory: viewedAdvisory,
                        pegHealth: headerPegHealth,
                        showRisk: caps.risk,
                    }}
                />
            }
            sidebar={
                <TokenSidebarWithData
                    descriptionOverride={assetDescription}
                    assetId={canonicalAssetId}
                    coingeckoId={coingeckoId ?? null}
                    enableCoinGeckoFallback={!isVariantView}
                    buyAddress={buyAddress}
                    buySymbol={activeSymbol}
                    buyLogoURI={displayLogoURI ?? undefined}
                    displayName={displayName}
                    advisory={viewedAdvisory}
                    tradeOnChainHref={tradeOnChainHref}
                    tradeOnChainLabel={tradeOnChainLabel}
                />
            }
        >
            {active && caps.chart !== 'none' && (
                <AssetPriceChartSection
                    assetId={canonicalAssetId}
                    coingeckoId={coingeckoId ?? undefined}
                    category={category}
                    mint={caps.chart === 'variant' ? activeSolanaMint : undefined}
                    mode={caps.chart}
                    symbol={
                        caps.chart === 'variant'
                            ? (active.displaySymbol ?? displaySymbol)
                            : // The canonical series is the asset's, not this token's: title it as such on a variant view.
                              canonicalSymbolForRealtime.trim() || displaySymbol
                    }
                    realtimeSymbol={(() => {
                        const canonicalUpper = canonicalSymbolForRealtime.trim().toUpperCase();
                        if (!canonicalUpper) return undefined;

                        if (caps.chart !== 'variant') return canonicalSymbolForRealtime;

                        const raw =
                            requestedVariant?.symbol ??
                            requestedVariant?.label ??
                            requestedVariant?.displaySymbol ??
                            '';
                        const trimmed = raw.trim();
                        if (!trimmed) return undefined;

                        const ticker = trimmed.toUpperCase();
                        // Only enable realtime for variants when we have a variant-specific ticker (avoid `SOL` leaking into JitoSOL).
                        if (ticker === canonicalUpper) return undefined;
                        if (!/^[A-Z0-9]{2,15}$/.test(ticker)) return undefined;
                        return ticker;
                    })()}
                    realtimeEnabled={shouldEnableRealtimePrice}
                    tokenName={displayName}
                    logoURI={
                        isVariantView
                            ? selectedVariantLogoURI || displayLogoURI
                            : getTokenLogoURLForMintWithSecondarySymbol(
                                  activeSolanaMint,
                                  displaySymbol,
                                  displayName,
                                  undefined,
                              ) || displayLogoURI
                    }
                    currentPrice={
                        isVariantView
                            ? (active.market?.price ?? undefined)
                            : referenceMarket?.source === 'stock'
                              ? (referenceMarket.price ?? undefined)
                              : (referenceMarket?.price ?? active.market?.price ?? undefined)
                    }
                    priceChange24h={
                        isVariantView
                            ? (active.market?.priceChange24hPercent ?? undefined)
                            : referenceMarket?.source === 'stock'
                              ? (referenceMarket.priceChange24hPercent ?? undefined)
                              : (referenceMarket?.priceChange24hPercent ??
                                active.market?.priceChange24hPercent ??
                                undefined)
                    }
                />
            )}

            <AssetStatsSection
                mode={isVariantView ? 'variant' : 'canonical'}
                market={isVariantView ? variantStatsMarket : canonicalStatsMarket}
                globalStats={isVariantView ? variantReferenceFallback(active?.reference) : null}
                chainLabel={activeChainLabel}
                chainList={isVariantView ? activeChainLabel : formatChainList(assetChains)}
            />

            {caps.marketsOverview && (
                <AssetMarketsOverviewSection
                    assetId={canonicalAssetId}
                    title={assetChains.length > 1 ? 'Solana markets' : 'Markets'}
                />
            )}

            {!isVariantView && <AssetLaunchesSection assetId={canonicalAssetId} displaySymbol={displaySymbol} />}

            {caps.dexMarkets && activeSolanaMint && (
                <AssetMarketsSection
                    assetId={canonicalAssetId}
                    tokenMint={activeSolanaMint}
                    tokenSymbol={displaySymbol}
                    tokenName={displayName}
                />
            )}

            {caps.risk && activeSolanaMint && <AssetRiskSection assetId={canonicalAssetId} mint={activeSolanaMint} />}

            <AssetVariantsSection
                canonicalAssetId={canonicalAssetId}
                variants={variants}
                hiddenCount={solanaHiddenCount}
            />

            <AssetDataSourceNote />
        </TokenPageScaffold>
    );
}

function AssetVariantsSection({
    canonicalAssetId,
    variants,
    hiddenCount,
}: {
    canonicalAssetId: string;
    variants: AssetPageVariant[];
    hiddenCount: number;
}) {
    const MIN_LIQUIDITY_USD = 250_000;
    const hasExecutionQuality = variants.some(v => v.executionQuality);

    return (
        <section className="mt-10">
            <h2 className="text-title-md text-text-extra-high text-balance">Variants</h2>
            {hiddenCount > 0 ? (
                <p className="mt-3 text-[13px] text-text-low">
                    Showing variants with at least {formatLargeNumber(MIN_LIQUIDITY_USD)} liquidity ({hiddenCount}{' '}
                    hidden).
                </p>
            ) : null}
            {hasExecutionQuality ? (
                <p className="mt-3 text-[13px] text-text-low">
                    Execution quality is available for highlighted variants to compare execution and routing quality.
                </p>
            ) : null}
            <AssetVariantsList canonicalAssetId={canonicalAssetId} variants={variants} />
        </section>
    );
}

function AssetDataSourceNote() {
    return (
        <section className="mt-6 flex items-start gap-2 rounded-2xl border border-border-extra-light bg-gray-50/80 px-4 py-3 text-[13px] leading-relaxed text-text-low">
            <Logo width={16} height={16} className="mt-1 shrink-0 opacity-80" />
            <p>
                We use publicly available data from the blockchain, as well as data procured by our trusted data
                partners and related sources.{' '}
                <Link
                    href="/partners"
                    className="inline-flex items-center gap-0.5 font-medium text-text-high transition-colors hover:text-text-extra-high"
                >
                    Learn more
                    <ArrowUpRight className="size-3" aria-hidden />
                </Link>
            </p>
        </section>
    );
}
