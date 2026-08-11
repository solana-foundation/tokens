'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@tokens/ui/cn';
import { CHAIN_LIST, type ChainId } from '@/lib/market-data/chains';
import type { DexPair } from '@/lib/market-data/dex-pairs';
import { CHANGE_WINDOWS, DexPairTable, type SortState } from './dex-pair-table';

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
}: {
    initialChain: ChainId;
    initialPairs: DexPair[];
    initialDegraded: boolean;
}) {
    const [chain, setChain] = useState<ChainId>(initialChain);
    const [pairs, setPairs] = useState<DexPair[]>(initialPairs);
    const [degraded, setDegraded] = useState(initialDegraded);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fetchedAt, setFetchedAt] = useState<number | null>(null);

    const [query, setQuery] = useState('');
    const [minLiquidity, setMinLiquidity] = useState<number>(0);
    const [minVolume, setMinVolume] = useState<number>(0);
    const [sort, setSort] = useState<SortState>({ key: 'volume', window: 'h24', desc: true });

    // The server already rendered `initialChain`; refetching it on mount would
    // spend a request re-reading what is on screen.
    const loadedChain = useRef<ChainId>(initialChain);

    const load = useCallback(async (next: ChainId, signal?: AbortSignal) => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/dex/${next}?pages=5`, { signal });
            const json = (await res.json()) as DexPairsResponse & { error?: string };
            if (!res.ok && !json.pairs) throw new Error(json.error ?? `HTTP ${res.status}`);

            setPairs(json.pairs ?? []);
            setDegraded(Boolean(json.degraded));
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

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = pairs.filter(pair => {
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
    }, [pairs, query, minLiquidity, minVolume, sort]);

    const totalLiquidity = visible.reduce((sum, pair) => sum + (pair.liquidityUsd ?? 0), 0);
    const totalVolume = visible.reduce((sum, pair) => sum + (pair.volume.h24 ?? 0), 0);

    return (
        <div className="mx-auto w-full max-w-[1400px] px-6 py-10">
            <header className="mb-6">
                <h1 className="text-2xl font-semibold text-gray-900">DEX Pairs</h1>
                <p className="mt-1 text-sm text-gray-500">
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
                            'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                            item.id === chain
                                ? 'bg-gray-900 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
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
                    placeholder="Filter by token, pair, DEX or address"
                    className="h-9 min-w-[280px] flex-1 rounded-lg border border-gray-200 px-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-400"
                />
                <select
                    value={minLiquidity}
                    onChange={event => setMinLiquidity(Number(event.target.value))}
                    className="h-9 rounded-lg border border-gray-200 px-2 text-sm text-gray-700 outline-none focus:border-gray-400"
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
                    className="h-9 rounded-lg border border-gray-200 px-2 text-sm text-gray-700 outline-none focus:border-gray-400"
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
                    className="h-9 rounded-lg border border-gray-200 px-2 text-sm text-gray-700 outline-none focus:border-gray-400"
                    aria-label="Volume window"
                >
                    {CHANGE_WINDOWS.map(window => (
                        <option key={window} value={window}>
                            Volume {window.replace('m', '').replace('h', '')}
                            {window.startsWith('m') ? 'm' : 'h'}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    onClick={() => void load(chain)}
                    disabled={isLoading}
                    className="h-9 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                    {isLoading ? 'Loading…' : 'Refresh'}
                </button>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>
                    {visible.length} of {pairs.length} pairs
                </span>
                <span>Liquidity {formatCompactUsd(totalLiquidity)}</span>
                <span>24h volume {formatCompactUsd(totalVolume)}</span>
                {fetchedAt !== null && <span>Updated {new Date(fetchedAt).toLocaleTimeString()}</span>}
            </div>

            {degraded && (
                <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    The DEX indexer did not answer for this network — showing nothing rather than stale
                    numbers.
                </p>
            )}

            {error && (
                <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                </p>
            )}

            <DexPairTable pairs={visible} sort={sort} onSortChange={setSort} />
        </div>
    );
}

function formatCompactUsd(value: number): string {
    if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
    return `$${value.toFixed(2)}`;
}
