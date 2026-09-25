'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@tokens/ui/button';
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

const ITEM_CLASS =
    'cursor-pointer rounded-lg px-2 py-1.5 text-[13px] text-text-high hover:bg-gray-100 aria-selected:bg-gray-100 aria-selected:text-text-extra-high';
const INPUT_CLASS = 'h-8 rounded-lg border-border-medium bg-white px-2 font-sans text-[13px] shadow-none';
const CRUMB_CLASS =
    'rounded-md bg-gray-100 px-1.5 py-0.5 text-[12px] font-medium text-text-high hover:bg-gray-200 transition-colors';

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
        <div className="flex w-[240px] flex-col gap-2">
            {field ? (
                <div className="flex flex-wrap items-center gap-1">
                    <button type="button" onClick={() => goTo('field')} className={CRUMB_CLASS}>
                        {field.label}
                    </button>
                    {stage === 'value' ? (
                        <button
                            type="button"
                            onClick={() => (field.kind === 'usd' ? goTo('op') : undefined)}
                            className={`${CRUMB_CLASS} tabular-nums`}
                        >
                            {opSymbol(op)}
                        </button>
                    ) : null}
                </div>
            ) : null}

            {stage === 'field' ? (
                <Command className="rounded-lg bg-transparent" loop>
                    <CommandInput
                        autoFocus
                        value={search}
                        onValueChange={setSearch}
                        placeholder="Type a filter…"
                        className="h-8 text-[13px]"
                    />
                    <CommandList className="max-h-64 p-1">
                        <CommandEmpty className="py-4 text-center text-[13px] text-text-low">
                            No matching filter.
                        </CommandEmpty>
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
                <Command className="rounded-lg bg-transparent" loop>
                    <CommandInput
                        autoFocus
                        value={search}
                        onValueChange={setSearch}
                        placeholder="Condition… (try > < =)"
                        className="h-8 text-[13px]"
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
                    <CommandList className="max-h-64 p-1">
                        <CommandEmpty className="py-4 text-center text-[13px] text-text-low">
                            No matching condition.
                        </CommandEmpty>
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
                                    <span className="w-5 tabular-nums text-text-low">{candidate.symbol}</span>
                                    {candidate.label}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            ) : null}

            {stage === 'value' && field?.kind === 'category' ? (
                <Command className="rounded-lg bg-transparent" loop>
                    <CommandInput
                        autoFocus
                        value={search}
                        onValueChange={setSearch}
                        placeholder={`${field.label}…`}
                        className="h-8 text-[13px]"
                        onKeyDown={event => {
                            if (event.key === 'Backspace' && search === '') {
                                event.preventDefault();
                                goTo('field');
                            }
                        }}
                    />
                    <CommandList className="max-h-64 p-1">
                        <CommandEmpty className="py-4 text-center text-[13px] text-text-low">
                            No matching value.
                        </CommandEmpty>
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
                                                    ? 'rounded-md bg-gray-1400 px-1.5 py-0.5 text-[11px] text-white'
                                                    : 'rounded-md px-1.5 py-0.5 text-[11px] text-text-low hover:text-text-high'
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
                    {error ? <p className="px-1 text-[12px] text-rose-500">{error}</p> : null}
                    {onRemove ? (
                        <div className="flex justify-end px-1 pt-1">
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-[12px] text-rose-500 hover:text-rose-600"
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
                    {error ? <p className="text-[12px] text-rose-500">{error}</p> : null}
                    <div className="flex items-center justify-between gap-2 pt-1">
                        {onRemove ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-[12px] text-rose-500 hover:text-rose-600"
                                onClick={onRemove}
                            >
                                Remove
                            </Button>
                        ) : (
                            <span className="text-[11px] text-text-low">Enter to apply · Backspace to go back</span>
                        )}
                        <Button
                            type="button"
                            size="sm"
                            className="h-7 rounded-full px-3 text-[12px]"
                            onClick={() => apply(rawValue)}
                        >
                            Apply
                        </Button>
                    </div>
                </>
            ) : null}
        </div>
    );
}
