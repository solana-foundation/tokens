'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
    IconChevronDown,
    IconCircleGridCrossFill,
    IconExclamationmarkTriangleFill,
    IconEyeSlashFill,
    IconInfoCircle,
} from 'symbols-react';
import { TextMorph } from 'torph/react';

import { Button } from '@tokens/ui/button';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@tokens/ui/command';
import { Skeleton } from '@tokens/ui/skeleton';
import { Spinner } from '@tokens/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@tokens/ui/tooltip';
import { EmptyState } from '@/components/global/empty-state';

import {
    TokenIdentity,
    formatUsd,
    humanize,
    shortMint,
    type PlaygroundFetcher,
    type SearchResponse,
    type SearchResult,
    type SuppressedResult,
} from './token-bits';

/**
 * ⌘K curator search palette, modeled on the archive PR's v2 search dialog:
 * judged results with score pills and warnings, an expandable per-result
 * inspector (score bars, reasons, attestations), the suppressed set, and a
 * policy switcher in the footer. Clicking a result inspects it; the explicit
 * Add button or Enter adds it to the active list while the palette stays open.
 */

const POLICY_IDS = ['strict', 'default', 'degen'] as const;
type PolicyId = (typeof POLICY_IDS)[number];

function scoreTone(total: number): string {
    if (total >= 70) return 'bg-emerald-100 text-emerald-700';
    if (total >= 40) return 'bg-amber-100 text-amber-700';
    return 'bg-red-100 text-red-700';
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timeout = setTimeout(() => setDebounced(value), delayMs);
        return () => clearTimeout(timeout);
    }, [value, delayMs]);
    return debounced;
}

function CodeChip({
    children,
    tone = 'neutral',
}: {
    children: React.ReactNode;
    tone?: 'neutral' | 'warn' | 'good' | 'bad';
}) {
    const tones = {
        neutral: 'bg-gray-100 text-muted-foreground',
        warn: 'bg-amber-100 text-amber-700',
        good: 'bg-emerald-100 text-emerald-700',
        bad: 'bg-red-100 text-red-700',
    } as const;
    return (
        <span
            className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-berkeley-mono text-[10px] leading-4 ${tones[tone]}`}
        >
            {children}
        </span>
    );
}

function TooltipChip({ children }: { children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center rounded-md bg-white/5 px-1.5 py-0.5 font-berkeley-mono text-[10px] leading-4 text-white">
            {children}
        </span>
    );
}

function Keycap({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="inline-flex h-4 select-none items-center justify-center rounded border border-border-light bg-gray-50 px-2 font-sans text-[11px] font-medium text-muted-foreground">
            {children}
        </kbd>
    );
}

function ShortcutHint({ keys, label }: { keys: string[]; label: string }) {
    return (
        <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
                {keys.map(key => (
                    <Keycap key={key}>{key}</Keycap>
                ))}
            </div>
            <span className="text-xs text-foreground">{label}</span>
        </div>
    );
}

function AddedCheckmark() {
    return (
        <svg
            width="32"
            height="32"
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            className="size-3.5 shrink-0"
        >
            <path
                d="M6 16.5831L12.2902 23L26 9"
                stroke="white"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function AddActionIcon({ state }: { state: 'add' | 'adding' | 'added' }) {
    const shouldReduceMotion = useReducedMotion();
    const initial = shouldReduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.9)' };
    const animate = shouldReduceMotion ? { opacity: 1 } : { opacity: 1, transform: 'scale(1)' };
    const exit = shouldReduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.95)' };

    return (
        <AnimatePresence initial={false} mode="popLayout">
            {state === 'adding' ? (
                <motion.span
                    key="adding"
                    initial={initial}
                    animate={animate}
                    exit={exit}
                    transition={{ duration: 0.12, ease: 'easeOut' }}
                    className="flex size-3.5 items-center justify-center"
                >
                    <Spinner size="sm" />
                </motion.span>
            ) : state === 'added' ? (
                <motion.span
                    key="added"
                    initial={initial}
                    animate={animate}
                    exit={exit}
                    transition={{ duration: 0.12, ease: 'easeOut' }}
                    className="flex size-3.5 items-center justify-center"
                >
                    <AddedCheckmark />
                </motion.span>
            ) : null}
        </AnimatePresence>
    );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
    return (
        <div className="flex items-center gap-2">
            <span className="w-28 shrink-0 font-berkeley-mono text-[10px] text-muted-foreground">{label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                <div
                    className={`h-full rounded-full ${value >= 70 ? 'bg-emerald-500' : value >= 40 ? 'bg-amber-500' : 'bg-red-400'}`}
                    style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
                />
            </div>
            <span className="w-7 shrink-0 text-right font-berkeley-mono text-[10px] text-muted-foreground">
                {Math.round(value)}
            </span>
        </div>
    );
}

/** Per-result judgment breakdown, toggled by its result row. */
function ResultInspector({ token, id, onInteraction }: { token: SearchResult; id: string; onInteraction: () => void }) {
    return (
        <div
            id={id}
            onClick={event => {
                event.stopPropagation();
                onInteraction();
            }}
            className="mt-2 w-full cursor-text overflow-hidden rounded-lg border border-black/[0.15] bg-white text-left shadow-sm dark:bg-zinc-950/30"
        >
            <div className="grid grid-cols-4 border-b border-black/[0.1] dark:border-white/10">
                <div className="border-r border-black/[0.1] px-3 py-2.5 dark:border-white/10">
                    <div className="text-[10px] font-inter-semibold uppercase tracking-wide text-muted-foreground">
                        Price
                    </div>
                    <div className="mt-1 font-berkeley-mono text-sm text-foreground">
                        {formatUsd(token.market.price)}
                    </div>
                </div>
                <div className="border-r border-black/[0.1] px-3 py-2.5 dark:border-white/10">
                    <div className="text-[10px] font-inter-semibold uppercase tracking-wide text-muted-foreground">
                        Market cap
                    </div>
                    <div className="mt-1 font-berkeley-mono text-sm text-foreground">
                        {formatUsd(token.market.marketCapUsd)}
                    </div>
                </div>
                <div className="border-r border-black/[0.1] px-3 py-2.5 dark:border-white/10">
                    <div className="text-[10px] font-inter-semibold uppercase tracking-wide text-muted-foreground">
                        Liquidity
                    </div>
                    <div className="mt-1 font-berkeley-mono text-sm text-foreground">
                        {formatUsd(token.market.liquidityUsd)}
                    </div>
                </div>
                <div className="px-3 py-2.5">
                    <div className="text-[10px] font-inter-semibold uppercase tracking-wide text-muted-foreground">
                        Volume 24h
                    </div>
                    <div className="mt-1 font-berkeley-mono text-sm text-foreground">
                        {formatUsd(token.market.volume24hUsd)}
                    </div>
                </div>
            </div>
            <div className="p-3">
                <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-inter-semibold uppercase tracking-wide text-muted-foreground">
                        Score Card
                    </span>
                    <Tooltip delayDuration={300}>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                aria-label="View score reasons"
                                className="inline-flex size-3.5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <IconInfoCircle aria-hidden="true" className="size-3 fill-current" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent
                            side="right"
                            className="max-w-64 rounded-sm bg-zinc-800 px-2 py-1.5 dark:bg-zinc-900"
                        >
                            <div className="text-[10px] font-inter-semibold uppercase tracking-wide text-white/60">
                                Reasons
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                                {token.reasons.length > 0 ? (
                                    token.reasons.map(reason => (
                                        <TooltipChip key={reason}>{humanize(reason)}</TooltipChip>
                                    ))
                                ) : (
                                    <span className="text-xs text-white/70">No specific reasons.</span>
                                )}
                            </div>
                            <div className="mt-2 border-t border-white/10 pt-2">
                                <div className="text-[10px] font-inter-semibold uppercase tracking-wide text-white/60">
                                    Evidence
                                </div>
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {token.claims.attestations.length > 0 ? (
                                        token.claims.attestations.map(attestation => (
                                            <TooltipChip key={`${attestation.code}:${attestation.detail}`}>
                                                {attestation.detail}
                                            </TooltipChip>
                                        ))
                                    ) : (
                                        <span className="text-xs text-white/70">No attestations.</span>
                                    )}
                                </div>
                            </div>
                        </TooltipContent>
                    </Tooltip>
                    {token.warnings.length > 0 && (
                        <Tooltip delayDuration={300}>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    aria-label={`View ${token.warnings.length} warning${token.warnings.length === 1 ? '' : 's'}`}
                                    className="inline-flex size-3.5 items-center justify-center rounded-full text-amber-600 transition-colors hover:text-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-300 dark:hover:text-amber-200"
                                >
                                    <IconExclamationmarkTriangleFill
                                        aria-hidden="true"
                                        className="size-3 fill-current"
                                    />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent
                                side="right"
                                className="max-w-64 rounded-sm bg-zinc-800 px-2 py-1.5 dark:bg-zinc-900"
                            >
                                <div className="text-[10px] font-inter-semibold uppercase tracking-wide text-white/60">
                                    Warnings
                                </div>
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {token.warnings.map(warning => (
                                        <TooltipChip key={warning}>{humanize(warning)}</TooltipChip>
                                    ))}
                                </div>
                            </TooltipContent>
                        </Tooltip>
                    )}
                </div>
                <div className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                    {Object.entries(token.score.components).map(([key, value]) => (
                        <ScoreBar key={key} label={humanize(key)} value={value} />
                    ))}
                </div>
            </div>
        </div>
    );
}

export function TokenSearchCommand({
    open,
    onOpenChange,
    listSlug,
    memberMints,
    playgroundFetch,
    addingMint,
    onAdd,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    listSlug: string;
    memberMints: Set<string>;
    playgroundFetch: PlaygroundFetcher;
    addingMint: string | null;
    /** Adds to the active list; the palette stays open for multi-add. */
    onAdd: (result: SearchResult) => void;
}) {
    const [query, setQuery] = useState('');
    const [policy, setPolicy] = useState<PolicyId>('strict');
    const [results, setResults] = useState<SearchResult[] | null>(null);
    const [suppressed, setSuppressed] = useState<SuppressedResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [expandedMint, setExpandedMint] = useState<string | null>(null);
    const pointerSelectionMintRef = useRef<string | null>(null);

    const debouncedQuery = useDebouncedValue(query.trim(), 300);
    const hasQuery = debouncedQuery.length >= 2;

    useEffect(() => {
        setExpandedMint(null);
        pointerSelectionMintRef.current = null;
    }, [debouncedQuery, policy]);

    useEffect(() => {
        if (!open || !hasQuery) {
            setResults(null);
            setSuppressed([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(false);
        void playgroundFetch(
            `/api/v2/lists/search-tokens?q=${encodeURIComponent(debouncedQuery)}&policy=${policy}&limit=8`,
        )
            .then(async res => {
                if (!res.ok) throw new Error(`search failed (HTTP ${res.status})`);
                const body = (await res.json()) as SearchResponse;
                if (cancelled) return;
                setResults(body.results);
                setSuppressed(body.suppressed);
            })
            .catch(() => {
                if (!cancelled) setError(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, hasQuery, debouncedQuery, policy, playgroundFetch]);

    function handleOpenChange(nextOpen: boolean) {
        onOpenChange(nextOpen);
        if (!nextOpen) {
            setQuery('');
            setExpandedMint(null);
        }
    }

    const toggleInspector = (mint: string) => {
        setExpandedMint(previous => (previous === mint ? null : mint));
    };

    return (
        <CommandDialog open={open} onOpenChange={handleOpenChange}>
            <CommandInput
                placeholder={`Search tokens to add to ${listSlug}…`}
                value={query}
                onValueChange={setQuery}
                endAdornment={
                    <button
                        type="button"
                        aria-label={`Search policy: ${policy}. Click to choose the next policy.`}
                        title="Search policy"
                        onClick={() => {
                            const currentIndex = POLICY_IDS.indexOf(policy);
                            setPolicy(POLICY_IDS[(currentIndex + 1) % POLICY_IDS.length]);
                        }}
                        className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-muted px-2 py-1 font-berkeley-mono text-xs text-foreground transition-[transform,background-color] duration-150 ease-out hover:bg-accent/50 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <span>{policy}</span>
                        <span className="flex flex-col items-center gap-0.5" aria-hidden="true">
                            {POLICY_IDS.map(option => (
                                <span
                                    key={option}
                                    className={`rounded-full ${option === policy ? 'size-1 bg-foreground' : 'size-0.5 bg-muted-foreground/60'}`}
                                />
                            ))}
                        </span>
                    </button>
                }
            />

            <CommandList className="h-[380px] max-h-[380px]">
                {!hasQuery ? (
                    <CommandEmpty className="py-0">
                        <EmptyState
                            icon={<IconCircleGridCrossFill className="mb-2 size-12 fill-muted-foreground" />}
                            title="Search for a token"
                            subtitle="Search by symbol, name, or mint address."
                            className="py-12"
                            titleClassName="text-base"
                        />
                    </CommandEmpty>
                ) : error ? (
                    <CommandEmpty>Search failed — check the API and your key.</CommandEmpty>
                ) : loading && results === null ? (
                    <CommandGroup heading="Judging candidates…">
                        {Array.from({ length: 4 }, (_, index) => (
                            <CommandItem
                                key={index}
                                disabled
                                value={`__loading__${index}`}
                                className="flex items-center gap-3 px-3 py-2"
                            >
                                <Skeleton className="h-8 w-8 rounded-full" />
                                <div className="flex flex-1 flex-col gap-1">
                                    <Skeleton className="h-4 w-40 rounded" />
                                    <Skeleton className="h-3 w-24 rounded" />
                                </div>
                                <Skeleton className="h-5 w-9 rounded-full" />
                            </CommandItem>
                        ))}
                    </CommandGroup>
                ) : results !== null ? (
                    <>
                        <CommandGroup heading="Ranked results">
                            {results.length === 0 && (
                                <CommandItem
                                    disabled
                                    value="__no_results__"
                                    className="px-3 py-2 text-muted-foreground"
                                >
                                    No results survived the {policy} policy.
                                </CommandItem>
                            )}
                            {results.map(result => {
                                const isMember = memberMints.has(result.mint);
                                const isAdding = addingMint === result.mint;
                                const actionState = isAdding ? 'adding' : isMember ? 'added' : 'add';
                                const expanded = expandedMint === result.mint;
                                const inspectorId = `token-result-inspector-${result.mint}`;
                                const symbol = result.claims.symbol ?? shortMint(result.mint);
                                return (
                                    <CommandItem
                                        key={result.mint}
                                        value={result.mint}
                                        aria-expanded={expanded}
                                        aria-controls={inspectorId}
                                        onClickCapture={() => {
                                            pointerSelectionMintRef.current = result.mint;
                                        }}
                                        onSelect={() => {
                                            const selectedWithPointer = pointerSelectionMintRef.current === result.mint;
                                            pointerSelectionMintRef.current = null;

                                            if (selectedWithPointer || isMember) {
                                                toggleInspector(result.mint);
                                                return;
                                            }

                                            if (!isAdding && addingMint === null) onAdd(result);
                                        }}
                                        className="group flex cursor-pointer flex-col items-stretch gap-0 rounded-xl !px-0.5 pb-0.5 pt-2 aria-selected:bg-accent/70"
                                    >
                                        <div className="flex w-full items-center gap-2 px-4 sm:gap-3">
                                            <div className="min-w-0 flex-1">
                                                <TokenIdentity
                                                    mint={result.mint}
                                                    symbol={result.claims.symbol}
                                                    name={
                                                        <a
                                                            href={`https://birdeye.so/token/${result.mint}?chain=solana`}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            title="Verify on Birdeye"
                                                            onPointerDown={event => {
                                                                event.stopPropagation();
                                                                pointerSelectionMintRef.current = null;
                                                            }}
                                                            onClick={event => {
                                                                event.stopPropagation();
                                                                pointerSelectionMintRef.current = null;
                                                            }}
                                                            className="inline-flex items-center gap-0.5 hover:text-foreground"
                                                        >
                                                            {shortMint(result.mint)}
                                                            <ArrowUpRight aria-hidden="true" className="size-2.5" />
                                                        </a>
                                                    }
                                                    nameClassName="text-[11px] text-muted-foreground"
                                                    logoURI={result.market.logoURI}
                                                    verified={result.verified}
                                                    symbolAccessory={
                                                        <span
                                                            aria-label={`Judgment score: ${result.score.total}`}
                                                            title={`Judgment score: ${result.score.total}`}
                                                            className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-berkeley-mono text-xs font-semibold ${scoreTone(result.score.total)}`}
                                                        >
                                                            {result.score.total}
                                                        </span>
                                                    }
                                                />
                                            </div>
                                            <div className="flex shrink-0 items-start gap-2">
                                                <div className="flex flex-col items-end gap-1">
                                                    <div className="flex items-center gap-2">
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            variant={isMember ? 'secondary' : 'default'}
                                                            disabled={isAdding || (!isMember && addingMint !== null)}
                                                            aria-disabled={isMember || undefined}
                                                            tabIndex={isMember ? -1 : undefined}
                                                            aria-label={
                                                                isAdding
                                                                    ? `Adding ${symbol} to ${listSlug}`
                                                                    : isMember
                                                                      ? `${symbol} is already in ${listSlug}`
                                                                      : `Add ${symbol} to ${listSlug}`
                                                            }
                                                            onPointerDown={event => {
                                                                if (actionState !== 'add') return;
                                                                event.stopPropagation();
                                                                pointerSelectionMintRef.current = null;
                                                            }}
                                                            onClick={event => {
                                                                if (actionState !== 'add') return;
                                                                event.preventDefault();
                                                                event.stopPropagation();
                                                                pointerSelectionMintRef.current = null;
                                                                if (addingMint === null) onAdd(result);
                                                            }}
                                                            className={`h-6 shrink-0 rounded-md pl-2.5 pr-3 text-xs ${
                                                                isMember
                                                                    ? 'pointer-events-none bg-emerald-600 text-white hover:bg-emerald-600 dark:bg-emerald-500 dark:hover:bg-emerald-500'
                                                                    : ''
                                                            }`}
                                                        >
                                                            <AddActionIcon state={actionState} />
                                                            <TextMorph as="span" respectReducedMotion>
                                                                {actionState === 'adding'
                                                                    ? 'Adding'
                                                                    : actionState === 'added'
                                                                      ? 'Added'
                                                                      : 'Add'}
                                                            </TextMorph>
                                                        </Button>
                                                    </div>
                                                </div>
                                                <IconChevronDown
                                                    aria-hidden="true"
                                                    className={`mt-1.5 size-3 shrink-0 fill-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
                                                />
                                            </div>
                                        </div>
                                        {expanded && (
                                            <ResultInspector
                                                id={inspectorId}
                                                token={result}
                                                onInteraction={() => {
                                                    pointerSelectionMintRef.current = null;
                                                }}
                                            />
                                        )}
                                    </CommandItem>
                                );
                            })}
                        </CommandGroup>
                        {suppressed.length > 0 && (
                            <CommandGroup heading={`Suppressed by policy (${suppressed.length})`}>
                                {suppressed.map(token => (
                                    <CommandItem
                                        key={token.mint}
                                        disabled
                                        value={`__suppressed__${token.mint}`}
                                        className="flex items-center gap-3 rounded-xl px-3 py-2 opacity-60"
                                    >
                                        <IconEyeSlashFill className="size-4 shrink-0 fill-muted-foreground" />
                                        <div className="flex min-w-0 flex-1 flex-col">
                                            <div className="flex items-center gap-2">
                                                <span className="font-inter-medium">
                                                    {token.symbol ?? shortMint(token.mint)}
                                                </span>
                                                <span className="truncate text-xs text-muted-foreground">
                                                    {token.name ?? ''}
                                                </span>
                                            </div>
                                            <div className="mt-0.5 flex flex-wrap gap-1">
                                                {token.suppressedBy.map(code => (
                                                    <CodeChip key={code} tone="bad">
                                                        {humanize(code)}
                                                    </CodeChip>
                                                ))}
                                            </div>
                                        </div>
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        )}
                    </>
                ) : null}
            </CommandList>
            <div className="hidden w-full items-center justify-center border-t border-border-light px-3 py-3 md:flex">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <ShortcutHint keys={['↑', '↓']} label="List" />
                    <ShortcutHint keys={['Enter']} label="Add" />
                    <ShortcutHint keys={['Esc']} label="Close" />
                </div>
            </div>
        </CommandDialog>
    );
}
