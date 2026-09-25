'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@tokens/ui/button';
import { cn } from '@tokens/ui/cn';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@tokens/ui/command';
import { Input } from '@tokens/ui/input';
import {
    CATEGORY_OPS,
    FILTER_FIELDS,
    HAS_TOKEN_PAGE_OPTIONS,
    USD_OPS,
    USD_OP_QUICK_KEYS,
    buildFilter,
    getFilterField,
    opSymbol,
    type CategoryFieldId,
    type FilterFieldId,
    type FilterOp,
    type RegistryFilter,
} from './lib/filters';

export type CategoryOptions = Readonly<Record<CategoryFieldId, readonly string[]>>;

type Stage = 'field' | 'op' | 'value';

// Styling ported 1:1 from the svela screener (screener-filter-editor.tsx).
/** Visible hover/selection against the white popover surface. No transitions — selection needs to snap. */
const ITEM_CLASS =
    'cursor-pointer rounded-lg text-xs hover:bg-gray-100 hover:text-gray-900 aria-selected:bg-gray-100 aria-selected:text-gray-900';
/** Our shared CommandInput adds a search icon + bordered wrapper; the screener palette is a bare input. */
const COMMAND_CLASS =
    'rounded-lg bg-transparent [&_[cmdk-input-wrapper]]:border-0 [&_[cmdk-input-wrapper]]:px-0 [&_[cmdk-input-wrapper]]:py-0 [&_[cmdk-input-wrapper]_svg]:hidden';
const COMMAND_INPUT_CLASS = 'h-8 pl-2 text-xs';
const COMMAND_LIST_CLASS = 'screener-filter-scroll max-h-56 scrollbar-hide p-0';
const COMMAND_EMPTY_CLASS = 'py-4 text-xs text-muted-foreground';
const INPUT_CLASS = 'h-8 rounded-lg text-xs';
const CRUMB_CLASS = 'rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary/80 hover:bg-primary/15';
const REMOVE_BUTTON_CLASS = 'h-7 px-2 text-xs text-rose-400 hover:text-rose-300';

const FIELD_GROUPS = [
    { label: 'Classification', fields: FILTER_FIELDS.filter(field => field.kind === 'category') },
    { label: 'Values', fields: FILTER_FIELDS.filter(field => field.kind === 'usd') },
] as const;

/**
 * Staged, keyboard-first popover body for editing ONE filter (or creating one
 * when `filter` is null). Flow: search a field → Enter → pick a condition
 * (type ">" "<" "=" or search "greater") → type/pick a value → Enter applies.
 * Backspace on an empty input steps back a stage; the breadcrumb chips jump
 * back on click. Values go through the same `buildFilter` the URL codec uses.
 */
export function RegistryFilterEditor({
    filter,
    options,
    onApply,
    onRemove,
}: {
    filter: RegistryFilter | null;
    options: CategoryOptions;
    onApply: (filter: RegistryFilter) => void;
    onRemove?: () => void;
}) {
    const [stage, setStage] = useState<Stage>(filter ? 'value' : 'field');
    const [fieldId, setFieldId] = useState<FilterFieldId | null>(filter?.field ?? null);
    const [op, setOp] = useState<FilterOp>(filter?.op ?? 'gt');
    const [search, setSearch] = useState('');
    const [rawValue, setRawValue] = useState(filter ? String(filter.value) : '');
    const [error, setError] = useState<string | null>(null);
    const valueInputRef = useRef<HTMLInputElement>(null);

    const field = fieldId ? getFilterField(fieldId) : null;

    useEffect(() => {
        if (stage === 'value' && field?.kind === 'usd') valueInputRef.current?.focus();
    }, [stage, field]);

    const goTo = (next: Stage) => {
        setSearch('');
        setError(null);
        setStage(next);
    };

    const pickField = (id: FilterFieldId) => {
        const picked = getFilterField(id);
        setFieldId(id);
        if (picked?.kind === 'category') {
            setOp('is');
            goTo('value');
        } else {
            setOp('gt');
            goTo('op');
        }
    };

    const apply = (value: string | number) => {
        if (!fieldId) return;
        const built = buildFilter({ field: fieldId, op, value });
        if ('error' in built) {
            setError(built.error);
            return;
        }
        setError(null);
        onApply(built.filter);
    };

    const categoryOptions =
        field?.kind === 'category'
            ? field.id === 'hasTokenPage'
                ? HAS_TOKEN_PAGE_OPTIONS
                : (options[field.id] ?? [])
            : [];

    return (
        <div className="flex w-[200px] flex-col gap-2">
            {field ? (
                <div className="flex flex-wrap items-center gap-1">
                    <button type="button" onClick={() => goTo('field')} className={CRUMB_CLASS}>
                        {field.label}
                    </button>
                    {stage === 'value' ? (
                        <button
                            type="button"
                            onClick={() => (field.kind === 'usd' ? goTo('op') : undefined)}
                            className={cn(CRUMB_CLASS, 'tabular-nums')}
                        >
                            {opSymbol(op)}
                        </button>
                    ) : null}
                </div>
            ) : null}

            {stage === 'field' ? (
                <Command className={COMMAND_CLASS} loop>
                    <CommandInput
                        autoFocus
                        value={search}
                        onValueChange={setSearch}
                        placeholder="Type a filter…"
                        className={COMMAND_INPUT_CLASS}
                    />
                    <CommandList className={COMMAND_LIST_CLASS}>
                        <CommandEmpty className={COMMAND_EMPTY_CLASS}>No matching filter.</CommandEmpty>
                        {FIELD_GROUPS.map(group => (
                            <CommandGroup key={group.label} heading={group.label}>
                                {group.fields.map(candidate => (
                                    <CommandItem
                                        key={candidate.id}
                                        value={`${candidate.label} ${candidate.synonyms.join(' ')}`}
                                        onSelect={() => pickField(candidate.id)}
                                        className={ITEM_CLASS}
                                    >
                                        {candidate.label}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        ))}
                    </CommandList>
                </Command>
            ) : null}

            {stage === 'op' && field?.kind === 'usd' ? (
                <Command className={COMMAND_CLASS} loop>
                    <CommandInput
                        autoFocus
                        value={search}
                        onValueChange={setSearch}
                        placeholder="Condition… (try > < =)"
                        className={COMMAND_INPUT_CLASS}
                        onKeyDown={event => {
                            if (event.key === 'Backspace' && search === '') {
                                event.preventDefault();
                                goTo('field');
                                return;
                            }
                            const quick = USD_OP_QUICK_KEYS[event.key];
                            if (quick && search === '') {
                                event.preventDefault();
                                setOp(quick);
                                goTo('value');
                            }
                        }}
                    />
                    <CommandList className={COMMAND_LIST_CLASS}>
                        <CommandEmpty className={COMMAND_EMPTY_CLASS}>No matching condition.</CommandEmpty>
                        <CommandGroup heading="Condition">
                            {USD_OPS.map(candidate => (
                                <CommandItem
                                    key={candidate.value}
                                    value={`${candidate.label} ${candidate.keywords.join(' ')}`}
                                    onSelect={() => {
                                        setOp(candidate.value);
                                        goTo('value');
                                    }}
                                    className={ITEM_CLASS}
                                >
                                    <span className="w-5 tabular-nums text-muted-foreground">{candidate.symbol}</span>
                                    {candidate.label}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            ) : null}

            {stage === 'value' && field?.kind === 'category' ? (
                <Command className={COMMAND_CLASS} loop>
                    <CommandInput
                        autoFocus
                        value={search}
                        onValueChange={setSearch}
                        placeholder={`${field.label}…`}
                        className={COMMAND_INPUT_CLASS}
                        onKeyDown={event => {
                            if (event.key === 'Backspace' && search === '') {
                                event.preventDefault();
                                goTo('field');
                            }
                        }}
                    />
                    <CommandList className={COMMAND_LIST_CLASS}>
                        <CommandEmpty className={COMMAND_EMPTY_CLASS}>No matching value.</CommandEmpty>
                        <CommandGroup
                            heading={
                                <span className="flex items-center gap-2">
                                    {CATEGORY_OPS.map(candidate => (
                                        <button
                                            key={candidate.value}
                                            type="button"
                                            onClick={() => setOp(candidate.value)}
                                            className={
                                                op === candidate.value
                                                    ? 'rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary/80'
                                                    : 'rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-primary/80'
                                            }
                                        >
                                            {candidate.label}
                                        </button>
                                    ))}
                                </span>
                            }
                        >
                            {categoryOptions.map(option => (
                                <CommandItem
                                    key={option}
                                    value={option}
                                    onSelect={() => apply(option)}
                                    className={ITEM_CLASS}
                                >
                                    {option}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                    {error ? <p className="px-1 text-xs text-rose-400">{error}</p> : null}
                    {onRemove ? (
                        <div className="flex justify-end px-1 pt-1">
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className={REMOVE_BUTTON_CLASS}
                                onClick={onRemove}
                            >
                                Remove
                            </Button>
                        </div>
                    ) : null}
                </Command>
            ) : null}

            {stage === 'value' && field?.kind === 'usd' ? (
                <>
                    <Input
                        ref={valueInputRef}
                        autoFocus
                        value={rawValue}
                        onChange={event => setRawValue(event.target.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                apply(rawValue);
                                return;
                            }
                            if (event.key === 'Backspace' && rawValue === '') {
                                event.preventDefault();
                                goTo('op');
                            }
                        }}
                        placeholder="e.g. 5m or $1.5b"
                        className={INPUT_CLASS}
                        aria-label="Value"
                    />
                    {error ? <p className="text-xs text-rose-400">{error}</p> : null}
                    <div className="flex items-center justify-between gap-2 pt-1">
                        {onRemove ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className={REMOVE_BUTTON_CLASS}
                                onClick={onRemove}
                            >
                                Remove
                            </Button>
                        ) : (
                            <span className="text-[10px] text-muted-foreground">
                                Enter to apply · Backspace to go back
                            </span>
                        )}
                        <Button type="button" size="sm" className="h-7 px-3 text-xs" onClick={() => apply(rawValue)}>
                            Apply
                        </Button>
                    </div>
                </>
            ) : null}
        </div>
    );
}
