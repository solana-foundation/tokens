'use client';

import { useEffect, useRef, useState } from 'react';
import { IconCheckmark, IconChevronDown, IconExclamationmarkTriangleFill, IconEyeSlashFill } from 'symbols-react';

import { Button } from '@tokens/ui/button';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@tokens/ui/command';
import { Skeleton } from '@tokens/ui/skeleton';
import { Spinner } from '@tokens/ui/spinner';

import {
    TokenIdentity,
    formatUsd,
    humanize,
    shortMint,
    type PlaygroundFetcher,
    type SearchResponse,
    type SearchResult,
    type SearchSources,
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
            <div className="grid gap-3 p-3 md:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-inter-semibold uppercase tracking-wide text-muted-foreground">
                        Score components
                    </span>
                    {Object.entries(token.score.components).map(([key, value]) => (
                        <ScoreBar key={key} label={humanize(key)} value={value} />
                    ))}
                </div>
                <div className="flex flex-col gap-2">
                    <div>
                        <span className="text-[10px] font-inter-semibold uppercase tracking-wide text-muted-foreground">
                            Reasons
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1">
                            {token.reasons.length > 0 ? (
                                token.reasons.map(reason => (
                                    <CodeChip key={reason} tone="good">
                                        {humanize(reason)}
                                    </CodeChip>
                                ))
                            ) : (
                                <span className="text-xs text-muted-foreground">none</span>
                            )}
                        </div>
                    </div>
                    <div>
                        <span className="text-[10px] font-inter-semibold uppercase tracking-wide text-muted-foreground">
                            Warnings
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1">
                            {token.warnings.length > 0 ? (
                                token.warnings.map(warning => (
                                    <CodeChip key={warning} tone="warn">
                                        {humanize(warning)}
                                    </CodeChip>
                                ))
                            ) : (
                                <span className="text-xs text-muted-foreground">none</span>
                            )}
                        </div>
                    </div>
                    <div>
                        <span className="text-[10px] font-inter-semibold uppercase tracking-wide text-muted-foreground">
                            Attestations
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1">
                            {token.claims.attestations.length > 0 ? (
                                token.claims.attestations.map(attestation => (
                                    <CodeChip key={`${attestation.code}:${attestation.detail}`} tone="neutral">
                                        {attestation.detail}
                                    </CodeChip>
                                ))
                            ) : (
                                <span className="text-xs text-muted-foreground">
                                    unattested — symbol/name are unverified claims
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-black/[0.1] px-3 py-2 text-[11px] text-muted-foreground dark:border-white/10">
                <span className="font-berkeley-mono">{token.mint}</span>
                <span>liq {formatUsd(token.market.liquidityUsd)}</span>
                <span>24h vol {formatUsd(token.market.volume24hUsd)}</span>
                <span>mcap {formatUsd(token.market.marketCapUsd)}</span>
                {token.inLists.length > 0 && <span>in: {token.inLists.join(', ')}</span>}
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
    const [sources, setSources] = useState<SearchSources | null>(null);
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
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
            setSources(null);
            setLatencyMs(null);
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
                setSources(body.sources);
                setLatencyMs(body.latencyMs);
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

    const sourceTone = (status: string): 'good' | 'neutral' | 'warn' =>
        status === 'ok' ? 'good' : status === 'disabled' ? 'neutral' : 'warn';

    const toggleInspector = (mint: string) => {
        setExpandedMint(previous => (previous === mint ? null : mint));
    };

    return (
        <CommandDialog open={open} onOpenChange={handleOpenChange}>
            <CommandInput placeholder={`Search tokens to add to ${listSlug}…`} value={query} onValueChange={setQuery} />

            <CommandList className="h-[380px] max-h-[380px]">
                {!hasQuery ? (
                    <CommandEmpty>Type at least 2 characters — symbol, name, or a mint address.</CommandEmpty>
                ) : error ? (
                    <CommandEmpty>Search failed — check the API and your key’s lists:write scope.</CommandEmpty>
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
                                const expanded = expandedMint === result.mint;
                                const inspectorId = `token-result-inspector-${result.mint}`;
                                const symbol = result.claims.symbol ?? shortMint(result.mint);
                                const warningCount = result.warnings.length;
                                const warningLabel = `${warningCount} warning${warningCount === 1 ? '' : 's'}`;
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
                                        className="group flex cursor-pointer flex-col items-stretch gap-0 rounded-xl px-3 py-2 aria-selected:bg-accent/70"
                                    >
                                        <div className="flex w-full items-center gap-2 sm:gap-3">
                                            <div className="min-w-0 flex-1">
                                                <TokenIdentity
                                                    mint={result.mint}
                                                    symbol={result.claims.symbol}
                                                    name={result.claims.name}
                                                    logoURI={result.market.logoURI}
                                                    verified={result.verified}
                                                    symbolAccessory={
                                                        warningCount > 0 ? (
                                                            <span
                                                                title={warningLabel}
                                                                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] leading-4 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
                                                            >
                                                                <IconExclamationmarkTriangleFill
                                                                    aria-hidden="true"
                                                                    className="size-3 shrink-0 fill-current"
                                                                />
                                                                {warningLabel}
                                                            </span>
                                                        ) : undefined
                                                    }
                                                >
                                                    <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                                                        <span>{formatUsd(result.market.price)}</span>
                                                        <span>liq {formatUsd(result.market.liquidityUsd)}</span>
                                                    </div>
                                                </TokenIdentity>
                                            </div>
                                            <span
                                                aria-label={`Judgment score: ${result.score.total}`}
                                                title={`Judgment score: ${result.score.total}`}
                                                className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-berkeley-mono text-xs font-semibold ${scoreTone(result.score.total)}`}
                                            >
                                                {result.score.total}
                                            </span>
                                            {isAdding ? (
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    disabled
                                                    aria-label={`Adding ${symbol} to ${listSlug}`}
                                                    className="h-7 shrink-0 rounded-md px-2.5 text-xs"
                                                >
                                                    <Spinner size="sm" />
                                                    Adding
                                                </Button>
                                            ) : isMember ? (
                                                <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                                                    <IconCheckmark
                                                        aria-hidden="true"
                                                        className="size-3 shrink-0 fill-current"
                                                    />
                                                    Added
                                                </span>
                                            ) : (
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    disabled={addingMint !== null}
                                                    aria-label={`Add ${symbol} to ${listSlug}`}
                                                    onPointerDown={event => {
                                                        event.stopPropagation();
                                                        pointerSelectionMintRef.current = null;
                                                    }}
                                                    onClick={event => {
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                        pointerSelectionMintRef.current = null;
                                                        if (addingMint === null) onAdd(result);
                                                    }}
                                                    className="h-7 shrink-0 rounded-md px-2.5 text-xs"
                                                >
                                                    Add
                                                    <span
                                                        aria-hidden="true"
                                                        className="font-berkeley-mono text-[10px] opacity-60"
                                                    >
                                                        ↵
                                                    </span>
                                                </Button>
                                            )}
                                            <IconChevronDown
                                                aria-hidden="true"
                                                className={`size-3.5 shrink-0 fill-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
                                            />
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

            {/* Policy + sources footer */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-extra-light px-4 py-2.5">
                <div className="flex items-center gap-1">
                    <span className="mr-1 text-[10px] font-inter-semibold uppercase tracking-wide text-muted-foreground">
                        policy
                    </span>
                    {POLICY_IDS.map(id => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setPolicy(id)}
                            className={`rounded-full px-2.5 py-1 font-berkeley-mono text-xs transition-colors ${
                                policy === id
                                    ? id === 'strict'
                                        ? 'bg-emerald-600 text-white'
                                        : id === 'degen'
                                          ? 'bg-red-500 text-white'
                                          : 'bg-gray-800 text-white'
                                    : 'bg-gray-100 text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            {id}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    {sources && (
                        <>
                            <CodeChip tone={sourceTone(sources.provider)}>provider:{sources.provider}</CodeChip>
                            <CodeChip tone={sourceTone(sources.db)}>db:{sources.db}</CodeChip>
                            <CodeChip tone="good">registry:ok</CodeChip>
                        </>
                    )}
                    {latencyMs !== null && <span className="font-berkeley-mono">{latencyMs}ms</span>}
                </div>
            </div>
        </CommandDialog>
    );
}
