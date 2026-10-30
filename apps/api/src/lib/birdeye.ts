import { cache } from 'react';
import { Effect } from 'effect';

import { BadRequestError } from '@tokens/effect';
import { fetchJsonWithRetry } from '@tokens/effect';
import { BirdeyeOverviewResponseSchema } from './birdeye.schemas';

const BIRDEYE_API_URL = 'https://public-api.birdeye.so';

interface TokenExtensions {
    coingeckoId?: string;
    website?: string;
    twitter?: string;
    discord?: string;
    telegram?: string;
    description?: string;
    github?: string;
}

export interface TokenOverview {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
    extensions?: TokenExtensions;
    price: number;
    priceChange24hPercent: number;
    marketCap: number;
    fdv: number;
    liquidity: number;
    volume24h: number;
    holder: number;
    totalSupply: number;
    circulatingSupply: number;
    lastTradeHumanTime: string;
}

interface BirdeyeOverviewResponse {
    success: boolean;
    data: {
        address: string;
        name: string;
        symbol: string;
        decimals: number;
        logoURI?: string;
        extensions?: TokenExtensions;
        price: number;
        priceChange24hPercent: number;
        marketCap: number;
        fdv: number;
        liquidity: number;
        v24h: number;
        v24hUSD: number;
        holder: number;
        totalSupply: number;
        circulatingSupply: number;
        lastTradeHumanTime: string;
    };
}

function fetchTokenOverview(apiKey: string, address: string) {
    return fetchJsonWithRetry<BirdeyeOverviewResponse>({
        schema: BirdeyeOverviewResponseSchema,
        url: `${BIRDEYE_API_URL}/defi/token_overview?address=${address}`,
        service: 'birdeye',
        init: {
            headers: {
                'X-API-KEY': apiKey,
                'x-chain': 'solana',
            },
            next: { revalidate: 60 }, // Cache for 1 minute (data changes frequently)
        },
        maxRetries: 3,
    }).pipe(
        Effect.flatMap(result => {
            if (!result.success) {
                return Effect.fail(
                    new BadRequestError({
                        message: 'Birdeye API returned unsuccessful response',
                        details: { address },
                    }),
                );
            }

            const { data } = result;

            return Effect.succeed({
                address: data.address,
                name: data.name,
                symbol: data.symbol,
                decimals: data.decimals,
                logoURI: data.logoURI,
                extensions: data.extensions,
                price: data.price,
                priceChange24hPercent: data.priceChange24hPercent,
                marketCap: data.marketCap,
                fdv: data.fdv,
                liquidity: data.liquidity,
                volume24h: data.v24hUSD,
                holder: data.holder,
                totalSupply: data.totalSupply,
                circulatingSupply: data.circulatingSupply,
                lastTradeHumanTime: data.lastTradeHumanTime,
            } satisfies TokenOverview);
        }),
    );
}

async function getTokenOverviewImpl(address: string): Promise<TokenOverview | null> {
    const apiKey = process.env.BIRDEYE_API_KEY;

    if (!apiKey) {
        throw new Error('BIRDEYE_API_KEY environment variable is not set');
    }

    return await Effect.runPromise(fetchTokenOverview(apiKey, address));
}

/**
 * Per-request deduplication for server rendering.
 * Useful when `getTokenOverview()` is called multiple times within a single request
 * (e.g. `generateMetadata()` + page render).
 */
export const getTokenOverview = cache(getTokenOverviewImpl);

export interface OHLCVData {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    /** Candle volume in USD. Prefer Birdeye OHLCV v3 `v_usd`. */
    volume: number;
}

interface BirdeyeOHLCVResponse {
    success: boolean;
    data: {
        items: Array<{
            unixTime?: number;
            unix_time?: number;
            time?: number;
            o?: number;
            open?: number;
            h?: number;
            high?: number;
            l?: number;
            low?: number;
            c?: number;
            close?: number;
            v?: number;
            volume?: number;
            v_usd?: number;
            volumeUsd?: number;
            volume_usd?: number;
            volumeUSD?: number;
        }>;
    };
}

export type TimeInterval = '1m' | '5m' | '15m' | '1H' | '4H' | '1D' | '1W';

function toFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function normalizeOhlcvItem(item: BirdeyeOHLCVResponse['data']['items'][number]): OHLCVData | null {
    const rawTime = toFiniteNumber(item.unixTime ?? item.unix_time ?? item.time);
    if (rawTime === null) return null;

    // Birdeye uses seconds; normalize if milliseconds are returned.
    const time = rawTime > 1e12 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);

    const open = toFiniteNumber(item.o ?? item.open);
    const high = toFiniteNumber(item.h ?? item.high);
    const low = toFiniteNumber(item.l ?? item.low);
    const close = toFiniteNumber(item.c ?? item.close);

    if (open === null || high === null || low === null || close === null) return null;

    const volumeUsd = toFiniteNumber(item.v_usd ?? item.volumeUsd ?? item.volume_usd ?? item.volumeUSD);
    const tokenVolume = toFiniteNumber(item.v ?? item.volume);
    const volume = volumeUsd ?? (tokenVolume !== null ? tokenVolume * close : 0);

    return { time, open, high, low, close, volume };
}

export interface TokenMarketToken {
    address: string;
    decimals?: number;
    symbol?: string;
    icon?: string;
    name?: string;
}

export interface TokenMarket {
    /** Market/pool address */
    address: string;
    /** Human-readable name like "JitoSOL-SOL" */
    name?: string;
    base?: TokenMarketToken;
    quote?: TokenMarketToken;
    source?: string;
    createdAt?: string;
    liquidity?: number;
    volume24h?: number;
    trade24h?: number;
    trade24hChangePercent?: number;
    uniqueWallet24h?: number;
    uniqueWallet24hChangePercent?: number;
    price?: number | null;
}

export async function getTokenOHLCV(
    address: string,
    interval: TimeInterval = '1H',
    timeFrom?: number,
    timeTo?: number,
): Promise<OHLCVData[]> {
    const apiKey = process.env.BIRDEYE_API_KEY;

    if (!apiKey) {
        throw new Error('BIRDEYE_API_KEY environment variable is not set');
    }

    // Default to last 7 days if no time range specified
    const now = Math.floor(Date.now() / 1000);
    const from = timeFrom ?? now - 7 * 24 * 60 * 60;
    const to = timeTo ?? now;

    const params = new URLSearchParams({
        address,
        type: interval,
        time_from: from.toString(),
        time_to: to.toString(),
    });

    const result = await Effect.runPromise(
        fetchJsonWithRetry<BirdeyeOHLCVResponse>({
            url: `${BIRDEYE_API_URL}/defi/v3/ohlcv?${params}`,
            service: 'birdeye',
            init: {
                headers: {
                    'X-API-KEY': apiKey,
                    'x-chain': 'solana',
                },
                next: { revalidate: 300 }, // Cache for 5 minutes
            },
            maxRetries: 3,
        }),
    );

    if (!result.success || !result.data?.items) {
        return [];
    }

    return result.data.items.map(normalizeOhlcvItem).filter((v): v is OHLCVData => v !== null);
}
