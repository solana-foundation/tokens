import { Effect } from 'effect';

import { tokenMarketsGetLatestByMint } from '@/lib/cloudrun';
import { coingeckoGetCoinById, coingeckoListOhlcv } from '@/lib/cloudrun';
import { ohlcvList, stockOhlcvList } from '@/lib/cloudrun';
import type { OHLCVData, TimeInterval } from '@/lib/birdeye';
import type { GlobalTokenStats, TokenLinks } from '@/lib/coingecko';
import { buildXProfileUrl } from '@/lib/social-links';
import { getCuratedListSlugsForMint } from '@/lib/curated-membership';
import { computeMarketScore, type MarketScoreInput } from '@/lib/token-risk-helpers';

import type { TokenMarketSnapshot } from './_asset-helpers';
import {
    type AssetIncludeError,
    type AssetIncludeOk,
    type AssetIncludeResult,
    type AssetMarketsInclude,
    type AssetRiskInclude,
} from './_asset-detail-types';
import { DEFAULT_MARKETS_STALE_MS } from './_market-cache';
import {
    scheduleCacheWarm,
    scheduleCoingeckoOhlcvWarm,
    scheduleCoinMetadataWarm,
    scheduleStockOhlcvWarm,
} from './_asset-detail-warm';

export function includeOk<T>(data: T): AssetIncludeOk<T> {
    return { ok: true, data };
}

export function includeError(reason: AssetIncludeError['reason'], message: string): AssetIncludeError {
    return { ok: false, reason, message };
}

function estimate7dVolume(volume24h: number | null): number | null {
    if (volume24h == null || volume24h <= 0) return null;
    return volume24h * 7;
}

function intervalToSeconds(interval: TimeInterval): number {
    switch (interval) {
        case '1m':
            return 60;
        case '5m':
            return 5 * 60;
        case '15m':
            return 15 * 60;
        case '1H':
            return 60 * 60;
        case '4H':
            return 4 * 60 * 60;
        case '1D':
            return 24 * 60 * 60;
        case '1W':
            return 7 * 24 * 60 * 60;
        default:
            return 60 * 60;
    }
}

function getLatestClose(candles: readonly OHLCVData[]): number | null {
    const close = candles.at(-1)?.close;
    return typeof close === 'number' && Number.isFinite(close) && close > 0 ? close : null;
}

function getCloseRange(candles: readonly OHLCVData[]): { min: number; max: number } | null {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (const candle of candles) {
        const close = candle.close;
        if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) continue;
        min = Math.min(min, close);
        max = Math.max(max, close);
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return { min, max };
}

function shouldUseCanonicalFallbackForUnhealthyVariant(params: {
    candles: readonly OHLCVData[];
    canonicalCandles: readonly OHLCVData[];
    expectedCount: number;
    isStale: boolean;
}): boolean {
    if (params.canonicalCandles.length === 0) return false;
    if (params.candles.length === 0 || params.isStale) return true;

    const minUsefulCoverage = Math.max(3, Math.floor(params.expectedCount * 0.5));
    if (params.candles.length < minUsefulCoverage && params.canonicalCandles.length > params.candles.length) {
        return true;
    }

    const latest = getLatestClose(params.candles);
    const canonicalLatest = getLatestClose(params.canonicalCandles);
    if (latest !== null && canonicalLatest !== null) {
        const divergence = Math.abs(latest / canonicalLatest - 1);
        if (divergence > 0.1) return true;
    }

    const range = getCloseRange(params.candles);
    const canonicalRange = getCloseRange(params.canonicalCandles);
    if (range && canonicalRange) {
        if (range.min < canonicalRange.min * 0.9) return true;
        if (range.max > canonicalRange.max * 1.1) return true;
    }

    return false;
}

function toMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function extractLinksFromCoinData(links?: {
    homepage?: string[];
    twitter_screen_name?: string | null;
    telegram_channel_identifier?: string | null;
    subreddit_url?: string | null;
    chat_url?: string[];
}): TokenLinks | undefined {
    if (!links) return undefined;

    const website = links.homepage?.find(url => typeof url === 'string' && url.trim().length > 0);
    const twitter = typeof links.twitter_screen_name === 'string' ? buildXProfileUrl(links.twitter_screen_name) : null;
    const telegram =
        typeof links.telegram_channel_identifier === 'string' && links.telegram_channel_identifier.trim().length > 0
            ? `https://t.me/${links.telegram_channel_identifier.trim()}`
            : undefined;
    const reddit =
        typeof links.subreddit_url === 'string' && links.subreddit_url.trim().length > 0
            ? links.subreddit_url
            : undefined;
    const discord = links.chat_url?.find(url => typeof url === 'string' && url.includes('discord'));

    const out: TokenLinks = {
        ...(website ? { website } : {}),
        ...(twitter ? { twitter } : {}),
        ...(telegram ? { telegram } : {}),
        ...(discord ? { discord } : {}),
        ...(reddit ? { reddit } : {}),
    };

    return Object.keys(out).length > 0 ? out : undefined;
}

function pickEnglishDescription(description?: Record<string, string> | null): string | undefined {
    if (!description) return undefined;
    const en = description.en;
    if (typeof en === 'string' && en.trim().length > 0) return en;
    return undefined;
}

export function loadProfileInclude(params: {
    coingeckoId: string | undefined;
}): Effect.Effect<AssetIncludeResult<GlobalTokenStats>, never> {
    return Effect.gen(function* () {
        const id = (params.coingeckoId ?? '').trim();
        if (!id) return includeError('not_available', 'Profile not available for this asset');

        const coinDoc = yield* coingeckoGetCoinById({ id });
        if (!coinDoc || !coinDoc.coin) {
            yield* scheduleCoinMetadataWarm({ coinId: id });
            return includeError('not_found', 'Profile not available in cache');
        }

        const md = coinDoc.coin.market_data;
        const price = md?.current_price?.usd;
        if (typeof price !== 'number' || !Number.isFinite(price)) {
            yield* scheduleCoinMetadataWarm({ coinId: id });
            return includeError('not_found', 'Profile not available in cache');
        }

        const description = pickEnglishDescription(coinDoc.coin.description);
        const links = extractLinksFromCoinData(coinDoc.coin.links);

        return includeOk({
            marketCap: md?.market_cap?.usd ?? 0,
            fdv: md?.fully_diluted_valuation?.usd ?? 0,
            circulatingSupply: md?.circulating_supply ?? 0,
            totalSupply: md?.total_supply ?? 0,
            price,
            priceChange24h: md?.price_change_percentage_24h ?? 0,
            volume24h: md?.total_volume?.usd ?? 0,
            allTimeHigh: md?.ath?.usd ?? 0,
            allTimeHighDate: md?.ath_date?.usd ?? '',
            ...(description ? { description } : {}),
            ...(links ? { links } : {}),
        } satisfies GlobalTokenStats);
    }).pipe(Effect.catch(error => Effect.succeed(includeError('error', toMessage(error)))));
}

export function loadRiskInclude(params: {
    primaryMint: string;
    market: TokenMarketSnapshot | undefined;
}): Effect.Effect<AssetIncludeResult<AssetRiskInclude>, never> {
    const volume24hUsd = params.market?.volume24hUSD ?? null;
    const volume7dUsd = estimate7dVolume(volume24hUsd);

    return Effect.gen(function* () {
        const curatedListSlugs = yield* Effect.promise(() => getCuratedListSlugsForMint(params.primaryMint));
        const marketScoreInput: MarketScoreInput = {
            liquidityUsd: params.market?.liquidity ?? null,
            marketCapUsd: params.market?.marketCap ?? null,
            holderCount: null,
            top10HoldersPercent: null,
            volume24hUsd,
            volume7dUsd,
            tokenMintTime: null,
            tokenAddress: params.primaryMint,
            curatedListSlugs,
        };

        const marketScore = computeMarketScore(marketScoreInput);

        return includeOk({
            tokenData: null,
            tradingData: null,
            marketScoreInput,
            marketScore,
        } satisfies AssetRiskInclude);
    });
}

export function loadMarketsInclude(
    request: Request,
    params: {
        primaryMint: string;
        offset: number;
        limit: number;
        staleMs?: number;
    },
): Effect.Effect<AssetIncludeResult<AssetMarketsInclude>, never> {
    return Effect.gen(function* () {
        const doc = yield* tokenMarketsGetLatestByMint({ mint: params.primaryMint });
        if (!doc) {
            yield* scheduleCacheWarm(request, { mint: params.primaryMint, markets: true, minAgeMs: 0 });
            return includeError('not_found', 'Markets not found in cache');
        }

        const staleMs = params.staleMs ?? DEFAULT_MARKETS_STALE_MS;
        const isStale = Date.now() - doc.lastFetchedAt > staleMs;
        if (doc.total <= 0 || isStale) {
            yield* scheduleCacheWarm(request, {
                mint: params.primaryMint,
                markets: true,
                minAgeMs: doc.total <= 0 ? 0 : staleMs,
            });
        }

        const offset = Math.max(0, Math.floor(params.offset));
        const limit = Math.max(1, Math.floor(params.limit));

        return includeOk({
            markets: doc.markets.slice(offset, offset + limit),
            total: doc.total,
            offset,
            limit,
        } satisfies AssetMarketsInclude);
    }).pipe(Effect.catch(error => Effect.succeed(includeError('error', toMessage(error)))));
}

export function loadOhlcvInclude(
    request: Request,
    params: {
        primaryMint: string;
        coingeckoId?: string;
        interval: TimeInterval;
        from: number;
        to: number;
        allowCoingeckoFallback: boolean;
        allowUnhealthyCoingeckoFallback?: boolean;
    },
): Effect.Effect<AssetIncludeResult<OHLCVData[]>, never> {
    return Effect.gen(function* () {
        const candles = yield* ohlcvList({
                address: params.primaryMint,
                interval: params.interval,
                from: params.from,
                to: params.to,
            });

        const intervalSeconds = intervalToSeconds(params.interval);
        const expectedCount = Math.max(1, Math.floor((params.to - params.from) / Math.max(intervalSeconds, 1)) + 1);
        const firstTime = candles.length > 0 ? (candles[0]?.time ?? null) : null;
        const lastTime = candles.length > 0 ? (candles[candles.length - 1]?.time ?? null) : null;

        const missingStart = firstTime === null || firstTime > params.from + intervalSeconds * 2;
        const sparse = candles.length < Math.max(3, Math.floor(expectedCount * 0.25));
        const shouldPreferCoingecko = candles.length === 0 || (missingStart && sparse);

        const latestTime = lastTime;
        const isStale = latestTime === null || params.to - latestTime > intervalSeconds * 2;
        const canUseCoingeckoFallback =
            params.allowCoingeckoFallback || params.allowUnhealthyCoingeckoFallback === true;

        if (canUseCoingeckoFallback) {
            const coinId = (params.coingeckoId ?? '').trim();
            const shouldCheckCoingecko = params.allowUnhealthyCoingeckoFallback === true || shouldPreferCoingecko;
            if (coinId && shouldCheckCoingecko) {
                const requestedDays = Math.max(1, Math.ceil((params.to - params.from) / (24 * 60 * 60)));
                yield* scheduleCoingeckoOhlcvWarm({ coinId, interval: params.interval, days: requestedDays });

                const cgCandles = yield* coingeckoListOhlcv({
                        coinId,
                        interval: params.interval,
                        from: params.from,
                        to: params.to,
                    });

                if (params.allowUnhealthyCoingeckoFallback === true) {
                    const shouldUseFallback = shouldUseCanonicalFallbackForUnhealthyVariant({
                        candles,
                        canonicalCandles: cgCandles,
                        expectedCount,
                        isStale,
                    });
                    if (shouldUseFallback) return includeOk(cgCandles);
                } else if (shouldPreferCoingecko && cgCandles.length > candles.length) {
                    return includeOk(cgCandles);
                }
            }
        }

        const shouldBackfill = missingStart && sparse;
        if (isStale || shouldBackfill) {
            const requestedDays = Math.max(1, Math.ceil((params.to - params.from) / (24 * 60 * 60)));
            yield* scheduleCacheWarm(request, {
                mint: params.primaryMint,
                ohlcv: true,
                ohlcvInterval: params.interval,
                ohlcvDays: requestedDays,
            });
        }

        return includeOk(candles);
    }).pipe(Effect.catch(error => Effect.succeed(includeError('error', toMessage(error)))));
}

export function loadStockOhlcvInclude(params: {
    assetId: string;
    interval: TimeInterval;
    from: number;
    to: number;
    coingeckoId?: string;
}): Effect.Effect<AssetIncludeResult<OHLCVData[]>, never> {
    return Effect.gen(function* () {
        const candles = yield* stockOhlcvList({
                assetId: params.assetId,
                interval: params.interval,
                from: params.from,
                to: params.to,
            });

        const intervalSeconds = intervalToSeconds(params.interval);
        const latestTime = candles.length > 0 ? (candles[candles.length - 1]?.time ?? null) : null;
        const isStale = latestTime === null || params.to - latestTime > intervalSeconds * 2;
        if (isStale) {
            const requestedDays = Math.max(1, Math.ceil((params.to - params.from) / (24 * 60 * 60)));
            yield* scheduleStockOhlcvWarm({
                assetId: params.assetId,
                interval: params.interval,
                days: requestedDays,
            });
        }

        if (candles.length === 0) {
            const coinId = (params.coingeckoId ?? '').trim();
            if (coinId) {
                const cgCandles = yield* coingeckoListOhlcv({
                        coinId,
                        interval: params.interval,
                        from: params.from,
                        to: params.to,
                    });
                if (cgCandles.length > 0) {
                    const requestedDays = Math.max(1, Math.ceil((params.to - params.from) / (24 * 60 * 60)));
                    yield* scheduleCoingeckoOhlcvWarm({ coinId, interval: params.interval, days: requestedDays });
                    return includeOk(cgCandles);
                }
            }
        }

        return includeOk(candles);
    }).pipe(Effect.catch(error => Effect.succeed(includeError('error', toMessage(error)))));
}
