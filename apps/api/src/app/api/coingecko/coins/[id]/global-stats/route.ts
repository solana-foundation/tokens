import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError } from '@tokens/effect';
import { coingeckoGetCoinById } from '@/lib/cloudrun';
import type { GlobalTokenStats, TokenLinks } from '@/lib/coingecko';
import { buildXProfileUrl } from '@/lib/social-links';

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

export const GET = route(
    (_request: Request, ctx: { params: Promise<{ id: string }> }) =>
        Effect.gen(function* () {
            const { id } = yield* Effect.tryPromise(() => ctx.params);
            const coinId = (id ?? '').trim();
            if (!coinId) {
                return yield* Effect.fail(new BadRequestError({ message: 'id is required' }));
            }

            const coinDoc = yield* coingeckoGetCoinById({ id: coinId });
            if (!coinDoc || !coinDoc.coin) return null;

            const md = coinDoc.coin.market_data;
            const price = md?.current_price?.usd;
            if (typeof price !== 'number' || !Number.isFinite(price)) return null;

            const description = pickEnglishDescription(coinDoc.coin.description);
            const links = extractLinksFromCoinData(coinDoc.coin.links);

            return {
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
            } satisfies GlobalTokenStats;
        }),
    { platform: { requiredScopes: ['internal:read'] } },
);
