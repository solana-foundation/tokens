'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';

import { Badge } from '@tokens/ui/badge';
import { Button } from '@tokens/ui/button';
import { cn } from '@tokens/ui/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@tokens/ui/popover';
import { RegistryFilterEditor, type CategoryOptions } from './registry-filter-editor';
import { isTypingContext } from './registry-shortcuts';
import { SORT_COLUMN_LABELS, formatFilter, getFilterField, type RegistryFilter } from './lib/filters';
import type { RegistryUrlState } from './use-registry-url-state';

// Chip + popover styling ported 1:1 from the svela screener (screener-filter-chips.tsx).
const CHIP_CLASS =
    'group h-6 gap-1 rounded-md pr-1 py-0 bg-primary/5 text-primary/50 hover:text-primary border-border border-dashed flex-shrink-0';
const POPOVER_CLASS = 'w-auto rounded-xl bg-white p-3';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <kbd
            className={cn(
                'inline-flex size-5 items-center justify-center gap-1 rounded-sm border border-border bg-primary/5 p-0 font-sans text-[10px] font-bold text-primary/50',
                className,
            )}
        >
            {children}
        </kbd>
    );
}

/** A read-only chip: label · value · ×. */
export function ChipShell({ label, value, onRemove }: { label: string; value: string; onRemove: () => void }) {
    return (
        <Badge variant="secondary" className={cn(CHIP_CLASS, 'cursor-crosshair')}>
            <span className="text-xs font-medium opacity-50">{label}</span>
            <div className="mx-1 h-[24px] w-[1px] bg-border" />
            <span className="text-xs tabular-nums">{value}</span>
            <Button
                variant="ghost"
                size="sm"
                className="ml-1 h-4 w-4 rounded-md p-0 group-hover:bg-blue-500 group-hover:text-white"
                aria-label={`Remove ${label} filter`}
                onClick={event => {
                    event.stopPropagation();
                    onRemove();
                }}
            >
                <X className="h-3 w-3" />
            </Button>
        </Badge>
    );
}

function FilterChip({
    filter,
    index,
    options,
    onUpdate,
    onRemove,
}: {
    filter: RegistryFilter;
    index: number;
    options: CategoryOptions;
    onUpdate: (index: number, filter: RegistryFilter) => void;
    onRemove: (index: number) => void;
}) {
    const [open, setOpen] = useState(false);
    const label = getFilterField(filter.field)?.label ?? filter.field;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            {/* The Badge wrapper is non-interactive; the edit trigger and remove control are sibling <button>s. */}
            <Badge variant="secondary" className={cn(CHIP_CLASS, 'cursor-pointer')}>
                <PopoverTrigger asChild>
                    <button type="button" className="flex min-w-0 items-center" aria-label={`Edit ${label} filter`}>
                        <span className="text-xs tabular-nums">{formatFilter(filter)}</span>
                    </button>
                </PopoverTrigger>
                <button
                    type="button"
                    aria-label="Remove filter"
                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-md p-0 group-hover:bg-blue-500 group-hover:text-white"
                    onClick={event => {
                        event.stopPropagation();
                        onRemove(index);
                    }}
                >
                    <X className="h-3 w-3" />
                </button>
            </Badge>
            <PopoverContent
                align="start"
                // Cover the chip instead of dropping below it (see AddFilterChip).
                sideOffset={-26}
                alignOffset={-4}
                className={POPOVER_CLASS}
            >
                {/* Remount the editor per open so stale stage/value state never leaks between edits. */}
                {open ? (
                    <RegistryFilterEditor
                        filter={filter}
                        options={options}
                        onApply={next => {
                            onUpdate(index, next);
                            setOpen(false);
                        }}
                        onRemove={() => {
                            onRemove(index);
                            setOpen(false);
                        }}
                    />
                ) : null}
            </PopoverContent>
        </Popover>
    );
}

/** The dashed "Add filter" chip. */
function AddFilterChip({ options, onAdd }: { options: CategoryOptions; onAdd: (filter: RegistryFilter) => void }) {
    const [open, setOpen] = useState(false);

    // Single-letter shortcut: F opens the add-filter palette. Guarded so it never fires while typing.
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key.toLowerCase() !== 'f' || open || isTypingContext(event)) return;
            event.preventDefault();
            setOpen(true);
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open]);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 rounded-md border border-dashed border-border px-2 pr-1 text-xs text-primary/50 hover:text-primary hover:ring-2 hover:ring-primary/10"
                    aria-label="Add filter"
                >
                    <Plus className="h-3 w-3" />
                    <span>Add filter</span>
                    <Kbd className="ml-0.5 h-4 px-1 text-[10px]">F</Kbd>
                </Button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                sideOffset={-40}
                alignOffset={-0}
                className="w-auto rounded-xl bg-white px-1.5 py-1.5"
            >
                {open ? (
                    <RegistryFilterEditor
                        filter={null}
                        options={options}
                        onApply={next => {
                            onAdd(next);
                            setOpen(false);
                        }}
                    />
                ) : null}
            </PopoverContent>
        </Popover>
    );
}

/**
 * One editable chip per active filter, plus Search and Sort chips and the
 * dashed "Add filter" launcher. All state is URL-backed via `state`.
 */
export function RegistryFilterChips({ state, options }: { state: RegistryUrlState; options: CategoryOptions }) {
    const chips: ReactNode[] = [];

    if (state.q.trim()) {
        chips.push(<ChipShell key="q" label="Search" value={state.q.trim()} onRemove={() => state.setQ('')} />);
    }

    // Filters have no id: key on their content, disambiguating exact duplicates by occurrence so keys stay
    // stable when other chips are added/removed/reordered.
    const seen = new Map<string, number>();
    state.filters.forEach((filter, index) => {
        const base = `${filter.field}-${filter.op}-${String(filter.value)}`;
        const occurrence = seen.get(base) ?? 0;
        seen.set(base, occurrence + 1);
        chips.push(
            <FilterChip
                key={occurrence === 0 ? base : `${base}#${occurrence}`}
                filter={filter}
                index={index}
                options={options}
                onUpdate={state.updateFilter}
                onRemove={state.removeFilter}
            />,
        );
    });

    if (state.sort) {
        chips.push(
            <ChipShell
                key="sort"
                label="Sort"
                value={`${SORT_COLUMN_LABELS[state.sort.id]} ${state.sort.desc ? '↓' : '↑'}`}
                onRemove={() => state.setSort(null)}
            />,
        );
    }

    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
            {chips}
            <AddFilterChip options={options} onAdd={state.addFilter} />
        </div>
    );
}
