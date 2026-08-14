import type { DexPair } from '@/lib/market-data/dex-pairs';

/**
 * Turnover screening for pool rows.
 *
 * Sorting pools by volume puts wash-traded ones on top: the highest-volume
 * Solana pool at the time of writing reported $216M of 24h volume against
 * $0.0000075 of reserves. Nobody traded $216M through seven millionths of a
 * dollar of depth, and a table that ranks on volume without saying so presents
 * that pool as the most active market on the chain.
 *
 * The flag is deliberately a label, not a filter — the rows stay visible and
 * the reader decides. Hiding them silently would be the same failure in the
 * other direction.
 */

/**
 * Daily turnover (24h volume ÷ depth) above which a pool is called out. A
 * working AMM pool cycles a fraction of its reserves to a few multiples per
 * day; two orders of magnitude past that is not a busy market, it is a number
 * that does not describe a tradable one.
 */
export const SUSPECT_TURNOVER_RATIO = 100;

/** Below this, "depth" is small enough that any turnover ratio is noise. */
const NEGLIGIBLE_LIQUIDITY_USD = 1_000;

export function turnoverRatio(pair: DexPair): number | null {
    const volume = pair.volume.h24;
    const liquidity = pair.liquidityUsd;
    if (volume === null || liquidity === null || liquidity <= 0) return null;
    return volume / liquidity;
}

export function isSuspectTurnover(pair: DexPair): boolean {
    const volume = pair.volume.h24 ?? 0;
    if (volume <= 0) return false;

    // No reserves at all, or reserves too small to route the reported volume
    // through, is the same finding as an extreme ratio.
    const liquidity = pair.liquidityUsd;
    if (liquidity === null || liquidity < NEGLIGIBLE_LIQUIDITY_USD) return true;

    return volume / liquidity >= SUSPECT_TURNOVER_RATIO;
}

/** Compact turnover label, e.g. `2.9e13×` or `340×`. */
export function formatTurnover(pair: DexPair): string {
    const ratio = turnoverRatio(pair);
    if (ratio === null) return 'no depth';
    if (ratio >= 10_000) return `${ratio.toExponential(1)}×`;
    return `${Math.round(ratio).toLocaleString('en-US')}×`;
}

/**
 * USD depth for the pair table.
 *
 * `formatLargeNumber` rounds sub-cent values to "$0.00", which is the same
 * claim-of-zero this codebase already had to remove from the liquidity column.
 * A pool with seven millionths of a dollar in it reads "<$0.01" instead.
 */
/** DEX ids arrive slugged (`uniswap-v4-base`); this is only for display. */
export function formatDexName(dex: string | null): string {
    if (!dex) return 'Unknown DEX';
    return dex
        .split('-')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

export function formatDepth(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—';
    if (value === 0) return '$0';
    if (value < 0.01) return '<$0.01';
    if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
    return `$${value.toFixed(2)}`;
}
