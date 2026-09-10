'use client';

import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@tokens/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@tokens/ui/popover';

interface SearchableSelectGroup<T> {
    id: string;
    label: string;
    options: T[];
}

interface SearchableSelectProps<T> {
    id?: string;
    'aria-labelledby'?: string;
    groups: SearchableSelectGroup<T>[];
    value: string;
    onValueChange: (value: string) => void;
    /** Case-sensitive identity (assetId or base58 mint); never derived from cmdk's lowercased value. */
    getOptionValue: (option: T) => string;
    /** Search haystack; must be unique per option, so include the id. */
    getOptionSearchText: (option: T) => string;
    renderOption: (option: T) => React.ReactNode;
    /** Selected row shown in the trigger; null renders the placeholder. */
    selectedContent: React.ReactNode | null;
    placeholder: string;
    searchPlaceholder: string;
    emptyMessage: string;
}

/**
 * Inline combobox replacing Radix Select for the playground's hundreds-long
 * option lists: same 52px trigger, but the dropdown filters as you type.
 */
export function SearchableSelect<T>({
    id,
    'aria-labelledby': ariaLabelledby,
    groups,
    value,
    onValueChange,
    getOptionValue,
    getOptionSearchText,
    renderOption,
    selectedContent,
    placeholder,
    searchPlaceholder,
    emptyMessage,
}: SearchableSelectProps<T>) {
    const [open, setOpen] = React.useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
                id={id}
                aria-labelledby={ariaLabelledby}
                role="combobox"
                aria-expanded={open}
                className="flex h-[52px] w-full items-center justify-between gap-2 rounded-md border border-border-medium bg-white px-3 py-2 text-left text-sm text-text-extra-high focus:ring-1 focus:ring-border-medium focus:outline-none"
            >
                <span className="flex min-w-0 flex-1 text-left">
                    {selectedContent ?? <span className="text-muted-foreground">{placeholder}</span>}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-[var(--radix-popover-trigger-width)] rounded-xl border-border-light bg-white p-0"
            >
                {/* Substring match instead of cmdk's fuzzy scorer: with 44-char
                    base58 mints in the haystack, fuzzy subsequences match almost
                    everything ("aapl" hits Arsenal FC before Apple). */}
                <Command
                    className="bg-white"
                    filter={(value, search) => (value.toLowerCase().includes(search.toLowerCase().trim()) ? 1 : 0)}
                >
                    <CommandInput placeholder={searchPlaceholder} />
                    <CommandList className="max-h-[min(360px,var(--radix-popover-content-available-height))] p-0">
                        <CommandEmpty>{emptyMessage}</CommandEmpty>
                        {groups.map(group => (
                            <CommandGroup
                                key={group.id}
                                heading={group.label}
                                className="p-0 [&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:border-b [&_[cmdk-group-heading]]:border-border-extra-light [&_[cmdk-group-heading]]:bg-white [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-text-medium"
                            >
                                {group.options.map(option => {
                                    const optionValue = getOptionValue(option);
                                    return (
                                        <CommandItem
                                            key={optionValue}
                                            value={getOptionSearchText(option)}
                                            onSelect={() => {
                                                onValueChange(optionValue);
                                                setOpen(false);
                                            }}
                                            className="gap-2 px-2 py-2"
                                        >
                                            <span className="flex min-w-0 flex-1">{renderOption(option)}</span>
                                            <Check
                                                className={`h-4 w-4 shrink-0 ${optionValue === value ? 'opacity-100' : 'opacity-0'}`}
                                            />
                                        </CommandItem>
                                    );
                                })}
                            </CommandGroup>
                        ))}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
