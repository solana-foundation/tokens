import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { decodeLimit, decodeOffset } from '@tokens/effect';
import { scheduleCacheWarm } from '@/lib/cloudrun/cacheWarm';
import { tokenMarketsGetLatestByMint } from '@/lib/cloudrun';
import { loadAssetWithSelectedVariant } from '../../_asset-route-loader';
import { loadProtocolTokensByMarketAddress } from '../../_protocol-tokens';
import { DEFAULT_MARKETS_STALE_MS, EQUITY_MARKETS_STALE_MS } from '../../_market-cache';

interface TokenMarketToken {
    address: string;
    decimals?: number;
    symbol?: string;
    icon?: string;
    name?: string;
}

interface TokenMarketRow {
    address: string;
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
    price?: number;
}

function scheduleMarketsWarm(mint: string): Effect.Effect<void, never> {
    return scheduleCacheWarm(null, {
        mint,
        markets: true,
        variantMarket: false,
        ohlcv: false,
        minAgeMs: 0,
        label: 'assets.markets.scheduleWarm',
    });
}

export const GET = route(
    (request: Request, ctx: { params: Promise<{ assetId: string }> }) =>
        Effect.gen(function* () {
            const { assetId: rawAssetId } = yield* Effect.tryPromise(() => ctx.params);
            const loaded = yield* loadAssetWithSelectedVariant({ request, rawAssetId });
            const url = new URL(request.url);
            const mint = loaded.selectedMint;
            const offset = yield* decodeOffset(url.searchParams.get('offset'));
            const limit = yield* decodeLimit(url.searchParams.get('limit'), { defaultValue: '10', max: 50 });

            const doc = yield* tokenMarketsGetLatestByMint({ mint });
            const staleMs =
                loaded.canonical.category === 'equity' ? EQUITY_MARKETS_STALE_MS : DEFAULT_MARKETS_STALE_MS;
            const isStale = doc ? Date.now() - doc.lastFetchedAt > staleMs : true;
            if (!doc || doc.total <= 0 || isStale) {
                yield* scheduleMarketsWarm(mint);
            }

            const slicedWithSource = doc ? doc.markets.slice(offset, offset + limit) : [];
            const protocolTokensByMarket = yield* loadProtocolTokensByMarketAddress(slicedWithSource);

            const markets: Array<Omit<TokenMarketRow, 'source'>> = doc
                ? (doc.markets as TokenMarketRow[])
                      .slice(offset, offset + limit)
                      .map(({ source: _source, ...row }) => row)
                : [];

            return {
                assetId: loaded.assetId,
                mint,
                markets,
                protocolTokensByMarket,
                total: doc ? doc.total : undefined,
                offset,
                limit,
                lastUpdatedAt: doc?.lastFetchedAt ?? null,
            };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60 } },
);
