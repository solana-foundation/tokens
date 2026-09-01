'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { Effect } from 'effect';
import { ArrowUpRight, ChartNoAxesColumn, ChevronDown, Store, X } from 'lucide-react';
import { AnimatePresence, domMax, LazyMotion, m, useReducedMotion } from 'motion/react';
import { IconArrowLeftArrowRight, IconExclamationmarkTriangleFill } from 'symbols-react';

import { Alert } from '@tokens/ui/alert';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@tokens/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@tokens/ui/dropdown-menu';
import { useMediaQuery } from '@tokens/ui/hooks';
import { SegmentedControl } from '@solana/design-system/segmented-control';
import { apiJson } from '@/effect/api-client';
import type { TokenMarket } from '@/lib/birdeye';
import type { PerpsMarket, PerpsMarketProviderId, PerpsMarketsResponse } from '@/lib/perps-markets';
import { getVariantByMint } from '@tokens/asset-registry';
import { buildSwapLinks, SOL_MINT, USDC_MINT } from '@tokens/execution-links';
import { getTokenLogoURLForMintWithSecondarySymbol } from '@/lib/logo-overrides';
import { trackEvent } from '@/lib/posthog-client';
import { formatCompactAddress, formatUsd } from '../lib/format';

type PoolProviderId = 'orca' | 'raydium' | 'byreal';
type DesktopActionTab = 'swap' | 'perps' | 'pools';

type ProviderCategory = 'aggregator' | 'venue' | 'perps' | 'pool';
type ProviderClickSurface = 'mobile_menu' | 'desktop_panel';

interface PendingNavigation {
    href: string;
    name: string;
    category: ProviderCategory;
    surface: ProviderClickSurface;
    trackingProperties?: Record<string, unknown>;
}

type PerpsProviderId = PerpsMarketProviderId | 'jupiter';

const FLASH_TRADE_ICON_SRC = '/logos/popular/flashtrade.png';
const JUPITER_ICON_SRC = '/logos/popular/jupiter.png';
const PHOENIX_TRADE_ICON_SRC = '/logos/popular/pheonix.png';

const JUPITER_PERPS_MARKET_BY_ASSET_ID: Record<string, string> = {
    ethereum: 'ETH',
    solana: 'SOL',
    // Jupiter perps uses WBTC for the BTC market.
    bitcoin: 'WBTC',
};

const PERPS_MARKET_SYMBOL_ALIASES_BY_ASSET_ID: Record<string, Partial<Record<PerpsProviderId, string[]>>> = {
    bitcoin: { flashtrade: ['BTC'], jupiter: ['WBTC'], phoenixtrade: ['BTC'] },
    gold: { flashtrade: ['XAU'], phoenixtrade: ['GOLD'] },
    silver: { flashtrade: ['XAG'], phoenixtrade: ['SILVER'] },
    // Promoted from equity `united-states-oil-fund` to the `oil` commodity canonical.
    oil: { flashtrade: ['CRUDEOIL'], phoenixtrade: ['WTIOIL'] },
    'usd-ai': { flashtrade: ['CHIP'], phoenixtrade: ['CHIP'] },
    'spdr-s-p-500-etf': { flashtrade: ['SPY'] },
    sp500: { flashtrade: ['SPY'] },
    spacex: { flashtrade: ['SPCX'], phoenixtrade: ['SPCX'] },
};

function normalizeMarketSymbol(value: string | undefined | null): string {
    return (value ?? '').trim().toUpperCase();
}

function normalizePerpsLookupKey(value: string | undefined | null): string {
    return normalizeMarketSymbol(value).replace(/[^A-Z0-9]/g, '');
}

function getDynamicPerpsMarket(args: {
    markets: PerpsMarket[];
    providerId: PerpsMarketProviderId;
    variantMatch: ReturnType<typeof getVariantByMint> | null;
    buyName: string;
    buySymbol?: string;
    buyAddress: string;
}): PerpsMarket | null {
    const targetKeys = getPerpsLookupKeys({
        providerId: args.providerId,
        variantMatch: args.variantMatch,
        buyName: args.buyName,
        buySymbol: args.buySymbol,
        buyAddress: args.buyAddress,
    });

    for (const market of args.markets) {
        if (market.providerId !== args.providerId) continue;

        const marketKeys = [market.symbol, market.displaySymbol, ...market.lookupKeys].flatMap(value => {
            const key = normalizePerpsLookupKey(value);
            return key ? [key] : [];
        });
        if (marketKeys.some(key => targetKeys.has(key))) return market;
    }

    return null;
}

/**
 * Issuer/wrapper names that appear as variant labels/tags but are also real
 * perp market symbols (e.g. Phoenix lists an ONDO market for the Ondo token).
 * Without this, every Ondo-tokenized asset page would match the ONDO perp.
 */
const PERPS_LOOKUP_KEY_BLOCKLIST = new Set(['ONDO', 'XSTOCK', 'XSTOCKS', 'PRESTOCK', 'PRESTOCKS', 'BACKED']);

function getPerpsLookupKeys(args: {
    providerId: PerpsProviderId;
    variantMatch: ReturnType<typeof getVariantByMint> | null;
    buyName: string;
    buySymbol?: string;
    buyAddress: string;
}): Set<string> {
    const asset = args.variantMatch?.asset;

    // A curated alias entry is authoritative for its provider: match ONLY that
    // market symbol (e.g. oil+phoenixtrade → WTIOIL), never heuristic keys.
    const curatedAliases = PERPS_MARKET_SYMBOL_ALIASES_BY_ASSET_ID[asset?.assetId ?? '']?.[args.providerId];
    if (curatedAliases && curatedAliases.length > 0) {
        const curatedKeys = new Set<string>();
        for (const alias of curatedAliases) {
            const key = normalizePerpsLookupKey(alias);
            if (key) curatedKeys.add(key);
        }
        return curatedKeys;
    }

    const keys = new Set<string>();
    const add = (value: string | undefined | null) => {
        const key = normalizePerpsLookupKey(value);
        if (key && !PERPS_LOOKUP_KEY_BLOCKLIST.has(key)) keys.add(key);
    };

    add(args.buyAddress);
    add(args.buyName);
    add(args.buySymbol);

    const variant = args.variantMatch?.variant;
    add(asset?.assetId);
    add(asset?.symbol);
    add(asset?.name);
    add(asset?.coingeckoId);
    for (const alias of asset?.aliases ?? []) add(alias);

    add(variant?.mint);
    add(variant?.symbol);
    add(variant?.name);
    add(variant?.label);
    for (const tag of variant?.tags ?? []) add(tag);

    return keys;
}

function getJupiterPerpsMarketSymbol(args: {
    variantMatch: ReturnType<typeof getVariantByMint> | null;
    buyName: string;
}): string | null {
    const assetId = args.variantMatch?.asset.assetId ?? '';
    const mapped = JUPITER_PERPS_MARKET_BY_ASSET_ID[assetId];
    if (mapped) return mapped;

    const assetSymbol = normalizeMarketSymbol(args.variantMatch?.asset.symbol);
    if (assetSymbol === 'ETH' || assetSymbol === 'SOL' || assetSymbol === 'WBTC') return assetSymbol;

    const variantSymbol = normalizeMarketSymbol(args.variantMatch?.variant.symbol);
    if (variantSymbol === 'ETH' || variantSymbol === 'SOL' || variantSymbol === 'WBTC') return variantSymbol;

    const nameHint = normalizeMarketSymbol(args.buyName);
    if (nameHint === 'ETH' || nameHint === 'SOL' || nameHint === 'WBTC') return nameHint;

    if (assetSymbol === 'BTC' || variantSymbol === 'BTC' || nameHint === 'BTC') return 'WBTC';

    return null;
}

function getJupiterPerpsUrl(marketSymbol: string): string {
    return `https://jup.ag/perps/long/USDC-${marketSymbol}`;
}

function getPerpsDisplaySymbol(args: {
    variantMatch: ReturnType<typeof getVariantByMint> | null;
    buyName: string;
    buySymbol?: string;
    marketSymbol: string;
}): string {
    const buySymbol = normalizeMarketSymbol(args.buySymbol);
    if (buySymbol && buySymbol !== 'WBTC') return buySymbol;

    const assetSymbol = normalizeMarketSymbol(args.variantMatch?.asset.symbol);
    if (assetSymbol && assetSymbol !== 'WBTC') return assetSymbol;

    const variantSymbol = normalizeMarketSymbol(args.variantMatch?.variant.symbol);
    if (variantSymbol && variantSymbol !== 'WBTC') return variantSymbol;

    const nameHint = normalizeMarketSymbol(args.buyName);
    if (nameHint && nameHint !== 'WBTC') return nameHint;

    return args.marketSymbol === 'WBTC' ? 'BTC' : args.marketSymbol;
}

function getExplorerPoolUrl(poolAddress: string): string {
    return `https://explorer.solana.com/address/${poolAddress}`;
}

function getOrcaPoolUrl(poolAddress: string): string {
    return `https://www.orca.so/pools/${poolAddress}`;
}

function getRaydiumPoolUrl(poolAddress: string): string {
    return `https://raydium.io/pools/${poolAddress}`;
}

function getMeteoraPoolUrl(poolAddress: string): string {
    return `https://app.meteora.ag/dlmm/${poolAddress}`;
}

function getPoolDeepLink(market: TokenMarket): { href: string; name: string } | null {
    const source = (market.source ?? '').trim();
    const address = (market.address ?? '').trim();
    if (!address) return null;

    if (/orca/i.test(source)) return { href: getOrcaPoolUrl(address), name: 'Orca' };
    if (/raydium/i.test(source)) return { href: getRaydiumPoolUrl(address), name: 'Raydium' };
    if (/meteora/i.test(source)) return { href: getMeteoraPoolUrl(address), name: 'Meteora' };

    return null;
}

function getPoolIdFromSource(source: string | undefined): PoolProviderId | null {
    if (!source) return null;
    if (/orca/i.test(source)) return 'orca';
    if (/raydium/i.test(source)) return 'raydium';
    if (/byreal/i.test(source)) return 'byreal';
    return null;
}

interface SwapProvidersDropdownProps {
    buyAddress: string;
    buyName: string;
    buySymbol?: string;
    buyLogoURI?: string;
}

type SwapProvidersDropdownBaseProps = SwapProvidersDropdownProps & { isVariantView: boolean };

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

interface AssetMarketsInclude {
    markets: TokenMarket[];
    total: number | undefined;
    offset: number;
    limit: number;
}

interface AssetMarketsApiResponse {
    includes?: {
        markets?: AssetIncludeResult<AssetMarketsInclude>;
    };
}

interface SpotProviderLink {
    href: string;
    name: string;
    iconSrc: string;
}

interface PerpsProviderLink {
    id: PerpsProviderId;
    name: string;
    href: string;
    iconSrc: string;
    baseSymbol: string;
    quoteSymbol: string;
}

interface PoolByVolumeLink {
    id: PoolProviderId;
    name: string;
    href: string;
    volume24hUsd: number;
    iconSrc: string;
}

function SwapProvidersDropdownWithSearchParams(props: SwapProvidersDropdownProps) {
    const searchParams = useSearchParams();
    const isVariantView = Boolean((searchParams.get('solana') ?? '').trim());
    return <SwapProvidersDropdownBase {...props} isVariantView={isVariantView} />;
}

export function SwapProvidersDropdown(props: SwapProvidersDropdownProps) {
    return (
        <React.Suspense fallback={<SwapProvidersDropdownBase {...props} isVariantView={false} />}>
            <SwapProvidersDropdownWithSearchParams {...props} />
        </React.Suspense>
    );
}

function useSwapMarkets(args: {
    assetId: string | null;
    safeBuyAddress: string;
    isEnabled: boolean;
    isMenuOpen: boolean;
    isDesktop: boolean;
    isVariantView: boolean;
    orcaUrl: string;
    raydiumUrl: string;
    byrealUrl: string;
}) {
    const { assetId, safeBuyAddress, isEnabled, isMenuOpen, isDesktop, isVariantView, orcaUrl, raydiumUrl, byrealUrl } =
        args;

    const {
        data: marketsData = [],
        isFetched: isMarketsFetched,
        isLoading: isMarketsLoading,
    } = useQuery<TokenMarket[]>({
        queryKey: ['assets', 'markets', assetId, safeBuyAddress],
        queryFn: async ({ signal }) => {
            if (!assetId) return [];

            const params = new URLSearchParams({
                include: 'markets',
                mint: safeBuyAddress,
                marketsOffset: '0',
                marketsLimit: '50',
            });

            const data = await Effect.runPromise(
                apiJson<AssetMarketsApiResponse>({
                    url: `/api/v1/assets/${encodeURIComponent(assetId)}?${params.toString()}`,
                }),
                { signal },
            );

            const include = data.includes?.markets;
            if (!include || !include.ok) return [];
            return include.data.markets;
        },
        enabled: isEnabled && Boolean(assetId) && (isMenuOpen || isDesktop),
        // Only used to sort pool links; keep it low-priority.
        staleTime: 2 * 60 * 1000,
    });

    const { data: perpsMarketsData } = useQuery<PerpsMarketsResponse>({
        queryKey: ['perps', 'markets'],
        queryFn: async ({ signal }) =>
            Effect.runPromise(apiJson<PerpsMarketsResponse>({ url: '/api/perps/markets' }), { signal }),
        enabled: isEnabled && (isMenuOpen || isDesktop),
        staleTime: 5 * 60 * 1000,
    });
    const perpsMarkets = perpsMarketsData?.markets ?? [];

    const marketsForPoolsTab = React.useMemo(() => {
        const sorted = marketsData
            .slice()
            .sort(
                (a, b) =>
                    (b.volume24h ?? 0) - (a.volume24h ?? 0) ||
                    (b.liquidity ?? 0) - (a.liquidity ?? 0) ||
                    (b.trade24h ?? 0) - (a.trade24h ?? 0),
            );

        const limit = isVariantView ? 12 : 4;
        return sorted.slice(0, limit);
    }, [isVariantView, marketsData]);

    const poolsByVolume = React.useMemo(() => {
        const volumeByPool: Record<PoolProviderId, number> = { orca: 0, raydium: 0, byreal: 0 };

        for (const market of marketsData) {
            const poolId = getPoolIdFromSource(market.source);
            if (!poolId) continue;
            volumeByPool[poolId] += market.volume24h ?? 0;
        }

        const pools = [
            {
                id: 'orca' as const,
                name: 'Orca',
                href: orcaUrl,
                volume24hUsd: volumeByPool.orca,
                iconSrc: 'https://www.orca.so/favicon.ico',
            },
            {
                id: 'raydium' as const,
                name: 'Raydium',
                href: raydiumUrl,
                volume24hUsd: volumeByPool.raydium,
                iconSrc: 'https://raydium.io/favicon.ico',
            },
            {
                id: 'byreal' as const,
                name: 'Byreal',
                href: byrealUrl,
                volume24hUsd: volumeByPool.byreal,
                iconSrc: 'https://www.byreal.io/favicon.ico',
            },
        ];

        if (!isMarketsFetched) return pools;
        return pools.slice().sort((a, b) => b.volume24hUsd - a.volume24hUsd);
    }, [byrealUrl, isMarketsFetched, marketsData, orcaUrl, raydiumUrl]);

    return { marketsForPoolsTab, poolsByVolume, isMarketsFetched, isMarketsLoading, perpsMarkets };
}

function buildPerpsProviders(args: {
    perpsMarkets: PerpsMarket[];
    variantMatch: ReturnType<typeof getVariantByMint> | null;
    buyName: string;
    buySymbol?: string;
    safeBuyAddress: string;
}): PerpsProviderLink[] {
    const { perpsMarkets, variantMatch, buyName, buySymbol, safeBuyAddress } = args;
    const perpsProviders: PerpsProviderLink[] = [];

    const phoenixMarket = getDynamicPerpsMarket({
        markets: perpsMarkets,
        providerId: 'phoenixtrade',
        variantMatch,
        buyName,
        buySymbol,
        buyAddress: safeBuyAddress,
    });
    if (phoenixMarket) {
        perpsProviders.push({
            id: 'phoenixtrade',
            name: 'Phoenix Trade',
            href: phoenixMarket.href,
            iconSrc: PHOENIX_TRADE_ICON_SRC,
            baseSymbol: getPerpsDisplaySymbol({
                variantMatch,
                buyName,
                buySymbol,
                marketSymbol: phoenixMarket.displaySymbol,
            }),
            quoteSymbol: phoenixMarket.quoteSymbol,
        });
    }

    const flashMarket = getDynamicPerpsMarket({
        markets: perpsMarkets,
        providerId: 'flashtrade',
        variantMatch,
        buyName,
        buySymbol,
        buyAddress: safeBuyAddress,
    });
    if (flashMarket) {
        perpsProviders.push({
            id: 'flashtrade',
            name: 'Flash Trade',
            href: flashMarket.href,
            iconSrc: FLASH_TRADE_ICON_SRC,
            baseSymbol: getPerpsDisplaySymbol({
                variantMatch,
                buyName,
                buySymbol,
                marketSymbol: flashMarket.displaySymbol,
            }),
            quoteSymbol: flashMarket.quoteSymbol,
        });
    }

    const jupiterSymbol = getJupiterPerpsMarketSymbol({ variantMatch, buyName });
    if (jupiterSymbol) {
        perpsProviders.push({
            id: 'jupiter',
            name: 'Jupiter',
            href: getJupiterPerpsUrl(jupiterSymbol),
            iconSrc: JUPITER_ICON_SRC,
            baseSymbol: getPerpsDisplaySymbol({ variantMatch, buyName, buySymbol, marketSymbol: jupiterSymbol }),
            quoteSymbol: 'USDC',
        });
    }

    return perpsProviders;
}

function getNavigationTrackingProperties(navigation: PendingNavigation): Record<string, unknown> {
    return {
        provider_name: navigation.name,
        provider_url: navigation.href,
        provider_category: navigation.category,
        surface: navigation.surface,
        ...navigation.trackingProperties,
    };
}

function SwapProvidersDropdownBase({
    buyAddress,
    buyName,
    buySymbol,
    buyLogoURI,
    isVariantView,
}: SwapProvidersDropdownBaseProps) {
    const normalizedBuyAddress = buyAddress.trim();
    const isEnabled = normalizedBuyAddress.length > 0;
    const [isMenuOpen, setIsMenuOpen] = React.useState(false);
    const [pendingNavigation, setPendingNavigation] = React.useState<PendingNavigation | null>(null);
    const [isConfirmOpen, setIsConfirmOpen] = React.useState(false);
    const [desktopTab, setDesktopTab] = React.useState<DesktopActionTab>('swap');
    const isDesktop = useMediaQuery('(min-width: 1024px)');
    const shouldReduceMotion = useReducedMotion();

    const buyLabel = buyName.trim() || 'token';
    const safeBuyAddress = normalizedBuyAddress || SOL_MINT;
    const variantMatch = getVariantByMint(safeBuyAddress);
    const assetId = variantMatch?.asset.assetId ?? null;

    // Same source of truth as GET /v2/execution/links; the buySymbol fallback
    // chain (buySymbol ?? variant.symbol ?? asset.symbol) lives in the package.
    const swapLinks = buildSwapLinks({
        buyMint: safeBuyAddress,
        ...(buySymbol !== undefined ? { buySymbol } : {}),
    });
    const urlByVenueId = new Map(swapLinks.venues.map(venue => [venue.id, venue.url]));
    const orcaUrl = urlByVenueId.get('orca') ?? '';
    const raydiumUrl = urlByVenueId.get('raydium') ?? '';
    const byrealUrl = urlByVenueId.get('byreal') ?? '';

    const { marketsForPoolsTab, poolsByVolume, isMarketsFetched, isMarketsLoading, perpsMarkets } = useSwapMarkets({
        assetId,
        safeBuyAddress,
        isEnabled,
        isMenuOpen,
        isDesktop,
        isVariantView,
        orcaUrl,
        raydiumUrl,
        byrealUrl,
    });

    if (!isEnabled) return null;

    function trackSwapEvent(event: string, properties?: Record<string, unknown>) {
        trackEvent(event, {
            token_address: safeBuyAddress,
            token_symbol: buySymbol,
            token_name: buyName,
            asset_id: assetId,
            is_variant_view: isVariantView,
            ...properties,
        });
    }

    function openConfirm(args: PendingNavigation) {
        trackSwapEvent('swap_provider_selected', getNavigationTrackingProperties(args));
        setPendingNavigation(args);
        setIsConfirmOpen(true);
    }

    function handleContinue() {
        if (!pendingNavigation) return;
        trackSwapEvent('swap_provider_clicked', getNavigationTrackingProperties(pendingNavigation));
        window.open(pendingNavigation.href, '_blank', 'noopener,noreferrer');
        setIsConfirmOpen(false);
    }

    function handleConfirmCancel() {
        if (pendingNavigation) {
            trackSwapEvent('swap_provider_cancelled', getNavigationTrackingProperties(pendingNavigation));
        }
        setIsConfirmOpen(false);
    }

    function handleConfirmOpenChange(open: boolean) {
        if (!open) {
            // Covers Esc, overlay click, and the dialog's close button.
            handleConfirmCancel();
            return;
        }
        setIsConfirmOpen(open);
    }

    function handleMenuOpenChange(open: boolean) {
        setIsMenuOpen(open);
        if (open) trackSwapEvent('swap_menu_opened', { surface: 'mobile_menu' });
    }

    function handleDesktopTabChange(tab: DesktopActionTab) {
        trackSwapEvent('swap_tab_changed', {
            tab,
            previous_tab: resolvedDesktopTab,
            surface: 'desktop_panel',
        });
        setDesktopTab(tab);
    }

    // The UI deliberately shows a subset of the package's venue registry —
    // the same caller-side selection the endpoint's `venues` param offers.
    const spotAggregatorProviders: SpotProviderLink[] = swapLinks.venues
        .filter(venue => venue.venueType === 'aggregator')
        .map(venue => ({ href: venue.url, name: venue.name, iconSrc: venue.iconPath ?? '' }));

    const spotVenueIds = ['sunrise', 'omfg', 'kamino', 'orca'];
    const spotVenueProviders: SpotProviderLink[] = swapLinks.venues
        .filter(venue => spotVenueIds.includes(venue.id))
        .map(venue => ({ href: venue.url, name: venue.name, iconSrc: venue.iconPath ?? '' }));

    const perpsProviders = buildPerpsProviders({ perpsMarkets, variantMatch, buyName, buySymbol, safeBuyAddress });

    const hasPerps = perpsProviders.length > 0;
    const resolvedDesktopTab: DesktopActionTab = desktopTab === 'perps' && !hasPerps ? 'swap' : desktopTab;

    return (
        <LazyMotion features={domMax}>
            <MobileSwapMenu
                isMenuOpen={isMenuOpen}
                onMenuOpenChange={handleMenuOpenChange}
                shouldReduceMotion={shouldReduceMotion}
                buyLabel={buyLabel}
                buyLogoURI={buyLogoURI}
                safeBuyAddress={safeBuyAddress}
                spotAggregatorProviders={spotAggregatorProviders}
                spotVenueProviders={spotVenueProviders}
                perpsProviders={perpsProviders}
                poolsByVolume={poolsByVolume}
                onOpenConfirm={openConfirm}
            />

            <DesktopSwapPanel
                resolvedDesktopTab={resolvedDesktopTab}
                onTabChange={handleDesktopTabChange}
                buyLabel={buyLabel}
                buyLogoURI={buyLogoURI}
                safeBuyAddress={safeBuyAddress}
                assetId={assetId}
                isVariantView={isVariantView}
                spotAggregatorProviders={spotAggregatorProviders}
                spotVenueProviders={spotVenueProviders}
                perpsProviders={perpsProviders}
                marketsForPoolsTab={marketsForPoolsTab}
                isMarketsFetched={isMarketsFetched}
                isMarketsLoading={isMarketsLoading}
                onOpenConfirm={openConfirm}
            />

            <LeavingSiteDialog
                isOpen={isConfirmOpen}
                onOpenChange={handleConfirmOpenChange}
                pendingNavigation={pendingNavigation}
                onCancel={handleConfirmCancel}
                onContinue={handleContinue}
            />
        </LazyMotion>
    );
}

function MobileSwapMenu({
    isMenuOpen,
    onMenuOpenChange,
    shouldReduceMotion,
    buyLabel,
    buyLogoURI,
    safeBuyAddress,
    spotAggregatorProviders,
    spotVenueProviders,
    perpsProviders,
    poolsByVolume,
    onOpenConfirm,
}: {
    isMenuOpen: boolean;
    onMenuOpenChange: (open: boolean) => void;
    shouldReduceMotion: boolean | null;
    buyLabel: string;
    buyLogoURI?: string;
    safeBuyAddress: string;
    spotAggregatorProviders: SpotProviderLink[];
    spotVenueProviders: SpotProviderLink[];
    perpsProviders: PerpsProviderLink[];
    poolsByVolume: PoolByVolumeLink[];
    onOpenConfirm: (navigation: PendingNavigation) => void;
}) {
    const hasPerps = perpsProviders.length > 0;

    return (
        <div className="lg:hidden">
            <DropdownMenu open={isMenuOpen} onOpenChange={onMenuOpenChange}>
                <DropdownMenuTrigger asChild>
                    <m.button
                        type="button"
                        layout
                        className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--button-primary-bg)] px-4 py-3 text-[var(--button-primary-text)] transition-[background-color,transform] duration-150 hover:bg-[var(--button-primary-bg-hover)] active:scale-[0.98] cursor-pointer"
                        transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                    >
                        <span className="text-[length:var(--text-button-md)] font-inter-semibold leading-none">
                            Buy {buyLabel}
                        </span>
                        <ChevronDown
                            className={`h-4 w-4 transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] ${
                                isMenuOpen ? 'rotate-180' : ''
                            }`}
                            aria-hidden="true"
                        />
                    </m.button>
                </DropdownMenuTrigger>
                <AnimatePresence initial={false}>
                    {isMenuOpen ? (
                        <DropdownMenuContent
                            key="swap-providers-mobile-menu"
                            asChild
                            forceMount
                            align="center"
                            side="top"
                            sideOffset={12}
                            className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[var(--radix-dropdown-menu-trigger-width)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto rounded-[22px] shadow-[0_22px_60px_rgba(20,20,21,0.16)] data-[state=open]:animate-none data-[state=closed]:animate-none"
                        >
                            <MeasuredMobileMenuPanel shouldReduceMotion={shouldReduceMotion}>
                                <DropdownMenuLabel className="px-4 py-2.5 text-text-medium text-sm font-medium flex items-center gap-2">
                                    <IconArrowLeftArrowRight className="size-3 fill-text-medium" />
                                    Aggregators
                                </DropdownMenuLabel>

                                {spotAggregatorProviders.map((provider, index) => (
                                    <SwapMenuLink
                                        key={provider.name}
                                        href={provider.href}
                                        name={provider.name}
                                        iconSrc={provider.iconSrc}
                                        onSelect={() =>
                                            onOpenConfirm({
                                                href: provider.href,
                                                name: provider.name,
                                                category: 'aggregator',
                                                surface: 'mobile_menu',
                                                trackingProperties: { rank: index + 1 },
                                            })
                                        }
                                    />
                                ))}

                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="px-4 py-2.5 text-text-medium text-sm font-medium flex items-center gap-2">
                                    <Store className="size-3.5 text-text-medium" />
                                    Individual Venues
                                </DropdownMenuLabel>

                                {spotVenueProviders.map((provider, index) => (
                                    <SwapMenuLink
                                        key={provider.name}
                                        href={provider.href}
                                        name={provider.name}
                                        iconSrc={provider.iconSrc}
                                        onSelect={() =>
                                            onOpenConfirm({
                                                href: provider.href,
                                                name: provider.name,
                                                category: 'venue',
                                                surface: 'mobile_menu',
                                                trackingProperties: { rank: index + 1 },
                                            })
                                        }
                                    />
                                ))}

                                {hasPerps ? (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuLabel className="px-4 py-2.5 text-text-medium text-sm font-medium flex items-center gap-2">
                                            <ChartNoAxesColumn className="size-3.5 fill-text-medium" />
                                            Perps
                                        </DropdownMenuLabel>

                                        {perpsProviders.map((provider, index) => (
                                            <SwapMenuLink
                                                key={provider.id}
                                                href={provider.href}
                                                name={provider.name}
                                                iconSrc={provider.iconSrc}
                                                right={
                                                    <PerpsPairPill
                                                        baseMint={safeBuyAddress}
                                                        baseSymbol={provider.baseSymbol}
                                                        baseDisplayName={buyLabel}
                                                        baseLogoURI={buyLogoURI}
                                                        quoteSymbol={provider.quoteSymbol}
                                                    />
                                                }
                                                onSelect={() =>
                                                    onOpenConfirm({
                                                        href: provider.href,
                                                        name: provider.name,
                                                        category: 'perps',
                                                        surface: 'mobile_menu',
                                                        trackingProperties: {
                                                            rank: index + 1,
                                                            provider_id: provider.id,
                                                            base_symbol: provider.baseSymbol,
                                                            quote_symbol: provider.quoteSymbol,
                                                        },
                                                    })
                                                }
                                            />
                                        ))}
                                    </>
                                ) : null}

                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="px-4 py-2.5 text-text-medium text-sm font-medium flex items-center gap-2">
                                    <ChartNoAxesColumn className="size-3.5 fill-text-medium" />
                                    Individual Pools
                                </DropdownMenuLabel>

                                {poolsByVolume.map((pool, index) => (
                                    <SwapMenuLink
                                        key={pool.id}
                                        href={pool.href}
                                        name={pool.name}
                                        iconSrc={pool.iconSrc}
                                        onSelect={() =>
                                            onOpenConfirm({
                                                href: pool.href,
                                                name: pool.name,
                                                category: 'pool',
                                                surface: 'mobile_menu',
                                                trackingProperties: {
                                                    rank: index + 1,
                                                    provider_id: pool.id,
                                                    pool_volume_24h_usd: pool.volume24hUsd,
                                                },
                                            })
                                        }
                                    />
                                ))}
                            </MeasuredMobileMenuPanel>
                        </DropdownMenuContent>
                    ) : null}
                </AnimatePresence>
            </DropdownMenu>
        </div>
    );
}

function DesktopSwapPanel({
    resolvedDesktopTab,
    onTabChange,
    buyLabel,
    buyLogoURI,
    safeBuyAddress,
    assetId,
    isVariantView,
    spotAggregatorProviders,
    spotVenueProviders,
    perpsProviders,
    marketsForPoolsTab,
    isMarketsFetched,
    isMarketsLoading,
    onOpenConfirm,
}: {
    resolvedDesktopTab: DesktopActionTab;
    onTabChange: (tab: DesktopActionTab) => void;
    buyLabel: string;
    buyLogoURI?: string;
    safeBuyAddress: string;
    assetId: string | null;
    isVariantView: boolean;
    spotAggregatorProviders: SpotProviderLink[];
    spotVenueProviders: SpotProviderLink[];
    perpsProviders: PerpsProviderLink[];
    marketsForPoolsTab: TokenMarket[];
    isMarketsFetched: boolean;
    isMarketsLoading: boolean;
    onOpenConfirm: (navigation: PendingNavigation) => void;
}) {
    const hasPerps = perpsProviders.length > 0;

    return (
        <div className="hidden lg:block">
            <div className="bg-white rounded-[26px] border border-border-light shadow-[0_8px_40px_rgba(0,0,0,0.03)] p-3">
                <SegmentedControl
                    className="flex w-full [&>button]:flex-1"
                    items={[
                        { value: 'swap', label: 'Spot' },
                        ...(hasPerps ? [{ value: 'perps', label: 'Futures' }] : []),
                        { value: 'pools', label: 'Liquidity' },
                    ]}
                    value={resolvedDesktopTab}
                    onValueChange={value => onTabChange(value as DesktopActionTab)}
                    aria-label="Trade type"
                />

                {resolvedDesktopTab === 'swap' && (
                    <div className="mt-5">
                        <div className="flex items-center justify-between mb-3 px-4">
                            <div className="text-sm font-medium text-text-medium">Aggregators</div>
                        </div>
                        <div className="space-y-2">
                            {spotAggregatorProviders.map((provider, index) => (
                                <ProviderRow
                                    key={provider.name}
                                    rank={index + 1}
                                    name={provider.name}
                                    iconSrc={provider.iconSrc}
                                    onClick={() =>
                                        onOpenConfirm({
                                            href: provider.href,
                                            name: provider.name,
                                            category: 'aggregator',
                                            surface: 'desktop_panel',
                                            trackingProperties: { rank: index + 1 },
                                        })
                                    }
                                />
                            ))}
                        </div>

                        <div className="flex items-center justify-between mb-3 mt-5 px-4">
                            <div className="text-sm font-medium text-text-medium">Individual Venues</div>
                        </div>
                        <div className="space-y-2">
                            {spotVenueProviders.map((provider, index) => (
                                <ProviderRow
                                    key={provider.name}
                                    rank={index + 1}
                                    name={provider.name}
                                    iconSrc={provider.iconSrc}
                                    onClick={() =>
                                        onOpenConfirm({
                                            href: provider.href,
                                            name: provider.name,
                                            category: 'venue',
                                            surface: 'desktop_panel',
                                            trackingProperties: { rank: index + 1 },
                                        })
                                    }
                                />
                            ))}
                        </div>
                    </div>
                )}

                {resolvedDesktopTab === 'perps' && hasPerps && (
                    <div className="mt-5">
                        <div className="flex items-center justify-between mb-3 px-4">
                            <div className="text-sm font-medium text-text-medium">Perps</div>
                        </div>
                        <div className="space-y-2">
                            {perpsProviders.map((provider, index) => (
                                <ProviderRow
                                    key={provider.id}
                                    rank={index + 1}
                                    name={provider.name}
                                    iconSrc={provider.iconSrc}
                                    right={
                                        <PerpsPairPill
                                            baseMint={safeBuyAddress}
                                            baseSymbol={provider.baseSymbol}
                                            baseDisplayName={buyLabel}
                                            baseLogoURI={buyLogoURI}
                                            quoteSymbol={provider.quoteSymbol}
                                        />
                                    }
                                    onClick={() =>
                                        onOpenConfirm({
                                            href: provider.href,
                                            name: provider.name,
                                            category: 'perps',
                                            surface: 'desktop_panel',
                                            trackingProperties: {
                                                rank: index + 1,
                                                provider_id: provider.id,
                                                base_symbol: provider.baseSymbol,
                                                quote_symbol: provider.quoteSymbol,
                                            },
                                        })
                                    }
                                />
                            ))}
                        </div>
                    </div>
                )}

                {resolvedDesktopTab === 'pools' && (
                    <div className="mt-5">
                        <div className="flex items-center justify-between mb-3 px-4">
                            <div className="text-sm font-medium text-text-medium">Pools</div>
                            <div className="flex items-center gap-2 text-sm font-medium text-text-extra-low">
                                <ChartNoAxesColumn className="size-3.5" aria-hidden="true" />
                                24h Volume
                            </div>
                        </div>

                        {!assetId ? (
                            <div className="rounded-3xl border border-border-light bg-gray-50/60 px-8 py-10 text-center">
                                <div className="text-[16px] text-text-medium font-medium">Pools unavailable</div>
                                <div className="text-[14px] text-text-extra-low mt-2">
                                    We couldn’t resolve pools for this token right now.
                                </div>
                            </div>
                        ) : isMarketsFetched && marketsForPoolsTab.length === 0 ? (
                            <div className="rounded-3xl border border-border-light bg-gray-50/60 px-8 py-10 text-center">
                                <div className="text-[16px] text-text-medium font-medium">No pools found</div>
                                <div className="text-[14px] text-text-extra-low mt-2">
                                    Birdeye didn’t return any pools for this token.
                                </div>
                            </div>
                        ) : (
                            <div
                                className={['space-y-2', isVariantView ? 'max-h-[420px] overflow-y-auto pr-1' : null]
                                    .filter(Boolean)
                                    .join(' ')}
                            >
                                {isMarketsLoading && marketsForPoolsTab.length === 0
                                    ? Array.from({ length: isVariantView ? 8 : 4 }, (_, idx) => (
                                          <div
                                              key={idx}
                                              className="w-full px-4 py-3 rounded-3xl border border-border-light bg-white"
                                          >
                                              <div className="flex items-center gap-3">
                                                  <div className="w-5 text-xs text-text-extra-low font-sans tabular-nums">
                                                      {idx + 1}
                                                  </div>
                                                  <div className="flex shrink-0 items-center">
                                                      <div className="size-6.5 rounded-full bg-gray-100 animate-pulse" />
                                                      <div className="-ml-2 size-6.5 rounded-full bg-gray-100 animate-pulse ring-2 ring-white" />
                                                  </div>
                                                  <div className="min-w-0 flex-1">
                                                      <div className="h-4 w-32 bg-gray-100 rounded animate-pulse" />
                                                      <div className="h-3 w-20 bg-gray-100 rounded animate-pulse mt-2" />
                                                  </div>
                                                  <div className="h-4 w-20 bg-gray-100 rounded animate-pulse" />
                                              </div>
                                          </div>
                                      ))
                                    : marketsForPoolsTab.map((market, idx) => (
                                          <MarketPoolRow
                                              key={market.address}
                                              rank={idx + 1}
                                              market={market}
                                              onClick={() => {
                                                  const deepLink = getPoolDeepLink(market);
                                                  onOpenConfirm({
                                                      href: deepLink?.href ?? getExplorerPoolUrl(market.address),
                                                      name: deepLink?.name ?? 'Solana Explorer',
                                                      category: 'pool',
                                                      surface: 'desktop_panel',
                                                      trackingProperties: {
                                                          rank: idx + 1,
                                                          market_address: market.address,
                                                          market_source: market.source,
                                                          market_volume_24h: market.volume24h,
                                                          market_liquidity: market.liquidity,
                                                          base_symbol: market.base?.symbol,
                                                          quote_symbol: market.quote?.symbol,
                                                      },
                                                  });
                                              }}
                                          />
                                      ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function LeavingSiteDialog({
    isOpen,
    onOpenChange,
    pendingNavigation,
    onCancel,
    onContinue,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    pendingNavigation: PendingNavigation | null;
    onCancel: () => void;
    onContinue: () => void;
}) {
    const destinationLabel = getDestinationLabel(pendingNavigation);

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl p-6 gap-10 rounded-[32px] w-full sm:w-[520px]" hideClose>
                <div className="flex items-start justify-between gap-6">
                    <DialogTitle className="text-[32px] leading-[1.1] text-text-extra-high font-medium tracking-tight">
                        You&apos;re leaving Tokens
                    </DialogTitle>
                    <DialogClose asChild>
                        <button
                            type="button"
                            className="inline-flex size-11 items-center justify-center rounded-full bg-gray-50 border border-border-light text-text-medium hover:bg-gray-100 transition-colors"
                            aria-label="Close"
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </DialogClose>
                </div>

                <Alert className="rounded-3xl border border-border-light bg-gray-50/60 px-8 py-7">
                    <div className="flex items-start gap-5">
                        <IconExclamationmarkTriangleFill className="h-6 w-6 fill-text-medium shrink-0 mt-0.5" />
                        <div className="text-[18px] text-text-medium leading-relaxed text-pretty">
                            Tokens does not endorse or guarantee any external platform. You are responsible for your own
                            due diligence.
                        </div>
                    </div>
                </Alert>

                <div className="grid grid-cols-2 gap-6">
                    <Button type="button" variant="outline" size="lg" className="rounded-xl" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="default"
                        size="lg"
                        className="rounded-xl"
                        onClick={onContinue}
                        disabled={!pendingNavigation}
                    >
                        Go to {destinationLabel}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

type MeasuredMobileMenuPanelProps = Omit<React.ComponentPropsWithoutRef<typeof m.div>, 'children'> & {
    children: React.ReactNode;
    shouldReduceMotion: boolean | null;
};

const MeasuredMobileMenuPanel = React.forwardRef<HTMLDivElement, MeasuredMobileMenuPanelProps>(
    function MeasuredMobileMenuPanel({ children, shouldReduceMotion, style, ...props }, forwardedRef) {
        const panelRef = React.useCallback(
            (node: HTMLDivElement | null) => {
                if (typeof forwardedRef === 'function') {
                    forwardedRef(node);
                    return;
                }

                if (forwardedRef) {
                    (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
                }
            },
            [forwardedRef],
        );
        const contentRef = React.useRef<HTMLDivElement>(null);
        const [contentHeight, setContentHeight] = React.useState(0);

        React.useLayoutEffect(() => {
            const element = contentRef.current;
            if (!element) return;

            const updateHeight = () => {
                setContentHeight(Math.ceil(element.scrollHeight));
            };

            updateHeight();

            const observer = new ResizeObserver(updateHeight);
            observer.observe(element);

            return () => observer.disconnect();
        }, []);

        return (
            <m.div
                ref={panelRef}
                {...props}
                initial={shouldReduceMotion ? false : { height: 0, opacity: 0, y: 8, scale: 0.98 }}
                animate={shouldReduceMotion ? { opacity: 1 } : { height: contentHeight, opacity: 1, y: 0, scale: 1 }}
                exit={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0, y: 8, scale: 0.98 }}
                transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
                style={{ ...style, transformOrigin: 'var(--radix-dropdown-menu-content-transform-origin)' }}
            >
                <div ref={contentRef}>{children}</div>
            </m.div>
        );
    },
);

function getDestinationLabel(pending: { href: string; name: string } | null): string {
    if (!pending) return 'site';
    try {
        const host = new URL(pending.href).hostname.replace(/^www\./, '');
        if (!host) return pending.name;
        return host.charAt(0).toUpperCase() + host.slice(1);
    } catch {
        return pending.name;
    }
}

function ProviderLogo({ name, src }: { name: string; src: string | undefined }) {
    const [hasError, setHasError] = React.useState(false);
    const initials = (name || '??').slice(0, 2).toUpperCase();

    if (!src || hasError) {
        return (
            <div className="flex size-6.5 items-center justify-center rounded-full border border-border-light bg-gray-50 text-[11px] font-sans text-text-medium">
                {initials}
            </div>
        );
    }

    return (
        <Image
            src={src}
            alt={`${name} logo`}
            width={26}
            height={26}
            className="size-6.5 rounded-full border border-border-light bg-gray-50 object-cover"
            loading="lazy"
            onError={() => setHasError(true)}
            unoptimized={/\.(svg|ico)(\?|#|$)/i.test(src)}
        />
    );
}

function MarketTokenAvatar({ token, className }: { token: TokenMarket['base'] | undefined; className?: string }) {
    const [hasError, setHasError] = React.useState(false);
    const label = token?.symbol ?? token?.name ?? formatCompactAddress(token?.address);
    const initials = (label || '??').slice(0, 2).toUpperCase();
    const iconUrl = (token?.icon ?? '').trim() || undefined;

    if (!iconUrl || hasError) {
        return (
            <div
                className={[
                    'flex size-6.5 items-center justify-center rounded-full border border-border-light bg-gray-50 text-[11px] font-sans text-text-medium',
                    className,
                ]
                    .filter(Boolean)
                    .join(' ')}
            >
                {initials}
            </div>
        );
    }

    return (
        <Image
            src={iconUrl}
            alt={label || 'Token'}
            width={26}
            height={26}
            className={['size-6.5 rounded-full border border-border-light bg-gray-50 object-cover', className]
                .filter(Boolean)
                .join(' ')}
            loading="lazy"
            onError={() => setHasError(true)}
        />
    );
}

function MarketPairAvatars({ base, quote }: { base?: TokenMarket['base']; quote?: TokenMarket['quote'] }) {
    const hasBase = Boolean(base?.address || base?.symbol || base?.name || base?.icon);
    const hasQuote = Boolean(quote?.address || quote?.symbol || quote?.name || quote?.icon);

    if (!hasBase && !hasQuote) return null;

    return (
        <div className="flex shrink-0 items-center">
            {hasBase && (
                <MarketTokenAvatar token={base} className={hasQuote ? 'relative z-20 ring-2 ring-white' : undefined} />
            )}
            {hasQuote && <MarketTokenAvatar token={quote} className={hasBase ? '-ml-2 relative z-10' : undefined} />}
        </div>
    );
}

function MarketPoolRow(args: { rank: number; market: TokenMarket; onClick: () => void }) {
    const market = args.market;
    const baseSymbol = market.base?.symbol?.trim() || formatCompactAddress(market.base?.address);
    const quoteSymbol = market.quote?.symbol?.trim() || formatCompactAddress(market.quote?.address);
    const pair = [baseSymbol, quoteSymbol].filter(Boolean).join('-') || (market.name ?? 'Pool');
    const source = (market.source ?? '').trim() || 'Unknown';

    return (
        <button
            type="button"
            className="w-full cursor-pointer px-2 py-3 pr-4 rounded-2xl active:scale-[0.99] hover:bg-gray-50 transition-colors"
            onClick={args.onClick}
        >
            <div className="flex w-full items-center gap-2">
                <div className="w-5 text-xs text-text-extra-low font-sans tabular-nums">{args.rank}</div>
                <MarketPairAvatars base={market.base} quote={market.quote} />
                <div className="min-w-0 text-left">
                    <div className="text-[14px] font-medium text-text-extra-high truncate">{pair}</div>
                    <div className="text-[13px] text-text-extra-low truncate">{source}</div>
                </div>
                <div className="ml-auto flex items-center gap-3">
                    <span className="text-[14px] text-text-extra-high font-sans text-right">
                        {formatUsd(market.volume24h)}
                    </span>
                    <ArrowUpRight className="h-4 w-4 text-text-extra-low" aria-hidden="true" />
                </div>
            </div>
        </button>
    );
}

function ProviderRow(args: {
    rank?: number;
    name: string;
    iconSrc?: string;
    right?: React.ReactNode;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            className="w-full cursor-pointer px-2 py-3 pr-4 rounded-3xl active:scale-[0.99] hover:bg-gray-50 transition-colors"
            onClick={args.onClick}
        >
            <div className="flex w-full items-center gap-2">
                {typeof args.rank === 'number' ? (
                    <div className="w-5 text-xs text-text-extra-low font-sans tabular-nums">{args.rank}</div>
                ) : null}
                <ProviderLogo name={args.name} src={args.iconSrc} />
                <span className="font-medium text-text-extra-high">{args.name}</span>
                <div className="ml-auto flex items-center gap-3">
                    {args.right}
                    <ArrowUpRight className="h-4 w-4 text-text-extra-low" aria-hidden="true" />
                </div>
            </div>
        </button>
    );
}

function getPerpsPairLogoSrc(args: { mint?: string; symbol: string; displayName?: string }): string | undefined {
    if (args.symbol === 'USDC') {
        return getTokenLogoURLForMintWithSecondarySymbol(USDC_MINT, 'USDC', 'USD Coin', '/logos/currencies/usd.png');
    }

    return getTokenLogoURLForMintWithSecondarySymbol(args.mint, args.symbol, args.displayName, undefined);
}

function PerpsPairPill(args: {
    baseMint?: string;
    baseSymbol: string;
    baseDisplayName?: string;
    baseLogoURI?: string;
    quoteSymbol: string;
}) {
    return (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-text-medium">
            <span className="flex items-center">
                <PairPillTokenAvatar
                    mint={args.baseMint}
                    symbol={args.baseSymbol}
                    displayName={args.baseDisplayName}
                    fallbackLogoURI={args.baseLogoURI}
                    className="relative z-20 ring-2 ring-gray-50"
                />
                <PairPillTokenAvatar symbol={args.quoteSymbol} className="-ml-1 relative z-10" />
            </span>
            <span className="font-sans tabular-nums leading-none">
                {args.baseSymbol}-{args.quoteSymbol}
            </span>
        </span>
    );
}

function PairPillTokenAvatar(args: {
    mint?: string;
    symbol: string;
    displayName?: string;
    fallbackLogoURI?: string;
    className?: string;
}) {
    const [hasError, setHasError] = React.useState(false);
    const iconUrl =
        getPerpsPairLogoSrc({
            mint: args.mint,
            symbol: args.symbol,
            displayName: args.displayName,
        }) ?? args.fallbackLogoURI;
    const initials = (args.symbol || '??').slice(0, 2).toUpperCase();

    if (!iconUrl || hasError) {
        return (
            <span
                className={[
                    'flex size-4 items-center justify-center rounded-full border border-border-light bg-white text-[8px] font-sans text-text-medium',
                    args.className,
                ]
                    .filter(Boolean)
                    .join(' ')}
            >
                {initials}
            </span>
        );
    }

    return (
        <Image
            src={iconUrl}
            alt={args.symbol}
            width={16}
            height={16}
            className={['size-4 rounded-full border border-border-light bg-white object-cover', args.className]
                .filter(Boolean)
                .join(' ')}
            loading="lazy"
            onError={() => setHasError(true)}
        />
    );
}

function SwapMenuLink(args: {
    href: string;
    name: string;
    iconSrc?: string;
    right?: React.ReactNode;
    onSelect: () => void;
}) {
    return (
        <DropdownMenuItem
            className="cursor-pointer px-3 py-2.5 rounded-2xl active:scale-[0.98] hover:bg-gray-50"
            onSelect={args.onSelect}
        >
            <div className="flex w-full items-center gap-3">
                <ProviderLogo name={args.name} src={args.iconSrc} />
                <span className="font-medium">{args.name}</span>
                {args.right ? <span className="ml-auto">{args.right}</span> : null}
                <ArrowUpRight className={`${args.right ? '' : 'ml-auto '}h-4 w-4 text-text-extra-low`} />
            </div>
        </DropdownMenuItem>
    );
}
