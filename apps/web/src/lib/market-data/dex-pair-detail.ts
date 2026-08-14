import 'server-only';

import { withKeyedTtl } from './cache';
import { CHAINS, type ChainId } from './chains';
import type { DexPair } from './dex-pairs';
import { readDexSnapshot } from './dex-snapshot';
import { dexScreenerPairToDexPair, fetchDexScreenerPair } from './dexscreener';
import { fetchGeckoTerminalJson } from './geckoterminal';

/** Loading one pool for its own page, rather than a chain's whole list. */

function num(value: unknown): number | null {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/**
 * One pool, from the warm chain snapshot when it is ranked there and from
 * DexScreener otherwise.
 *
 * The snapshot only holds each chain's top pools, so any pool reached by a
 * pasted address or a search hit lands in the second path — that call is the
 * whole reason the page can serve pools it has never ranked.
 */
export async function fetchDexPairDetail(chain: ChainId, pairAddress: string): Promise<DexPair | null> {
    const needle = pairAddress.trim().toLowerCase();
    if (!needle) return null;

    const ranked = readDexSnapshot(chain).pairs.find(pair => pair.address.toLowerCase() === needle);
    if (ranked) return ranked;

    const live = await fetchDexScreenerPair(chain, pairAddress.trim());
    return live ? dexScreenerPairToDexPair(chain, live, pairAddress.trim()) : null;
}

export interface PoolCandle {
    /** Candle open time in epoch seconds, as the chart components expect. */
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/**
 * Chart windows offered on a pair page, and how each maps upstream. The keys
 * match the day counts in `TIME_RANGES`, so the shared chart's timeframe tabs
 * work here without a translation layer.
 */
export const POOL_CHART_RANGES = {
    1: { timeframe: 'minute', aggregate: 15, limit: 96 },
    7: { timeframe: 'hour', aggregate: 1, limit: 168 },
    30: { timeframe: 'hour', aggregate: 4, limit: 180 },
    90: { timeframe: 'day', aggregate: 1, limit: 90 },
    365: { timeframe: 'day', aggregate: 1, limit: 365 },
} as const;

export type PoolChartRange = keyof typeof POOL_CHART_RANGES;

export function isPoolChartRange(value: number): value is PoolChartRange {
    return Object.prototype.hasOwnProperty.call(POOL_CHART_RANGES, value);
}

/**
 * Five minutes, which is long for a chart and short for this provider: the
 * keyless tier answers 429 to a second call a few seconds after the first, so
 * every reload that re-fetched a pool's candles would mostly return errors.
 */
const OHLCV_TTL_MS = 5 * 60 * 1000;

const loadCandles = withKeyedTtl(OHLCV_TTL_MS, async (key: string): Promise<PoolCandle[]> => {
    const [chain, address, rawDays] = key.split('|');
    const days = Number.parseInt(rawDays ?? '', 10);
    const range = POOL_CHART_RANGES[(isPoolChartRange(days) ? days : 7) as PoolChartRange];
    const network = CHAINS[chain as ChainId].geckoterminalNetwork;

    const payload = await fetchGeckoTerminalJson(
        `/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(address ?? '')}` +
            `/ohlcv/${range.timeframe}?aggregate=${range.aggregate}&limit=${range.limit}`,
    );

    const list = (payload as { data?: { attributes?: { ohlcv_list?: unknown } } })?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return [];

    const candles: PoolCandle[] = [];
    for (const entry of list) {
        if (!Array.isArray(entry) || entry.length < 5) continue;
        const [time, open, high, low, close, volume] = entry as unknown[];
        const parsed = {
            time: num(time),
            open: num(open),
            high: num(high),
            low: num(low),
            close: num(close),
            volume: num(volume) ?? 0,
        };
        if (parsed.time === null || parsed.open === null || parsed.high === null || parsed.low === null || parsed.close === null) {
            continue;
        }
        candles.push(parsed as PoolCandle);
    }

    // Upstream returns newest first; charts read left to right.
    return candles.sort((a, b) => a.time - b.time);
});

export async function fetchPoolCandles(
    chain: ChainId,
    pairAddress: string,
    days: PoolChartRange,
): Promise<PoolCandle[]> {
    try {
        return await loadCandles(`${chain}|${pairAddress}|${days}`);
    } catch (error) {
        console.warn(
            `[dex-pair-detail] candles unavailable for ${chain}/${pairAddress}:`,
            error instanceof Error ? error.message : String(error),
        );
        return [];
    }
}
