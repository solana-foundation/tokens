'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { domAnimation, LazyMotion, m, useReducedMotion } from 'motion/react';
import { trackEvent } from '@/lib/posthog-client';
import { TokenTable } from './token-table';
import { TRENDING_MODE_IDS, TRENDING_WINDOW_IDS } from './home-tokens-constants';
import { useHomeTokens } from './home-tokens-provider';
import { type TrendingMode } from '@/hooks/queries/use-token-search';
import type { HomeTabId } from '@/lib/home-highlights';
import type { TrendingWindow } from '@/lib/types';
import { Skeleton } from '@tokens/ui/skeleton';
import { cn } from '@tokens/ui/cn';
import { SegmentedControl } from '@solana/design-system/segmented-control';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@tokens/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@tokens/ui/tooltip';
import { Info, Settings2 } from 'lucide-react';

const TRENDING_WINDOW_LABELS: Record<TrendingWindow, string> = {
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '6h': '6h',
    '24h': '24h',
};
const TRENDING_MODE_LABELS: Record<TrendingMode, string> = {
    fresh: 'Fresh',
    flow: 'Flow',
};

function TrendingFlameIcon() {
    const shouldReduceMotion = useReducedMotion();
    const flamePath =
        'M15.5426 5.41676C15.4708 5.34319 15.3794 5.29308 15.2799 5.27279C15.1803 5.25249 15.0772 5.26291 14.9835 5.30273C14.8897 5.34256 14.8096 5.40999 14.7532 5.49651C14.6968 5.58303 14.6667 5.68476 14.6667 5.78882C14.6667 8.0048 13.608 9.528 12.8037 10.1756C13.5067 5.9317 12.3207 1.09884 9.1851 0.0267794C9.1079 0.000539394 9.0258 -0.00655056 8.9454 0.00609944C8.8651 0.0187394 8.7888 0.0507595 8.7229 0.0995295C8.657 0.148289 8.6032 0.212399 8.5662 0.286599C8.5291 0.360799 8.5097 0.442959 8.5096 0.526329C8.5096 3.80508 6.5104 5.5935 4.3939 7.4868C2.67924 9.0203 0.905979 10.6073 0.315719 13.0289C-0.645821 16.9737 0.583809 19.9317 4.0752 22.0717C4.1682 22.1289 4.2764 22.1544 4.3843 22.1446C4.4923 22.1348 4.5945 22.0901 4.6761 22.0171C4.7578 21.944 4.8148 21.8462 4.8389 21.7378C4.863 21.6295 4.853 21.516 4.8103 21.4139C3.5013 18.1939 4.2473 14.398 6.7385 12.1624C7.0377 11.8939 7.4905 12.1262 7.5541 12.5232C7.8929 14.6366 9.3425 15.0411 9.5184 17.4051C9.5385 17.6751 9.7526 17.9028 10.0211 17.8683C10.5126 17.8051 10.9853 17.6257 11.4011 17.3415C11.7992 17.0693 12.1308 16.7106 12.3741 16.2935C12.5246 16.0354 12.8521 15.9047 13.0845 16.0925C14.6504 17.3581 14.469 20.1637 12.2923 21.9915C12.2798 22.0008 12.1991 22.0635 12.1875 22.0738C12.1079 22.1437 12.0509 22.2369 12.0245 22.341C11.9981 22.4451 12.0033 22.555 12.0396 22.6559C12.0759 22.7568 12.1415 22.8439 12.2275 22.9054C12.3136 22.9669 12.4159 22.9999 12.5208 23C12.5558 23.0003 12.5908 22.9965 12.625 22.9887C15.4124 22.3956 17.6266 20.1508 18.5481 16.9862C19.7219 12.9548 18.5705 8.5218 15.5426 5.41676Z';

    return (
        <LazyMotion features={domAnimation}>
            <m.span
                animate={{ opacity: 1, scale: 1 }}
                className="relative inline-flex h-[17px] w-[14px] origin-center items-center justify-center"
                initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.75 }}
                transition={
                    shouldReduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 24, mass: 0.55 }
                }
            >
                <svg
                    aria-hidden="true"
                    className="absolute h-[20px] w-[17px] scale-125 opacity-60 blur-[3px]"
                    fill="none"
                    viewBox="0 0 19 23"
                    xmlns="http://www.w3.org/2000/svg"
                >
                    <defs>
                        <linearGradient id="trending-flame-glow-gradient" x1="3.25" x2="17.5" y1="22.5" y2="3.5">
                            <stop offset="0" stopColor="#FB923C" />
                            <stop offset="0.45" stopColor="#EF4444" />
                            <stop offset="1" stopColor="#FACC15" />
                        </linearGradient>
                    </defs>
                    <path d={flamePath} fill="url(#trending-flame-glow-gradient)" />
                </svg>

                <svg
                    aria-hidden="true"
                    className="relative h-[17px] w-[14px] drop-shadow-[0_1px_2px_rgba(239,68,68,0.28)]"
                    fill="none"
                    viewBox="0 0 19 23"
                    xmlns="http://www.w3.org/2000/svg"
                >
                    <defs>
                        <linearGradient id="trending-flame-gradient" x1="3.25" x2="17.5" y1="22.5" y2="3.5">
                            <stop offset="0" stopColor="#F97316" />
                            <stop offset="0.45" stopColor="#EF4444" />
                            <stop offset="1" stopColor="#FBBF24" />
                        </linearGradient>
                    </defs>
                    <path d={flamePath} fill="url(#trending-flame-gradient)" />
                </svg>
            </m.span>
        </LazyMotion>
    );
}

function nextFromList<T extends string>(items: readonly T[], value: T): T {
    const currentIndex = items.indexOf(value);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    return items[nextIndex] ?? items[0]!;
}

function TrendingCycleRow<T extends string>({
    label,
    tooltip,
    value,
    values,
    labels,
    onCycle,
}: {
    label: string;
    tooltip: string;
    value: T;
    values: readonly T[];
    labels: Record<T, string>;
    onCycle: () => void;
}) {
    const valueLabel = labels[value] ?? value;

    return (
        <div className="flex min-h-10 w-full items-center gap-3 rounded-xl px-2 py-1.5">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-text-medium">
                {label}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            aria-label={`${label} info`}
                            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-text-extra-low transition-colors hover:text-text-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium cursor-help"
                        >
                            <Info className="size-3.5" aria-hidden />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent
                        side="top"
                        align="center"
                        className="max-w-56 rounded-xl bg-[#111111] px-3 py-2 text-xs leading-4 text-white shadow-[0_10px_30px_rgba(20,20,21,0.18)]"
                    >
                        {tooltip}
                    </TooltipContent>
                </Tooltip>
            </span>
            <button
                type="button"
                aria-label={`${label}: ${valueLabel}. Click to choose the next option.`}
                onClick={onCycle}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 transition-[transform,background-color] duration-150 ease-out hover:bg-gray-50 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium cursor-pointer"
            >
                <span className="shrink-0 text-sm font-semibold text-text-extra-high">{valueLabel}</span>
                <span className="flex shrink-0 flex-col items-center gap-1" aria-hidden>
                    {values.map(option => (
                        <span
                            key={option}
                            className={cn(
                                'size-1 rounded-full transition-colors',
                                option === value ? 'bg-text-high' : 'bg-border-medium',
                            )}
                        />
                    ))}
                </span>
            </button>
        </div>
    );
}

function TrendingSettingsMenu({
    mode,
    window,
    onModeCycle,
    onWindowCycle,
}: {
    mode: TrendingMode;
    window: TrendingWindow;
    onModeCycle: () => void;
    onWindowCycle: () => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label="Trending settings"
                    title="Trending settings"
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border-light bg-white/70 text-text-medium shadow-[0_1px_2px_rgba(20,20,21,0.08)] transition-[transform,background-color,border-color,color] duration-150 ease-out hover:border-border-medium hover:bg-white hover:text-text-extra-high active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium cursor-pointer"
                >
                    <Settings2 className="size-4" aria-hidden />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                sideOffset={8}
                className="w-48 rounded-2xl border-border-light bg-white p-1.5 shadow-[0_18px_48px_rgba(20,20,21,0.16)]"
            >
                <TooltipProvider delayDuration={200}>
                    <TrendingCycleRow
                        label="Data"
                        tooltip="Fresh ranks from selected Birdeye-first market snapshots. Flow uses ClickHouse trade-flow windows."
                        value={mode}
                        values={TRENDING_MODE_IDS}
                        labels={TRENDING_MODE_LABELS}
                        onCycle={onModeCycle}
                    />
                    <DropdownMenuSeparator className="my-1 bg-border-extra-light" />
                    <TrendingCycleRow
                        label="Volume"
                        tooltip="Sets the active volume and trade window shown in the table. 24h volume stays as a separate column."
                        value={window}
                        values={TRENDING_WINDOW_IDS}
                        labels={TRENDING_WINDOW_LABELS}
                        onCycle={onWindowCycle}
                    />
                </TooltipProvider>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function CategoryTabsInner() {
    const {
        categories,
        activeCategoryId,
        isTrending,
        trendingMode,
        trendingWindow,
        tokens,
        isLoading: activeIsLoading,
        error: activeError,
        setActiveCategoryId,
        setTrendingMode,
        setTrendingWindow,
    } = useHomeTokens();

    const contentRef = useRef<HTMLDivElement>(null);
    const [minHeight, setMinHeight] = useState<number | undefined>(undefined);
    const prevCategoryRef = useRef(activeCategoryId);

    useLayoutEffect(() => {
        prevCategoryRef.current = activeCategoryId;
    }, [activeCategoryId]);

    // Release min-height after new content paints
    useLayoutEffect(() => {
        if (minHeight == null) return;
        if (activeIsLoading && tokens.length === 0 && !activeError) return;
        const raf = requestAnimationFrame(() => setMinHeight(undefined));
        return () => cancelAnimationFrame(raf);
    }, [minHeight, activeIsLoading, tokens.length, activeError]);

    const segmentedItems = useMemo(
        () =>
            categories.map(category => ({
                value: category.id,
                label: category.name,
                ...(category.id === 'trending' && activeCategoryId === 'trending'
                    ? { icon: <TrendingFlameIcon /> }
                    : {}),
            })),
        [activeCategoryId, categories],
    );

    return (
        <div>
            <div className="mx-auto max-w-7xl px-4 md:px-6">
                <div className="mb-4 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 overflow-x-auto pb-2 -mb-2 scrollbar-hide">
                        <SegmentedControl
                            className={cn(
                                'w-max min-w-0 [&_button]:!text-[22px]',
                                'bg-transparent',
                                '[&_span.absolute.inset-0]:!bg-black/[0.04] dark:[&_span.absolute.inset-0]:!bg-white/[0.08] [&_span.absolute.inset-0]:!shadow-none',
                            )}
                            items={segmentedItems}
                            value={activeCategoryId}
                            onValueChange={value => {
                                const nextCategoryId = value as HomeTabId;
                                const nextCategory = categories.find(category => category.id === nextCategoryId);

                                if (nextCategory && nextCategoryId !== activeCategoryId) {
                                    // Snapshot outgoing content height before the DOM updates,
                                    // so the container doesn't jump while loading the next tab.
                                    if (contentRef.current) {
                                        setMinHeight(contentRef.current.offsetHeight);
                                    }

                                    trackEvent('category_switched', {
                                        category_id: nextCategoryId,
                                        category_name: nextCategory.name,
                                        previous_category_id: activeCategoryId,
                                    });
                                }

                                setActiveCategoryId(nextCategoryId);
                            }}
                            aria-label="Token list category"
                        />
                    </div>

                    {isTrending ? (
                        <div className="flex shrink-0 items-center gap-2 pb-2">
                            <TrendingSettingsMenu
                                mode={trendingMode}
                                window={trendingWindow}
                                onModeCycle={() => {
                                    const nextMode = nextFromList(TRENDING_MODE_IDS, trendingMode);
                                    if (nextMode !== trendingMode) {
                                        if (contentRef.current) {
                                            setMinHeight(contentRef.current.offsetHeight);
                                        }
                                        trackEvent('trending_mode_switched', {
                                            mode: nextMode,
                                            previous_mode: trendingMode,
                                        });
                                    }

                                    setTrendingMode(nextMode);
                                }}
                                onWindowCycle={() => {
                                    const nextWindow = nextFromList(TRENDING_WINDOW_IDS, trendingWindow);
                                    if (nextWindow !== trendingWindow) {
                                        trackEvent('trending_window_changed', {
                                            window: nextWindow,
                                            previous_window: trendingWindow,
                                            mode: trendingMode,
                                        });
                                    }

                                    setTrendingWindow(nextWindow);
                                }}
                            />
                        </div>
                    ) : null}
                </div>
            </div>

            <div ref={contentRef} style={minHeight != null ? { minHeight } : undefined}>
                {activeError ? (
                    <section className="mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24">
                        <div className="bg-white rounded-[24px] md:rounded-[32px] border border-border-light shadow-[0_8px_40px_rgba(0,0,0,0.03)] p-6 md:p-12 text-center">
                            <p className="text-text-low text-[14px] md:text-[16px]">Failed to load tokens</p>
                            <p className="text-text-extra-low text-[12px] md:text-[14px] mt-2">
                                {activeError instanceof Error ? activeError.message : 'Try again in a moment.'}
                            </p>
                        </div>
                    </section>
                ) : activeIsLoading && tokens.length === 0 ? (
                    <TokenTableSkeleton />
                ) : (
                    <TokenTable
                        tokens={tokens}
                        categoryId={isTrending ? `trending:${trendingMode}` : activeCategoryId}
                        trendingWindow={trendingWindow}
                    />
                )}
            </div>
        </div>
    );
}

export function CategoryTabs() {
    return <CategoryTabsInner />;
}

function TokenTableSkeleton() {
    return (
        <section className="mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24">
            <div className="bg-white rounded-[24px] md:rounded-[32px] border border-border-medium shadow-[0_8px_40px_rgba(0,0,0,0.03)] overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="border-b border-border-extra-light bg-gray-50/80">
                                {Array.from({ length: 6 }, (_, index) => (
                                    <th
                                        key={index}
                                        className={`py-3 bg-gray-50/80 border-b border-border-light ${
                                            index === 0
                                                ? 'pl-4 md:pl-8 pr-4'
                                                : index === 5
                                                  ? 'pl-6 pr-4 md:pr-8 text-right'
                                                  : 'px-3 md:px-6'
                                        }`}
                                    >
                                        <Skeleton className="h-4 w-16 md:w-20 bg-gray-100 rounded" />
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border-extra-light">
                            {Array.from({ length: 8 }, (_, rowIndex) => (
                                <tr key={rowIndex}>
                                    <td className="py-4 pl-4 md:pl-8 pr-4">
                                        <div className="flex items-center gap-3 md:gap-4">
                                            <Skeleton className="h-8 w-8 rounded-full bg-gray-100" />
                                            <div className="space-y-2">
                                                <Skeleton className="h-4 w-24 md:w-40 bg-gray-100" />
                                                <Skeleton className="h-3 w-16 md:w-20 bg-gray-100" />
                                            </div>
                                        </div>
                                    </td>
                                    {Array.from({ length: 5 }, (_, colIndex) => (
                                        <td
                                            key={colIndex}
                                            className={colIndex === 4 ? 'py-4 pl-6 pr-4 md:pr-8' : 'py-4 px-3 md:px-6'}
                                        >
                                            <Skeleton className="h-4 w-16 md:w-24 bg-gray-100 ml-auto" />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </section>
    );
}
