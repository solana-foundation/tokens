'use client';

import { explorerTokenUrl } from '@tokens/asset-registry/chains';
import * as React from 'react';
import Image from 'next/image';
import { type ColumnDef, createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { ArrowUpRight, ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { IconTriangleFill } from 'symbols-react';
import { trackEvent } from '@/lib/posthog-client';

import { cn } from '@tokens/ui/cn';
import type { TokenMarket, TokenMarketToken } from '@/lib/birdeye';
import { formatCompactAddress, formatCount, formatUsd } from '@/app/token/[address]/lib/format';
import { MarketsTableShell } from '@/app/_components/markets/markets-table-shell';
import { getPoolProtocolLogo } from '@/app/_components/markets/pool-protocol-logos';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';

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

const columnHelper = createColumnHelper<TokenMarket>();

function InlineChangeMetric({
    value,
    changePercent,
}: {
    value: number | undefined | null;
    changePercent: number | undefined | null;
}) {
    const hasChange = typeof changePercent === 'number' && Number.isFinite(changePercent);
    const isPositive = (changePercent ?? 0) >= 0;

    return (
        <div className="flex w-full items-center justify-end gap-1.5 text-nowrap">
            {hasChange ? (
                <span
                    className={cn(
                        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums',
                        isPositive ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800',
                    )}
                >
                    <IconTriangleFill
                        className={cn('size-1.5 shrink-0 fill-current', !isPositive && 'rotate-180')}
                        aria-hidden
                    />
                    {`${Math.abs(changePercent).toFixed(2)}%`}
                </span>
            ) : null}
            <span className="text-[14px] text-[#2D2D2D] font-sans tabular-nums">{formatCount(value)}</span>
        </div>
    );
}

function MarketTokenAvatar({
    token,
    className,
    preferPoolLogo = false,
}: {
    token: TokenMarketToken | undefined;
    className?: string;
    preferPoolLogo?: boolean;
}) {
    const [hasError, setHasError] = React.useState(false);

    const label = token?.symbol ?? token?.name ?? formatCompactAddress(token?.address);
    const initials = (label || '??').slice(0, 2).toUpperCase();
    const iconUrl = normalizeLogoSrc(
        preferPoolLogo ? getPoolProtocolLogo(token) : (token?.icon ?? '').trim() || undefined,
    );

    if (!iconUrl || hasError) {
        return (
            <div
                className={cn(
                    'flex size-6.5 items-center justify-center rounded-full border border-border-light bg-gray-50 text-[11px] font-sans text-text-medium',
                    className,
                )}
            >
                {initials}
            </div>
        );
    }

    // The image optimizer rejects SVG (dangerouslyAllowSVG is off) and ICO (e.g. pool protocol favicons).
    const isUnoptimizedFormat = /\.(svg|ico)(\?|#|$)/i.test(iconUrl);

    return (
        <Image
            src={iconUrl}
            alt={label || 'Token'}
            width={26}
            height={26}
            className={cn('size-6.5 rounded-full border border-border-light bg-gray-50 object-cover', className)}
            unoptimized={isUnoptimizedFormat}
            onError={() => setHasError(true)}
        />
    );
}

function MarketPairAvatars({
    base,
    quote,
    protocol,
}: {
    base?: TokenMarketToken;
    quote?: TokenMarketToken;
    protocol?: TokenMarketToken;
}) {
    const hasBase = Boolean(base?.address || base?.symbol || base?.name || base?.icon);
    const hasQuote = Boolean(quote?.address || quote?.symbol || quote?.name || quote?.icon);
    const hasProtocol = Boolean(protocol?.address || protocol?.symbol || protocol?.name || protocol?.icon);

    if (!hasBase && !hasQuote && !hasProtocol) return null;

    return (
        <div className="flex shrink-0 items-center">
            {hasBase && (
                <MarketTokenAvatar
                    token={base}
                    className={cn((hasQuote || hasProtocol) && 'relative z-30 ring-2 ring-white')}
                />
            )}
            {hasQuote && (
                <MarketTokenAvatar
                    token={quote}
                    className={cn(hasBase && '-ml-2', 'relative z-20', hasProtocol && 'ring-2 ring-white')}
                />
            )}
            {hasProtocol && (
                <MarketTokenAvatar
                    token={protocol}
                    preferPoolLogo
                    className={cn((hasBase || hasQuote) && '-ml-2', 'relative z-10')}
                />
            )}
        </div>
    );
}

function createColumns(protocolTokensByMarket: Record<string, TokenMarketToken | undefined> | undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cols: Array<ColumnDef<TokenMarket, any>> = [
        columnHelper.display({
            id: 'pair',
            header: 'Pair',
            cell: info => {
                const market = info.row.original;
                const protocolToken: TokenMarketToken | undefined =
                    protocolTokensByMarket?.[market.address] ??
                    (market.source
                        ? {
                              address: market.address,
                              symbol: market.source,
                              name: market.source,
                          }
                        : undefined);
                const baseSymbol = market.base?.symbol ?? formatCompactAddress(market.base?.address);
                const quoteSymbol = market.quote?.symbol ?? formatCompactAddress(market.quote?.address);

                return (
                    <div className="min-w-[200px]">
                        <div className="flex items-center gap-3">
                            <MarketPairAvatars base={market.base} quote={market.quote} protocol={protocolToken} />
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-[14px] font-medium text-text-extra-high">{baseSymbol}</span>
                                    <span className="text-[12px] text-text-extra-low font-sans">/</span>
                                    <span className="text-[14px] font-medium text-text-extra-high">{quoteSymbol}</span>
                                </div>
                                <a
                                    href={explorerTokenUrl('solana', market.address)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-text-extra-low font-sans hover:text-text-extra-high transition-colors"
                                    onClick={e => e.stopPropagation()}
                                >
                                    {formatCompactAddress(market.address)}
                                    <ArrowUpRight className="h-3 w-3 text-text-extra-low group-hover:text-text-low transition-colors" />
                                </a>
                            </div>
                        </div>
                    </div>
                );
            },
        }),
        columnHelper.accessor(market => market.liquidity ?? 0, {
            id: 'liquidity',
            header: 'Liquidity',
            cell: info => (
                <span className="text-[14px] text-text-extra-high font-sans text-right block text-nowrap tabular-nums">
                    {formatUsd(info.row.original.liquidity)}
                </span>
            ),
        }),
        columnHelper.accessor(market => market.volume24h ?? 0, {
            id: 'volume24h',
            header: '24h Volume',
            cell: info => (
                <span className="text-[14px] text-text-extra-high font-sans text-right block text-nowrap tabular-nums">
                    {formatUsd(info.row.original.volume24h)}
                </span>
            ),
        }),
        columnHelper.accessor(market => market.trade24h ?? 0, {
            id: 'trade24h',
            header: '24h Trades',
            cell: info => {
                const market = info.row.original;
                return <InlineChangeMetric value={market.trade24h} changePercent={market.trade24hChangePercent} />;
            },
        }),
        columnHelper.accessor(market => market.uniqueWallet24h ?? 0, {
            id: 'uniqueWallet24h',
            header: '24h Wallets',
            cell: info => {
                const market = info.row.original;
                return (
                    <InlineChangeMetric
                        value={market.uniqueWallet24h}
                        changePercent={market.uniqueWallet24hChangePercent}
                    />
                );
            },
        }),
    ];

    return cols;
}

interface AssetMarketsTableProps {
    assetId: string;
    tokenMint: string;
    tokenSymbol: string;
    tokenName: string;
    initialMarkets: TokenMarket[];
    initialTotal: number | undefined;
}

export function AssetMarketsTable({
    assetId,
    tokenMint,
    tokenSymbol,
    tokenName,
    initialMarkets,
    initialTotal,
}: AssetMarketsTableProps) {
    const [markets, setMarkets] = React.useState<TokenMarket[]>(() => initialMarkets);
    const [total, setTotal] = React.useState<number | undefined>(initialTotal);
    const [pageIndex, setPageIndex] = React.useState(0);
    const [pageSize, setPageSize] = React.useState(10);
    const [isLoading, setIsLoading] = React.useState(false);
    const [sort, setSort] = React.useState<{ column: string | null; desc: boolean }>({
        column: 'volume24h',
        desc: true,
    });
    const { column: sortColumn, desc: sortDesc } = sort;

    const columns = React.useMemo(() => createColumns(undefined), []);

    const fetchPage = React.useCallback(
        async (newPageIndex: number, newPageSize: number) => {
            setIsLoading(true);
            try {
                const offset = newPageIndex * newPageSize;
                const params = new URLSearchParams({
                    include: 'markets',
                    marketsOffset: String(offset),
                    marketsLimit: String(newPageSize),
                });
                params.set('mint', tokenMint);

                const response = await fetch(`/api/v1/assets/${encodeURIComponent(assetId)}?${params.toString()}`);
                if (!response.ok) throw new Error('Failed to fetch markets');

                const data: AssetMarketsApiResponse = await response.json();
                const include = data.includes?.markets;
                if (!include) throw new Error('Failed to fetch markets');
                if (!include.ok) throw new Error(include.message);

                setMarkets(include.data.markets);
                if (include.data.total !== undefined) setTotal(include.data.total);
            } catch (error) {
                console.error('Error fetching markets:', error);
            } finally {
                setIsLoading(false);
            }
        },
        [assetId, tokenMint],
    );

    const handlePageChange = React.useCallback(
        (newPageIndex: number) => {
            trackEvent('markets_page_changed', {
                asset_id: assetId,
                token_address: tokenMint,
                token_address_type: 'solana',
                token_symbol: tokenSymbol,
                token_name: tokenName,
                page_index: newPageIndex,
                previous_page_index: pageIndex,
                page_size: pageSize,
                total_markets: total,
                source: 'assets',
            });
            setPageIndex(newPageIndex);
            fetchPage(newPageIndex, pageSize);
        },
        [assetId, fetchPage, pageIndex, pageSize, tokenMint, tokenName, tokenSymbol, total],
    );

    const handlePageSizeChange = React.useCallback(
        (newPageSize: number) => {
            setPageSize(newPageSize);
            setPageIndex(0);
            fetchPage(0, newPageSize);
        },
        [fetchPage],
    );

    const handleSort = React.useCallback((columnId: string) => {
        setSort(prev =>
            prev.column === columnId ? { column: columnId, desc: !prev.desc } : { column: columnId, desc: true },
        );
    }, []);

    const sortedMarkets = React.useMemo(() => {
        if (!sortColumn) return markets;

        return [...markets].sort((a, b) => {
            let aVal: number | string = 0;
            let bVal: number | string = 0;

            switch (sortColumn) {
                case 'liquidity':
                    aVal = a.liquidity ?? 0;
                    bVal = b.liquidity ?? 0;
                    break;
                case 'volume24h':
                    aVal = a.volume24h ?? 0;
                    bVal = b.volume24h ?? 0;
                    break;
                case 'trade24h':
                    aVal = a.trade24h ?? 0;
                    bVal = b.trade24h ?? 0;
                    break;
                case 'uniqueWallet24h':
                    aVal = a.uniqueWallet24h ?? 0;
                    bVal = b.uniqueWallet24h ?? 0;
                    break;
                default:
                    return 0;
            }

            if (sortDesc) return bVal > aVal ? 1 : bVal < aVal ? -1 : 0;
            return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
        });
    }, [markets, sortColumn, sortDesc]);

    const table = useReactTable({
        data: sortedMarkets,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getRowId: row => row.address,
        manualPagination: true,
        manualSorting: true,
        pageCount: total ? Math.ceil(total / pageSize) : -1,
        state: {
            pagination: { pageIndex, pageSize },
        },
    });

    function handleRowClick(market: TokenMarket) {
        trackEvent('market_clicked', {
            asset_id: assetId,
            token_address: tokenMint,
            token_address_type: 'solana',
            token_symbol: tokenSymbol,
            token_name: tokenName,
            market_address: market.address,
            market_source: market.source,
            market_liquidity: market.liquidity,
            market_volume_24h: market.volume24h,
            base_symbol: market.base?.symbol,
            quote_symbol: market.quote?.symbol,
            source: 'assets',
        });
        window.open(explorerTokenUrl('solana', market.address), '_blank', 'noopener,noreferrer');
    }

    const sortableColumns = ['liquidity', 'volume24h', 'trade24h', 'uniqueWallet24h'];

    return (
        <MarketsTableShell
            isLoading={isLoading}
            pagination={{
                pageIndex,
                pageSize,
                total,
                visibleCount: markets.length,
                itemLabel: 'markets',
                isLoading,
                onPageChange: handlePageChange,
                onPageSizeChange: handlePageSizeChange,
            }}
        >
            <table className="w-full text-left border-collapse">
                <thead>
                    {table.getHeaderGroups().map(headerGroup => (
                        <tr key={headerGroup.id} className="border-b border-border-extra-light bg-gray-50/80">
                            {headerGroup.headers.map((header, index) => {
                                const canSort = sortableColumns.includes(header.id);
                                const isSorted = sortColumn === header.id;
                                const sortDirection = isSorted ? (sortDesc ? 'desc' : 'asc') : false;

                                return (
                                    <th
                                        key={header.id}
                                        className={`py-3 text-[14px] font-medium text-text-high bg-gray-50/80 border-b border-border-light ${
                                            index === 0
                                                ? 'pl-8 pr-4'
                                                : index === headerGroup.headers.length - 1
                                                  ? 'pl-4 pr-6 text-right'
                                                  : 'px-4'
                                        }`}
                                    >
                                        {header.isPlaceholder ? null : (
                                            <button
                                                type="button"
                                                className={`inline-flex text-nowrap items-center gap-1 ${
                                                    canSort
                                                        ? 'cursor-pointer hover:text-text-extra-high select-none'
                                                        : ''
                                                } ${index === headerGroup.headers.length - 1 ? 'justify-end w-full' : ''}`}
                                                onClick={() => canSort && handleSort(header.id)}
                                                disabled={!canSort}
                                            >
                                                {flexRender(header.column.columnDef.header, header.getContext())}
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
                <tbody className="divide-y divide-border-extra-light">
                    {table.getRowModel().rows.map(row => (
                        <tr
                            key={row.id}
                            role="button"
                            tabIndex={0}
                            className="hover:bg-gray-50/50 transition-colors group cursor-pointer"
                            onClick={() => handleRowClick(row.original)}
                            onKeyDown={event => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    handleRowClick(row.original);
                                }
                            }}
                        >
                            {row.getVisibleCells().map((cell, index) => (
                                <td
                                    key={cell.id}
                                    className={`py-4 ${
                                        index === 0
                                            ? 'pl-8 pr-4'
                                            : index === row.getVisibleCells().length - 1
                                              ? 'pl-4 pr-6'
                                              : 'px-4'
                                    }`}
                                >
                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </MarketsTableShell>
    );
}
