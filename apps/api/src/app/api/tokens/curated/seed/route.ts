import { Effect, Option } from 'effect';

import { getTokenOverview } from '@/lib/birdeye';
import { getGlobalTokenStats } from '@/lib/coingecko';
import { getWrapperGroupByAddress } from '@tokens/asset-registry/compat';
import { CURATED_LIST_ORDER, type CuratedListSlug as CuratedTokenListId } from '@tokens/asset-registry/curated-lists';
import { cleanTokenName, getTokenLogoURL } from '@/lib/logo-overrides';
import { MissingEnvError, NotFoundError } from '@tokens/effect';
import { route } from '@/effect/next-route';
import { decodeUnknownOrBadRequest, NonNegativeIntFromString, PositiveIntFromString } from '@tokens/effect';
import { tapErrorAndDefault } from '@tokens/effect';
import { getEffectiveCuratedAddresses } from '../../../_curated-addresses';

type CuratedTokenCategoryId = 'all' | CuratedTokenListId;

function getOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
}

function isCuratedTokenCategoryId(value: string): value is CuratedTokenCategoryId {
    if (value === 'all') return true;
    return CURATED_LIST_ORDER.includes(value as CuratedTokenListId);
}

export const POST = route((request: Request) =>
    Effect.gen(function* () {
        // Avoid exposing a bulk-write endpoint in production by default.
        if (process.env.NODE_ENV === 'production') {
            return yield* Effect.fail(new NotFoundError({ message: 'Not found' }));
        }

        const apiKey = process.env.BIRDEYE_API_KEY?.trim();
        if (!apiKey)
            return yield* Effect.fail(
                new MissingEnvError({ name: 'BIRDEYE_API_KEY', message: 'BIRDEYE_API_KEY is not set' }),
            );

        const url = new URL(request.url);
        const searchParams = url.searchParams;
        const rawListId = searchParams.get('list') ?? 'all';
        const listId: CuratedTokenCategoryId = isCuratedTokenCategoryId(rawListId) ? rawListId : 'all';

        const { addresses: allAddresses } = yield* Effect.tryPromise(() => getEffectiveCuratedAddresses(listId));

        const offset = yield* decodeUnknownOrBadRequest(
            NonNegativeIntFromString,
            searchParams.get('offset') ?? '0',
            'Invalid offset',
        );
        const limitDefault = String(allAddresses.length);
        const limitUnclamped = yield* decodeUnknownOrBadRequest(
            PositiveIntFromString,
            searchParams.get('limit') ?? limitDefault,
            'Invalid limit',
        );
        const limit = Math.min(limitUnclamped, 200);
        const addresses = allAddresses.slice(offset, offset + limit);

        const overviews = yield* Effect.all(
            addresses.map(address =>
                Effect.tryPromise(() => getTokenOverview(address)).pipe(
                    tapErrorAndDefault('tokens.curatedSeed.getTokenOverview', null, { address }),
                ),
            ),
            { concurrency: 2 },
        );

        const tokens = overviews.filter((token): token is Exclude<(typeof overviews)[number], null> => token !== null);

        type UpsertResult = { ok: true; address: string } | { ok: false; address: string; message: string };

        function upsertToken(token: (typeof tokens)[number]): Effect.Effect<UpsertResult, never> {
            return Effect.gen(function* () {
                const displayName = cleanTokenName(token.name);
                const displayLogoURI = getTokenLogoURL(token.symbol, token.logoURI);

                const wrapperGroup = getWrapperGroupByAddress(token.address);
                const coingeckoId = getOptionalString(wrapperGroup?.coingeckoId ?? token.extensions?.coingeckoId);
                const globalStatsOpt = coingeckoId
                    ? yield* Effect.option(Effect.tryPromise(() => getGlobalTokenStats(coingeckoId)))
                    : null;
                const globalStats = globalStatsOpt
                    ? Option.match(globalStatsOpt, { onNone: () => null, onSome: v => v })
                    : null;

                const cgDescription = getOptionalString(globalStats?.description);
                const beDescription = getOptionalString(token.extensions?.description);
                const description = cgDescription ?? beDescription;

                const website = getOptionalString(globalStats?.links?.website ?? token.extensions?.website);
                const twitter = getOptionalString(globalStats?.links?.twitter ?? token.extensions?.twitter);
                const discord = getOptionalString(globalStats?.links?.discord ?? token.extensions?.discord);
                const telegram = getOptionalString(globalStats?.links?.telegram ?? token.extensions?.telegram);
                const reddit = getOptionalString(globalStats?.links?.reddit);
                const github = getOptionalString(token.extensions?.github);

                const logoUri = getOptionalString(displayLogoURI);
                const price = getOptionalNumber(token.price);
                const priceChange24hPercent = getOptionalNumber(token.priceChange24hPercent);
                const volume24hUSD = getOptionalNumber(token.volume24h);
                const liquidity = getOptionalNumber(token.liquidity);
                const marketCap = getOptionalNumber(token.marketCap);

                const args = {
                    address: token.address,
                    symbol: token.symbol,
                    name: displayName,
                    decimals: token.decimals,
                    ...(logoUri ? { logoUri } : {}),
                    ...(coingeckoId ? { coingeckoId } : {}),
                    ...(description ? { description } : {}),
                    ...(website ? { website } : {}),
                    ...(twitter ? { twitter } : {}),
                    ...(discord ? { discord } : {}),
                    ...(telegram ? { telegram } : {}),
                    ...(reddit ? { reddit } : {}),
                    ...(github ? { github } : {}),
                    ...(price !== undefined ? { price } : {}),
                    ...(priceChange24hPercent !== undefined ? { priceChange24hPercent } : {}),
                    ...(volume24hUSD !== undefined ? { volume24hUSD } : {}),
                    ...(liquidity !== undefined ? { liquidity } : {}),
                    ...(marketCap !== undefined ? { marketCap } : {}),
                };

                // ponytail: dev-only seed endpoint (NODE_ENV=production 404s).
                // Write path removed with Convex; add a `tokensUpsertFromBirdeye`
                // cloudrun-assets mutation and route through it when this
                // endpoint needs to actually seed again. Until then the body
                // can't fail, so no catchAll is needed.
                void args;
                return { ok: true as const, address: token.address } as {
                    ok: true;
                    address: string;
                } | {
                    ok: false;
                    address: string;
                    message: string;
                };
            });
        }

        const results = yield* Effect.all(
            tokens.map(token => upsertToken(token)),
            { concurrency: 4 },
        );

        const upserted = results.filter(r => r.ok).length;
        const failed = results.length - upserted;

        return {
            listId,
            totalAddresses: allAddresses.length,
            offset,
            limit,
            processed: addresses.length,
            fetched: tokens.length,
            upserted,
            failed,
            errors: results
                .filter((r): r is { ok: false; address: string; message: string } => !r.ok)
                .slice(0, 15)
                .map(r => ({ address: r.address, message: r.message })),
            nextOffset: offset + limit < allAddresses.length ? offset + limit : null,
        };
    }),
);
