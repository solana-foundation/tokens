import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError, NotFoundError } from '@tokens/effect';
import { scheduleCoinMetadataWarm } from '@/lib/cloudrun/cacheWarm';
import { coingeckoGetCoinById } from '@/lib/cloudrun';
import { getByAssetId as cloudRunGetByAssetId } from '@/lib/cloudrun/assets';
import { buildXProfileUrl } from '@/lib/social-links';
import { resolveAssetIdFromRef } from '../../_resolve-asset-ref';

interface AssetProfileOk<T> {
    ok: true;
    data: T;
}

interface AssetProfileError {
    ok: false;
    reason: 'not_available' | 'not_configured' | 'not_found' | 'error';
    message: string;
}

type AssetProfileResult<T> = AssetProfileOk<T> | AssetProfileError;

function profileOk<T>(data: T): AssetProfileOk<T> {
    return { ok: true, data };
}

function profileError(reason: AssetProfileError['reason'], message: string): AssetProfileError {
    return { ok: false, reason, message };
}

function scheduleProfileWarm(coinId: string): Effect.Effect<void, never> {
    return scheduleCoinMetadataWarm({ coinId, label: 'assets.profile.scheduleWarm' });
}

function pickEnglishDescription(description?: Record<string, string> | null): string | undefined {
    if (!description) return undefined;
    const en = description.en;
    if (typeof en === 'string' && en.trim().length > 0) return en;
    return undefined;
}

function extractLinksFromCoinData(links?: {
    homepage?: string[];
    twitter_screen_name?: string | null;
    telegram_channel_identifier?: string | null;
    subreddit_url?: string | null;
    chat_url?: string[];
}) {
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

    const out = {
        ...(website ? { website } : {}),
        ...(twitter ? { twitter } : {}),
        ...(telegram ? { telegram } : {}),
        ...(discord ? { discord } : {}),
        ...(reddit ? { reddit } : {}),
    };

    return Object.keys(out).length > 0 ? out : undefined;
}

export const GET = route(
    (_request: Request, ctx: { params: Promise<{ assetId: string }> }) =>
        Effect.gen(function* () {
            const { assetId: rawAssetId } = yield* Effect.tryPromise(() => ctx.params);
            const assetRef = (rawAssetId ?? '').trim();
            if (!assetRef) return yield* Effect.fail(new BadRequestError({ message: 'assetId is required' }));

            const assetId = yield* resolveAssetIdFromRef(assetRef);

            const assetDoc = yield* cloudRunGetByAssetId({ assetId });
            if (!assetDoc)
                return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));

            const coinId = (assetDoc.coingeckoId ?? '').trim();
            if (!coinId) {
                return {
                    assetId,
                    profile: profileError('not_available', 'Profile not available'),
                };
            }

            const coinDoc = yield* coingeckoGetCoinById({ id: coinId });
            const nowMs = Date.now();
            const lastFetchedAt = coinDoc?.lastMetadataFetchedAt ?? 0;
            const isStale = lastFetchedAt <= 0 || nowMs - lastFetchedAt > 24 * 60 * 60_000;
            if (!coinDoc?.coin || isStale) yield* scheduleProfileWarm(coinId);

            const profile: AssetProfileResult<{
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
                links?: {
                    website?: string;
                    twitter?: string;
                    telegram?: string;
                    discord?: string;
                    reddit?: string;
                };
            }> = !coinDoc?.coin
                ? profileError('not_found', 'Profile not available in cache')
                : (() => {
                      const coin = coinDoc.coin;
                      const md = coin.market_data;
                      const price = md?.current_price?.usd;
                      if (typeof price !== 'number' || !Number.isFinite(price)) {
                          return profileError('not_found', 'Profile not available in cache');
                      }

                      const description = pickEnglishDescription(coin.description);
                      const links = extractLinksFromCoinData(coin.links);

                      return profileOk({
                          marketCap: md?.market_cap?.usd ?? 0,
                          fdv: md?.fully_diluted_valuation?.usd ?? 0,
                          circulatingSupply: md?.circulating_supply ?? null,
                          totalSupply: md?.total_supply ?? null,
                          maxSupply: md?.max_supply ?? null,
                          price,
                          priceChange24h: md?.price_change_percentage_24h ?? 0,
                          volume24h: md?.total_volume?.usd ?? 0,
                          allTimeHigh: md?.ath?.usd ?? 0,
                          allTimeHighDate: md?.ath_date?.usd ?? '',
                          ...(description ? { description } : {}),
                          ...(links ? { links } : {}),
                      });
                  })();

            return { assetId, profile };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 300, staleWhileRevalidate: 600 } },
);
