'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { trackEvent } from '@/lib/posthog-client';
import { useInlineLatestClose } from '@/hooks/queries/use-inline-latest-close';
import { buildCoinHref } from '@/lib/coin-href';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    useReactTable,
    type SortingState,
    type Table,
} from '@tanstack/react-table';
import { ChevronUp, ChevronDown, ChevronsUpDown, Info } from 'lucide-react';
import type { Token, TrendingWindow } from '@/lib/types';
import { cleanTokenName, getTokenLogoURLWithSecondarySymbol } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { getWrapperGroupByAddress } from '@tokens/asset-registry/compat';
import { getVariantByMint } from '@tokens/asset-registry';
import { cn } from '@tokens/ui/cn';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@tokens/ui/tooltip';
import { IconTriangleFill } from 'symbols-react';

const InlinePriceChart = dynamic(() => import('@/components/inline-price-chart').then(m => m.InlinePriceChart), {
    ssr: false,
    loading: () => <div className="w-full h-8 rounded-sm bg-gray-50" />,
});

const INLINE_CHART_FALLBACK_DAYS = 7;
const TOKEN_TABLE_ROW_HEIGHT = 64;
const ROW_PREFETCH_HOVER_DELAY_MS = 75;
const MIN_TABLE_VOLUME_24H_USD = 25;

interface TokenTableVariantConfig {
    id: string;
    requiresMinimumVolume?: boolean;
    columns: {
        showRank: boolean;
        showPrice: boolean;
        showPriceChange1h: boolean;
        showPriceChange24h: boolean;
        showChart24h: boolean;
        showVolume1hUSD: boolean;
        showVolume24hUSD: boolean;
        showLiquidityUSD: boolean;
        showTrade1h: boolean;
    };
    defaultSorting: SortingState;
}

const CURRENCIES_TABLE_VARIANT: TokenTableVariantConfig = {
    id: 'currencies',
    columns: {
        showRank: false,
        showPrice: true,
        showPriceChange1h: false,
        showPriceChange24h: false,
        showChart24h: false,
        showVolume1hUSD: false,
        showVolume24hUSD: true,
        showLiquidityUSD: true,
        showTrade1h: false,
    },
    // Highest volume first
    defaultSorting: [{ id: 'volume24hUSD', desc: true }],
};

const RWA_TABLE_VARIANT: TokenTableVariantConfig = {
    id: 'rwas',
    columns: {
        showRank: false,
        showPrice: true,
        showPriceChange1h: false,
        showPriceChange24h: false,
        showChart24h: false,
        showVolume1hUSD: false,
        showVolume24hUSD: false,
        showLiquidityUSD: true,
        showTrade1h: false,
    },
    // Highest liquidity first
    defaultSorting: [{ id: 'liquidity', desc: true }],
};

const ETF_TABLE_VARIANT: TokenTableVariantConfig = {
    id: 'etfs',
    columns: {
        showRank: false,
        showPrice: true,
        showPriceChange1h: false,
        showPriceChange24h: true,
        showChart24h: true,
        showVolume1hUSD: false,
        showVolume24hUSD: true,
        showLiquidityUSD: true,
        showTrade1h: false,
    },
    // Highest volume first
    defaultSorting: [{ id: 'volume24hUSD', desc: true }],
};

const TOKEN_TABLE_VARIANTS: Record<string, TokenTableVariantConfig> = {
    trending: {
        id: 'trending:fresh',
        columns: {
            showRank: true,
            showPrice: true,
            showPriceChange1h: true,
            showPriceChange24h: false,
            showChart24h: false,
            showVolume1hUSD: true,
            showVolume24hUSD: true,
            showLiquidityUSD: false,
            showTrade1h: true,
        },
        defaultSorting: [],
    },
    'trending:fresh': {
        id: 'trending:fresh',
        columns: {
            showRank: true,
            showPrice: true,
            showPriceChange1h: true,
            showPriceChange24h: false,
            showChart24h: false,
            showVolume1hUSD: true,
            showVolume24hUSD: true,
            showLiquidityUSD: false,
            showTrade1h: true,
        },
        defaultSorting: [],
    },
    'trending:flow': {
        id: 'trending:flow',
        columns: {
            showRank: true,
            showPrice: true,
            showPriceChange1h: true,
            showPriceChange24h: false,
            showChart24h: false,
            showVolume1hUSD: true,
            showVolume24hUSD: true,
            showLiquidityUSD: false,
            showTrade1h: true,
        },
        defaultSorting: [],
    },
    default: {
        id: 'default',
        columns: {
            showRank: false,
            showPrice: true,
            showPriceChange1h: false,
            showPriceChange24h: true,
            showChart24h: true,
            showVolume1hUSD: false,
            showVolume24hUSD: true,
            showLiquidityUSD: true,
            showTrade1h: false,
        },
        // Highest volume first
        defaultSorting: [{ id: 'volume24hUSD', desc: true }],
    },
    majors: {
        id: 'majors',
        columns: {
            showRank: false,
            showPrice: true,
            showPriceChange1h: false,
            showPriceChange24h: true,
            showChart24h: true,
            showVolume1hUSD: false,
            showVolume24hUSD: true,
            showLiquidityUSD: true,
            showTrade1h: false,
        },
        // Highest volume first
        defaultSorting: [{ id: 'volume24hUSD', desc: true }],
    },
    currencies: CURRENCIES_TABLE_VARIANT,
    // Legacy alias: stables → currencies
    stables: CURRENCIES_TABLE_VARIANT,
    rwas: RWA_TABLE_VARIANT,
    // Product copy often refers to the RWA list as treasuries.
    treasuries: RWA_TABLE_VARIANT,
    etfs: ETF_TABLE_VARIANT,
    stocks: {
        id: 'stocks',
        requiresMinimumVolume: true,
        columns: {
            showRank: false,
            showPrice: true,
            showPriceChange1h: false, // Stocks don't need 1h changes typically
            showPriceChange24h: true,
            showChart24h: true,
            showVolume1hUSD: false,
            showVolume24hUSD: true,
            showLiquidityUSD: true,
            showTrade1h: false,
        },
        // Highest volume first
        defaultSorting: [{ id: 'volume24hUSD', desc: true }],
    },
    metals: {
        id: 'metals',
        columns: {
            showRank: false,
            showPrice: true,
            showPriceChange1h: false,
            showPriceChange24h: true,
            showChart24h: true,
            showVolume1hUSD: false,
            showVolume24hUSD: true,
            showLiquidityUSD: true,
            showTrade1h: false,
        },
        // Highest volume first
        defaultSorting: [{ id: 'volume24hUSD', desc: true }],
    },
};

function getTokenTableVariant(categoryId: string | undefined): TokenTableVariantConfig {
    return TOKEN_TABLE_VARIANTS[categoryId ?? ''] ?? TOKEN_TABLE_VARIANTS.default;
}

function getColumnWidth(columnId: string): string {
    if (columnId.startsWith('volume:')) return '132px';
    if (columnId.startsWith('trade:')) return '112px';

    switch (columnId) {
        case 'rank':
            return '42px';
        case 'name':
            return '34%';
        case 'price':
            return '120px';
        case 'priceChange1hPercent':
        case 'priceChange24hPercent':
            return '88px';
        case 'chart':
            return '144px';
        case 'volume1hUSD':
        case 'liquidity':
            return '132px';
        case 'volume24hUSD':
            return '156px';
        case 'trade1h':
            return '112px';
        default:
            return '120px';
    }
}

function isTokenNameColumn(columnId: string): boolean {
    return columnId === 'name';
}

function isTrendingWindowGroupEndColumn(columnId: string): boolean {
    return columnId === 'volume24hUSD';
}

const columnHelper = createColumnHelper<Token>();
const TRENDING_WINDOW_LABELS: Record<TrendingWindow, string> = {
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '6h': '6h',
    '24h': '24h',
};

function formatPrice(price: number | null | undefined): string {
    if (price == null || isNaN(price)) return '$0.00';
    if (price === 0) return '$0.00';
    if (price < 0.00001) return `$${price.toExponential(2)}`;
    if (price < 0.01) return `$${price.toFixed(6)}`;
    if (price < 1) return `$${price.toFixed(4)}`;
    return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function TokenTablePriceCell({ token }: { token: Token }) {
    const shouldUseCanonicalAssetChart = token.canonicalMarketSource === 'clickhouse_stock';
    const latestClose = useInlineLatestClose({
        assetId: token.assetId,
        address: token.address,
        useCanonicalAssetChart: shouldUseCanonicalAssetChart,
        fallbackDays: INLINE_CHART_FALLBACK_DAYS,
    });
    const displayPrice = token.coingeckoId || shouldUseCanonicalAssetChart ? token.price : (latestClose ?? token.price);

    return (
        <span className="block w-full text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums">
            {formatPrice(displayPrice)}
        </span>
    );
}

function formatVolume(volume: number | null | undefined): string {
    if (volume == null || isNaN(volume)) return '$0.00';
    if (volume >= 1_000_000_000) return `$${(volume / 1_000_000_000).toFixed(2)}B`;
    if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(2)}M`;
    if (volume >= 1_000) return `$${(volume / 1_000).toFixed(2)}K`;
    return `$${volume.toFixed(2)}`;
}

function formatOptionalVolume(volume: number | null | undefined): string {
    if (volume == null || isNaN(volume)) return '—';
    return formatVolume(volume);
}

function shouldShowUnderlyingVolume(token: Token): boolean {
    if (token.canonicalMarketSource === 'clickhouse_stock') return false;

    const underlying = token.underlyingVolume24hUSD;
    if (typeof underlying !== 'number' || !Number.isFinite(underlying) || underlying <= 0) return false;
    const primary = token.volume24hUSD;
    if (typeof primary !== 'number' || !Number.isFinite(primary) || primary <= 0) return true;
    return Math.abs(underlying - primary) > Math.max(1, primary * 0.001);
}

function Volume24hCell({ token, showUnderlyingVolume = true }: { token: Token; showUnderlyingVolume?: boolean }) {
    const showUnderlying = showUnderlyingVolume && shouldShowUnderlyingVolume(token);
    const underlyingLabel =
        token.underlyingVolume24hLabel?.trim() ||
        (token.canonicalMarketSource === 'clickhouse_stock' ? 'Stock' : 'Canonical');
    const underlyingValue = formatVolume(token.underlyingVolume24hUSD);

    return (
        <div className="flex w-full items-center justify-end gap-2">
            <span className="text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums">
                {formatVolume(token.volume24hUSD)}
            </span>
            {showUnderlying ? (
                <span
                    aria-label={`${underlyingLabel} provider 24 hour volume ${underlyingValue}`}
                    className="inline-flex max-w-full items-center rounded-full bg-[#F2F3F5] px-2 py-0.5 text-[11px] font-semibold leading-none text-text-medium opacity-55 tabular-nums transition-[background-color,opacity] hover:bg-[#E8EAED] hover:opacity-100"
                >
                    {underlyingValue}
                </span>
            ) : null}
        </div>
    );
}

function Volume24hHeaderTooltipContent() {
    return (
        <div className="max-w-64">
            <p>The main number is aggregate on-chain volume across available Solana variant markets.</p>
            <p className="mt-1 text-white/80">
                The smaller pill appears for crypto when CoinGecko volume differs from aggregate on-chain volume.
            </p>
        </div>
    );
}

function formatInteger(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return Math.round(value).toLocaleString();
}

function isTrendingVariant(variant: TokenTableVariantConfig): boolean {
    return variant.id === 'trending' || variant.id.startsWith('trending:');
}

function getVolumeForWindow(token: Token, window: TrendingWindow): number | undefined {
    switch (window) {
        case '5m':
            return token.volume5mUSD;
        case '15m':
            return token.volume15mUSD;
        case '1h':
            return token.volume1hUSD;
        case '6h':
            return token.volume6hUSD;
        case '24h':
            return token.volume24hUSD;
    }
}

function hasTableVolume(token: Token): boolean {
    return (
        typeof token.volume24hUSD === 'number' &&
        Number.isFinite(token.volume24hUSD) &&
        token.volume24hUSD >= MIN_TABLE_VOLUME_24H_USD
    );
}

function shouldShowTokenInTable(token: Token, variant: TokenTableVariantConfig): boolean {
    return !variant.requiresMinimumVolume || hasTableVolume(token);
}

function getTradeForWindow(token: Token, window: TrendingWindow): number | undefined {
    switch (window) {
        case '5m':
            return token.trade5m;
        case '15m':
            return token.trade15m;
        case '1h':
            return token.trade1h;
        case '6h':
            return token.trade6h;
        case '24h':
            return token.trade24h;
    }
}

function PercentChangeCell({ value }: { value: number }) {
    const isPositive = value >= 0;
    return (
        <span
            className={cn(
                'inline-flex w-full items-center justify-end gap-1 text-[14px] font-medium tabular-nums',
                isPositive ? 'text-green-800' : 'text-red-800',
            )}
        >
            <IconTriangleFill className={cn('size-2 shrink-0 fill-current', !isPositive && 'rotate-180')} aria-hidden />
            {`${Math.abs(value).toFixed(2)}%`}
        </span>
    );
}

function resolveCoinGeckoIdForToken(token: Token): string | null {
    const wrapperGroup = getWrapperGroupByAddress(token.address);
    if (wrapperGroup?.coingeckoId) return wrapperGroup.coingeckoId;

    const match = getVariantByMint(token.address);
    if (match) return match.asset.coingeckoId ?? match.asset.assetId;

    return null;
}

function TokenLogo({ token }: { token: Token }) {
    const [hasError, setHasError] = React.useState(false);

    const symbol = token.symbol || token.name || '??';
    const initials = symbol.slice(0, 2).toUpperCase();
    const resolvedLogoURI = normalizeLogoSrc(
        token.trendingRank != null && token.logoURI
            ? token.logoURI
            : getTokenLogoURLWithSecondarySymbol(token.symbol, token.name, token.logoURI),
    );

    if (!resolvedLogoURI || hasError) {
        return (
            <div className="size-[26px] rounded-full bg-gray-1400 flex items-center justify-center flex-shrink-0">
                <span className="text-[10px] font-bold text-white">{initials}</span>
            </div>
        );
    }

    return (
        <Image
            src={resolvedLogoURI}
            alt={symbol}
            width={26}
            height={26}
            className="size-[26px] rounded-full bg-gray-50 object-cover flex-shrink-0"
            loading="lazy"
            decoding="async"
            onError={() => setHasError(true)}
            referrerPolicy="no-referrer"
        />
    );
}

function createColumns(variant: TokenTableVariantConfig, trendingWindow: TrendingWindow) {
    const isTrending = isTrendingVariant(variant);
    const windowLabel = TRENDING_WINDOW_LABELS[trendingWindow];
    const showTrailing24hVolume = variant.columns.showVolume24hUSD && !(isTrending && trendingWindow === '24h');

    const cols = [
        variant.columns.showRank
            ? columnHelper.display({
                  id: 'rank',
                  header: '#',
                  cell: info => (
                      <span className="block w-full text-right text-[13px] text-text-low font-medium tabular-nums">
                          {info.row.original.trendingRank ?? info.row.index + 1}
                      </span>
                  ),
              })
            : null,
        columnHelper.accessor('name', {
            header: 'Token Name',
            cell: info => {
                const token = info.row.original;
                const displayName = isTrending ? token.name?.trim() || 'Unknown' : cleanTokenName(token.name);
                return (
                    <div className="flex items-center gap-[8px]">
                        <TokenLogo token={token} />
                        <div className="flex min-w-0 items-center gap-2">
                            <span
                                className={cn(
                                    'truncate text-[16px] font-medium text-text-extra-high',
                                    isTrending && 'min-w-0',
                                )}
                                title={displayName}
                            >
                                {displayName}
                            </span>
                            <span className="shrink-0 text-[14px] text-text-extra-low font-medium">
                                ${token.symbol || '???'}
                            </span>
                        </div>
                    </div>
                );
            },
        }),
        variant.columns.showPrice
            ? columnHelper.accessor('price', {
                  header: 'Price',
                  cell: info => <TokenTablePriceCell token={info.row.original} />,
              })
            : null,
        variant.columns.showPriceChange1h
            ? columnHelper.accessor('priceChange1hPercent', {
                  header: '1H',
                  cell: info => {
                      const value = info.getValue();
                      if (value == null)
                          return <span className="block w-full text-right text-[14px] text-text-extra-low">—</span>;

                      return <PercentChangeCell value={value} />;
                  },
              })
            : null,
        variant.columns.showPriceChange24h
            ? columnHelper.accessor('priceChange24hPercent', {
                  header: '1D',
                  cell: info => {
                      const value = info.getValue();
                      if (value == null)
                          return <span className="block w-full text-right text-[14px] text-text-extra-low">—</span>;

                      return <PercentChangeCell value={value} />;
                  },
              })
            : null,
        variant.columns.showChart24h
            ? columnHelper.display({
                  id: 'chart',
                  header: 'Last 24h',
                  cell: info => {
                      const token = info.row.original;
                      return (
                          <div className="flex w-full justify-end">
                              <InlinePriceChart
                                  assetId={token.assetId}
                                  coingeckoId={token.coingeckoId}
                                  useCanonicalAssetChart={token.canonicalMarketSource === 'clickhouse_stock'}
                                  address={token.address}
                                  percentChange24h={token.priceChange24hPercent}
                                  symbol={token.symbol}
                                  emptyText="no chart data available"
                                  fallbackDays={INLINE_CHART_FALLBACK_DAYS}
                              />
                          </div>
                      );
                  },
              })
            : null,
        variant.columns.showVolume1hUSD && !isTrending
            ? columnHelper.accessor('volume1hUSD', {
                  header: '1h Volume',
                  cell: info => (
                      <span className="block w-full text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums">
                          {formatVolume(info.getValue())}
                      </span>
                  ),
              })
            : null,
        showTrailing24hVolume
            ? columnHelper.accessor('volume24hUSD', {
                  header: '24h Volume',
                  cell: info => <Volume24hCell token={info.row.original} showUnderlyingVolume={!isTrending} />,
              })
            : null,
        variant.columns.showVolume1hUSD && isTrending
            ? columnHelper.display({
                  id: `volume:${trendingWindow}`,
                  header: `${windowLabel} Volume`,
                  cell: info => (
                      <span className="block w-full text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums">
                          {formatOptionalVolume(getVolumeForWindow(info.row.original, trendingWindow))}
                      </span>
                  ),
              })
            : null,
        variant.columns.showTrade1h
            ? isTrending
                ? columnHelper.display({
                      id: `trade:${trendingWindow}`,
                      header: `${windowLabel} Trades`,
                      cell: info => (
                          <span className="block w-full text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums">
                              {formatInteger(getTradeForWindow(info.row.original, trendingWindow))}
                          </span>
                      ),
                  })
                : columnHelper.accessor('trade1h', {
                      header: 'Trades',
                      cell: info => (
                          <span className="block w-full text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums">
                              {formatInteger(info.getValue())}
                          </span>
                      ),
                  })
            : null,
        variant.columns.showLiquidityUSD
            ? columnHelper.accessor('liquidity', {
                  header: 'Liquidity',
                  // A token nobody has quoted depth for reads `—`; rendering it
                  // as $0.00 claims the pool is empty, which is a different fact.
                  sortUndefined: 'last',
                  sortingFn: (a, b) => (a.original.liquidity ?? -1) - (b.original.liquidity ?? -1),
                  cell: info => (
                      <span className="block w-full text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums">
                          {formatOptionalVolume(info.getValue())}
                      </span>
                  ),
              })
            : null,
    ];

    return cols.filter((col): col is Exclude<(typeof cols)[number], null> => col !== null);
}

function useTokenRowNavigation(variant: TokenTableVariantConfig, categoryId: string | undefined) {
    const router = useRouter();
    const prefetchedHrefs = React.useRef<Set<string>>(new Set());
    const prefetchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Clear any pending hover-intent prefetch timer on unmount.
    React.useEffect(
        () => () => {
            if (prefetchTimerRef.current !== null) clearTimeout(prefetchTimerRef.current);
        },
        [],
    );

    function getRowHref(token: Token): string {
        const assetId = token.assetId?.trim() || null;
        const coingeckoId = assetId ? null : resolveCoinGeckoIdForToken(token);
        const routeName = assetId ?? coingeckoId;

        if (isTrendingVariant(variant) && routeName) return buildCoinHref(routeName, token.address);
        if (routeName) return `/${encodeURIComponent(routeName)}`;
        // Fallback: navigate by mint (will resolve to an asset if it's in the registry).
        return `/${encodeURIComponent(token.address)}`;
    }

    function handleRowClick(token: Token) {
        const assetId = token.assetId?.trim() || null;
        const coingeckoId = assetId ? null : resolveCoinGeckoIdForToken(token);

        trackEvent('token_clicked', {
            ...(assetId ? { asset_id: assetId } : {}),
            token_address: token.address,
            token_symbol: token.symbol,
            token_name: token.name,
            token_price: token.price,
            token_price_change_24h: token.priceChange24hPercent,
            category_id: categoryId,
            ...(coingeckoId ? { coingecko_id: coingeckoId } : {}),
        });

        router.push(getRowHref(token));
    }

    // Hover-intent prefetch: warm the RSC payload for a row's target route shortly
    // before the user clicks. Each href is prefetched at most once per mount.
    function prefetchRow(token: Token) {
        const href = getRowHref(token);
        if (prefetchedHrefs.current.has(href)) return;
        prefetchedHrefs.current.add(href);
        router.prefetch(href);
    }

    function handleRowPointerEnter(token: Token) {
        if (prefetchTimerRef.current !== null) clearTimeout(prefetchTimerRef.current);
        prefetchTimerRef.current = setTimeout(() => {
            prefetchTimerRef.current = null;
            prefetchRow(token);
        }, ROW_PREFETCH_HOVER_DELAY_MS);
    }

    function handleRowPointerLeave() {
        if (prefetchTimerRef.current !== null) {
            clearTimeout(prefetchTimerRef.current);
            prefetchTimerRef.current = null;
        }
    }

    return { handleRowClick, handleRowPointerEnter, handleRowPointerLeave, prefetchRow };
}

function TokenTableHeader({ table }: { table: Table<Token> }) {
    return (
        <thead>
            {table.getHeaderGroups().map(headerGroup => (
                <tr key={headerGroup.id} className="border-b border-border-extra-light bg-gray-50/80">
                    {headerGroup.headers.map((header, index) => {
                        const canSort = header.column.getCanSort();
                        const sortDirection = header.column.getIsSorted();
                        const isRank = header.column.id === 'rank';
                        const isName = isTokenNameColumn(header.column.id);
                        const isTrendingGroupEnd = isTrendingWindowGroupEndColumn(header.column.id);
                        const isVolume24h = header.column.id === 'volume24hUSD';
                        const isLast = index === headerGroup.headers.length - 1;

                        return (
                            <th
                                key={header.id}
                                className={cn(
                                    'py-3 text-[12px] md:text-[14px] font-medium text-text-high bg-gray-50/80 border-b border-border-light',
                                    isRank && 'pl-3 pr-1 md:pl-5 md:pr-1 text-right',
                                    isName && 'pl-3 pr-2 text-left md:pl-4 md:pr-4',
                                    !isRank &&
                                        !isName &&
                                        isLast &&
                                        'pl-3 md:pl-6 pr-4 md:pr-8 text-right',
                                    !isRank && !isName && !isLast && 'px-3 md:px-6 text-right',
                                    isTrendingGroupEnd && 'border-r border-border-light',
                                )}
                            >
                                {header.isPlaceholder ? null : isVolume24h ? (
                                    <div className="inline-flex w-full min-w-0 items-center justify-end gap-1.5">
                                        <button
                                            type="button"
                                            className={cn(
                                                'inline-flex min-w-0 items-center justify-end gap-1 text-nowrap',
                                                canSort &&
                                                    'cursor-pointer hover:text-text-extra-high select-none',
                                            )}
                                            onClick={header.column.getToggleSortingHandler()}
                                            disabled={!canSort}
                                        >
                                            <span>
                                                {flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext(),
                                                )}
                                            </span>
                                            {canSort && (
                                                <span className="text-text-extra-low">
                                                    {sortDirection === 'asc' ? (
                                                        <ChevronUp className="h-4 w-4" />
                                                    ) : sortDirection === 'desc' ? (
                                                        <ChevronDown className="h-4 w-4" />
                                                    ) : (
                                                        <ChevronsUpDown className="h-3.5 w-3.5" />
                                                    )}
                                                </span>
                                            )}
                                        </button>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <button
                                                    type="button"
                                                    aria-label="About 24h Volume"
                                                    onClick={event => event.stopPropagation()}
                                                    className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-text-extra-low transition-colors hover:text-text-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium cursor-help"
                                                >
                                                    <Info className="size-3.5" aria-hidden />
                                                </button>
                                            </TooltipTrigger>
                                            <TooltipContent
                                                side="top"
                                                align="center"
                                                className="max-w-64 rounded-xl bg-[#111111] px-3 py-2 text-xs leading-4 text-white shadow-[0_10px_30px_rgba(20,20,21,0.18)]"
                                            >
                                                <Volume24hHeaderTooltipContent />
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className={cn(
                                            'inline-flex text-nowrap items-center gap-1',
                                            canSort &&
                                                'cursor-pointer hover:text-text-extra-high select-none',
                                            !isName && 'w-full min-w-0 justify-end',
                                            isName && 'justify-start',
                                        )}
                                        onClick={header.column.getToggleSortingHandler()}
                                        disabled={!canSort}
                                    >
                                        {flexRender(
                                            header.column.columnDef.header,
                                            header.getContext(),
                                        )}
                                        {canSort && (
                                            <span className="text-text-extra-low">
                                                {sortDirection === 'asc' ? (
                                                    <ChevronUp className="h-4 w-4" />
                                                ) : sortDirection === 'desc' ? (
                                                    <ChevronDown className="h-4 w-4" />
                                                ) : (
                                                    <ChevronsUpDown className="h-3.5 w-3.5" />
                                                )}
                                            </span>
                                        )}
                                    </button>
                                )}
                            </th>
                        );
                    })}
                </tr>
            ))}
        </thead>
    );
}

interface TokenTableProps {
    tokens: Token[];
    categoryId?: string;
    trendingWindow?: TrendingWindow;
}

export function TokenTable({ tokens, categoryId, trendingWindow = '1h' }: TokenTableProps) {
    const variant = getTokenTableVariant(categoryId);
    const columns = React.useMemo(() => createColumns(variant, trendingWindow), [variant, trendingWindow]);
    const visibleTokens = React.useMemo(
        () => tokens.filter(token => shouldShowTokenInTable(token, variant)),
        [tokens, variant],
    );
    const [sorting, setSorting] = React.useState<SortingState>(() => variant.defaultSorting);
    const tableTopRef = React.useRef<HTMLDivElement>(null);
    const [scrollMargin, setScrollMargin] = React.useState(0);
    const { handleRowClick, handleRowPointerEnter, handleRowPointerLeave, prefetchRow } = useTokenRowNavigation(
        variant,
        categoryId,
    );

    // Reset sorting when the variant changes — during render, not in an effect, so the
    // table never sees a sort for a column the new variant doesn't have.
    const [prevVariantId, setPrevVariantId] = React.useState(variant.id);
    if (prevVariantId !== variant.id) {
        setPrevVariantId(variant.id);
        setSorting(variant.defaultSorting);
    }

    // Belt and braces: only apply sort rules whose column exists in the current column
    // set (e.g. a stale `volume:5m` sort after the trending window changes, or a volume
    // sort on a variant without a volume column). Unknown rules fall back to natural order.
    const columnIds = React.useMemo(
        () =>
            new Set(
                columns.map(column => {
                    const def = column as { id?: string; accessorKey?: string };
                    return def.id ?? def.accessorKey ?? '';
                }),
            ),
        [columns],
    );
    const activeSorting = React.useMemo(
        () => sorting.filter(rule => columnIds.has(rule.id)),
        [sorting, columnIds],
    );

    const table = useReactTable({
        data: visibleTokens,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        state: { sorting: activeSorting },
        onSortingChange: setSorting,
    });

    const rows = table.getRowModel().rows;
    const colCount = table.getVisibleLeafColumns().length;

    React.useLayoutEffect(() => {
        const el = tableTopRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setScrollMargin(rect.top + window.scrollY);
    }, [categoryId]);

    const rowVirtualizer = useWindowVirtualizer({
        count: rows.length,
        estimateSize: () => TOKEN_TABLE_ROW_HEIGHT,
        overscan: 10,
        scrollMargin,
        useFlushSync: false,
    });

    const virtualRows = rowVirtualizer.getVirtualItems();
    const paddingTop = virtualRows.length > 0 ? Math.max(0, virtualRows[0]!.start - scrollMargin) : 0;
    const paddingBottom =
        virtualRows.length > 0
            ? Math.max(0, rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end)
            : 0;

    if (visibleTokens.length === 0) {
        return (
            <section className="mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24">
                <div className="bg-white rounded-[24px] md:rounded-[50px] border border-border-light shadow-[0_8px_40px_rgba(0,0,0,0.03)] p-6 md:p-12 text-center">
                    <p className="text-text-low text-[14px] md:text-[16px]">No tokens available</p>
                    <p className="text-text-extra-low text-[12px] md:text-[14px] mt-2">
                        Check back later or search for a specific token
                    </p>
                </div>
            </section>
        );
    }

    return (
        <TooltipProvider delayDuration={200}>
            <section className="mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24">
                <div className="bg-white rounded-[24px] border border-border-medium shadow-[0_8px_40px_rgba(0,0,0,0.03)] overflow-hidden">
                    <div className="overflow-x-auto">
                        <div ref={tableTopRef} />
                        <table className="w-full min-w-[980px] table-fixed text-left border-collapse">
                        <colgroup>
                            {table.getVisibleLeafColumns().map(column => (
                                <col key={column.id} style={{ width: getColumnWidth(column.id) }} />
                            ))}
                        </colgroup>
                        <TokenTableHeader table={table} />
                        <tbody className="divide-y divide-border-extra-light">
                            {paddingTop > 0 ? (
                                <tr>
                                    <td colSpan={colCount} style={{ height: paddingTop, padding: 0, border: 0 }} />
                                </tr>
                            ) : null}

                            {virtualRows.map(virtualRow => {
                                const row = rows[virtualRow.index];
                                if (!row) return null;

                                return (
                                    <tr
                                        key={row.id}
                                        style={{ height: TOKEN_TABLE_ROW_HEIGHT }}
                                        className="hover:bg-gray-50/50 transition-colors group cursor-pointer"
                                        tabIndex={0}
                                        onClick={() => handleRowClick(row.original)}
                                        onKeyDown={event => {
                                            if (event.key !== 'Enter' && event.key !== ' ') return;
                                            event.preventDefault();
                                            handleRowClick(row.original);
                                        }}
                                        onPointerEnter={() => handleRowPointerEnter(row.original)}
                                        onPointerLeave={handleRowPointerLeave}
                                        onPointerDown={() => prefetchRow(row.original)}
                                        onFocus={() => prefetchRow(row.original)}
                                    >
                                        {row.getVisibleCells().map((cell, index) => {
                                            const isRank = cell.column.id === 'rank';
                                            const isName = isTokenNameColumn(cell.column.id);
                                            const isTrendingGroupEnd = isTrendingWindowGroupEndColumn(cell.column.id);
                                            const isLast = index === row.getVisibleCells().length - 1;

                                            return (
                                                <td
                                                    key={cell.id}
                                                    className={cn(
                                                        'h-16 py-0 align-middle',
                                                        isRank && 'pl-3 pr-1 md:pl-5 md:pr-1 text-right',
                                                        isName && 'pl-3 pr-2 text-left md:pl-4 md:pr-4',
                                                        !isRank &&
                                                            !isName &&
                                                            isLast &&
                                                            'pl-3 md:pl-6 pr-4 md:pr-8 text-right',
                                                        !isRank && !isName && !isLast && 'px-3 md:px-6 text-right',
                                                        isTrendingGroupEnd && 'border-r border-border-light',
                                                    )}
                                                >
                                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                );
                            })}

                            {paddingBottom > 0 ? (
                                <tr>
                                    <td colSpan={colCount} style={{ height: paddingBottom, padding: 0, border: 0 }} />
                                </tr>
                            ) : null}
                        </tbody>
                        </table>
                    </div>
                </div>
            </section>
        </TooltipProvider>
    );
}
