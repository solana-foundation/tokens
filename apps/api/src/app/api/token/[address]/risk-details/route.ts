import { Effect } from 'effect';

import { getCuratedListSlugsForMint } from '@/lib/curated-membership';

import { route } from '@/effect/next-route';
import { decodeUnknownOrBadRequest, SolanaAddress } from '@tokens/effect';
import type { MarketScoreInput } from '@/lib/token-risk-helpers';
import type { WebacyTokenResponse, WebacyTradingLiteResponse } from '@/lib/webacy';
import { scheduleCacheWarm } from '@/lib/cloudrun/cacheWarm';
import { variantMarketsGetLatestByMints } from '@/lib/cloudrun';

function estimate7dVolume(volume24h: number | null): number | null {
    if (volume24h == null || volume24h <= 0) return null;
    return volume24h * 7;
}


function scheduleVariantMarketWarm(mint: string): Effect.Effect<void, never> {
    return scheduleCacheWarm(null, {
        mint,
        variantMarket: true,
        markets: false,
        ohlcv: false,
        minAgeMs: 0,
        label: 'token.riskDetails.scheduleWarm',
    });
}

export interface TokenRiskDetailsOk {
    ok: true;
    tokenData: WebacyTokenResponse | null;
    tradingData: WebacyTradingLiteResponse | null;
    marketScoreInput: MarketScoreInput;
}

export interface TokenRiskDetailsNotConfigured {
    ok: false;
    reason: 'not_configured';
    message: string;
}

export interface TokenRiskDetailsUnsupported {
    ok: false;
    reason: 'unsupported';
    message: string;
}

export interface TokenRiskDetailsError {
    ok: false;
    reason: 'error';
    message: string;
}

export type TokenRiskDetailsApiResponse =
    | TokenRiskDetailsOk
    | TokenRiskDetailsNotConfigured
    | TokenRiskDetailsUnsupported
    | TokenRiskDetailsError;

export const GET = route(
    (_request: Request, ctx: { params: Promise<{ address: string }> }) =>
        Effect.gen(function* () {
            const { address: rawAddress } = yield* Effect.tryPromise(() => ctx.params);
            const address = yield* decodeUnknownOrBadRequest(SolanaAddress, rawAddress, 'Invalid address');

            const rows = yield* variantMarketsGetLatestByMints({ mints: [address] });
            const market = rows[0]?.market ?? null;

            const isStale = market ? Date.now() - market.lastFetchedAt > 60 * 60_000 : true;
            if (!market || isStale) {
                yield* scheduleVariantMarketWarm(address);
            }

            const volume24hUsd = market?.volume24hUSD ?? null;
            const volume7dUsd = estimate7dVolume(volume24hUsd);

            const marketScoreInput: MarketScoreInput = {
                liquidityUsd: market?.liquidity ?? null,
                marketCapUsd: market?.marketCap ?? null,
                holderCount: market?.holder ?? null,
                top10HoldersPercent: null,
                volume24hUsd,
                volume7dUsd,
                tokenMintTime: null,
                tokenAddress: address,
                curatedListSlugs: yield* Effect.promise(() => getCuratedListSlugsForMint(address)),
            };

            return {
                ok: true,
                tokenData: null as WebacyTokenResponse | null,
                tradingData: null as WebacyTradingLiteResponse | null,
                marketScoreInput,
            } satisfies TokenRiskDetailsOk;
        }),
    { platform: { requiredScopes: ['internal:read'] } },
);
