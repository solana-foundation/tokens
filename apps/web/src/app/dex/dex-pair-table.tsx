'use client';

import { cn } from '@tokens/ui/cn';
import { formatLargeNumber, formatPrice } from '@/lib/format';
import type { DexPair } from '@/lib/market-data/dex-pairs';
import { CHAINS } from '@/lib/market-data/chains';

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

/** DEX ids arrive slugged (`uniswap-v4-base`); this is only for display. */
function formatDexName(dex: string | null): string {
    if (!dex) return 'Unknown DEX';
    return dex
        .split('-')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function ChangeCell({ value }: { value: number | null }) {
    if (value === null) return <span className="text-gray-400">—</span>;
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
                    'inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-gray-900',
                    active ? 'text-gray-900' : 'text-gray-500',
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
            <p className="rounded-2xl border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">
                No pairs match these filters.
            </p>
        );
    }

    return (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
            <table className="w-full min-w-[1080px] text-sm">
                <thead className="border-b border-gray-100 bg-gray-50 text-xs">
                    <tr>
                        <th className="w-10 px-3 py-3 text-left font-medium uppercase tracking-wide text-gray-500">
                            #
                        </th>
                        <th className="px-3 py-3 text-left font-medium uppercase tracking-wide text-gray-500">
                            Pair
                        </th>
                        <th className="px-3 py-3 text-right font-medium uppercase tracking-wide text-gray-500">
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
                <tbody className="divide-y divide-gray-100">
                    {pairs.map((pair, index) => (
                        <tr key={`${pair.chain}:${pair.address}`} className="hover:bg-gray-50">
                            <td className="px-3 py-3 text-gray-400 tabular-nums">{index + 1}</td>
                            <td className="px-3 py-3">
                                <a
                                    href={`${CHAINS[pair.chain].explorerUrl}/token/${pair.base.address}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="group flex items-center gap-2"
                                >
                                    <span className="font-semibold text-gray-900 group-hover:underline">
                                        {pair.base.symbol}
                                    </span>
                                    <span className="text-gray-400">/</span>
                                    <span className="text-gray-500">{pair.quote.symbol}</span>
                                    <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                                        {formatDexName(pair.dex)}
                                    </span>
                                </a>
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-gray-900">
                                {formatPrice(pair.priceUsd)}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-gray-500">
                                {formatAge(pair.createdAt)}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-gray-600">
                                {formatCount(
                                    pair.buys24h === null && pair.sells24h === null
                                        ? null
                                        : (pair.buys24h ?? 0) + (pair.sells24h ?? 0),
                                )}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-gray-900">
                                {formatLargeNumber(pair.volume[sort.window])}
                            </td>
                            {CHANGE_WINDOWS.map(window => (
                                <td key={window} className="px-3 py-3 text-right">
                                    <ChangeCell value={pair.priceChange[window]} />
                                </td>
                            ))}
                            <td className="px-3 py-3 text-right tabular-nums text-gray-900">
                                {formatLargeNumber(pair.liquidityUsd)}
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums text-gray-600">
                                {formatLargeNumber(pair.fdvUsd)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
