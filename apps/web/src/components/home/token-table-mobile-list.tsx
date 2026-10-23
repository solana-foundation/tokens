'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import type { Column, Row, Table } from '@tanstack/react-table';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

import { AssetAdvisoryBadge } from '@/components/asset-advisory-badge';
import { MobileDetailDrawer } from '@/components/mobile-detail-drawer';
import type { Token } from '@/lib/types';
import {
    INLINE_CHART_FALLBACK_DAYS,
    PercentChangeCell,
    TokenLogo,
    TokenTablePriceCell,
    formatVolume,
} from './token-table-cells';

const MOBILE_ROW_HEIGHT = 64;

const InlinePriceChart = dynamic(() => import('@/components/inline-price-chart').then(m => m.InlinePriceChart), {
    ssr: false,
    loading: () => null,
});

/** One stat in the detail drawer, e.g. "24h Vol" → "$1.20M". */
export interface TokenMobileStat {
    id: string;
    label: string;
    format: (token: Token) => string;
    /** Table column that sorts this stat; display-only columns have none. */
    sortColumnId?: string;
}

/** What a table variant shows per row on phones; built next to the column set in token-table.tsx. */
export interface TokenMobileRowSpec {
    showRank: boolean;
    showPrice: boolean;
    /** Inline 24h sparkline between the name and the price. */
    showChart: boolean;
    change: { key: 'priceChange1hPercent' | 'priceChange24hPercent'; label: string } | null;
    stats: TokenMobileStat[];
    displayName: (token: Token) => string;
}

export interface TokenMobileRowHandlers {
    /** Navigate to the token's page (fires the click analytics event). */
    onClick: (token: Token) => void;
    onPointerDown: (token: Token) => void;
    onFocus: (token: Token) => void;
}

/**
 * Phone layout (below md) for the home table: the same sorted rows as the
 * table, one quiet row each — logo, symbol over name, a small sparkline, price
 * over change — and a tap opens a detail drawer with the chart, the variant's
 * stats and a "View more" into the token page. Window-virtualized like the
 * table, with its own fixed row height.
 */
export function TokenTableMobileList({
    rows,
    table,
    spec,
    handlers,
    categoryId,
}: {
    rows: Row<Token>[];
    table: Table<Token>;
    spec: TokenMobileRowSpec;
    handlers: TokenMobileRowHandlers;
    categoryId: string | undefined;
}) {
    const topRef = React.useRef<HTMLDivElement>(null);
    const [scrollMargin, setScrollMargin] = React.useState(0);
    const [detail, setDetail] = React.useState<Token | null>(null);

    React.useLayoutEffect(() => {
        const el = topRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setScrollMargin(rect.top + window.scrollY);
    }, [categoryId]);

    const virtualizer = useWindowVirtualizer({
        count: rows.length,
        estimateSize: () => MOBILE_ROW_HEIGHT,
        overscan: 8,
        scrollMargin,
        useFlushSync: false,
    });
    const virtualRows = virtualizer.getVirtualItems();
    const paddingTop = virtualRows.length > 0 ? Math.max(0, virtualRows[0]!.start - scrollMargin) : 0;
    const paddingBottom =
        virtualRows.length > 0 ? Math.max(0, virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end) : 0;

    const sortableStat = spec.stats.find(stat => stat.sortColumnId);

    return (
        <div className="md:hidden">
            <div className="flex items-center justify-between gap-3 border-b border-border-light bg-gray-50/80 px-4 py-2.5">
                <span className="text-[12px] font-medium text-text-high">Token</span>
                <div className="flex items-center gap-4">
                    {sortableStat ? (
                        <SortButton column={table.getColumn(sortableStat.sortColumnId!)} label={sortableStat.label} />
                    ) : null}
                    {spec.showPrice ? <SortButton column={table.getColumn('price')} label="Price" /> : null}
                </div>
            </div>
            <div ref={topRef} />
            <ul role="list" className="divide-y divide-border-extra-light">
                {paddingTop > 0 ? <li aria-hidden style={{ height: paddingTop }} className="border-0" /> : null}
                {virtualRows.map(virtualRow => {
                    const row = rows[virtualRow.index];
                    if (!row) return null;
                    return (
                        <TokenMobileRow
                            key={row.id}
                            token={row.original}
                            index={row.index}
                            spec={spec}
                            onOpen={token => {
                                handlers.onPointerDown(token);
                                setDetail(token);
                            }}
                            onPrefetch={handlers.onFocus}
                        />
                    );
                })}
                {paddingBottom > 0 ? <li aria-hidden style={{ height: paddingBottom }} className="border-0" /> : null}
            </ul>
            <TokenDetailDrawer
                token={detail}
                spec={spec}
                onOpenChange={open => {
                    if (!open) setDetail(null);
                }}
                onViewMore={handlers.onClick}
            />
        </div>
    );
}

function SortButton({ column, label }: { column: Column<Token> | undefined; label: string }) {
    const canSort = column?.getCanSort() ?? false;
    const sortDirection = column?.getIsSorted() ?? false;
    if (!column || !canSort) return null;
    return (
        <button
            type="button"
            className="inline-flex h-8 cursor-pointer select-none items-center gap-1 text-[12px] font-medium text-text-high hover:text-text-extra-high"
            onClick={column.getToggleSortingHandler()}
        >
            {label}
            <span className="text-text-extra-low">
                {sortDirection === 'asc' ? (
                    <ChevronUp className="h-4 w-4" />
                ) : sortDirection === 'desc' ? (
                    <ChevronDown className="h-4 w-4" />
                ) : (
                    <ChevronsUpDown className="h-3.5 w-3.5" />
                )}
            </span>
        </button>
    );
}

function ChangeCell({ value, className }: { value: number | undefined; className?: string }) {
    if (value == null) return <span className="text-text-extra-low">—</span>;
    return (
        <span className={className}>
            <PercentChangeCell value={value} />
        </span>
    );
}

function TokenMobileRow({
    token,
    index,
    spec,
    onOpen,
    onPrefetch,
}: {
    token: Token;
    index: number;
    spec: TokenMobileRowSpec;
    onOpen: (token: Token) => void;
    onPrefetch: (token: Token) => void;
}) {
    const change = spec.change ? token[spec.change.key] : undefined;
    return (
        <li
            style={{ height: MOBILE_ROW_HEIGHT }}
            role="button"
            tabIndex={0}
            aria-label={`${spec.displayName(token)} details`}
            className="flex cursor-pointer items-center gap-3 px-4 transition-colors active:bg-gray-50/60"
            onClick={() => onOpen(token)}
            onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onOpen(token);
            }}
            onFocus={() => onPrefetch(token)}
        >
            {spec.showRank ? (
                <span className="w-4 shrink-0 text-right text-[11px] font-medium tabular-nums text-text-low">
                    {token.trendingRank ?? index + 1}
                </span>
            ) : null}
            <TokenLogo token={token} size={32} />
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[15px] font-semibold text-text-extra-high">
                        {token.symbol || '???'}
                    </span>
                    <AssetAdvisoryBadge advisory={token.advisory} size="sm" />
                </span>
                <span className="truncate text-[12px] text-text-low" title={spec.displayName(token)}>
                    {spec.displayName(token)}
                </span>
            </div>
            {spec.showChart ? (
                <InlinePriceChart
                    assetId={token.assetId}
                    coingeckoId={token.coingeckoId}
                    useCanonicalAssetChart={token.canonicalMarketSource === 'clickhouse_stock'}
                    address={token.address}
                    percentChange24h={token.priceChange24hPercent}
                    symbol={token.symbol}
                    emptyText=""
                    chartHeight={28}
                    lineWidth={1.5}
                    fallbackDays={INLINE_CHART_FALLBACK_DAYS}
                    className="relative h-7 w-[72px] shrink-0 overflow-hidden bg-transparent"
                />
            ) : null}
            <div className="flex shrink-0 flex-col items-end gap-0.5 leading-tight">
                {spec.showPrice ? <TokenTablePriceCell token={token} /> : null}
                {spec.change ? <ChangeCell value={change} className="[&_span]:text-[12px]" /> : null}
            </div>
        </li>
    );
}

/** The drawer a row opens: big price, change, chart, the variant's stats and "View more". */
function TokenDetailDrawer({
    token,
    spec,
    onOpenChange,
    onViewMore,
}: {
    token: Token | null;
    spec: TokenMobileRowSpec;
    onOpenChange: (open: boolean) => void;
    onViewMore: (token: Token) => void;
}) {
    // Keep the last token mounted while the drawer animates closed.
    const lastToken = React.useRef<Token | null>(null);
    if (token) lastToken.current = token;
    const shown = token ?? lastToken.current;
    if (!shown) return null;

    const change = spec.change ? shown[spec.change.key] : undefined;
    const changeCaption = spec.change?.key === 'priceChange1hPercent' ? 'past hour' : 'past day';
    const stats = [
        { label: 'Market cap', value: shown.marketCap > 0 ? formatVolume(shown.marketCap) : '—' },
        ...spec.stats.map(stat => ({ label: stat.label, value: stat.format(shown) })),
    ];

    return (
        <MobileDetailDrawer
            open={token !== null}
            onOpenChange={onOpenChange}
            logo={<TokenLogo token={shown} size={40} />}
            title={spec.displayName(shown)}
            subtitle={shown.symbol}
            stats={stats}
            action={{ label: 'View more', onClick: () => onViewMore(shown) }}
        >
            <div className="flex flex-col gap-1">
                {spec.showPrice ? (
                    <TokenTablePriceCell
                        token={shown}
                        className="text-left text-[32px] font-semibold leading-none tracking-tight text-text-extra-high"
                    />
                ) : null}
                {spec.change ? (
                    <span className="flex items-center gap-1.5 text-[14px] text-text-low">
                        <ChangeCell value={change} className="[&_span]:text-[14px]" />
                        <span>· {changeCaption}</span>
                    </span>
                ) : null}
            </div>
            <div className="mt-4">
                <InlinePriceChart
                    key={shown.address}
                    assetId={shown.assetId}
                    coingeckoId={shown.coingeckoId}
                    useCanonicalAssetChart={shown.canonicalMarketSource === 'clickhouse_stock'}
                    address={shown.address}
                    percentChange24h={shown.priceChange24hPercent}
                    symbol={shown.symbol}
                    emptyText="No chart data"
                    chartHeight={120}
                    lineWidth={2}
                    fill
                    fallbackDays={INLINE_CHART_FALLBACK_DAYS}
                    className="relative h-[120px] w-full overflow-hidden rounded-lg bg-transparent"
                />
            </div>
        </MobileDetailDrawer>
    );
}
