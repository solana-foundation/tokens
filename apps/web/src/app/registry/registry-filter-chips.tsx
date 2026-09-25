'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';

import { cn } from '@tokens/ui/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@tokens/ui/popover';
import { RegistryFilterEditor, type CategoryOptions } from './registry-filter-editor';
import { isTypingContext } from './registry-shortcuts';
import { SORT_COLUMN_LABELS, formatFilterValue, getFilterField, opSymbol, type RegistryFilter } from './lib/filters';
import type { RegistryUrlState } from './use-registry-url-state';

const CHIP_CLASS =
    'group inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border-medium bg-white pl-3 pr-1.5 text-[13px] text-text-extra-high shadow-none transition-colors hover:bg-gray-50/60';
const POPOVER_CLASS = 'w-auto rounded-2xl border-border-medium bg-white p-2 shadow-[0_8px_40px_rgba(0,0,0,0.08)]';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <kbd
            className={cn(
                'inline-flex h-4 min-w-4 items-center justify-center rounded border border-border-medium bg-gray-50 px-1 font-sans text-[10px] font-medium text-text-low',
                className,
            )}
        >
            {children}
        </kbd>
    );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            aria-label={label}
            className="ml-0.5 inline-flex size-5 items-center justify-center rounded-full text-text-low transition-colors hover:bg-gray-1400 hover:text-white"
            onClick={event => {
                event.stopPropagation();
                onClick();
            }}
        >
            <X className="h-3 w-3" />
        </button>
    );
}

/** A read-only chip: label · value · ×. */
export function ChipShell({ label, value, onRemove }: { label: string; value: string; onRemove: () => void }) {
    return (
        <span className={CHIP_CLASS}>
            <span className="text-text-low">{label}</span>
            <span className="h-4 w-px bg-border-medium" />
            <span className="tabular-nums">{value}</span>
            <RemoveButton label={`Remove ${label} filter`} onClick={onRemove} />
        </span>
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
            {/* The chip wrapper is non-interactive; the edit trigger and remove control are sibling buttons. */}
            <span className={cn(CHIP_CLASS, 'cursor-pointer')}>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        className="flex min-w-0 items-center gap-1.5"
                        aria-label={`Edit ${label} filter`}
                    >
                        <span className="text-text-low">{label}</span>
                        <span className="text-text-low tabular-nums">{opSymbol(filter.op)}</span>
                        <span className="tabular-nums">{formatFilterValue(filter)}</span>
                    </button>
                </PopoverTrigger>
                <RemoveButton label={`Remove ${label} filter`} onClick={() => onRemove(index)} />
            </span>
            <PopoverContent align="start" sideOffset={-36} alignOffset={-4} className={POPOVER_CLASS}>
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
                <button
                    type="button"
                    aria-label="Add filter"
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border-medium bg-white pl-3 pr-2 text-[13px] text-text-low transition-colors hover:border-gray-1400/40 hover:text-text-extra-high"
                >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Add filter</span>
                    <Kbd className="ml-0.5">F</Kbd>
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={-36} alignOffset={-4} className={POPOVER_CLASS}>
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

    state.filters.forEach((filter, index) => {
        chips.push(
            <FilterChip
                key={`${filter.field}-${filter.op}-${String(filter.value)}-${index}`}
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
