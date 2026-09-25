'use client';

import { useEffect } from 'react';
import { Download } from 'lucide-react';

import { Button } from '@tokens/ui/button';
import { Input } from '@tokens/ui/input';
import { Kbd, RegistryFilterChips } from './registry-filter-chips';
import type { CategoryOptions } from './registry-filter-editor';
import { hasOpenOverlay, isTypingContext } from './registry-shortcuts';
import type { RegistryUrlState } from './use-registry-url-state';

/**
 * Search box + editable filter chips + CSV export.
 * Esc clears everything unless a chip editor popover is open (Esc closes it).
 */
export function RegistryToolbar({
    state,
    options,
    isFiltered,
    matchedCount,
    onExportCsv,
}: {
    state: RegistryUrlState;
    options: CategoryOptions;
    /** True when search/filters exclude some rows; the export button then shows the matched count. */
    isFiltered: boolean;
    matchedCount: number;
    onExportCsv: () => void;
}) {
    const { hasActive, clearAll } = state;

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || !hasActive || hasOpenOverlay()) return;
            // Esc inside the search box should still clear (it is the most natural "reset").
            if (isTypingContext(event) && !(event.target instanceof HTMLInputElement)) return;
            event.preventDefault();
            (event.target as HTMLElement | null)?.blur?.();
            clearAll();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [hasActive, clearAll]);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                    <Input
                        type="search"
                        value={state.q}
                        onChange={event => state.setQ(event.target.value)}
                        placeholder="Search by name, symbol, or mint"
                        aria-label="Search registry"
                        className="h-9 rounded-full border-border-medium bg-white px-4 font-sans text-[13px] text-text-extra-high shadow-none placeholder:text-text-low focus-visible:ring-border-medium sm:w-[280px]"
                    />
                    <RegistryFilterChips state={state} options={options} />
                    {hasActive ? (
                        <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                            press <Kbd className="w-8 font-bold">esc</Kbd> to clear
                        </span>
                    ) : null}
                </div>
                <div className="flex shrink-0 lg:justify-end">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 rounded-full border-border-medium bg-white px-4 font-sans text-[13px] text-text-extra-high shadow-none hover:bg-gray-50/60 sm:w-auto"
                        onClick={onExportCsv}
                        disabled={matchedCount === 0}
                        aria-label={`Export ${matchedCount.toLocaleString()} assets as CSV`}
                    >
                        <Download className="h-4 w-4" />
                        Export CSV
                        {isFiltered ? (
                            <span className="text-text-low tabular-nums">({matchedCount.toLocaleString()})</span>
                        ) : null}
                    </Button>
                </div>
            </div>
        </div>
    );
}
