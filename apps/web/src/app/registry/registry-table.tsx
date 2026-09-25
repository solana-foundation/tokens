'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
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
import { ArrowUpRight, ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

import { cn, truncateAddress } from '@tokens/ui/cn';
import { Button } from '@tokens/ui/button';
import { MarketsPagination } from '@/app/_components/markets/markets-pagination';
import { formatLargeNumber } from '@/lib/format';
import { cleanTokenName } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { downloadTextFile, registryCsvFilename, registryRowsToCsv } from './lib/csv';
import { SORTABLE_COLUMN_IDS, applyFilters, type SortableColumnId } from './lib/filters';
import type { RegistryData, RegistryRow } from './lib/types';
import type { CategoryOptions } from './registry-filter-editor';
import { RegistryToolbar } from './registry-toolbar';
import { useRegistryUrlState } from './use-registry-url-state';

const columnHelper = createColumnHelper<RegistryRow>();

const RIGHT_ALIGNED_COLUMNS = new Set(['rwaValueUsd', 'alliumValueUsd', 'marketCapUsd']);

// next/image only accepts https remote patterns; drop anything else rather than crash the row.
function renderableLogoSrc(src: string | undefined): string | undefined {
    const normalized = normalizeLogoSrc(src);
    if (!normalized) return undefined;
    return normalized.startsWith('/') || normalized.startsWith('https://') ? normalized : undefined;
}

// Logos already served by our image proxy are CDN-cached there; skip the optimizer's extra hop.
function isProxiedLogo(src: string): boolean {
    return src.startsWith('/api/image-proxy?');
}

function RegistryTokenLogo({ row }: { row: RegistryRow }) {
    const [hasError, setHasError] = useState(false);
    const symbol = row.symbol || row.name || '??';
    const initials = symbol.slice(0, 2).toUpperCase();
    const src = renderableLogoSrc(row.logoURI ?? undefined);

    if (!src || hasError) {
        return (
            <div className="size-[26px] rounded-full bg-gray-1400 flex items-center justify-center shrink-0">
                <span className="text-[10px] font-bold text-white">{initials}</span>
            </div>
        );
    }

    return (
        <Image
            src={src}
            alt={symbol}
            width={26}
            height={26}
            className="size-[26px] rounded-full bg-gray-50 object-cover shrink-0"
            loading="lazy"
            decoding="async"
            onError={() => setHasError(true)}
            referrerPolicy="no-referrer"
            unoptimized={isProxiedLogo(src)}
        />
    );
}

function TokenCell({ row }: { row: RegistryRow }) {
    const displayName = row.name ? cleanTokenName(row.name) : row.symbol;
    const content = (
        <>
            <RegistryTokenLogo row={row} />
            <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[16px] font-medium text-text-extra-high" title={displayName}>
                    {displayName}
                </span>
                {row.name ? (
                    <span className="shrink-0 text-[14px] text-text-extra-low font-medium">${row.symbol}</span>
                ) : null}
            </div>
        </>
    );

    if (!row.hasTokenPage) {
        return <div className="flex items-center gap-[8px]">{content}</div>;
    }
    return (
        <Link
            href={`/token/${row.mintAddress}`}
            prefetch={false}
            className="flex items-center gap-[8px] hover:opacity-80 transition-opacity"
        >
            {content}
        </Link>
    );
}

function EmptyValue({ align = 'left' }: { align?: 'left' | 'right' }) {
    return <span className={cn('block text-[14px] text-text-extra-low', align === 'right' && 'text-right')}>—</span>;
}

function TextCell({ value }: { value: string | null }) {
    return value ? <span className="text-[14px] text-text-high">{value}</span> : <EmptyValue />;
}

function UsdCell({ value }: { value: number | null }) {
    return value == null ? (
        <EmptyValue align="right" />
    ) : (
        <span className="block text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums">
            {formatLargeNumber(value)}
        </span>
    );
}

const columns = [
    columnHelper.accessor('symbol', {
        id: 'token',
        header: 'Token',
        cell: info => <TokenCell row={info.row.original} />,
    }),
    columnHelper.accessor('mintAddress', {
        header: 'Address',
        enableSorting: false,
        cell: info => {
            const address = info.getValue();
            return (
                <a
                    href={`https://explorer.solana.com/address/${address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[13px] text-text-medium transition-colors hover:text-text-extra-high"
                    title={address}
                >
                    {truncateAddress(address)}
                    <ArrowUpRight className="h-3 w-3 text-text-extra-low" />
                </a>
            );
        },
    }),
    columnHelper.accessor('solanaClass', {
        header: 'Asset Class',
        enableSorting: false,
        cell: info => <TextCell value={info.getValue()} />,
    }),
    columnHelper.accessor('rwaClass', {
        header: 'RWA.xyz Class',
        enableSorting: false,
        cell: info => <TextCell value={info.getValue()} />,
    }),
    columnHelper.accessor(row => row.rwaValueUsd ?? undefined, {
        id: 'rwaValueUsd',
        header: 'RWA Value',
        sortUndefined: 'last',
        cell: info => <UsdCell value={info.row.original.rwaValueUsd} />,
    }),
    columnHelper.accessor('alliumClass', {
        header: 'Allium Class',
        enableSorting: false,
        cell: info => <TextCell value={info.getValue()} />,
    }),
    columnHelper.accessor(row => row.alliumValueUsd ?? undefined, {
        id: 'alliumValueUsd',
        header: 'Allium Value',
        sortUndefined: 'last',
        cell: info => <UsdCell value={info.row.original.alliumValueUsd} />,
    }),
    columnHelper.accessor(row => row.marketCapUsd ?? undefined, {
        id: 'marketCapUsd',
        header: 'Market Cap',
        sortUndefined: 'last',
        cell: info => <UsdCell value={info.row.original.marketCapUsd} />,
    }),
];

function distinctSorted(values: Array<string | null>): string[] {
    return [...new Set(values.filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b));
}

function isSortableColumnId(id: string): id is SortableColumnId {
    return (SORTABLE_COLUMN_IDS as readonly string[]).includes(id);
}

export function RegistryTable({ data }: { data: RegistryData }) {
    const urlState = useRegistryUrlState();
    const { q, filters, sort, setSort, clearAll } = urlState;
    const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });

    const options = useMemo<CategoryOptions>(
        () => ({
            solanaClass: distinctSorted(data.rows.map(row => row.solanaClass)),
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
        <div className="flex flex-col gap-4">
            <RegistryToolbar
                state={urlState}
                options={options}
                isFiltered={filteredRows.length !== data.rows.length}
                matchedCount={filteredRows.length}
                onExportCsv={handleExportCsv}
            />

            <div className="bg-white rounded-[24px] border border-border-medium shadow-[0_8px_40px_rgba(0,0,0,0.03)] overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[1100px] text-left border-collapse">
                        <thead>
                            {table.getHeaderGroups().map(headerGroup => (
                                <tr key={headerGroup.id} className="border-b border-border-extra-light bg-gray-50/80">
                                    {headerGroup.headers.map((header, index) => {
                                        const canSort = header.column.getCanSort();
                                        const sortDirection = header.column.getIsSorted();
                                        const isLast = index === headerGroup.headers.length - 1;
                                        const alignRight = RIGHT_ALIGNED_COLUMNS.has(header.column.id);

                                        return (
                                            <th
                                                key={header.id}
                                                className={cn(
                                                    'py-3 text-[12px] md:text-[14px] font-medium text-text-high bg-gray-50/80 border-b border-border-light',
                                                    index === 0 && 'pl-4 pr-3 md:pl-6 md:pr-4',
                                                    index !== 0 && !isLast && 'px-3 md:px-5',
                                                    isLast && 'pl-3 md:pl-5 pr-4 md:pr-8',
                                                    alignRight && 'text-right',
                                                )}
                                            >
                                                <button
                                                    type="button"
                                                    className={cn(
                                                        'inline-flex text-nowrap items-center gap-1',
                                                        canSort &&
                                                            'cursor-pointer hover:text-text-extra-high select-none',
                                                        alignRight && 'justify-end w-full',
                                                    )}
                                                    onClick={header.column.getToggleSortingHandler()}
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
                                            </th>
                                        );
                                    })}
                                </tr>
                            ))}
                        </thead>
                        <tbody className="divide-y divide-border-extra-light">
                            {visibleRows.length === 0 ? (
                                <tr>
                                    <td colSpan={columns.length} className="px-6 py-12 text-center">
                                        <p className="text-text-low text-[14px] md:text-[16px]">
                                            No assets match your filters
                                        </p>
                                        <p className="text-text-extra-low text-[12px] md:text-[14px] mt-2">
                                            Try a different symbol, name, or mint address, or loosen a filter
                                        </p>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="mt-4 h-9 rounded-full border-border-medium bg-white px-4 font-sans text-[13px] text-text-extra-high shadow-none hover:bg-gray-50/60"
                                            onClick={clearAll}
                                        >
                                            Clear filters
                                        </Button>
                                    </td>
                                </tr>
                            ) : (
                                visibleRows.map(row => (
                                    <tr key={row.id} className="hover:bg-gray-50/50 transition-colors">
                                        {row.getVisibleCells().map((cell, index) => {
                                            const isLast = index === row.getVisibleCells().length - 1;
                                            return (
                                                <td
                                                    key={cell.id}
                                                    className={cn(
                                                        'py-3.5',
                                                        index === 0 && 'pl-4 pr-3 md:pl-6 md:pr-4',
                                                        index !== 0 && !isLast && 'px-3 md:px-5',
                                                        isLast && 'pl-3 md:pl-5 pr-4 md:pr-8',
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
        </div>
    );
}
