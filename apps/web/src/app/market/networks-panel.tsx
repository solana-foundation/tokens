'use client';

import { cn } from '@tokens/ui/cn';
import { formatLargeNumber } from '@/lib/format';
import type { CrossChainLiquidity } from '@/lib/market-data/cross-chain';

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
    return (
        <div>
            <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
            <div className={cn('mt-0.5 tabular-nums', muted ? 'text-gray-400' : 'text-gray-900')}>
                {value}
            </div>
        </div>
    );
}

export function NetworksPanel({ data }: { data: CrossChainLiquidity }) {
    const { chains, totals } = data;

    return (
        <div className="space-y-4">
            <section className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    <Stat label="Protocol TVL" value={formatLargeNumber(totals.tvlUsd)} />
                    <Stat
                        label="Sampled DEX depth"
                        value={formatLargeNumber(totals.sampledDexLiquidityUsd)}
                    />
                    <Stat label="24h DEX volume" value={formatLargeNumber(totals.sampledDexVolume24hUsd)} />
                </div>
                <p className="mt-3 text-xs leading-relaxed text-gray-500">
                    TVL and DEX depth are kept separate rather than summed — TVL is everything locked
                    in a chain&apos;s protocols, DEX depth is what is quotable right now. Depth samples
                    the 20 highest-volume pools per chain, so it is a comparable lower bound, not
                    total chain liquidity.
                </p>
            </section>

            {totals.degradedChains.length > 0 && (
                <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    DEX data unavailable this cycle for: {totals.degradedChains.join(', ')}
                </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
                {chains.map(chain => (
                    <article key={chain.id} className="rounded-lg border border-gray-200 p-4">
                        <header className="mb-3 flex items-baseline justify-between">
                            <h3 className="font-semibold text-gray-900">{chain.label}</h3>
                            <span className="text-xs text-gray-400">{chain.nativeSymbol}</span>
                        </header>

                        <div className="grid grid-cols-3 gap-3 text-sm">
                            <Stat
                                label="TVL"
                                value={chain.tvlTracked ? formatLargeNumber(chain.tvlUsd) : 'not tracked'}
                                muted={!chain.tvlTracked}
                            />
                            <Stat label="Depth" value={formatLargeNumber(chain.sampledDexLiquidityUsd)} />
                            <Stat label="24h vol" value={formatLargeNumber(chain.sampledDexVolume24hUsd)} />
                        </div>

                        {chain.poolsWithInvalidLiquidity > 0 && (
                            <p className="mt-2 text-[11px] text-amber-700">
                                {chain.poolsWithInvalidLiquidity} pool reported a negative reserve and
                                was excluded from depth.
                            </p>
                        )}

                        {chain.topPools.length > 0 && (
                            <ul className="mt-3 space-y-1 border-t border-gray-100 pt-3">
                                {chain.topPools.map(pool => (
                                    <li
                                        key={`${chain.id}-${pool.name}-${pool.dex ?? 'dex'}`}
                                        className="flex items-baseline justify-between gap-3 text-xs"
                                    >
                                        <span className="truncate text-gray-600">{pool.name}</span>
                                        <span className="shrink-0 tabular-nums text-gray-500">
                                            {formatLargeNumber(pool.liquidityUsd)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </article>
                ))}
            </div>
        </div>
    );
}
