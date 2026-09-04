import { Effect } from 'effect';

import { scheduleCacheWarm } from '@/lib/cloudrun/cacheWarm';
import { variantMarketsGetLatestByMints } from '@/lib/cloudrun';
import { CURATED_LIST_ORDER, type CuratedListSlug as CuratedTokenListId } from '@tokens/asset-registry/curated-lists';
import { route } from '@/effect/next-route';
import type { Token } from '@/lib/types';
import { getEffectiveCuratedAddresses } from '../../_curated-addresses';

type CuratedTokenCategoryId = 'all' | CuratedTokenListId;

function hasValidSymbol(symbol: string): boolean {
    const trimmed = symbol.trim();
    if (!trimmed) return false;
    // Legacy placeholder from older Birdeye parsing.
    if (trimmed === '???') return false;
    return true;
}

function isCuratedTokenCategoryId(value: string): value is CuratedTokenCategoryId {
    if (value === 'all') return true;
    return CURATED_LIST_ORDER.includes(value as CuratedTokenListId);
}

export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const searchParams = url.searchParams;
            const rawListId = searchParams.get('list') ?? 'all';
            const listId: CuratedTokenCategoryId = isCuratedTokenCategoryId(rawListId) ? rawListId : 'all';

            const { addresses } = yield* Effect.tryPromise(() => getEffectiveCuratedAddresses(listId));

            const rows = yield* variantMarketsGetLatestByMints({ mints: addresses });
            const marketByMint = new Map<string, (typeof rows)[number]['market']>();
            for (const row of rows) marketByMint.set(row.mint, row.market);

            const missingOrStale = addresses.filter(mint => {
                const market = marketByMint.get(mint) ?? null;
                if (!market) return true;
                return Date.now() - market.lastFetchedAt > 60 * 60_000;
            });

            const secret = (process.env.TOKENS_CACHE_WARM_SECRET ?? '').trim();
            if (secret && missingOrStale.length > 0) {
                yield* Effect.all(
                    missingOrStale.slice(0, 25).map(mint =>
                        scheduleCacheWarm(null, {
                            mint,
                            variantMarket: true,
                            markets: false,
                            ohlcv: false,
                            minAgeMs: 0,
                            label: 'tokens.curated.scheduleVariantMarketWarm',
                        }),
                    ),
                    { concurrency: 4 },
                );
            }

            const tokens: Token[] = addresses
                .map(address => {
                    const market = marketByMint.get(address) ?? null;
                    if (!market) return null;
                    const symbol = market.symbol ?? '???';
                    const name = market.name ?? 'Unknown';
                    return {
                        address,
                        symbol,
                        name,
                        decimals: market.decimals ?? 9,
                        ...(market.logoURI ? { logoURI: market.logoURI } : {}),
                        liquidity: market.liquidity ?? 0,
                        volume24hUSD: market.volume24hUSD ?? 0,
                        price: market.price ?? 0,
                        priceChange24hPercent: market.priceChange24hPercent ?? 0,
                        ...(market.priceChange1hPercent !== undefined
                            ? { priceChange1hPercent: market.priceChange1hPercent }
                            : {}),
                        marketCap: market.marketCap ?? 0,
                    } satisfies Token;
                })
                .filter((t): t is Token => t !== null)
                .filter(t => hasValidSymbol(t.symbol))
                .sort((a, b) => b.volume24hUSD - a.volume24hUSD);

            return {
                listId,
                tokens,
                backfill: {
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    errors: [],
                },
            };
        }),
    { platform: { requiredScopes: ['internal:read'] } },
);
