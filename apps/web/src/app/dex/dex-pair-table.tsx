'use client';

import Link from 'next/link';

import { cn } from '@tokens/ui/cn';
import { formatLargeNumber, formatPrice } from '@/lib/format';
import type { DexPair } from '@/lib/market-data/dex-pairs';
import { formatDepth, formatDexName, formatTurnover, isSuspectTurnover } from './dex-pair-health';

/**
 * The pair table. Column set follows what a pair explorer is read for —
 * price, age, trade count, volume and depth per pool — rather than the
 * asset-level columns the homepage shows.
 */

export type SortKey = 'volume' | 'liquidity' | 'fdv' | 'age' | 'txns' | 'change';

export interface SortState {
    key: SortKey;
    /** The change/volume window a sort on those columns reads. */
    window: keyof DexPair['volume'];
    desc: boolean;
}

const WINDOW_LABELS: Record<keyof DexPair['volume'], string> = {
    m5: '5M',
    h1: '1H',
    h6: '6H',
    h24: '24H',
};

export const CHANGE_WINDOWS = ['m5', 'h1', 'h6', 'h24'] as const;

function formatAge(createdAt: number | null): string {
    if (createdAt === null) return '—';
    const minutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60_000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 365) return `${days}d`;
    return `${Math.floor(days / 365)}y`;
}

function formatCount(value: number | null): string {
    if (value === null) return '—';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(value);
}

function ChangeCell({ value }: { value: number | null }) {
    if (value === null) return <span className="text-text-extra-low">—</span>;
    const sign = value >= 0 ? '+' : '';
    return (
        <span className={cn('tabular-nums', value >= 0 ? 'text-emerald-600' : 'text-red-600')}>
            {sign}
            {value.toFixed(2)}%
        </span>
    );
}

function SortHeader({
    label,
    active,
    desc,
    align = 'right',
    onClick,
}: {
    label: string;
    active: boolean;
    desc: boolean;
    align?: 'left' | 'right';
    onClick: () => void;
}) {
    return (
        <th className={cn('px-3 py-3 font-medium', align === 'right' ? 'text-right' : 'text-left')}>
            <button
                type="button"
                onClick={onClick}
                className={cn(
                    'inline-flex cursor-pointer items-center gap-1 font-semibold uppercase tracking-wide transition-colors hover:text-text-extra-high',
                    active ? 'text-text-extra-high' : 'text-text-extra-low',
                )}
            >
                {label}
                <span aria-hidden className={cn('text-[9px]', active ? 'opacity-100' : 'opacity-0')}>
                    {desc ? '▼' : '▲'}
                </span>
            </button>
        </th>
    );
}

export function DexPairTable({
    pairs,
    sort,
    onSortChange,
}: {
    pairs: DexPair[];
    sort: SortState;
    onSortChange: (next: SortState) => void;
}) {
    function toggle(key: SortKey, window?: keyof DexPair['volume']) {
        const sameColumn = sort.key === key && (window === undefined || sort.window === window);
        onSortChange({
            key,
            window: window ?? sort.window,
            // First click on a new column sorts descending — for every column
            // here the interesting end is the large one.
            desc: sameColumn ? !sort.desc : true,
        });
    }

    if (pairs.length === 0) {
        return (
            <p className="rounded-2xl border border-border-light bg-white px-4 py-10 text-center text-sm text-text-medium">
                No pairs match these filters.
            </p>
        );
    }

    return (
        <div className="overflow-x-auto rounded-2xl border border-border-light bg-white">
            <table className="w-full min-w-[1080px] text-sm">
                <thead className="border-b border-border-extra-light bg-gray-50/80 text-xs">
                    <tr>
                        <th className="w-10 px-3 py-3 text-left font-semibold uppercase tracking-wide text-text-extra-low">
                            #
                        </th>
                        <th className="px-3 py-3 text-left font-semibold uppercase tracking-wide text-text-extra-low">
                            Pair
                        </th>
                        <th className="px-3 py-3 text-right font-semibold uppercase tracking-wide text-text-extra-low">
                            Price
                        </th>
                        <SortHeader label="Age" active={sort.key === 'age'} desc={sort.desc} onClick={() => toggle('age')} />
                        <SortHeader
                            label="Txns"
                            active={sort.key === 'txns'}
                            desc={sort.desc}
                            onClick={() => toggle('txns')}
                        />
                        <SortHeader
                            label={`Volume ${WINDOW_LABELS[sort.window]}`}
                            active={sort.key === 'volume'}
                            desc={sort.desc}
                            onClick={() => toggle('volume')}
                        />
                        {CHANGE_WINDOWS.map(window => (
                            <SortHeader
                                key={window}
                                label={WINDOW_LABELS[window]}
                                active={sort.key === 'change' && sort.window === window}
                                desc={sort.desc}
                                onClick={() => toggle('change', window)}
                            />
                        ))}
                        <SortHeader
                            label="Liquidity"
                            active={sort.key === 'liquidity'}
                            desc={sort.desc}
                            onClick={() => toggle('liquidity')}
                        />
                        <SortHeader
                            label="FDV"
                            active={sort.key === 'fdv'}
                            desc={sort.desc}
                            onClick={() => toggle('fdv')}
                        />
                    </tr>
                </thead>
                <tbody className="divide-y divide-border-extra-light">
                    {pairs.map((pair, index) => (
                        <tr key={`${pair.chain}:${pair.address}`} className="hover:bg-gray-50">
                            <td className="px-3 py-3 text-text-extra-low tabular-nums">{index + 1}</td>
                            <td className="px-3 py-3">
                                <Link
                                    href={`/dex/${pair.chain}/${encodeURIComponent(pair.address)}`}
                                    className="group flex items-center gap-2"
                                >
                                    <span className="font-semibold text-text-extra-high group-hover:underline">
                                        {pair.base.symbol}
                                    </span>
                                    <span className="text-text-extra-low">/</span>
                                    <span className="text-text-medium">{pair.quote.symbol}</span>
                                    <span className="ml-1 rounded-full bg-[#F2F3F5] px-2 py-0.5 text-[11px] font-semibold text-text-medium">
                                        {formatDexName(pair.dex)}
                                    </span>
                                    {isSuspectTurnover(pair) && (
                                        <span
                                            title={`24h volume is ${formatTurnover(pair)} this pool's depth — more than any tradable market turns over in a day.`}
                                            className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
                                        >
                                            {formatTurnover(pair)}
                                        </span>
                                    )}
                                </Link>
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-[#2D2D2D] font-medium">
                                {formatPrice(pair.priceUsd)}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-text-low">
                                {formatAge(pair.createdAt)}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-text-medium">
                                {formatCount(
                                    pair.buys24h === null && pair.sells24h === null
                                        ? null
                                        : (pair.buys24h ?? 0) + (pair.sells24h ?? 0),
                                )}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-[#2D2D2D] font-medium">
                                {formatLargeNumber(pair.volume[sort.window])}
                            </td>
                            {CHANGE_WINDOWS.map(window => (
                                <td key={window} className="px-3 py-3 text-right">
                                    <ChangeCell value={pair.priceChange[window]} />
                                </td>
                            ))}
                            <td className="px-3 py-3 text-right tabular-nums text-[#2D2D2D] font-medium">
                                {formatDepth(pair.liquidityUsd)}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-text-medium">
                                {formatLargeNumber(pair.fdvUsd)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
