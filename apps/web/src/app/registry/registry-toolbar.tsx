'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@tokens/ui/button';
import { Input } from '@tokens/ui/input';
import { Kbd, RegistryFilterChips } from './registry-filter-chips';
import type { CategoryOptions } from './registry-filter-editor';
import { hasOpenOverlay, isTypingContext } from './registry-shortcuts';
import type { RegistryUrlState } from './use-registry-url-state';

/**
 * Matched-row count pinned to the button's top-right corner. Scales in from 0 when filters start
 * excluding rows and scales back to 0 before unmounting when they stop; `count === null` means hidden.
 */
function ExportCountBadge({ count }: { count: number | null }) {
    // Keep the last shown number on screen while the exit animation plays.
    const [shown, setShown] = useState<number | null>(count);
    if (count !== null && count !== shown) setShown(count);

    const closing = count === null && shown !== null;

    if (shown === null) return null;

    return (
        <span
            aria-hidden="true"
            data-state={closing ? 'closed' : 'open'}
            onAnimationEnd={event => {
                if (closing && event.animationName === 'registry-badge-out') setShown(null);
            }}
            className="registry-export-badge absolute -right-1.5 -top-2 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-semibold leading-none text-white tabular-nums shadow-[0_0_0_2px_var(--color-background)]"
        >
            {shown.toLocaleString()}
        </span>
    );
}

function SearchIcon({ className }: { className?: string }) {
    return (
        <svg
            aria-hidden="true"
            className={className}
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M8 15.22C8 11.23 11.23 8 15.22 8C19.21 8 22.44 11.23 22.44 15.22C22.44 19.21 19.21 22.44 15.22 22.44C11.23 22.44 8 19.21 8 15.22ZM15.22 5.33C9.76 5.33 5.33 9.76 5.33 15.22C5.33 20.68 9.76 25.11 15.22 25.11C17.47 25.11 19.55 24.36 21.21 23.09L24.39 26.28C24.91 26.8 25.76 26.8 26.28 26.28C26.8 25.76 26.8 24.91 26.28 24.39L23.09 21.21C24.36 19.55 25.11 17.47 25.11 15.22C25.11 9.76 20.68 5.33 15.22 5.33Z"
                fill="currentColor"
            />
        </svg>
    );
}

function ExportIcon({ className }: { className?: string }) {
    return (
        <svg
            aria-hidden="true"
            className={className}
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path
                className="registry-export-arrow"
                d="M12 5L12 13M8.5 9.5L12 13L15.5 9.5"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M5 14.5L5 16.75C5 17.99 6.01 19 7.25 19L16.75 19C17.99 19 19 17.99 19 16.75L19 14.5"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
            />
        </svg>
    );
}

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
    const searchRef = useRef<HTMLInputElement>(null);

    // "/" focuses the table search. Guarded so it never fires while typing or inside a popover.
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== '/' || isTypingContext(event)) return;
            event.preventDefault();
            searchRef.current?.focus();
            searchRef.current?.select();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, []);

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
            {/* One wrapping row: on phones the search takes the first line and the filter chips share the
                second with Export (pushed right); on wide screens everything sits on one line. */}
            <div className="flex flex-wrap items-center gap-3">
                <div className="relative w-full sm:w-[300px]">
                    <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-medium" />
                    <Input
                        ref={searchRef}
                        type="search"
                        value={state.q}
                        onChange={event => state.setQ(event.target.value)}
                        placeholder="Search by name, symbol, mint, or category"
                        aria-label="Search registry"
                        aria-keyshortcuts="/"
                        className="h-9 w-full rounded-full border-border-medium bg-white pl-9 pr-10 font-sans text-[13px] text-text-extra-high shadow-none placeholder:text-text-low focus-visible:ring-border-medium"
                    />
                    {/* Same key-cap treatment as the nav search hint; hidden once there is a query. */}
                    {state.q ? null : (
                        <kbd
                            aria-hidden="true"
                            className="pointer-events-none absolute right-2.5 top-1/2 hidden size-5 -translate-y-1/2 items-center justify-center rounded-sm bg-gray-100 font-sans text-[11px] font-medium leading-none text-text-medium sm:flex"
                        >
                            /
                        </kbd>
                    )}
                </div>
                <RegistryFilterChips state={state} options={options} />
                {hasActive ? (
                    <span className="ml-1 hidden text-[10px] uppercase text-muted-foreground sm:inline">
                        press <Kbd className="w-8 font-bold">esc</Kbd> to clear
                    </span>
                ) : null}
                <div className="ml-auto flex shrink-0">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="group/export relative h-9 overflow-visible rounded-full border-border-medium bg-white px-4 font-sans text-[13px] text-text-extra-high shadow-none hover:bg-gray-50/60 sm:w-auto"
                        onClick={onExportCsv}
                        disabled={matchedCount === 0}
                        aria-label={`Export ${matchedCount.toLocaleString()} assets as CSV`}
                    >
                        <ExportIcon className="size-4" />
                        Export CSV
                        <ExportCountBadge count={isFiltered ? matchedCount : null} />
                    </Button>
                </div>
            </div>
        </div>
    );
}
