'use client';

import type { Column, Row, Table } from '@tanstack/react-table';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

import { cn } from '@tokens/ui/cn';
import { formatLargeNumber } from '@/lib/format';
import type { RegistryRow } from './lib/types';
import { AddressLink, ProviderValues, RegistryEmptyState, TokenLink } from './registry-cells';
import { RegistryTokenLogo } from './registry-token-logo';

/**
 * Phone layout (below md): the same filtered/sorted/paginated rows as the
 * table, one stacked row per asset instead of a sideways-scrolling grid.
 * Tier 1 is logo + symbol over the mint address with both provider values on
 * the right; tier 2 is category · class with the market cap. The name and the
 * Response sheet stay desktop-only (both are on the asset page).
 */
export function RegistryMobileList({
    rows,
    table,
    onClearFilters,
}: {
    rows: Row<RegistryRow>[];
    table: Table<RegistryRow>;
    onClearFilters: () => void;
}) {
    return (
        <div className="md:hidden">
            <div className="flex items-center justify-between gap-3 border-b border-border-light bg-gray-50/80 px-4 py-2.5">
                <SortButton column={table.getColumn('token')} label="Token" />
                <SortButton column={table.getColumn('providerValueUsd')} label="Value" align="right" />
            </div>
            {rows.length === 0 ? (
                <RegistryEmptyState onClear={onClearFilters} />
            ) : (
                <ul role="list" aria-label="Registry assets" className="divide-y divide-border-extra-light">
                    {rows.map(row => (
                        <RegistryMobileRow key={row.id} row={row.original} />
                    ))}
                </ul>
            )}
        </div>
    );
}

/** The desktop header's sort toggle, for the two columns a phone shows. */
function SortButton({
    column,
    label,
    align = 'left',
}: {
    column: Column<RegistryRow> | undefined;
    label: string;
    align?: 'left' | 'right';
}) {
    const sortDirection = column?.getIsSorted() ?? false;
    return (
        <button
            type="button"
            className={cn(
                'inline-flex h-8 cursor-pointer select-none items-center gap-1 text-[12px] font-medium text-text-high hover:text-text-extra-high',
                align === 'right' && 'justify-end',
            )}
            onClick={column?.getToggleSortingHandler()}
            disabled={!column}
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

/**
 * Category and class as one split pill: two segments joined by a hatched
 * divider, so the two taxonomy tiers read as a pair instead of one dotted
 * string. Either side may be missing; with neither it is a plain dash.
 */
function TaxonomyBadge({ category, assetClass }: { category: string | null; assetClass: string | null }) {
    const segments = [category, assetClass].filter((value): value is string => !!value);
    if (segments.length === 0) return <span className="text-text-extra-low">—</span>;
    return (
        <span
            className="inline-flex min-w-0 max-w-full items-stretch overflow-hidden rounded-md border border-border-medium text-[11px] font-medium leading-none text-text-medium"
            title={segments.join(' · ')}
        >
            {segments.map((segment, index) => (
                <span key={segment} className="contents">
                    {index > 0 ? (
                        <span
                            aria-hidden
                            className="w-3 shrink-0 border-x border-border-medium bg-[repeating-linear-gradient(135deg,var(--color-border-medium)_0_1px,transparent_1px_4px)]"
                        />
                    ) : null}
                    <span className="min-w-0 truncate px-2 py-1">{segment}</span>
                </span>
            ))}
        </span>
    );
}

function RegistryMobileRow({ row }: { row: RegistryRow }) {
    return (
        <li className="flex flex-col gap-2 px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
                {/* The symbol links to the asset page and the address to the explorer: two
                    separate anchors side by side rather than one nested in the other. */}
                <div className="flex min-w-0 items-start gap-2.5">
                    <TokenLink row={row} className="-m-1 shrink-0 p-1">
                        <RegistryTokenLogo row={row} size={32} />
                    </TokenLink>
                    <div className="flex min-w-0 flex-col leading-tight">
                        <TokenLink row={row} className="-my-1 py-1">
                            <span className="block truncate text-[15px] font-medium text-text-extra-high">
                                {row.symbol}
                            </span>
                        </TokenLink>
                        <AddressLink address={row.mintAddress} className="-my-1 py-1 text-[12px]" />
                    </div>
                </div>
                {/* All the numbers stack in one right column: both provider values, then
                    the market cap as a quieter third line. */}
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <ProviderValues row={row} align="right" />
                    {row.marketCapUsd != null ? (
                        <div className="grid grid-cols-[auto_auto] justify-end gap-x-2 text-right leading-tight tabular-nums">
                            <span className="min-w-[52px] self-center text-left text-[11px] font-medium text-text-extra-low">
                                Mcap
                            </span>
                            <span className="text-[12px] font-medium text-text-low">
                                {formatLargeNumber(row.marketCapUsd)}
                            </span>
                        </div>
                    ) : null}
                </div>
            </div>
            <div className="flex min-w-0 pl-[42px] text-[12px] text-text-low">
                <TaxonomyBadge category={row.category} assetClass={row.assetClass} />
            </div>
        </li>
    );
}
