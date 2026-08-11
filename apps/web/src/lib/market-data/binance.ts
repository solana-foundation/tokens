import 'server-only';

import { Effect } from 'effect';
import { fetchJsonWithRetry } from '@tokens/effect';
import { type MarketRow } from './types';

/**
 * `data-api.binance.vision` is Binance's read-only market-data host: same
 * payloads as `api.binance.com` but no key and no account endpoints.
 *
 * Note: some networks (including ISPs that filter exchange traffic by TLS SNI)
 * reset the connection to every Binance host. Callers must treat this provider
 * as optional — see `fetchBinanceQuotes`, which resolves to `null` instead of
 * throwing so a blocked network degrades to TradingView-only data.
 */
const BINANCE_BASE_URL = process.env.BINANCE_API_URL?.trim() || 'https://data-api.binance.vision';

const REQUEST_TIMEOUT_MS = 8_000;

export interface BinanceCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface RawTicker {
    symbol?: unknown;
    lastPrice?: unknown;
    priceChangePercent?: unknown;
    quoteVolume?: unknown;
}

function parseNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function toMarketRow(raw: RawTicker): MarketRow | null {
    if (typeof raw.symbol !== 'string') return null;

    return {
        id: `BINANCE:${raw.symbol}`,
        symbol: raw.symbol,
        name: raw.symbol,
        price: parseNumber(raw.lastPrice),
        changePercent: parseNumber(raw.priceChangePercent),
        volume: parseNumber(raw.quoteVolume),
        marketCap: null,
        currency: 'USD',
        sector: null,
        source: 'binance',
    };
}

/**
 * Returns `null` when Binance is unreachable rather than throwing, so a
 * blocked or rate-limited exchange never takes down the whole response.
 */
export async function fetchBinanceQuotes(symbols: readonly string[]): Promise<MarketRow[] | null> {
    if (symbols.length === 0) return [];

    const query = encodeURIComponent(JSON.stringify([...symbols]));
    const url = `${BINANCE_BASE_URL}/api/v3/ticker/24hr?symbols=${query}`;

    try {
        const payload = await Effect.runPromise(
            fetchJsonWithRetry<unknown>({
                url,
                service: 'binance',
                init: { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
                maxRetries: 1,
            }),
        );

        if (!Array.isArray(payload)) return null;

        return payload
            .map(item => toMarketRow((item ?? {}) as RawTicker))
            .filter((row): row is MarketRow => row !== null);
    } catch (error) {
        console.warn(
            '[market-data] Binance unreachable, continuing without it:',
            error instanceof Error ? error.message : String(error),
        );
        return null;
    }
}

/** Historical candles for one pair. Returns `null` when Binance is unreachable. */
export async function fetchBinanceKlines(
    symbol: string,
    interval: string,
    limit: number,
): Promise<BinanceCandle[] | null> {
    const url =
        `${BINANCE_BASE_URL}/api/v3/klines` +
        `?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${encodeURIComponent(interval)}` +
        `&limit=${Math.min(Math.max(limit, 1), 1000)}`;

    try {
        const payload = await Effect.runPromise(
            fetchJsonWithRetry<unknown>({
                url,
                service: 'binance',
                init: { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
                maxRetries: 1,
            }),
        );

        if (!Array.isArray(payload)) return null;

        return payload
            .map((entry): BinanceCandle | null => {
                if (!Array.isArray(entry)) return null;
                const time = parseNumber(entry[0]);
                const open = parseNumber(entry[1]);
                const high = parseNumber(entry[2]);
                const low = parseNumber(entry[3]);
                const close = parseNumber(entry[4]);
                const volume = parseNumber(entry[5]);
                if (time === null || open === null || high === null || low === null || close === null) {
                    return null;
                }
                return { time, open, high, low, close, volume: volume ?? 0 };
            })
            .filter((candle): candle is BinanceCandle => candle !== null);
    } catch (error) {
        console.warn(
            '[market-data] Binance klines unavailable:',
            error instanceof Error ? error.message : String(error),
        );
        return null;
    }
}
