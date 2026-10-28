'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    useReactTable,
    type PaginationState,
    type SortingState,
} from '@tanstack/react-table';
import { Braces, ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

import { cn } from '@tokens/ui/cn';
import { MarketsPagination } from '@/app/_components/markets/markets-pagination';
import { downloadTextFile, registryCsvFilename, registryRowsToCsv } from './lib/csv';
import { SORTABLE_COLUMN_IDS, applyFilters, type SortableColumnId } from './lib/filters';
import type { RegistryData, RegistryRow } from './lib/types';
import {
    AddressLink,
    ProviderValues,
    RegistryEmptyState,
    TextCell,
    TokenLink,
    UsdCell,
} from './registry-cells';
import { displayNameOf } from './lib/registry-row';
import type { CategoryOptions } from './registry-filter-editor';
import { RegistryMobileList } from './registry-mobile-list';
import { RegistryNuqsAdapter } from './registry-nuqs-adapter';
import { RegistryResponseSheet } from './registry-response-sheet';
import { RegistryTokenLogo } from './registry-token-logo';
import { RegistryToolbar } from './registry-toolbar';
import { useRegistryUrlState } from './use-registry-url-state';

const columnHelper = createColumnHelper<RegistryRow>();

// The table only renders at md and up (phones get RegistryMobileList), so the
// cells carry no phone variants and the Token column needs no sticky pin.
function TokenCell({ row }: { row: RegistryRow }) {
    const displayName = displayNameOf(row);
    return (
        <TokenLink row={row} className="flex max-w-[280px] items-center gap-[8px]">
            <RegistryTokenLogo row={row} />
            <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[16px] font-medium text-text-extra-high" title={displayName}>
                    {displayName}
                </span>
                {row.name ? (
                    <span className="shrink-0 text-[14px] text-text-extra-low font-medium">${row.symbol}</span>
                ) : null}
            </div>
        </TokenLink>
    );
}

/**
 * Six data columns. Group is implied by Category and both provider classes are
 * independent taxonomies with partial coverage, so they live in the filter chips
 * and the Response sheet rather than in the grid; the two provider values share
 * the one "Value" column. CSV columns are unchanged.
 */
function buildColumns(onOpenResponse: (row: RegistryRow) => void) {
    return [
        columnHelper.accessor('symbol', {
            id: 'token',
            header: 'Token',
            cell: info => <TokenCell row={info.row.original} />,
        }),
        columnHelper.accessor('mintAddress', {
            header: 'Address',
            enableSorting: false,
            cell: info => <AddressLink address={info.getValue()} />,
        }),
        columnHelper.accessor('category', {
            header: 'Category',
            enableSorting: false,
            cell: info => <TextCell value={info.getValue()} />,
        }),
        columnHelper.accessor('assetClass', {
            header: 'Class',
            enableSorting: false,
            cell: info => <TextCell value={info.getValue()} />,
        }),
        columnHelper.accessor(row => row.providerValueUsd ?? undefined, {
            id: 'providerValueUsd',
            header: () => (
                <span className="flex flex-col items-start leading-tight">
                    Value
                    <span className="text-[11px] font-medium text-text-extra-low">Allium · RWA.xyz</span>
                </span>
            ),
            sortUndefined: 'last',
            cell: info => <ProviderValues row={info.row.original} />,
        }),
        columnHelper.accessor(row => row.marketCapUsd ?? undefined, {
            id: 'marketCapUsd',
            header: () => (
                <span className="flex flex-col items-start leading-tight">
                    Market Cap
                    <span className="text-[11px] font-medium text-text-extra-low">CoinGecko</span>
                </span>
            ),
            sortUndefined: 'last',
            cell: info => <UsdCell value={info.row.original.marketCapUsd} />,
        }),
        columnHelper.display({
            id: 'response',
            header: () => <span className="sr-only">Response</span>,
            enableSorting: false,
            cell: info => {
                const row = info.row.original;
                return (
                    <span className="flex justify-end">
                        <button
                            type="button"
                            onClick={() => onOpenResponse(row)}
                            aria-label={`View API response for ${row.symbol}`}
                            title="View API response"
                            className="inline-flex size-8 items-center justify-center rounded-full border border-border-medium bg-white text-text-medium shadow-none transition-colors hover:bg-gray-50/60 hover:text-text-extra-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium"
                        >
                            <Braces className="size-3.5" aria-hidden />
                        </button>
                    </span>
                );
            },
        }),
    ];
}

function distinctSorted(values: Array<string | null>): string[] {
    return [...new Set(values.filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b));
}

function isSortableColumnId(id: string): id is SortableColumnId {
    return (SORTABLE_COLUMN_IDS as readonly string[]).includes(id);
}

/**
 * Wrapped in the registry's own nuqs adapter so the table (toolbar state and
 * all) renders in the prerendered HTML instead of behind a Suspense fallback.
 */
export function RegistryTable({ data }: { data: RegistryData }) {
    return (
        <RegistryNuqsAdapter>
            <RegistryTableInner data={data} />
        </RegistryNuqsAdapter>
    );
}

function RegistryTableInner({ data }: { data: RegistryData }) {
    const urlState = useRegistryUrlState();
    const { q, filters, sort, setSort, clearAll } = urlState;
    const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });
    const [openMint, setOpenMint] = useState<string | null>(null);
    const columns = useMemo(() => buildColumns(row => setOpenMint(row.mintAddress)), []);
    const openRow = useMemo(
        () => (openMint ? (data.rows.find(row => row.mintAddress === openMint) ?? null) : null),
        [data.rows, openMint],
    );

    const options = useMemo<CategoryOptions>(
        () => ({
            group: distinctSorted(data.rows.map(row => row.group)),
            category: distinctSorted(data.rows.map(row => row.category)),
            assetClass: distinctSorted(data.rows.map(row => row.assetClass)),
            rwaClass: distinctSorted(data.rows.map(row => row.rwaClass)),
            alliumClass: distinctSorted(data.rows.map(row => row.alliumClass)),
            hasTokenPage: ['yes', 'no'],
        }),
        [data.rows],
    );

    const filteredRows = useMemo(() => applyFilters(data.rows, { q, filters }), [data.rows, q, filters]);

    useEffect(() => {
        setPagination(current => ({ ...current, pageIndex: 0 }));
    }, [q, filters]);

    // Sorting lives in the URL; an empty state keeps the server's canonical coalesced order.
    const sorting = useMemo<SortingState>(() => (sort ? [{ id: sort.id, desc: sort.desc }] : []), [sort]);
    const handleSortingChange = useCallback(
        (updater: SortingState | ((current: SortingState) => SortingState)) => {
            const next = typeof updater === 'function' ? updater(sorting) : updater;
            const first = next[0];
            setSort(first && isSortableColumnId(first.id) ? { id: first.id, desc: first.desc } : null);
        },
        [sorting, setSort],
    );

    const table = useReactTable({
        data: filteredRows,
        columns,
        state: { sorting, pagination },
        onSortingChange: handleSortingChange,
        onPaginationChange: setPagination,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
    });

    const visibleRows = table.getRowModel().rows;

    // Exports everything that matches the current search/filters, in the current sort order, across all pages.
    const handleExportCsv = () => {
        const rows = table.getPrePaginationRowModel().rows.map(row => row.original);
        downloadTextFile(registryRowsToCsv(rows), registryCsvFilename(data.generatedAt));
    };

    return (
        <>
            <div className="flex flex-col gap-4">
                <RegistryToolbar
                    state={urlState}
                    options={options}
                    isFiltered={filteredRows.length !== data.rows.length}
                    matchedCount={filteredRows.length}
                    onExportCsv={handleExportCsv}
                />

                <div className="bg-white rounded-[24px] border border-border-medium shadow-[0_8px_40px_rgba(0,0,0,0.03)] overflow-hidden">
                    <div className="hidden overflow-x-auto md:block">
                        <table className="w-full min-w-[1040px] text-left border-collapse">
                            <thead>
                                {table.getHeaderGroups().map(headerGroup => (
                                    <tr
                                        key={headerGroup.id}
                                        className="border-b border-border-extra-light bg-gray-50/80"
                                    >
                                        {headerGroup.headers.map((header, index) => {
                                            const canSort = header.column.getCanSort();
                                            const sortDirection = header.column.getIsSorted();
                                            const isLast = index === headerGroup.headers.length - 1;

                                            return (
                                                <th
                                                    key={header.id}
                                                    className={cn(
                                                        'py-3 text-[14px] font-medium text-text-high bg-gray-50/80 border-b border-border-light align-bottom',
                                                        index === 0 && 'pl-6 pr-4',
                                                        index !== 0 && !isLast && 'px-5',
                                                        isLast && 'pl-5 pr-8',
                                                    )}
                                                >
                                                    <button
                                                        type="button"
                                                        className={cn(
                                                            'inline-flex text-nowrap items-center gap-1',
                                                            canSort &&
                                                                'cursor-pointer hover:text-text-extra-high select-none',
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
                                                </th>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </thead>
                            <tbody className="divide-y divide-border-extra-light">
                                {visibleRows.length === 0 ? (
                                    <tr>
                                        <td colSpan={columns.length}>
                                            <RegistryEmptyState onClear={clearAll} />
                                        </td>
                                    </tr>
                                ) : (
                                    visibleRows.map(row => (
                                        <tr key={row.id} className="group/row hover:bg-gray-50/50 transition-colors">
                                            {row.getVisibleCells().map((cell, index) => {
                                                const isLast = index === row.getVisibleCells().length - 1;
                                                return (
                                                    <td
                                                        key={cell.id}
                                                        className={cn(
                                                            'py-3.5',
                                                            index === 0 && 'pl-6 pr-4',
                                                            index !== 0 && !isLast && 'px-5',
                                                            isLast && 'pl-5 pr-8',
                                                        )}
                                                    >
                                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                    <RegistryMobileList
                        rows={visibleRows}
                        table={table}
                        onClearFilters={clearAll}
                        onOpenResponse={row => setOpenMint(row.mintAddress)}
                    />
                    <MarketsPagination
                        state={{
                            pageIndex: pagination.pageIndex,
                            pageSize: pagination.pageSize,
                            total: filteredRows.length,
                            visibleCount: visibleRows.length,
                            itemLabel: 'assets',
                            isLoading: false,
                            onPageChange: pageIndex => setPagination(current => ({ ...current, pageIndex })),
                            onPageSizeChange: pageSize => setPagination({ pageIndex: 0, pageSize }),
                        }}
                    />
                </div>
                <RegistryResponseSheet
                    mint={openMint}
                    row={openRow}
                    onOpenChange={open => {
                        if (!open) setOpenMint(null);
                    }}
                />
            </div>
        </>
    );
}
