import { Effect } from 'effect';

import type { TokenMarket, TokenMarketToken } from '@/lib/birdeye';
import { route } from '@/effect/next-route';
import { decodeLimit, decodeOffset } from '@tokens/effect';
import { decodeUnknownOrBadRequest, SolanaAddress } from '@tokens/effect';
import { scheduleCacheWarm as scheduleCacheWarmShared } from '@/lib/cloudrun/cacheWarm';
import { tokenMarketsGetLatestByMint } from '@/lib/cloudrun';
import { loadProtocolTokensByMarketAddress } from '@/app/api/v1/assets/_protocol-tokens';

function scheduleCacheWarm(
    request: Request,
    params: {
        mint: string;
        markets?: boolean;
        variantMarket?: boolean;
    },
): Effect.Effect<void, never> {
    return scheduleCacheWarmShared(request, {
        mint: params.mint,
        markets: params.markets ?? false,
        variantMarket: params.variantMarket ?? false,
        ohlcv: false,
        minAgeMs: 0,
        label: 'token.markets.scheduleWarm',
    });
}

export interface MarketsApiResponse {
    markets: TokenMarket[];
    protocolTokensByMarket: Record<string, TokenMarketToken | undefined>;
    total: number | undefined;
    offset: number;
    limit: number;
}

export const GET = route(
    (_request: Request, ctx: { params: Promise<{ address: string }> }) =>
        Effect.gen(function* () {
            const { address: rawAddress } = yield* Effect.tryPromise(() => ctx.params);
            const address = yield* decodeUnknownOrBadRequest(SolanaAddress, rawAddress, 'Invalid address');

            const url = new URL(_request.url);
            const searchParams = url.searchParams;

            const offset = yield* decodeOffset(searchParams.get('offset'));
            const limit = yield* decodeLimit(searchParams.get('limit'), { defaultValue: '10', max: 50 });

            const doc = yield* tokenMarketsGetLatestByMint({ mint: address });
            const isStale = doc ? Date.now() - doc.lastFetchedAt > 60 * 60_000 : true;
            if (!doc || doc.total <= 0 || isStale) {
                yield* scheduleCacheWarm(_request, { mint: address, markets: true });
            }

            const markets = doc ? doc.markets : [];
            const sliced = markets.slice(offset, offset + limit);

            const protocolTokensByMarket = yield* loadProtocolTokensByMarketAddress(sliced);

            return {
                markets: sliced,
                protocolTokensByMarket,
                total: doc ? doc.total : undefined,
                offset,
                limit,
            } satisfies MarketsApiResponse;
        }),
    { platform: { requiredScopes: ['internal:read'] } },
);
