'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { CopyButton } from '@/components/copy-button';
import { TokenPriceChartCore } from '@/components/charts/token-price-chart-core';
import type { PriceCandle } from '@/components/charts/price-chart-types';
import { CHAINS } from '@/lib/market-data/chains';
import type { DexPair } from '@/lib/market-data/dex-pairs';
import { formatCompactAddress, formatCount, formatPercent, formatUsd } from '@/app/token/[address]/lib/format';
import { formatDepth, formatDexName, isSuspectTurnover, formatTurnover } from '../../dex-pair-health';

interface PairDetailProps {
    pair: DexPair;
    initialCandles: PriceCandle[];
    initialDays: number;
}

const CHANGE_WINDOWS = [
    { key: 'm5', label: '5m' },
    { key: 'h1', label: '1h' },
    { key: 'h6', label: '6h' },
    { key: 'h24', label: '24h' },
] as const;

function formatPrice(value: number | null): string {
    if (value === null) return '—';
    if (value >= 1) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    // Sub-dollar pool prices routinely run to eight decimals; rounding them to
    // two would print "$0.00" for most of the table's tail.
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
}

function formatAge(createdAt: number | null): string {
    if (createdAt === null) return '—';
    const days = Math.floor((Date.now() - createdAt) / (24 * 60 * 60 * 1000));
    if (days < 1) return 'today';
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
}

export function PairDetail({ pair, initialCandles, initialDays }: PairDetailProps) {
    const chain = CHAINS[pair.chain];
    const [timeRangeDays, setTimeRangeDays] = useState(initialDays);
    const [candles, setCandles] = useState<PriceCandle[]>(initialCandles);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadCandles = useCallback(
        async (days: number, signal: AbortSignal) => {
            setIsLoading(true);
            setError(null);
            try {
                const response = await fetch(
                    `/api/dex/${pair.chain}/${encodeURIComponent(pair.address)}/ohlcv?days=${days}`,
                    { signal },
                );
                if (!response.ok) throw new Error(`Chart unavailable (${response.status})`);
                const data = (await response.json()) as { candles?: PriceCandle[] };
                setCandles(Array.isArray(data.candles) ? data.candles : []);
            } catch (caught) {
                if (signal.aborted) return;
                setError(caught instanceof Error ? caught.message : 'Chart unavailable');
            } finally {
                if (!signal.aborted) setIsLoading(false);
            }
        },
        [pair.address, pair.chain],
    );

    useEffect(() => {
        // The initial window is already rendered from the server payload.
        if (timeRangeDays === initialDays) return;

        const controller = new AbortController();
        void loadCandles(timeRangeDays, controller.signal);
        return () => controller.abort();
    }, [initialDays, loadCandles, timeRangeDays]);

    const totalTxns =
        pair.buys24h === null && pair.sells24h === null ? null : (pair.buys24h ?? 0) + (pair.sells24h ?? 0);

    return (
        <div className="mx-auto w-full max-w-[1120px] px-6 pt-28 pb-16">
            <Link
                href={`/dex?chain=${pair.chain}`}
                className="inline-flex items-center gap-2 text-body-md text-text-medium transition-colors hover:text-text-extra-high"
            >
                <ArrowLeft className="size-4" aria-hidden />
                All {chain.label} pairs
            </Link>

            <header className="mt-6 flex flex-wrap items-start justify-between gap-6">
                <div className="flex min-w-0 items-center gap-4">
                    {pair.base.imageUrl ? (
                        <Image
                            src={pair.base.imageUrl}
                            alt=""
                            width={48}
                            height={48}
                            className="size-12 shrink-0 rounded-full bg-gray-50 object-cover"
                            referrerPolicy="no-referrer"
                            unoptimized
                        />
                    ) : (
                        <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-gray-100 text-sm font-semibold text-text-medium">
                            {pair.base.symbol.slice(0, 3)}
                        </div>
                    )}
                    <div className="min-w-0">
                        <h1 className="truncate text-title-lg text-text-extra-high">
                            {pair.base.symbol} <span className="text-text-extra-low">/</span> {pair.quote.symbol}
                        </h1>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-[#F2F3F5] px-2.5 py-1 text-[11px] font-semibold leading-none text-text-medium">
                                {chain.label}
                            </span>
                            <span className="rounded-full bg-[#F2F3F5] px-2.5 py-1 text-[11px] font-semibold leading-none text-text-medium">
                                {formatDexName(pair.dex)}
                            </span>
                            {isSuspectTurnover(pair) ? (
                                <span
                                    title={`24h volume is ${formatTurnover(pair)} this pool's depth — more than any tradable market turns over in a day.`}
                                    className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold leading-none text-amber-800"
                                >
                                    {formatTurnover(pair)} turnover
                                </span>
                            ) : null}
                        </div>
                    </div>
                </div>

                <div className="text-right">
                    <p className="text-title-lg tabular-nums text-text-extra-high">{formatPrice(pair.priceUsd)}</p>
                    <p
                        className={`mt-1 text-body-md tabular-nums ${
                            (pair.priceChange.h24 ?? 0) >= 0 ? 'text-emerald-700' : 'text-red-600'
                        }`}
                    >
                        {formatPercent(pair.priceChange.h24)} · 24h
                    </p>
                </div>
            </header>

            <section className="mt-8">
                <TokenPriceChartCore
                    candles={candles}
                    isLoading={isLoading}
                    error={error}
                    symbol={pair.base.symbol}
                    tokenName={pair.base.name || pair.name}
                    {...(pair.base.imageUrl ? { logoURI: pair.base.imageUrl } : {})}
                    {...(pair.priceUsd !== null ? { currentPrice: pair.priceUsd } : {})}
                    {...(pair.priceChange.h24 !== null ? { priceChange24h: pair.priceChange.h24 } : {})}
                    timeRangeDays={timeRangeDays}
                    onTimeRangeChange={setTimeRangeDays}
                    showIntervalSelector={false}
                    variant="card"
                    shareContext={{ address: pair.base.address }}
                />
            </section>

            <section className="mt-12">
                <h2 className="mb-6 text-title-md text-text-extra-high">Stats</h2>
                <div className="grid grid-cols-2 overflow-hidden md:grid-cols-4 [&>*]:border-border-light [&>*:nth-child(even)]:border-l md:[&>*:nth-child(n+2)]:border-l max-md:[&>*:nth-child(n+3)]:border-t">
                    <Stat label="Liquidity" value={formatDepth(pair.liquidityUsd)} />
                    <Stat label="Volume 24h" value={formatUsd(pair.volume.h24)} />
                    <Stat label="FDV" value={formatUsd(pair.fdvUsd)} />
                    <Stat label="Pool age" value={formatAge(pair.createdAt)} />
                </div>
                <div className="grid grid-cols-2 overflow-hidden border-t border-border-light md:grid-cols-4 [&>*]:border-border-light [&>*:nth-child(even)]:border-l md:[&>*:nth-child(n+2)]:border-l max-md:[&>*:nth-child(n+3)]:border-t">
                    <Stat label="Txns 24h" value={formatCount(totalTxns)} />
                    <Stat label="Buys 24h" value={formatCount(pair.buys24h)} />
                    <Stat label="Sells 24h" value={formatCount(pair.sells24h)} />
                    <Stat label="Volume 6h" value={formatUsd(pair.volume.h6)} />
                </div>
            </section>

            <section className="mt-12">
                <h2 className="mb-6 text-title-md text-text-extra-high">Price change</h2>
                <div className="grid grid-cols-2 overflow-hidden md:grid-cols-4 [&>*]:border-border-light [&>*:nth-child(even)]:border-l md:[&>*:nth-child(n+2)]:border-l max-md:[&>*:nth-child(n+3)]:border-t">
                    {CHANGE_WINDOWS.map(window => {
                        const value = pair.priceChange[window.key];
                        return (
                            <Stat
                                key={window.key}
                                label={window.label}
                                value={formatPercent(value)}
                                tone={value === null ? 'neutral' : value >= 0 ? 'up' : 'down'}
                            />
                        );
                    })}
                </div>
            </section>

            <section className="mt-12">
                <h2 className="mb-6 text-title-md text-text-extra-high">Pool</h2>
                <div className="grid gap-px overflow-hidden md:grid-cols-3 [&>*]:border-border-light md:[&>*:nth-child(n+2)]:border-l">
                    <AddressRow label="Pool address" address={pair.address} />
                    <AddressRow label={`${pair.base.symbol} address`} address={pair.base.address} />
                    <AddressRow label={`${pair.quote.symbol} address`} address={pair.quote.address} />
                </div>
            </section>
        </div>
    );
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'up' | 'down' | 'neutral' }) {
    const toneClass = tone === 'up' ? 'text-emerald-700' : tone === 'down' ? 'text-red-600' : 'text-text-extra-high';

    return (
        <div className="py-5 pl-6 pr-6 first:pl-0 max-md:odd:pl-0">
            <div className="mb-2 text-body-md text-text-medium">{label}</div>
            <p className={`text-title-sm tabular-nums ${toneClass}`}>{value}</p>
        </div>
    );
}

function AddressRow({ label, address }: { label: string; address: string }) {
    return (
        <div className="py-5 pl-6 pr-6 first:pl-0 max-md:pl-0">
            <div className="mb-2 text-body-md text-text-medium">{label}</div>
            {address ? (
                <div className="flex items-center gap-2">
                    <span className="font-mono text-body-md text-text-extra-high">
                        {formatCompactAddress(address)}
                    </span>
                    <CopyButton textToCopy={address} showText={false} />
                </div>
            ) : (
                <p className="text-title-sm text-text-extra-high">—</p>
            )}
        </div>
    );
}
