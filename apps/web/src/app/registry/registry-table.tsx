'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { parseAsString, useQueryState } from 'nuqs';

import { cn, truncateAddress } from '@tokens/ui/cn';
import { Input } from '@tokens/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';
import { MarketsPagination } from '@/app/_components/markets/markets-pagination';
import { formatLargeNumber } from '@/lib/format';
import { cleanTokenName } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import type { RegistryData, RegistryRow } from './lib/types';

const searchParser = parseAsString.withDefault('').withOptions({ history: 'replace', scroll: false });

const columnHelper = createColumnHelper<RegistryRow>();

const RIGHT_ALIGNED_COLUMNS = new Set(['rwaValueUsd', 'alliumValueUsd', 'marketCapUsd']);

const generatedAtFormatter = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
});

// next/image only accepts https remote patterns; drop anything else rather than crash the row.
function renderableLogoSrc(src: string | undefined): string | undefined {
    const normalized = normalizeLogoSrc(src);
    if (!normalized) return undefined;
    return normalized.startsWith('/') || normalized.startsWith('https://') ? normalized : undefined;
}

function RegistryTokenLogo({ row }: { row: RegistryRow }) {
    const [hasError, setHasError] = useState(false);
    const symbol = row.symbol || row.name || '??';
    const initials = symbol.slice(0, 2).toUpperCase();
    const src = renderableLogoSrc(row.logoURI ?? undefined);

    if (!src || hasError) {
        return (
            <div className="size-[26px] rounded-full bg-gray-1400 flex items-center justify-center flex-shrink-0">
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
            className="size-[26px] rounded-full bg-gray-50 object-cover flex-shrink-0"
            loading="lazy"
            decoding="async"
            onError={() => setHasError(true)}
            referrerPolicy="no-referrer"
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

interface ClassFilterProps {
    label: string;
    value: string;
    options: string[];
    onChange: (value: string) => void;
}

function ClassFilter({ label, value, options, onChange }: ClassFilterProps) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger
                aria-label={label}
                className="h-10 w-full rounded-full border-border-medium bg-white px-4 font-sans text-[13px] text-text-extra-high shadow-none focus:ring-border-medium sm:w-[190px]"
            >
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="all" className="font-sans text-[13px]">
                    All {label}
                </SelectItem>
                {options.map(option => (
                    <SelectItem key={option} value={option} className="font-sans text-[13px]">
                        {option}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

export function RegistryTable({ data }: { data: RegistryData }) {
    const [search, setSearch] = useQueryState('q', searchParser);
    const [solanaClassFilter, setSolanaClassFilter] = useState('all');
    const [rwaClassFilter, setRwaClassFilter] = useState('all');
    const [alliumClassFilter, setAlliumClassFilter] = useState('all');
    const [sorting, setSorting] = useState<SortingState>([{ id: 'marketCapUsd', desc: true }]);
    const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });

    const solanaClasses = useMemo(() => distinctSorted(data.rows.map(row => row.solanaClass)), [data.rows]);
    const rwaClasses = useMemo(() => distinctSorted(data.rows.map(row => row.rwaClass)), [data.rows]);
    const alliumClasses = useMemo(() => distinctSorted(data.rows.map(row => row.alliumClass)), [data.rows]);

    const filteredRows = useMemo(() => {
        const q = search.toLowerCase().trim();
        return data.rows.filter(row => {
            if (solanaClassFilter !== 'all' && row.solanaClass !== solanaClassFilter) return false;
            if (rwaClassFilter !== 'all' && row.rwaClass !== rwaClassFilter) return false;
            if (alliumClassFilter !== 'all' && row.alliumClass !== alliumClassFilter) return false;
            if (!q) return true;
            return (
                row.symbol.toLowerCase().includes(q) ||
                row.mintAddress.toLowerCase().includes(q) ||
                (row.name?.toLowerCase().includes(q) ?? false)
            );
        });
    }, [data.rows, search, solanaClassFilter, rwaClassFilter, alliumClassFilter]);

    useEffect(() => {
        setPagination(current => ({ ...current, pageIndex: 0 }));
    }, [search, solanaClassFilter, rwaClassFilter, alliumClassFilter]);

    const table = useReactTable({
        data: filteredRows,
        columns,
        state: { sorting, pagination },
        onSortingChange: setSorting,
        onPaginationChange: setPagination,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
    });

    const visibleRows = table.getRowModel().rows;
    const generatedAtLabel = Number.isNaN(Date.parse(data.generatedAt))
        ? null
        : `${generatedAtFormatter.format(new Date(data.generatedAt))} UTC`;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <Input
                        type="search"
                        value={search}
                        onChange={event => setSearch(event.target.value)}
                        placeholder="Search by name, symbol, or mint"
                        aria-label="Search registry"
                        className="h-10 rounded-full border-border-medium bg-white px-4 font-sans text-[13px] text-text-extra-high shadow-none placeholder:text-text-low focus-visible:ring-border-medium sm:w-[300px]"
                    />
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <ClassFilter
                            label="asset classes"
                            value={solanaClassFilter}
                            options={solanaClasses}
                            onChange={setSolanaClassFilter}
                        />
                        <ClassFilter
                            label="RWA.xyz classes"
                            value={rwaClassFilter}
                            options={rwaClasses}
                            onChange={setRwaClassFilter}
                        />
                        <ClassFilter
                            label="Allium classes"
                            value={alliumClassFilter}
                            options={alliumClasses}
                            onChange={setAlliumClassFilter}
                        />
                    </div>
                </div>
                <p className="text-[12px] text-text-low tabular-nums lg:text-right">
                    {generatedAtLabel ? `Updated ${generatedAtLabel} · ` : ''}
                    {data.rows.length.toLocaleString()} assets
                    {data.truncated ? ' · partial dataset' : ''}
                </p>
            </div>

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
                                                        canSort && 'cursor-pointer hover:text-text-extra-high select-none',
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
                                        <p className="text-text-low text-[14px] md:text-[16px]">No assets match your search</p>
                                        <p className="text-text-extra-low text-[12px] md:text-[14px] mt-2">
                                            Try a different symbol, name, or mint address
                                        </p>
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
