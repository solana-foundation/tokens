'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@tokens/ui/cn';
import { CHAIN_LIST, type ChainId } from '@/lib/market-data/chains';
import type { DexPair } from '@/lib/market-data/dex-pairs';
import { CHANGE_WINDOWS, DexPairTable, type SortState } from './dex-pair-table';
import { isSuspectTurnover, SUSPECT_TURNOVER_RATIO } from './dex-pair-health';

/**
 * Chain-scoped pair explorer.
 *
 * One chain is loaded at a time on purpose: GeckoTerminal's keyless tier
 * serializes requests ~1.5s apart, so a five-page sweep of one chain already
 * costs ~8s and fetching all seven up front would take a minute. Switching
 * chains fetches on demand and the result is cached upstream for a minute.
 */

interface DexPairsResponse {
    chain: ChainId;
    pairs: DexPair[];
    degraded: boolean;
    pagesLoaded: number;
    pagesRequested: number;
    fetchedAt: number;
}

const REFRESH_MS = 60_000;

const LIQUIDITY_FILTERS = [
    { label: 'Any liquidity', value: 0 },
    { label: '≥ $10K', value: 10_000 },
    { label: '≥ $100K', value: 100_000 },
    { label: '≥ $1M', value: 1_000_000 },
] as const;

const VOLUME_FILTERS = [
    { label: 'Any volume', value: 0 },
    { label: '≥ $10K', value: 10_000 },
    { label: '≥ $100K', value: 100_000 },
    { label: '≥ $1M', value: 1_000_000 },
] as const;

function sortValue(pair: DexPair, sort: SortState): number {
    switch (sort.key) {
        case 'volume':
            return pair.volume[sort.window] ?? 0;
        case 'change':
            return pair.priceChange[sort.window] ?? 0;
        case 'liquidity':
            return pair.liquidityUsd ?? 0;
        case 'fdv':
            return pair.fdvUsd ?? 0;
        case 'txns':
            return (pair.buys24h ?? 0) + (pair.sells24h ?? 0);
        case 'age':
            // Unknown creation time sorts oldest, so a descending "newest first"
            // never leads with pools whose age we simply do not know.
            return pair.createdAt ?? 0;
    }
}

export function DexExplorer({
    initialChain,
    initialPairs,
    initialDegraded,
    initialPagesLoaded,
    initialPagesRequested,
}: {
    initialChain: ChainId;
    initialPairs: DexPair[];
    initialDegraded: boolean;
    initialPagesLoaded: number;
    initialPagesRequested: number;
}) {
    const [chain, setChain] = useState<ChainId>(initialChain);
    const [pairs, setPairs] = useState<DexPair[]>(initialPairs);
    const [degraded, setDegraded] = useState(initialDegraded);
    const [pages, setPages] = useState({ loaded: initialPagesLoaded, requested: initialPagesRequested });
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fetchedAt, setFetchedAt] = useState<number | null>(null);

    const [query, setQuery] = useState('');
    const [minLiquidity, setMinLiquidity] = useState<number>(0);
    const [minVolume, setMinVolume] = useState<number>(0);
    const [hideSuspect, setHideSuspect] = useState(false);
    const [sort, setSort] = useState<SortState>({ key: 'volume', window: 'h24', desc: true });

    // The server already rendered `initialChain`; refetching it on mount would
    // spend a request re-reading what is on screen.
    const loadedChain = useRef<ChainId>(initialChain);

    const load = useCallback(async (next: ChainId, signal?: AbortSignal) => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/dex/${next}`, { signal });
            const json = (await res.json()) as DexPairsResponse & { error?: string };
            if (!res.ok && !json.pairs) throw new Error(json.error ?? `HTTP ${res.status}`);

            setPairs(json.pairs ?? []);
            setDegraded(Boolean(json.degraded));
            setPages({ loaded: json.pagesLoaded ?? 0, requested: json.pagesRequested ?? 0 });
            setFetchedAt(json.fetchedAt ?? Date.now());
            loadedChain.current = next;
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            setError(err instanceof Error ? err.message : String(err));
            setPairs([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (chain === loadedChain.current) return;
        const controller = new AbortController();
        void load(chain, controller.signal);
        return () => controller.abort();
    }, [chain, load]);

    // Keeps the URL shareable without a server round trip on every chain click.
    useEffect(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('chain', chain);
        window.history.replaceState(null, '', url);
    }, [chain]);

    useEffect(() => {
        const timer = setInterval(() => void load(chain), REFRESH_MS);
        return () => clearInterval(timer);
    }, [chain, load]);

    const suspectCount = useMemo(() => pairs.filter(isSuspectTurnover).length, [pairs]);

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = pairs.filter(pair => {
            if (hideSuspect && isSuspectTurnover(pair)) return false;
            if ((pair.liquidityUsd ?? 0) < minLiquidity) return false;
            if ((pair.volume.h24 ?? 0) < minVolume) return false;
            if (!needle) return true;
            return (
                pair.name.toLowerCase().includes(needle) ||
                pair.base.symbol.toLowerCase().includes(needle) ||
                pair.quote.symbol.toLowerCase().includes(needle) ||
                pair.base.name.toLowerCase().includes(needle) ||
                (pair.dex ?? '').toLowerCase().includes(needle) ||
                pair.base.address.toLowerCase() === needle
            );
        });

        return filtered.sort((a, b) => {
            const delta = sortValue(a, sort) - sortValue(b, sort);
            return sort.desc ? -delta : delta;
        });
    }, [pairs, query, minLiquidity, minVolume, hideSuspect, sort]);

    // A query that matches none of this chain's ranked pools is asked upstream
    // instead of coming back empty: pasted contract addresses and pools outside
    // the top pages are exactly what someone types here.
    const [remotePairs, setRemotePairs] = useState<DexPair[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const needsRemoteSearch = visible.length === 0 && query.trim().length >= 2;

    useEffect(() => {
        if (!needsRemoteSearch) {
            setRemotePairs([]);
            return;
        }

        const controller = new AbortController();
        const timer = setTimeout(async () => {
            setIsSearching(true);
            try {
                const res = await fetch(
                    `/api/dex/search?q=${encodeURIComponent(query.trim())}&chain=${chain}`,
                    { signal: controller.signal },
                );
                const json = (await res.json()) as { pairs?: DexPair[] };
                setRemotePairs(json.pairs ?? []);
            } catch {
                // An unreachable search leaves the empty-state message in place.
            } finally {
                if (!controller.signal.aborted) setIsSearching(false);
            }
        }, 250);

        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [chain, needsRemoteSearch, query]);

    const rows = visible.length > 0 ? visible : remotePairs;

    const totalLiquidity = visible.reduce((sum, pair) => sum + (pair.liquidityUsd ?? 0), 0);
    const totalVolume = visible.reduce((sum, pair) => sum + (pair.volume.h24 ?? 0), 0);

    return (
        <div className="mx-auto w-full max-w-[1400px] px-6 pt-28 pb-16">
            <header className="mb-8">
                <h1 className="text-title-lg text-text-extra-high">DEX Pairs</h1>
                <p className="mt-2 text-body-md text-text-medium">
                    Live pools across {CHAIN_LIST.length} networks, ranked by traded volume.
                </p>
            </header>

            <nav className="mb-4 flex flex-wrap gap-2">
                {CHAIN_LIST.map(item => (
                    <button
                        key={item.id}
                        type="button"
                        onClick={() => setChain(item.id)}
                        className={cn(
                            'cursor-pointer rounded-full px-4 py-1.5 text-sm font-semibold transition-colors',
                            item.id === chain
                                ? 'bg-text-extra-high text-background'
                                : 'bg-[#F2F3F5] text-text-medium hover:bg-[#E8EAED]',
                        )}
                    >
                        {item.label}
                    </button>
                ))}
            </nav>

            <div className="mb-4 flex flex-wrap items-center gap-2">
                <input
                    type="search"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder="Search by name, symbol, DEX or contract address"
                    className="h-9 min-w-[280px] flex-1 rounded-full border border-border-light px-4 text-sm text-text-extra-high outline-none transition-colors placeholder:text-text-extra-low focus:border-border-medium"
                />
                <select
                    value={minLiquidity}
                    onChange={event => setMinLiquidity(Number(event.target.value))}
                    className="h-9 rounded-full border border-border-light px-3 text-sm text-text-medium outline-none transition-colors focus:border-border-medium"
                >
                    {LIQUIDITY_FILTERS.map(option => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
                <select
                    value={minVolume}
                    onChange={event => setMinVolume(Number(event.target.value))}
                    className="h-9 rounded-full border border-border-light px-3 text-sm text-text-medium outline-none transition-colors focus:border-border-medium"
                >
                    {VOLUME_FILTERS.map(option => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
                <select
                    value={sort.window}
                    onChange={event =>
                        setSort(current => ({
                            ...current,
                            window: event.target.value as SortState['window'],
                        }))
                    }
                    className="h-9 rounded-full border border-border-light px-3 text-sm text-text-medium outline-none transition-colors focus:border-border-medium"
                    aria-label="Volume window"
                >
                    {CHANGE_WINDOWS.map(window => (
                        <option key={window} value={window}>
                            Volume {window.replace('m', '').replace('h', '')}
                            {window.startsWith('m') ? 'm' : 'h'}
                        </option>
                    ))}
                </select>
                <label
                    className="flex h-9 select-none items-center gap-2 rounded-full border border-border-light px-3 text-sm text-text-medium"
                    title={`Pools whose 24h volume is ${SUSPECT_TURNOVER_RATIO}× their depth or more, which no tradable market sustains.`}
                >
                    <input
                        type="checkbox"
                        checked={hideSuspect}
                        onChange={event => setHideSuspect(event.target.checked)}
                        className="size-3.5 accent-gray-900"
                    />
                    Hide suspect turnover
                </label>
                <button
                    type="button"
                    onClick={() => void load(chain)}
                    disabled={isLoading}
                    className="h-9 rounded-full border border-border-light px-4 text-sm font-semibold text-text-medium transition-colors hover:bg-gray-50 disabled:opacity-50"
                >
                    {isLoading ? 'Loading…' : 'Refresh'}
                </button>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-extra-low">
                <span>
                    {visible.length > 0
                        ? `${visible.length} of ${pairs.length} pairs`
                        : remotePairs.length > 0
                          ? `${remotePairs.length} pairs found by search`
                          : `${visible.length} of ${pairs.length} pairs`}
                </span>
                {isSearching && <span>Searching all chains…</span>}
                <span>Liquidity {formatCompactUsd(totalLiquidity)}</span>
                <span>24h volume {formatCompactUsd(totalVolume)}</span>
                {suspectCount > 0 && (
                    <span className="text-amber-700">{suspectCount} flagged for suspect turnover</span>
                )}
                {fetchedAt !== null && <span>Updated {new Date(fetchedAt).toLocaleTimeString()}</span>}
            </div>

            {degraded && (
                <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    The DEX indexer did not answer for this network — showing nothing rather than stale
                    numbers.
                </p>
            )}

            {!degraded && pages.requested > 0 && pages.loaded < pages.requested && (
                <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    Showing {pages.loaded} of {pages.requested} pages — the indexer rate-limited the rest,
                    so pools below these are missing rather than absent. Setting a CoinGecko API key
                    removes the limit.
                </p>
            )}

            {error && (
                <p className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                </p>
            )}

            <DexPairTable pairs={rows} sort={sort} onSortChange={setSort} />
        </div>
    );
}

function formatCompactUsd(value: number): string {
    if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
    return `$${value.toFixed(2)}`;
}
