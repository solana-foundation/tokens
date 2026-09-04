'use client';

import { memo, useMemo, useState } from 'react';
import {
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    useReactTable,
    type ColumnDef,
    type Row,
    type SortingState,
    type Table,
} from '@tanstack/react-table';
import { motion } from 'motion/react';
import { toast } from 'sonner';

import { Checkbox } from '@tokens/ui/checkbox';
import { CopyButton } from '@/components/app-ui/copy-button';

import {
    SELECT_CELL_VARIANTS,
    SELECT_CHECKBOX_VARIANTS,
    SELECT_CONTENT_VARIANTS,
    useSelectRevealTransition,
    type ListSelection,
} from './use-list-selection';
import { TokenIdentity, formatDate, shortMint, type V2ListToken } from './token-bits';

/**
 * Member table structured after the svela screener table (MIT,
 * stevesarmiento/svela-prod): TanStack columns with per-column align/
 * interactive meta, an external grid header with sort toggles, a scrollable
 * white card body, and a merged select+token first cell whose checkbox is
 * hover-revealed and locked open while anything is selected.
 */

export const MEMBER_GRID_TEMPLATE_COLUMNS = 'minmax(0, 2fr) minmax(0, 1.2fr) minmax(0, 0.8fr)';

declare module '@tanstack/react-table' {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    interface ColumnMeta<TData, TValue> {
        /** Horizontal alignment for header + cells (default "left"). */
        align?: 'left' | 'right';
        /** Cell hosts its own interactive control — row clicks/keys are swallowed. */
        interactive?: boolean;
    }
}

function createMemberColumns(): ColumnDef<V2ListToken>[] {
    return [
        {
            id: 'token',
            accessorFn: row => row.symbol ?? row.mint,
            meta: { align: 'left' },
            header: 'Token',
            cell: ({ row }) => (
                <TokenIdentity
                    mint={row.original.mint}
                    symbol={row.original.symbol}
                    name={row.original.name}
                    logoURI={row.original.logoURI}
                    verified={row.original.verified}
                    layout="inline"
                    symbolClassName="text-[13px]"
                    nameClassName="truncate text-[11px] text-muted-foreground"
                    indicatorClassName="size-2"
                />
            ),
        },
        {
            id: 'mint',
            accessorKey: 'mint',
            enableSorting: false,
            meta: { align: 'left', interactive: true },
            header: 'Mint',
            cell: ({ row }) => (
                <div className="flex items-center gap-1">
                    <span className="font-berkeley-mono text-xs text-muted-foreground">
                        {shortMint(row.original.mint)}
                    </span>
                    <CopyButton
                        textToCopy={row.original.mint}
                        showText={false}
                        ariaLabel={`Copy ${row.original.symbol ?? row.original.mint} mint address`}
                        className="h-7 w-7 rounded-sm hover:bg-gray-50/60 transition-colors duration-150"
                        iconClassName="h-3 w-3 text-muted-foreground"
                        iconClassNameCheck="h-3 w-3"
                        onCopied={() => toast.success('Mint address copied')}
                    />
                </div>
            ),
        },
        {
            id: 'added',
            accessorFn: row => row.addedAt ?? 0,
            meta: { align: 'left' },
            header: 'Added',
            cell: ({ row }) => (
                <span className="text-sm text-muted-foreground">{formatDate(row.original.addedAt)}</span>
            ),
        },
    ];
}

function MemberTableHeader({ table }: { table: Table<V2ListToken> }) {
    return (
        <div className="px-4 py-1">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                {table.getHeaderGroups().map(headerGroup => (
                    <div
                        key={headerGroup.id}
                        className="grid gap-4"
                        style={{ gridTemplateColumns: MEMBER_GRID_TEMPLATE_COLUMNS }}
                    >
                        {headerGroup.headers.map(header => {
                            const align = header.column.columnDef.meta?.align ?? 'left';
                            const canSort = header.column.getCanSort();
                            const onClick = canSort ? header.column.getToggleSortingHandler() : undefined;
                            const className = [
                                'flex w-full min-w-0 items-center gap-1',
                                align === 'left' ? 'justify-start' : 'justify-end',
                                canSort ? 'cursor-pointer select-none hover:text-foreground' : '',
                            ].join(' ');

                            const content = (
                                <>
                                    {flexRender(header.column.columnDef.header, header.getContext())}
                                    {{ asc: ' ↑', desc: ' ↓' }[header.column.getIsSorted() as string] ?? null}
                                </>
                            );

                            if (canSort && onClick) {
                                return (
                                    <button type="button" key={header.id} className={className} onClick={onClick}>
                                        {content}
                                    </button>
                                );
                            }
                            return (
                                <div key={header.id} className={className}>
                                    {content}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}

function MemberTableRowInner({
    row,
    selectable,
    isSelected,
    hasSelected,
    onSelect,
    onRowClick,
}: {
    row: Row<V2ListToken>;
    /** False for read-only tables (browsing someone else's list). */
    selectable: boolean;
    isSelected: boolean;
    hasSelected: boolean;
    onSelect: (mint: string, selected: boolean) => void;
    onRowClick: (token: V2ListToken) => void;
}) {
    const mint = row.original.mint;
    const selectRevealTransition = useSelectRevealTransition();

    const className = [
        'grid gap-4 px-4 py-2 border-b last:border-b-0 cursor-pointer transition-opacity duration-200',
        'hover:bg-gray-50/50 dark:hover:bg-zinc-900/30',
        hasSelected && !isSelected ? 'opacity-40' : '',
    ].join(' ');

    const cells = row.getVisibleCells().map((cell, cellIndex) => {
        const meta = cell.column.columnDef.meta;
        const align = meta?.align ?? 'left';
        const cellClassName = ['flex min-w-0 items-center', align === 'left' ? 'justify-start' : 'justify-end'].join(
            ' ',
        );

        // First cell — merged select + token: hover reveals the checkbox, but
        // only the checkbox itself toggles selection. Clicks anywhere else in
        // the cell fall through to the row (metadata sheet / selection toggle).
        if (cellIndex === 0 && selectable) {
            return (
                <div key={cell.id} className={cellClassName}>
                    <motion.div
                        className="relative flex h-full w-full min-w-0 items-center justify-start"
                        variants={SELECT_CELL_VARIANTS}
                        initial="rest"
                        animate={hasSelected ? 'revealed' : 'rest'}
                        whileHover={hasSelected ? undefined : 'revealed'}
                    >
                        {/* Checkbox - stable DOM to avoid "jump" on select/deselect */}
                        <motion.div
                            className="absolute left-0 z-10 px-1"
                            variants={SELECT_CHECKBOX_VARIANTS}
                            transition={selectRevealTransition}
                            onClick={event => {
                                // Checkbox toggles via onCheckedChange; keep the
                                // click from reaching the row (would double-toggle).
                                event.preventDefault();
                                event.stopPropagation();
                            }}
                        >
                            <Checkbox
                                data-member-row-checkbox="true"
                                checked={isSelected}
                                tabIndex={hasSelected ? 0 : -1}
                                onCheckedChange={checked => onSelect(mint, checked === true)}
                                aria-label={`Select ${row.original.symbol ?? mint}`}
                            />
                        </motion.div>

                        {/* Token content slides right to make room for the checkbox */}
                        <motion.div
                            className="flex min-w-0 items-center"
                            variants={SELECT_CONTENT_VARIANTS}
                            transition={selectRevealTransition}
                        >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </motion.div>
                    </motion.div>
                </div>
            );
        }

        // Interactive cells host their own controls: keep clicks/keys away
        // from the row action.
        if (meta?.interactive) {
            return (
                <div
                    key={cell.id}
                    className={cellClassName}
                    onClick={event => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                    onKeyDown={event => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
            );
        }

        return (
            <div key={cell.id} className={cellClassName}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </div>
        );
    });

    return (
        <div
            role="button"
            tabIndex={0}
            aria-selected={hasSelected ? isSelected : undefined}
            onClick={() => {
                // Selection mode: row clicks toggle instead of opening metadata.
                if (hasSelected) onSelect(mint, !isSelected);
                else onRowClick(row.original);
            }}
            onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                const target = event.target as HTMLElement;
                if (target.closest('[data-member-row-checkbox="true"]')) return;
                event.preventDefault();
                if (hasSelected) onSelect(mint, !isSelected);
                else onRowClick(row.original);
            }}
            className={className}
            style={{ gridTemplateColumns: MEMBER_GRID_TEMPLATE_COLUMNS }}
        >
            {cells}
        </div>
    );
}

// TanStack recreates Row wrappers whenever any table state changes, so a
// plain memo() on the `row` prop never bails out. The row's rendered output
// only depends on its underlying data object — compare that instead, plus the
// per-row selection booleans; the callbacks are identity-stable.
const MemberTableRow = memo(
    MemberTableRowInner,
    (prev, next) =>
        prev.row.id === next.row.id &&
        prev.row.original === next.row.original &&
        prev.selectable === next.selectable &&
        prev.isSelected === next.isSelected &&
        prev.hasSelected === next.hasSelected &&
        prev.onSelect === next.onSelect &&
        prev.onRowClick === next.onRowClick,
);

const NOOP_SELECT = () => {};

export function MemberTable({
    tokens,
    selection,
    onRowClick,
}: {
    tokens: V2ListToken[];
    /** Omit for read-only tables — rows lose the checkbox cell and never dim. */
    selection?: ListSelection;
    onRowClick: (token: V2ListToken) => void;
}) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const columns = useMemo(() => createMemberColumns(), []);

    const table = useReactTable({
        data: tokens,
        columns,
        getRowId: row => row.mint,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        onSortingChange: setSorting,
        state: { sorting },
    });

    const selectable = selection !== undefined;
    const selected = selection?.selected;
    const hasSelected = selection?.hasSelected ?? false;
    const handleSelect = selection?.handleSelect ?? NOOP_SELECT;

    return (
        <div className="rounded-[12px] bg-gray-100/60 p-0.5">
            <div className="mx-px">
                <MemberTableHeader table={table} />
            </div>
            <div className="relative bg-white dark:bg-zinc-950/30 border border-black/[0.15] rounded-lg shadow-sm max-h-[62dvh] overflow-y-auto">
                {table.getRowModel().rows.map(row => (
                    <MemberTableRow
                        key={row.id}
                        row={row}
                        selectable={selectable}
                        isSelected={selected?.has(row.original.mint) ?? false}
                        hasSelected={hasSelected}
                        onSelect={handleSelect}
                        onRowClick={onRowClick}
                    />
                ))}
            </div>
        </div>
    );
}
