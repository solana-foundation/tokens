'use client';

import { useState } from 'react';
import type { Column, Row, Table } from '@tanstack/react-table';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

import { cn, truncateAddress } from '@tokens/ui/cn';
import { formatLargeNumber } from '@/lib/format';
import type { RegistryRow } from './lib/types';
import { RegistryEmptyState, displayNameOf } from './registry-cells';
import { RegistryDetailDrawer } from './registry-detail-drawer';
import { RegistryTokenLogo } from './registry-token-logo';

const SOURCE_LABELS = { allium: 'Allium', rwa: 'RWA.xyz' } as const;

/**
 * Phone layout (below md): the same filtered/sorted/paginated rows as the
 * table, one quiet row per asset — logo, symbol over name (or address), the
 * headline value over its source — and a tap opens a detail drawer with the
 * taxonomy badge, the address, all three numbers and "View more" when the
 * asset has a tokens.xyz page.
 */
export function RegistryMobileList({
    rows,
    table,
    onClearFilters,
    onOpenResponse,
}: {
    rows: Row<RegistryRow>[];
    table: Table<RegistryRow>;
    onClearFilters: () => void;
    onOpenResponse: (row: RegistryRow) => void;
}) {
    const [detail, setDetail] = useState<RegistryRow | null>(null);
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
                        <RegistryMobileRow key={row.id} row={row.original} onOpen={setDetail} />
                    ))}
                </ul>
            )}
            <RegistryDetailDrawer
                row={detail}
                onOpenChange={open => {
                    if (!open) setDetail(null);
                }}
                onOpenResponse={onOpenResponse}
            />
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

function RegistryMobileRow({ row, onOpen }: { row: RegistryRow; onOpen: (row: RegistryRow) => void }) {
    // Headline number: the coalesced provider value, else market cap, else a dash.
    const headline =
        row.providerValueUsd != null && row.providerValueSource
            ? { value: row.providerValueUsd, source: SOURCE_LABELS[row.providerValueSource] }
            : row.marketCapUsd != null
              ? { value: row.marketCapUsd, source: 'Market cap' }
              : null;
    const secondary = row.name ? displayNameOf(row) : truncateAddress(row.mintAddress);

    return (
        <li
            role="button"
            tabIndex={0}
            aria-label={`${row.symbol} details`}
            className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors active:bg-gray-50/60"
            onClick={() => onOpen(row)}
            onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onOpen(row);
            }}
        >
            <RegistryTokenLogo row={row} size={32} />
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[15px] font-semibold text-text-extra-high">{row.symbol}</span>
                <span className={cn('truncate text-[12px] text-text-low', !row.name && 'font-mono')} title={secondary}>
                    {secondary}
                </span>
            </div>
            <div className="flex shrink-0 flex-col items-end leading-tight">
                <span
                    className={cn(
                        'text-[14px] font-medium tabular-nums',
                        headline ? 'text-[#2D2D2D]' : 'text-text-extra-low',
                    )}
                >
                    {headline ? formatLargeNumber(headline.value) : '—'}
                </span>
                <span className="text-[11px] font-medium text-text-extra-low">{headline ? headline.source : ''}</span>
            </div>
        </li>
    );
}
