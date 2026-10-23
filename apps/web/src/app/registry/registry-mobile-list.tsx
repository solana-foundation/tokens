'use client';

import type { Column, Row, Table } from '@tanstack/react-table';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

import { cn } from '@tokens/ui/cn';
import { formatLargeNumber } from '@/lib/format';
import type { RegistryRow } from './lib/types';
import { AddressLink, RegistryEmptyState, TokenLink } from './registry-cells';
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
                            className="w-2.5 shrink-0 border-x border-border-medium bg-[repeating-linear-gradient(135deg,var(--color-border-medium)_0_1px,transparent_1px_4px)]"
                        />
                    ) : null}
                    <span className="min-w-0 truncate px-1.5 py-1">{segment}</span>
                </span>
            ))}
        </span>
    );
}

/** One stat line of the phone row's right column: label left, number right. */
function StatRow({ label, value, muted = false }: { label: string; value: number | null; muted?: boolean }) {
    return (
        <div className="flex items-baseline justify-between gap-2 py-1 first:pt-0 last:pb-0">
            <dt className="text-[11px] font-medium text-text-extra-low">{label}</dt>
            <dd
                className={cn(
                    'text-[13px] font-medium tabular-nums',
                    value == null ? 'text-text-extra-low' : muted ? 'text-text-medium' : 'text-[#2D2D2D]',
                )}
            >
                {formatLargeNumber(value)}
            </dd>
        </div>
    );
}

function RegistryMobileRow({ row }: { row: RegistryRow }) {
    return (
        <li className="flex items-stretch gap-2.5 px-4 py-3">
            {/* Main area: identity, then the taxonomy badge right under the address. The symbol
                links to the asset page and the address to the explorer: two separate anchors
                side by side rather than one nested in the other. */}
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
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
                <div className="flex min-w-0">
                    <TaxonomyBadge category={row.category} assetClass={row.assetClass} />
                </div>
            </div>
            {/* Stats column: the three numbers as a hairline-separated list, split from the main area. */}
            <dl className="flex w-[120px] shrink-0 flex-col justify-center divide-y divide-border-extra-light border-l border-border-light pl-2.5">
                <StatRow label="Allium" value={row.alliumValueUsd} />
                <StatRow label="RWA.xyz" value={row.rwaValueUsd} />
                <StatRow label="Mcap" value={row.marketCapUsd} muted />
            </dl>
        </li>
    );
}
