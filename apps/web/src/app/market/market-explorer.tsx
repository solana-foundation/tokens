'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@tokens/ui/cn';
import { formatLargeNumber, formatPercent, formatPrice } from '@/lib/format';
import type { CrossChainLiquidity } from '@/lib/market-data/cross-chain';
import { MARKET_CATEGORIES, type MarketCategory, type MarketRow } from '@/lib/market-data/types';
import { NetworksPanel } from './networks-panel';

/** The networks view is a tab but not a market category — it has its own shape. */
const NETWORKS_TAB = 'networks';

type TabId = MarketCategory | typeof NETWORKS_TAB;

const TABS: TabId[] = [...MARKET_CATEGORIES, NETWORKS_TAB];

const TAB_LABELS: Record<TabId, string> = {
    tokens: 'Tokens',
    etfs: 'ETFs',
    stocks: 'Stocks',
    metals: 'Metals',
    rwa: 'RWA',
    networks: 'Networks',
};

interface MarketResponse {
    label: string;
    rows: MarketRow[];
    totalCount: number;
    fetchedAt: number;
    cached: boolean;
    missingTickers?: string[];
}

function ChangeCell({ value }: { value: number | null }) {
    if (value === null) return <span className="text-gray-400">—</span>;
    return (
        <span className={cn('tabular-nums', value >= 0 ? 'text-emerald-600' : 'text-red-600')}>
            {formatPercent(value)}
        </span>
    );
}

export function MarketExplorer() {
    const [tab, setTab] = useState<TabId>('tokens');
    const [data, setData] = useState<MarketResponse | null>(null);
    const [networks, setNetworks] = useState<CrossChainLiquidity | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const load = useCallback(async (next: TabId, signal?: AbortSignal) => {
        setIsLoading(true);
        setError(null);
        try {
            const path = next === NETWORKS_TAB ? '/api/market/chains' : `/api/market/${next}?limit=50`;
            const res = await fetch(path, { signal });
            const json = await res.json();
            if (!res.ok) {
                throw new Error(json?.detail || json?.error || `HTTP ${res.status}`);
            }
            if (next === NETWORKS_TAB) {
                setNetworks(json as CrossChainLiquidity);
                setData(null);
            } else {
                setData(json as MarketResponse);
                setNetworks(null);
            }
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            setError(err instanceof Error ? err.message : String(err));
            setData(null);
            setNetworks(null);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        void load(tab, controller.signal);
        return () => controller.abort();
    }, [tab, load]);

    return (
        <div className="mx-auto w-full max-w-5xl px-6 py-10">
            <header className="mb-6">
                <h1 className="text-2xl font-semibold text-gray-900">Market Data</h1>
                <p className="mt-1 text-sm text-gray-500">
                    Quotes from the TradingView screeners — tokens, ETFs, stocks, metals and
                    tokenized real-world assets — plus liquidity across Solana, Base, Stellar and
                    Robinhood.
                </p>
            </header>

            <nav className="mb-4 flex flex-wrap gap-2">
                {TABS.map(item => (
                    <button
                        key={item}
                        type="button"
                        onClick={() => setTab(item)}
                        className={cn(
                            'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                            item === tab
                                ? 'bg-gray-900 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
                        )}
                    >
                        {TAB_LABELS[item]}
                    </button>
                ))}
            </nav>

            <div className="mb-3 flex items-center gap-3 text-xs text-gray-500">
                <button
                    type="button"
                    onClick={() => void load(tab)}
                    disabled={isLoading}
                    className="rounded border border-gray-200 px-2 py-1 font-medium hover:bg-gray-50 disabled:opacity-50"
                >
                    {isLoading ? 'Loading…' : 'Refresh'}
                </button>
                {data && (
                    <span>
                        {data.rows.length} of {data.totalCount.toLocaleString()} ·{' '}
                        {data.cached ? 'cached' : 'live'} ·{' '}
                        {new Date(data.fetchedAt).toLocaleTimeString()}
                    </span>
                )}
                {networks && (
                    <span>
                        {networks.chains.length} networks ·{' '}
                        {new Date(networks.fetchedAt).toLocaleTimeString()}
                    </span>
                )}
            </div>

            {data?.missingTickers && data.missingTickers.length > 0 && (
                <p className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    Unresolved upstream symbols: {data.missingTickers.join(', ')}
                </p>
            )}

            {error && (
                <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                </p>
            )}

            {networks && <NetworksPanel data={networks} />}

            {data && (
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-3 font-medium">Symbol</th>
                                <th className="px-4 py-3 font-medium">Name</th>
                                <th className="px-4 py-3 text-right font-medium">Price</th>
                                <th className="px-4 py-3 text-right font-medium">24h</th>
                                <th className="px-4 py-3 text-right font-medium">Volume</th>
                                <th className="px-4 py-3 text-right font-medium">Mkt Cap / AUM</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {data.rows.map(row => (
                                <tr key={row.id} className="hover:bg-gray-50">
                                    <td className="px-4 py-2.5 font-semibold text-gray-900">
                                        {row.symbol}
                                    </td>
                                    <td className="px-4 py-2.5 text-gray-600">{row.name}</td>
                                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-900">
                                        {formatPrice(row.price)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right">
                                        <ChangeCell value={row.changePercent} />
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">
                                        {formatLargeNumber(row.volume)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">
                                        {formatLargeNumber(row.marketCap)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
