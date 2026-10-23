'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import type { Column, Row, Table } from '@tanstack/react-table';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

import { AssetAdvisoryBadge } from '@/components/asset-advisory-badge';
import { SplitBadge } from '@/components/split-badge';
import type { Token } from '@/lib/types';
import { INLINE_CHART_FALLBACK_DAYS, PercentChangeCell, TokenLogo, TokenTablePriceCell } from './token-table-cells';

const MOBILE_ROW_HEIGHT = 68;
// The logo sits inside the 20px name line, same height as the text, so it never outweighs the row.
const MOBILE_LOGO_SIZE = 20;

// Backdrop sparkline: no loading placeholder, it fades in once the data is there.
const InlinePriceChart = dynamic(() => import('@/components/inline-price-chart').then(m => m.InlinePriceChart), {
    ssr: false,
    loading: () => null,
});

/** One small stat in the phone row's second line, e.g. "24h Vol $1.20M". */
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
    /** Paint the 24h sparkline as a faded backdrop on the row's right half. */
    showChart: boolean;
    change: { key: 'priceChange1hPercent' | 'priceChange24hPercent'; label: string } | null;
    stats: TokenMobileStat[];
    displayName: (token: Token) => string;
}

export interface TokenMobileRowHandlers {
    onClick: (token: Token) => void;
    onPointerDown: (token: Token) => void;
    onFocus: (token: Token) => void;
}

/**
 * Phone layout (below md) for the home table: the same sorted rows, one
 * stacked row each instead of a 980px grid that only shows the name column.
 * Line 1 is logo + name + $symbol with the price on the right; line 2 is the
 * variant's two or three headline stats with the price change on the right.
 * Window-virtualized like the table, with its own fixed row height.
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
                            handlers={handlers}
                        />
                    );
                })}
                {paddingBottom > 0 ? <li aria-hidden style={{ height: paddingBottom }} className="border-0" /> : null}
            </ul>
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

function TokenMobileRow({
    token,
    index,
    spec,
    handlers,
}: {
    token: Token;
    index: number;
    spec: TokenMobileRowSpec;
    handlers: TokenMobileRowHandlers;
}) {
    const change = spec.change ? token[spec.change.key] : undefined;
    return (
        <li
            style={{ height: MOBILE_ROW_HEIGHT }}
            className="relative flex cursor-pointer flex-col justify-center px-4 transition-colors active:bg-gray-50/60"
            tabIndex={0}
            onClick={() => handlers.onClick(token)}
            onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                handlers.onClick(token);
            }}
            onPointerDown={() => handlers.onPointerDown(token)}
            onFocus={() => handlers.onFocus(token)}
        >
            {spec.showChart ? (
                // The 24h sparkline as a quiet backdrop in the row's middle band: a soft filled
                // area that fades in after the stats and fades out again under the price, so it
                // reads as texture and never competes with the numbers (the end dot sits in the
                // faded-out zone).
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-y-2 right-0 w-[58%] opacity-25 [mask-image:linear-gradient(to_right,transparent_0%,black_38%,black_62%,transparent_90%)]"
                >
                    <InlinePriceChart
                        assetId={token.assetId}
                        coingeckoId={token.coingeckoId}
                        useCanonicalAssetChart={token.canonicalMarketSource === 'clickhouse_stock'}
                        address={token.address}
                        percentChange24h={token.priceChange24hPercent}
                        symbol={token.symbol}
                        emptyText=""
                        chartHeight={MOBILE_ROW_HEIGHT - 16}
                        fallbackDays={INLINE_CHART_FALLBACK_DAYS}
                        fill
                        exaggerate={false}
                        lineWidth={1.25}
                        className="relative h-full w-full overflow-hidden bg-transparent"
                    />
                </div>
            ) : null}
            <div className="relative flex min-w-0 flex-col gap-[3px]">
                {/* Line 1: rank, a name-sized logo and the name, price on the right. */}
                <div className="flex items-center justify-between gap-3 leading-5">
                    <div className="flex min-w-0 items-center gap-2">
                        {spec.showRank ? (
                            <span className="w-4 shrink-0 text-right text-[12px] font-medium tabular-nums text-text-low">
                                {token.trendingRank ?? index + 1}
                            </span>
                        ) : null}
                        <TokenLogo token={token} size={MOBILE_LOGO_SIZE} />
                        <span
                            className="truncate text-[15px] font-medium text-text-extra-high"
                            title={spec.displayName(token)}
                        >
                            {spec.displayName(token)}
                        </span>
                        <span className="shrink-0 text-[12px] font-medium text-text-extra-low">
                            ${token.symbol || '???'}
                        </span>
                        <AssetAdvisoryBadge advisory={token.advisory} size="sm" />
                    </div>
                    {spec.showPrice ? (
                        <span className="shrink-0">
                            <TokenTablePriceCell token={token} />
                        </span>
                    ) : null}
                </div>
                {/* Line 2: the stats pill, price change on the right. */}
                <div className="flex items-center justify-between gap-3 text-[12px] leading-none">
                    <SplitBadge
                        className="bg-white"
                        segments={spec.stats.map(stat => (
                            <React.Fragment key={stat.id}>
                                <span className="font-normal text-text-extra-low">{stat.label} </span>
                                {stat.format(token)}
                            </React.Fragment>
                        ))}
                    />
                    {spec.change ? (
                        <span className="shrink-0 [&_span]:text-[12px]">
                            {change == null ? (
                                <span className="text-text-extra-low">—</span>
                            ) : (
                                <PercentChangeCell value={change} />
                            )}
                        </span>
                    ) : null}
                </div>
            </div>
        </li>
    );
}
