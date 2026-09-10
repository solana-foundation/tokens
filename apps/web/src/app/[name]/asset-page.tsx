import { Suspense, cache, type ComponentProps } from 'react';
import { connection } from 'next/server';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

import type { AssetVariant, CanonicalAsset, LiquidityTier, TrustTier, VariantHub } from '@tokens/asset-registry';
import { getVariantHubById, liquidityTierPriority } from '@tokens/asset-registry';
import { Skeleton } from '@tokens/ui/skeleton';

import { TokenHeader } from '@/app/token/[address]/components/token-header';
import { Logo } from '@/components/logo';
import { TokenViewedEvent } from '@/components/token-viewed-event';
import { cleanTokenName, getMintLogoOverride, getTokenLogoURLForMintWithSecondarySymbol } from '@/lib/logo-overrides';
import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import { formatLargeNumber } from '@/lib/format';
import { getGlobalTokenStats, type GlobalTokenStats } from '@/lib/coingecko';
import { looksLikeSolanaMintAddress } from '@/lib/solana-address';
import { AssetPriceChartSection } from './components/asset-price-chart-section';
import { AssetMarketsSection } from './components/asset-markets-section';
import { AssetMarketsOverviewSection } from './components/asset-markets-overview-section';
import { AssetRiskSection } from './components/asset-risk-section';
import { AssetStatsSection } from './components/asset-stats-section';
import { AssetVariantsList } from './components/asset-variants-list';
import { TokenPageBackgroundBlur, TokenPageScaffold, TokenPageSidebar } from './components/token-page-shell';
import { normalizeOptionalText, pickFirstDisplayName, pickFirstSymbol } from './lib/asset-display';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';

interface AssetPageProps {
    asset: CanonicalAsset;
    /** The original `/[name]` param; can differ from `asset.assetId` when using CoinGecko IDs. */
    requestedName: string;
    /** Optional mint to render as the active variant (e.g. `?solana=...` or `/token/[mint]`). */
    requestedMint?: string;
}

interface MarketSnapshot {
    source?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    metricsSource?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    price: number | null;
    liquidity: number | null;
    volume1hUSD?: number | null;
    volume24hUSD: number | null;
    trade1h?: number | null;
    trade24h?: number | null;
    uniqueWallet1h?: number | null;
    uniqueWallet24h?: number | null;
    marketCap: number | null;
    fdv?: number | null;
    holder?: number | null;
    totalSupply?: number | null;
    circulatingSupply?: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
    decimals: number | null;
    logoURI: string | null;
    // These may or may not be present depending on the endpoint/version.
    symbol?: string;
    name?: string;
    lastTradeAt?: number | null;
    asOf?: number | null;
    lastFetchedAt?: number | null;
}

interface VariantExecutionQualitySnapshot {
    source: 'clickhouse_fill_quality';
    range: '24h';
    horizon: '5s';
    quoteMint: string;
    volume24hUSD: number;
    trade24h: number;
    botVolume24hUSD: number;
    botTrade24h: number;
    botVolumeRatio: number;
    fee24hUSD: number;
    feeBps: number;
    flowSourceCount: number;
    markoutPnl24hUSD: number | null;
    markoutCount: number | null;
    markoutBps: number | null;
    executionScore: number;
    isEligibleForPrimary: boolean;
    asOf: number | null;
    lastComputedAt: number;
}

type CanonicalMarketSnapshot =
    | {
          source: 'coingecko';
          coinId: string;
          price: number | null;
          marketCap: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          lastFetchedAt: number | null;
          providerLastUpdatedAt: number | null;
      }
    | {
          source: 'clickhouse_stock';
          symbol: string;
          price: number | null;
          marketCap?: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          lastFetchedAt: number | null;
          providerLastUpdatedAt: number | null;
          asOf: number | null;
      }
    | {
          source: 'prestocks';
          symbol: string;
          mint: string;
          price: number | null;
          /** Implied company valuation — NOT the tokenized float value. */
          marketCap: number | null;
          markPriceUsd: number | null;
          markValuationUsd: number | null;
          impliedValuationUsd: number | null;
          premiumToMarkPercent: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          lastFetchedAt: number | null;
          providerLastUpdatedAt: number | null;
          asOf: number | null;
      };

/** PreStocks reference block attached to variants whose mint is a PreStocks token. */
interface PreStocksVariantSnapshot {
    symbol?: string;
    markPriceUsd: number | null;
    markValuationUsd: number | null;
    impliedValuationUsd: number | null;
    premiumToMarkPercent: number | null;
    lastFetchedAt?: number | null;
}

interface AssetStatsSnapshot {
    price: number | null;
    liquidity: number | null;
    volume24hUSD: number | null;
    marketCap: number | null;
    fdv?: number | null;
    totalSupply?: number | null;
    circulatingSupply?: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
}

interface VariantWithMarket extends AssetVariant {
    liquidityTier?: LiquidityTier;
    market: MarketSnapshot | null;
    executionQuality?: VariantExecutionQualitySnapshot | null;
    /** Best-effort display */
    displaySymbol: string;
    displayName: string;
}

type ApiAssetVariant = AssetVariant & {
    liquidityTier?: LiquidityTier;
    market?: MarketSnapshot & { lastFetchedAt?: number; source?: string };
    executionQuality?: VariantExecutionQualitySnapshot | null;
    rank?: number;
    preStocks?: PreStocksVariantSnapshot | null;
};

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

interface AssetsV1AssetResponse {
    asset: {
        assetId: string;
        name?: string;
        symbol?: string;
        category?: CanonicalAsset['category'];
        coingeckoId?: string;
        description?: string;
        canonicalMarket?: CanonicalMarketSnapshot;
        imageUrl?: string | null;
        stats?: AssetStatsSnapshot | null;
        primaryVariant:
            | (AssetVariant & {
                  liquidityTier?: LiquidityTier;
                  market?: MarketSnapshot & { lastFetchedAt?: number; source?: string };
                  executionQuality?: VariantExecutionQualitySnapshot | null;
                  rank?: number;
                  preStocks?: PreStocksVariantSnapshot | null;
              })
            | null;
        variantGroups: Partial<
            Record<'spot' | 'etf' | 'yield' | 'leveraged' | 'basket' | 'lst' | 'tokenizedEquity', ApiAssetVariant[]>
        >;
    };
    includes?: {
        profile?: AssetIncludeResult<GlobalTokenStats>;
    };
}

function effectiveLiquidityTier(variant: { liquidityTier?: LiquidityTier; trustTier: TrustTier }): LiquidityTier {
    return variant.liquidityTier ?? variant.trustTier;
}

function pickPrimaryVariant(
    variants: VariantWithMarket[],
    options: { category?: CanonicalAsset['category'] } = {},
): VariantWithMarket | null {
    if (variants.length === 0) return null;

    const candidates =
        options.category === 'equity'
            ? variants.filter(
                  v => v.stockVariantTier === 'share_redeemable' || v.stockVariantTier === 'cash_redeemable',
              )
            : variants;
    const rankedVariants = candidates.length > 0 ? candidates : variants;

    const byLiquidity = rankedVariants.slice().sort((a, b) => (b.market?.liquidity ?? 0) - (a.market?.liquidity ?? 0));
    const bestLiquidity = byLiquidity[0]?.market?.liquidity ?? 0;
    const liquidityCandidates = byLiquidity.filter(v => (v.market?.liquidity ?? 0) === bestLiquidity);

    const byTrust = liquidityCandidates
        .slice()
        .sort(
            (a, b) =>
                liquidityTierPriority(effectiveLiquidityTier(b)) - liquidityTierPriority(effectiveLiquidityTier(a)),
        );
    const bestTrust = liquidityTierPriority(effectiveLiquidityTier(byTrust[0] ?? { trustTier: 'tier3' }));
    const trustCandidates = byTrust.filter(v => liquidityTierPriority(effectiveLiquidityTier(v)) === bestTrust);

    const byVolume = trustCandidates
        .slice()
        .sort((a, b) => (b.market?.volume24hUSD ?? 0) - (a.market?.volume24hUSD ?? 0));

    return byVolume[0] ?? trustCandidates[0] ?? rankedVariants[0] ?? null;
}

function shouldShowSingletonVariantBadge(asset: CanonicalAsset): boolean {
    return asset.category === 'equity' && asset.variants.length === 1;
}

function buildVariantGroup(
    assetId: string,
    displayName: string,
    variants: VariantWithMarket[],
    registryHub?: VariantHub | null,
) {
    if (variants.length === 0) return null;

    // API variants (registry ∪ DB) decide membership so admin-added variants
    // appear without a redeploy; the static registry hub only supplies labels.
    const registryLabelByMint = new Map(
        (registryHub?.addresses ?? []).map(item => [item.address, item.label] as const),
    );

    return {
        id: assetId,
        label: `${displayName} variants`,
        addresses: (() => {
            const unique: Array<{ address: string; label?: string }> = [];
            const seen = new Set<string>();
            for (const variant of variants) {
                if (seen.has(variant.mint)) continue;
                seen.add(variant.mint);
                const label = registryLabelByMint.get(variant.mint) ?? variant.label?.trim() ?? undefined;
                unique.push({ address: variant.mint, ...(label ? { label } : {}) });
            }
            return unique;
        })(),
    };
}

function getProviderOnlyLabel(value: string | undefined | null): 'xstock' | 'ondo' | null {
    const normalized = (value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    if (normalized === 'xstock') return 'xstock';
    if (normalized === 'ondo') return 'ondo';
    return null;
}

function deriveProviderVariantSymbol(
    provider: 'xstock' | 'ondo' | null,
    canonicalSymbol: string,
    marketSymbol: string | undefined | null,
): string {
    if (!provider || !canonicalSymbol) return '';

    const normalizedCanonical = canonicalSymbol.trim();
    const normalizedMarket = (marketSymbol ?? '').trim();
    const marketLooksCanonical =
        !normalizedMarket || normalizedMarket.toLowerCase() === normalizedCanonical.toLowerCase();

    if (!marketLooksCanonical) return '';
    return provider === 'xstock' ? `${normalizedCanonical}x` : `${normalizedCanonical}on`;
}

function isCanonicalSymbolMatch(value: string | undefined | null, canonicalSymbol: string): boolean {
    const normalizedValue = (value ?? '').trim();
    const normalizedCanonical = canonicalSymbol.trim();
    return Boolean(
        normalizedValue && normalizedCanonical && normalizedValue.toLowerCase() === normalizedCanonical.toLowerCase(),
    );
}

function humanizeAssetRef(value: string | undefined | null): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed || looksLikeSolanaMintAddress(trimmed)) return '';

    const withoutProviderPrefix = trimmed.replace(/^xstock[-_]/i, '').replace(/^ondo[-_]/i, '');
    return withoutProviderPrefix
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map(part => (part.length <= 4 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`))
        .join(' ');
}

function buildVariantsWithMarket(
    asset: CanonicalAsset,
    tokenByMint: Map<string, MarketSnapshot>,
    options?: { assetSymbol?: string; assetName?: string },
): VariantWithMarket[] {
    const assetFallbackSymbol = pickFirstSymbol(options?.assetSymbol, asset.symbol);
    const assetFallbackName = pickFirstDisplayName(options?.assetName, asset.name) || assetFallbackSymbol;

    return asset.variants.map(variant => {
        const market = tokenByMint.get(variant.mint) ?? null;
        const providerLabel = getProviderOnlyLabel(variant.label);
        const labelFallback = providerLabel ? '' : variant.label;
        const variantSymbol = pickFirstSymbol(variant.symbol);
        const variantSymbolFallback =
            providerLabel &&
            (isCanonicalSymbolMatch(variantSymbol, assetFallbackSymbol) || getProviderOnlyLabel(variantSymbol))
                ? ''
                : variantSymbol;
        const marketSymbolFallback =
            providerLabel && isCanonicalSymbolMatch(market?.symbol, assetFallbackSymbol) ? '' : market?.symbol;
        const providerDisplaySymbol = deriveProviderVariantSymbol(providerLabel, assetFallbackSymbol, market?.symbol);

        const displaySymbol =
            pickFirstSymbol(variantSymbolFallback, providerDisplaySymbol, marketSymbolFallback, labelFallback) ||
            assetFallbackSymbol ||
            '???';
        const displayName =
            pickFirstDisplayName(variant.name, market?.name, assetFallbackName, labelFallback) || displaySymbol;

        return {
            ...variant,
            market,
            executionQuality: (variant as { executionQuality?: VariantExecutionQualitySnapshot | null })
                .executionQuality,
            displaySymbol,
            displayName,
        };
    });
}

function getApiVariantRows(groups: AssetsV1AssetResponse['asset']['variantGroups'] | undefined): ApiAssetVariant[] {
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

const loadGlobalStats = cache(
    async (
        assetId: string,
        coingeckoId: string | null,
        enableCoinGeckoFallback: boolean,
    ): Promise<GlobalTokenStats | null> => {
        // Profile is optional (requires extra scopes). Load separately so `assets:read` can still render the page.
        const apiProfile = await fetchApiAppJsonOrNull<AssetsV1AssetResponse>(
            `/api/v1/assets/${encodeURIComponent(assetId)}?${new URLSearchParams({ include: 'profile' }).toString()}`,
            { next: { revalidate: 300 } },
        );

        const profileInclude = apiProfile?.includes?.profile;
        const apiGlobalStats = profileInclude && profileInclude.ok ? profileInclude.data : null;
        if (apiGlobalStats) return apiGlobalStats;

        const resolvedCoinGeckoId = (coingeckoId ?? '').trim();
        if (enableCoinGeckoFallback && resolvedCoinGeckoId) {
            // The Effect runtime reads the clock internally, which Next 16
            // rejects during prerendering; this fallback is request-time work,
            // so mark the boundary dynamic before entering it.
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

function TokenSidebarWithData({
    descriptionOverride,
    assetId,
    coingeckoId,
    enableCoinGeckoFallback,
    buyAddress,
    buySymbol,
    buyLogoURI,
    displayName,
}: {
    descriptionOverride?: string | null;
    assetId: string;
    coingeckoId: string | null;
    enableCoinGeckoFallback: boolean;
    buyAddress: string | null;
    buySymbol?: string;
    buyLogoURI?: string;
    displayName: string;
}) {
    return (
        <Suspense
            fallback={
                <TokenPageSidebar
                    buyAddress={buyAddress}
                    buySymbol={buySymbol}
                    buyLogoURI={buyLogoURI}
                    displayName={displayName}
                    description={descriptionOverride ?? null}
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
}: {
    descriptionOverride?: string | null;
    assetId: string;
    coingeckoId: string | null;
    enableCoinGeckoFallback: boolean;
    buyAddress: string | null;
    buySymbol?: string;
    buyLogoURI?: string;
    displayName: string;
}) {
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

function canonicalVolumeLabel(source: CanonicalMarketSnapshot['source'] | undefined): string | null {
    if (source === 'coingecko') return 'Canonical';
    return null;
}

function shouldShowCanonicalVolumePill(
    category: CanonicalAsset['category'] | undefined,
    canonicalMarket: CanonicalMarketSnapshot | null,
) {
    return category === 'crypto' && canonicalMarket?.source === 'coingecko';
}

function buildCanonicalStatsMarket(
    stats: AssetStatsSnapshot | null | undefined,
    canonicalMarket: CanonicalMarketSnapshot | null,
    category?: CanonicalAsset['category'],
): ComponentProps<typeof AssetStatsSection>['market'] {
    if (!stats && !canonicalMarket) return null;

    if (canonicalMarket?.source === 'clickhouse_stock') {
        // Prefer the underlying company's market cap (price × shares
        // outstanding) over the aggregated tokenized-supply mcap.
        const companyMarketCap = pickFiniteNumber(canonicalMarket.marketCap ?? null, null);
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
        };
    }

    if (canonicalMarket?.source === 'prestocks') {
        // Tokenized pre-IPO exposure: `marketCap` stays the on-chain token
        // float; the implied company valuation and premium-to-mark render from
        // the dedicated `preStocks` block.
        return {
            price: pickFiniteNumber(stats?.price, canonicalMarket.price),
            liquidity: pickFiniteNumber(stats?.liquidity, null),
            volume24hUSD: pickFiniteNumber(stats?.volume24hUSD, null),
            marketCap: pickFiniteNumber(stats?.marketCap, null),
            fdv: pickFiniteNumber(stats?.fdv, null),
            totalSupply: pickFiniteNumber(stats?.totalSupply, null),
            circulatingSupply: pickFiniteNumber(stats?.circulatingSupply, null),
            priceChange24hPercent: pickFiniteNumber(stats?.priceChange24hPercent, null),
            preStocks: {
                markPriceUsd: canonicalMarket.markPriceUsd,
                markValuationUsd: canonicalMarket.markValuationUsd,
                impliedValuationUsd: canonicalMarket.impliedValuationUsd,
                premiumToMarkPercent: canonicalMarket.premiumToMarkPercent,
            },
        };
    }

    const showCanonicalVolumePill = shouldShowCanonicalVolumePill(category, canonicalMarket);
    const underlyingVolume24hUSD =
        showCanonicalVolumePill && canonicalMarket ? pickFiniteNumber(canonicalMarket.volume24hUSD, null) : null;
    const underlyingVolume24hLabel =
        underlyingVolume24hUSD !== null ? canonicalVolumeLabel(canonicalMarket?.source) : null;

    return {
        price: pickFiniteNumber(stats?.price, canonicalMarket?.price),
        liquidity: pickFiniteNumber(stats?.liquidity, null),
        volume24hUSD: pickFiniteNumber(stats?.volume24hUSD, canonicalMarket?.volume24hUSD),
        ...(underlyingVolume24hUSD !== null ? { underlyingVolume24hUSD } : {}),
        ...(underlyingVolume24hLabel ? { underlyingVolume24hLabel } : {}),
        marketCap: pickFiniteNumber(stats?.marketCap, canonicalMarket?.marketCap ?? null),
        fdv: pickFiniteNumber(stats?.fdv, null),
        totalSupply: pickFiniteNumber(stats?.totalSupply, null),
        circulatingSupply: pickFiniteNumber(stats?.circulatingSupply, null),
        priceChange24hPercent: pickFiniteNumber(stats?.priceChange24hPercent, canonicalMarket?.priceChange24hPercent),
    };
}

function AssetStatsSectionWithData({
    assetId,
    coingeckoId,
    enableCoinGeckoFallback,
    market,
    mode,
}: {
    assetId: string;
    coingeckoId: string | null;
    enableCoinGeckoFallback: boolean;
    market: ComponentProps<typeof AssetStatsSection>['market'];
    mode: ComponentProps<typeof AssetStatsSection>['mode'];
}) {
    return (
        <Suspense fallback={<AssetStatsSection market={market} globalStats={null} mode={mode} />}>
            <AssetStatsSectionWithDataLoader
                assetId={assetId}
                coingeckoId={coingeckoId}
                enableCoinGeckoFallback={enableCoinGeckoFallback}
                market={market}
                mode={mode}
            />
        </Suspense>
    );
}

async function AssetStatsSectionWithDataLoader({
    assetId,
    coingeckoId,
    enableCoinGeckoFallback,
    market,
    mode,
}: {
    assetId: string;
    coingeckoId: string | null;
    enableCoinGeckoFallback: boolean;
    market: ComponentProps<typeof AssetStatsSection>['market'];
    mode: ComponentProps<typeof AssetStatsSection>['mode'];
}) {
    const globalStats = await loadGlobalStats(assetId, coingeckoId, enableCoinGeckoFallback);
    return <AssetStatsSection market={market} globalStats={globalStats} mode={mode} />;
}

export function AssetPage(props: AssetPageProps) {
    // No awaits before JSX: flush the page shell (breadcrumb, header identity,
    // section chrome) immediately and stream the `/api/v1/assets/:id`-dependent
    // content in via Suspense. `page.tsx` has already validated the asset
    // (registry or resolve API) and owns notFound(); `AssetPageContent` degrades
    // gracefully to registry data when the fetch returns null, so no
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
function AssetPageShellFallback({ asset, requestedName, requestedMint }: AssetPageProps) {
    const assetRef = requestedName.trim() || asset.assetId;
    const canonicalAssetId = asset.assetId;
    const requestedMintClean = (requestedMint ?? '').trim();

    const variants = buildVariantsWithMarket(asset, new Map());
    const primary = pickPrimaryVariant(variants, { category: asset.category });
    const requestedVariant =
        requestedMintClean.length > 0 && looksLikeSolanaMintAddress(requestedMintClean)
            ? (variants.find(v => v.mint === requestedMintClean) ?? null)
            : null;
    const isVariantView = Boolean(requestedVariant);
    const active = requestedVariant ?? primary;

    const displayNameRaw =
        pickFirstDisplayName(
            asset.name,
            humanizeAssetRef(canonicalAssetId),
            humanizeAssetRef(requestedName),
            active?.displayName,
        ) || 'Unknown';
    const displayName = cleanTokenName(displayNameRaw);
    const displaySymbol =
        (isVariantView
            ? pickFirstSymbol(active?.displaySymbol, asset.symbol)
            : pickFirstSymbol(asset.symbol, active?.displaySymbol)) || '???';

    const selectedVariantLogoURI = requestedVariant ? getMintLogoOverride(requestedVariant.mint) : undefined;
    const canonicalLogoURI = getTokenLogoURLForMintWithSecondarySymbol(
        active?.mint,
        displaySymbol,
        displayName,
        undefined,
    );
    const displayLogoURI = isVariantView ? selectedVariantLogoURI || canonicalLogoURI : canonicalLogoURI;

    const activeMint = active?.mint ?? null;
    const variantHubFromRegistry = getVariantHubById(canonicalAssetId);
    const showSingletonVariantBadge = shouldShowSingletonVariantBadge(asset);
    const variantGroup =
        (variants.length > 1 || showSingletonVariantBadge
            ? buildVariantGroup(canonicalAssetId, displayName, variants, variantHubFromRegistry)
            : null) ?? variantHubFromRegistry;

    return (
        <TokenPageScaffold
            background={displayLogoURI ? <AssetPageBackground logoURI={displayLogoURI} /> : null}
            displayName={displayName}
            breadcrumbCanonicalHref={requestedVariant ? `/${encodeURIComponent(assetRef)}` : undefined}
            breadcrumbVariantSymbol={requestedVariant ? requestedVariant.displaySymbol : undefined}
            buyAddress={null}
            header={
                <TokenHeader
                    address={activeMint ?? canonicalAssetId}
                    symbol={displaySymbol}
                    displayName={displayName}
                    displayLogoURI={displayLogoURI}
                    selectedVariant={
                        requestedVariant
                            ? {
                                  mint: requestedVariant.mint,
                                  symbol: requestedVariant.displaySymbol,
                              }
                            : null
                    }
                    variantLinkMode="coingecko"
                    variantLinkCoinId={asset.coingeckoId ?? canonicalAssetId}
                    variantGroup={variantGroup}
                    showSingletonVariantBadge={showSingletonVariantBadge}
                    variantCurrentAddress={activeMint ?? undefined}
                />
            }
            sidebar={<AssetPageSidebarSkeleton showBuyButton={Boolean(activeMint)} />}
        >
            <AssetPageSectionsSkeleton showChart={Boolean(activeMint)} />
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
 * Fetch `/api/v1/assets/:id` and derive everything `AssetPageContent` renders:
 * the effective asset (API overrides layered over the registry), variant list
 * with market snapshots, the active/primary variant, and display identity
 * (name/symbol/logo). Degrades gracefully to registry data when the fetch
 * returns null.
 */
async function loadAssetPageModel({ asset, requestedName, requestedMint }: AssetPageProps) {
    const tokenByMint = new Map<string, MarketSnapshot>();

    const assetRef = requestedName.trim() || asset.assetId;
    const apiAssetRef = asset.assetId.trim() || assetRef;
    const requestedMintClean = (requestedMint ?? '').trim();
    const apiAssetUrl =
        requestedMintClean.length > 0 && looksLikeSolanaMintAddress(requestedMintClean)
            ? `/api/v1/assets/${encodeURIComponent(apiAssetRef)}?mint=${encodeURIComponent(requestedMintClean)}`
            : `/api/v1/assets/${encodeURIComponent(apiAssetRef)}`;
    const apiAsset = await fetchApiAppJsonOrNull<AssetsV1AssetResponse>(apiAssetUrl, {
        next: { revalidate: 60 },
    });
    const preStocksByMint = new Map<string, PreStocksVariantSnapshot>();
    if (apiAsset) {
        const primary = apiAsset.asset.primaryVariant;
        if (primary?.market) tokenByMint.set(primary.mint, primary.market);
        if (primary?.preStocks) preStocksByMint.set(primary.mint, primary.preStocks);

        for (const variant of getApiVariantRows(apiAsset.asset.variantGroups)) {
            if (variant.preStocks) preStocksByMint.set(variant.mint, variant.preStocks);
            if (!variant.market) continue;
            tokenByMint.set(variant.mint, variant.market);
        }
    }

    const canonicalMarket = apiAsset?.asset.canonicalMarket ?? null;
    const stockCanonicalSymbol =
        canonicalMarket?.source === 'clickhouse_stock' ? pickFirstSymbol(canonicalMarket.symbol) : null;
    const apiDisplayName = pickFirstDisplayName(apiAsset?.asset.name, apiAsset?.asset.primaryVariant?.name);
    const apiDisplaySymbol = pickFirstSymbol(
        stockCanonicalSymbol,
        apiAsset?.asset.symbol,
        apiAsset?.asset.primaryVariant?.symbol,
    );

    const canonicalAssetId = (apiAsset?.asset.assetId ?? asset.assetId).trim() || asset.assetId;
    const coingeckoId = apiAsset?.asset.coingeckoId ?? asset.coingeckoId;

    const apiVariants = apiAsset
        ? (() => {
              const rows = getApiVariantRows(apiAsset.asset.variantGroups);
              const unique: AssetVariant[] = [];
              const seen = new Set<string>();
              for (const row of rows) {
                  if (seen.has(row.mint)) continue;
                  seen.add(row.mint);
                  const {
                      market: _market,
                      executionQuality: _executionQuality,
                      rank: _rank,
                      ...variant
                  } = row as AssetVariant & {
                      market?: unknown;
                      executionQuality?: VariantExecutionQualitySnapshot | null;
                      rank?: unknown;
                  };
                  unique.push({
                      ...variant,
                      ...(_executionQuality ? { executionQuality: _executionQuality } : {}),
                  } as AssetVariant);
              }
              return unique.length > 0 ? unique : asset.variants;
          })()
        : asset.variants;

    const effectiveAsset: CanonicalAsset = {
        assetId: canonicalAssetId,
        ...(apiDisplayName ? { name: apiDisplayName } : asset.name ? { name: asset.name } : {}),
        ...(apiDisplaySymbol ? { symbol: apiDisplaySymbol } : asset.symbol ? { symbol: asset.symbol } : {}),
        category: asset.category,
        aliases: asset.aliases,
        ...(apiAsset?.asset.coingeckoId
            ? { coingeckoId: apiAsset.asset.coingeckoId }
            : asset.coingeckoId
              ? { coingeckoId: asset.coingeckoId }
              : {}),
        variants: apiVariants,
    };

    const variants = buildVariantsWithMarket(effectiveAsset, tokenByMint, {
        assetName: apiDisplayName,
        assetSymbol: apiDisplaySymbol,
    });
    const apiPrimaryMint = apiAsset?.asset.primaryVariant?.mint ?? null;
    const apiPrimaryVariant = apiPrimaryMint ? (variants.find(v => v.mint === apiPrimaryMint) ?? null) : null;
    const assetDescription = normalizeOptionalText(apiAsset?.asset.description) ?? null;
    const primary = apiPrimaryVariant ?? pickPrimaryVariant(variants, { category: effectiveAsset.category });
    const requestedVariant =
        requestedMintClean.length > 0 && looksLikeSolanaMintAddress(requestedMintClean)
            ? (variants.find(v => v.mint === requestedMintClean) ?? null)
            : null;
    const isVariantView = Boolean(requestedVariant);
    const active = requestedVariant ?? primary;
    const shouldUseCanonicalMarket = !isVariantView && canonicalMarket !== null;
    const shouldEnableRealtimePrice = isVariantView || canonicalMarket?.source !== 'clickhouse_stock';
    const canonicalStatsMarket = buildCanonicalStatsMarket(
        apiAsset?.asset.stats,
        canonicalMarket,
        effectiveAsset.category,
    );
    // Variant view: merge the variant's PreStocks reference block into its
    // market snapshot so the stats section renders the same premium/implied
    // valuation treatment as the canonical view.
    const activePreStocks = active ? (preStocksByMint.get(active.mint) ?? null) : null;
    const variantStatsMarket: ComponentProps<typeof AssetStatsSection>['market'] = active?.market
        ? {
              ...active.market,
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
            apiDisplayName,
            asset.name,
            humanizeAssetRef(canonicalAssetId),
            humanizeAssetRef(requestedName),
            active?.displayName,
        ) || 'Unknown';
    const displayName = cleanTokenName(displayNameRaw);

    const displaySymbol =
        (isVariantView
            ? pickFirstSymbol(active?.displaySymbol, apiDisplaySymbol, asset.symbol)
            : pickFirstSymbol(apiDisplaySymbol, active?.displaySymbol, asset.symbol)) || '???';
    const canonicalSymbolForRealtime = pickFirstSymbol(apiDisplaySymbol, asset.symbol) || displaySymbol;
    const uploadedLogoURI = normalizeOptionalText(apiAsset?.asset.imageUrl);
    const selectedVariantLogoURI = requestedVariant
        ? normalizeOptionalText(requestedVariant.market?.logoURI) || getMintLogoOverride(requestedVariant.mint)
        : undefined;
    const canonicalLogoURI =
        uploadedLogoURI ||
        getTokenLogoURLForMintWithSecondarySymbol(
            active?.mint,
            displaySymbol,
            displayName,
            active?.market?.logoURI ?? undefined,
        );
    const displayLogoURI = isVariantView ? selectedVariantLogoURI || canonicalLogoURI : canonicalLogoURI;

    const activeMint = active?.mint ?? null;
    const buyAddress = activeMint;
    const variantHubFromRegistry = getVariantHubById(canonicalAssetId);
    const showSingletonVariantBadge = shouldShowSingletonVariantBadge(effectiveAsset);
    const variantGroup =
        (variants.length > 1 || showSingletonVariantBadge
            ? buildVariantGroup(canonicalAssetId, displayName, variants, variantHubFromRegistry)
            : null) ?? variantHubFromRegistry;

    return {
        assetRef,
        canonicalAssetId,
        coingeckoId,
        assetDescription,
        variants,
        requestedVariant,
        isVariantView,
        active,
        activeMint,
        buyAddress,
        canonicalMarket,
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
    };
}

async function AssetPageContent(props: AssetPageProps) {
    const {
        assetRef,
        canonicalAssetId,
        coingeckoId,
        assetDescription,
        requestedVariant,
        isVariantView,
        active,
        activeMint,
        buyAddress,
        canonicalMarket,
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
    } = await loadAssetPageModel(props);

    return (
        <TokenPageScaffold
            viewedEvent={
                <TokenViewedEvent
                    tokenAddress={!isVariantView && coingeckoId ? coingeckoId : (activeMint ?? canonicalAssetId)}
                    tokenAddressType={!isVariantView && coingeckoId ? 'coingecko' : 'solana'}
                    tokenSymbol={displaySymbol}
                    tokenName={displayName}
                    tokenPrice={
                        shouldUseCanonicalMarket ? (canonicalMarket?.price ?? null) : (active?.market?.price ?? null)
                    }
                    tokenPriceChange24h={
                        shouldUseCanonicalMarket
                            ? (canonicalMarket?.priceChange24hPercent ?? null)
                            : (active?.market?.priceChange24hPercent ?? null)
                    }
                    tokenMarketCap={
                        shouldUseCanonicalMarket
                            ? (canonicalMarket?.marketCap ?? null)
                            : (active?.market?.marketCap ?? null)
                    }
                    hasCoingeckoId={Boolean(coingeckoId)}
                    coingeckoId={coingeckoId}
                    source="assets"
                />
            }
            background={displayLogoURI ? <AssetPageBackground logoURI={displayLogoURI} /> : null}
            displayName={displayName}
            breadcrumbCanonicalHref={requestedVariant ? `/${encodeURIComponent(assetRef)}` : undefined}
            breadcrumbVariantSymbol={requestedVariant ? requestedVariant.displaySymbol : undefined}
            buyAddress={buyAddress}
            buySymbol={requestedVariant?.displaySymbol ?? displaySymbol}
            buyLogoURI={displayLogoURI ?? undefined}
            header={
                <TokenHeaderWithLinks
                    assetId={canonicalAssetId}
                    coingeckoId={coingeckoId ?? null}
                    enableCoinGeckoFallback={!isVariantView}
                    baseProps={{
                        address: activeMint ?? canonicalAssetId,
                        symbol: displaySymbol,
                        displayName,
                        displayLogoURI,
                        selectedVariant: requestedVariant
                            ? {
                                  mint: requestedVariant.mint,
                                  symbol: requestedVariant.displaySymbol,
                              }
                            : null,
                        variantLinkMode: 'coingecko',
                        variantLinkCoinId: coingeckoId ?? canonicalAssetId,
                        variantGroup,
                        showSingletonVariantBadge,
                        variantCurrentAddress: activeMint ?? undefined,
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
                    buySymbol={requestedVariant?.displaySymbol ?? displaySymbol}
                    buyLogoURI={displayLogoURI ?? undefined}
                    displayName={displayName}
                />
            }
        >
            {activeMint && (
                <AssetPriceChartSection
                    assetId={canonicalAssetId}
                    coingeckoId={coingeckoId ?? undefined}
                    mint={isVariantView ? activeMint : undefined}
                    mode={isVariantView ? 'variant' : 'canonical'}
                    symbol={isVariantView ? (active?.displaySymbol ?? displaySymbol) : displaySymbol}
                    realtimeSymbol={(() => {
                        const canonicalUpper = canonicalSymbolForRealtime.trim().toUpperCase();
                        if (!canonicalUpper) return undefined;

                        if (!isVariantView) return canonicalSymbolForRealtime;

                        const raw = (requestedVariant?.market?.symbol ??
                            requestedVariant?.symbol ??
                            requestedVariant?.label ??
                            requestedVariant?.displaySymbol ??
                            '') as string;
                        const trimmed = (raw ?? '').trim();
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
                                  activeMint ?? undefined,
                                  displaySymbol,
                                  displayName,
                                  undefined,
                              ) || displayLogoURI
                    }
                    currentPrice={
                        isVariantView
                            ? (active?.market?.price ?? undefined)
                            : canonicalMarket?.source === 'clickhouse_stock'
                              ? (canonicalMarket.price ?? undefined)
                              : (canonicalMarket?.price ?? active?.market?.price ?? undefined)
                    }
                    priceChange24h={
                        isVariantView
                            ? (active?.market?.priceChange24hPercent ?? undefined)
                            : canonicalMarket?.source === 'clickhouse_stock'
                              ? (canonicalMarket.priceChange24hPercent ?? undefined)
                              : (canonicalMarket?.priceChange24hPercent ??
                                active?.market?.priceChange24hPercent ??
                                undefined)
                    }
                />
            )}

            <AssetStatsSectionWithData
                assetId={canonicalAssetId}
                coingeckoId={coingeckoId ?? null}
                enableCoinGeckoFallback={!isVariantView}
                mode={isVariantView ? 'variant' : 'canonical'}
                market={isVariantView ? variantStatsMarket : canonicalStatsMarket}
            />

            {!isVariantView && <AssetMarketsOverviewSection assetId={canonicalAssetId} />}

            {isVariantView && activeMint && (
                <AssetMarketsSection
                    assetId={canonicalAssetId}
                    tokenMint={activeMint}
                    tokenSymbol={displaySymbol}
                    tokenName={displayName}
                />
            )}

            {isVariantView && activeMint && <AssetRiskSection assetId={canonicalAssetId} mint={activeMint} />}

            <AssetVariantsSection
                canonicalAssetId={canonicalAssetId}
                displayName={displayName}
                variants={variants}
                activeMint={active?.mint ?? null}
            />

            <AssetDataSourceNote />
        </TokenPageScaffold>
    );
}

function AssetVariantsSection({
    canonicalAssetId,
    displayName,
    variants,
    activeMint,
}: {
    canonicalAssetId: string;
    displayName: string;
    variants: VariantWithMarket[];
    activeMint: string | null;
}) {
    const MIN_LIQUIDITY_USD = 250_000;

    // The Solana asset can have a large number of yield variants (LSTs).
    // Hide the long tail by default; still include the active mint so deep-links remain navigable.
    const isSolana = canonicalAssetId === 'solana';

    const shouldHide = (v: VariantWithMarket): boolean => {
        if (!isSolana) return false;
        if (v.kind !== 'yield') return false;
        if (activeMint && v.mint === activeMint) return false;
        const liq = v.market?.liquidity ?? 0;
        return !(typeof liq === 'number' && Number.isFinite(liq) && liq >= MIN_LIQUIDITY_USD);
    };

    const visible = variants.filter(v => !shouldHide(v));
    const hidden = variants.length - visible.length;
    const hasExecutionQuality = visible.some(v => v.executionQuality);

    return (
        <section className="mt-10">
            <h2 className="text-title-md text-text-extra-high text-balance">Variants</h2>
            <p className="mt-2 text-body-md text-text-medium text-pretty">
                Token representations of {displayName} on Solana.
            </p>
            {isSolana && hidden > 0 ? (
                <p className="mt-3 text-[13px] text-text-low">
                    Showing variants with at least {formatLargeNumber(MIN_LIQUIDITY_USD)} liquidity ({hidden} hidden).
                </p>
            ) : null}
            {hasExecutionQuality ? (
                <p className="mt-3 text-[13px] text-text-low">
                    Execution quality is available for highlighted variants to compare execution and routing quality.
                </p>
            ) : null}
            <AssetVariantsList canonicalAssetId={canonicalAssetId} variants={visible} />
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
