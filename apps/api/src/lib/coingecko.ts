import { cache } from 'react';
import { Effect } from 'effect';

import { UpstreamHttpError } from '@tokens/effect';
import { fetchJsonWithRetry } from '@tokens/effect';
import { CoinGeckoResponseSchema } from './coingecko.schemas';
import { buildXProfileUrl } from './social-links';

const COINGECKO_PUBLIC_API_URL = 'https://api.coingecko.com/api/v3';
const COINGECKO_PRO_API_URL = 'https://pro-api.coingecko.com/api/v3';

function getCoinGeckoRequestConfig(): { baseUrl: string; headers: Record<string, string> } {
    const apiKey = process.env.COINGECKO_API_KEY?.trim();
    if (apiKey) {
        return {
            baseUrl: COINGECKO_PRO_API_URL,
            headers: {
                Accept: 'application/json',
                'x-cg-pro-api-key': apiKey,
            },
        };
    }

    return {
        baseUrl: COINGECKO_PUBLIC_API_URL,
        headers: {
            Accept: 'application/json',
        },
    };
}

export interface TokenLinks {
    website?: string;
    twitter?: string;
    telegram?: string;
    discord?: string;
    reddit?: string;
}

export interface GlobalTokenStats {
    marketCap: number;
    fdv: number;
    /** Canonical supply; `null` when the provider has no value (`maxSupply` also for uncapped assets). */
    circulatingSupply: number | null;
    totalSupply: number | null;
    maxSupply: number | null;
    price: number;
    priceChange24h: number;
    volume24h: number;
    allTimeHigh: number;
    allTimeHighDate: string;
    description?: string;
    links?: TokenLinks;
}

interface CoinGeckoResponse {
    id: string;
    symbol: string;
    name: string;
    description?: {
        en?: string;
    };
    links?: {
        homepage?: string[];
        twitter_screen_name?: string;
        telegram_channel_identifier?: string;
        subreddit_url?: string;
        chat_url?: string[];
        official_forum_url?: string[];
    };
    market_data: {
        current_price: { usd: number };
        market_cap: { usd: number };
        fully_diluted_valuation: { usd: number };
        total_volume: { usd: number };
        circulating_supply: number | null;
        total_supply: number | null;
        max_supply?: number | null;
        price_change_percentage_24h: number;
        ath: { usd: number };
        ath_date: { usd: string };
    };
}

function extractLinks(links?: CoinGeckoResponse['links']): TokenLinks | undefined {
    if (!links) return undefined;

    const result: TokenLinks = {};

    // Get first valid homepage URL
    const website = links.homepage?.find(url => url && url.length > 0);
    if (website) result.website = website;

    const twitter = buildXProfileUrl(links.twitter_screen_name ?? '');
    if (twitter) result.twitter = twitter;

    // Telegram
    if (links.telegram_channel_identifier) {
        result.telegram = `https://t.me/${links.telegram_channel_identifier}`;
    }

    // Reddit
    if (links.subreddit_url && links.subreddit_url.length > 0) {
        result.reddit = links.subreddit_url;
    }

    // Discord - check chat_url for discord links
    const discordUrl = links.chat_url?.find(url => url?.includes('discord'));
    if (discordUrl) result.discord = discordUrl;

    return Object.keys(result).length > 0 ? result : undefined;
}

async function getGlobalTokenStatsImpl(coingeckoId: string): Promise<GlobalTokenStats | null> {
    const { baseUrl, headers } = getCoinGeckoRequestConfig();
    const url = `${baseUrl}/coins/${encodeURIComponent(
        coingeckoId,
    )}?localization=false&tickers=false&community_data=false&developer_data=false`;

    return await Effect.runPromise(
        fetchJsonWithRetry<CoinGeckoResponse>({
            url,
            service: 'coingecko',
            schema: CoinGeckoResponseSchema,
            init: { headers, next: { revalidate: 300 } }, // Cache for 5 minutes
            maxRetries: 2,
        }).pipe(
            Effect.map(data => {
                const { market_data, description, links } = data;
                return {
                    marketCap: market_data.market_cap?.usd ?? 0,
                    fdv: market_data.fully_diluted_valuation?.usd ?? 0,
                    circulatingSupply: market_data.circulating_supply ?? null,
                    totalSupply: market_data.total_supply ?? null,
                    maxSupply: market_data.max_supply ?? null,
                    price: market_data.current_price?.usd ?? 0,
                    priceChange24h: market_data.price_change_percentage_24h ?? 0,
                    volume24h: market_data.total_volume?.usd ?? 0,
                    allTimeHigh: market_data.ath?.usd ?? 0,
                    allTimeHighDate: market_data.ath_date?.usd ?? '',
                    description: description?.en || undefined,
                    links: extractLinks(links),
                } satisfies GlobalTokenStats;
            }),
            Effect.catch(error => {
                if (error instanceof UpstreamHttpError && error.status === 404) {
                    console.warn('CoinGecko coin not found', { coingeckoId });
                    return Effect.succeed(null);
                }
                console.error('Failed to fetch CoinGecko data:', error);
                return Effect.succeed(null);
            }),
        ),
    );
}

/**
 * Per-request deduplication for server rendering (e.g. multiple sections reading CoinGecko).
 */
export const getGlobalTokenStats = cache(getGlobalTokenStatsImpl);
