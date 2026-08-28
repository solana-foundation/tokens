import { Effect } from 'effect';

import { getCuratedListSlugsForMint } from '@/lib/curated-membership';

import { coingeckoGetCoinById } from '@/lib/cloudrun';
import type { MarketScoreInput } from '@/lib/token-risk-helpers';
import type { WebacyTokenResponse, WebacyTradingLiteResponse } from '@/lib/webacy';
import { BadRequestError, NotFoundError } from '@tokens/effect';
import { route } from '@/effect/next-route';

function estimate7dVolume(volume24hUsd: number | null): number | null {
    if (volume24hUsd == null || volume24hUsd <= 0) return null;
    return volume24hUsd * 7;
}

function pickAnyPlatformAddress(platforms: Record<string, string> | undefined): string | null {
    if (!platforms) return null;
    for (const value of Object.values(platforms)) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed) return trimmed;
    }
    return null;
}

export interface CoinRiskDetailsOk {
    ok: true;
    tokenData: WebacyTokenResponse | null;
    tradingData: WebacyTradingLiteResponse | null;
    marketScoreInput: MarketScoreInput;
}

export interface CoinRiskDetailsNotConfigured {
    ok: false;
    reason: 'not_configured';
    message: string;
}

export interface CoinRiskDetailsUnsupported {
    ok: false;
    reason: 'unsupported';
    message: string;
}

export interface CoinRiskDetailsError {
    ok: false;
    reason: 'error';
    message: string;
}

export type CoinRiskDetailsApiResponse =
    | CoinRiskDetailsOk
    | CoinRiskDetailsNotConfigured
    | CoinRiskDetailsUnsupported
    | CoinRiskDetailsError;

export const GET = route(
    (_request: Request, ctx: { params: Promise<{ id: string }> }) =>
        Effect.gen(function* () {
            const { id } = yield* Effect.tryPromise(() => ctx.params);
            const coinId = (id ?? '').trim();
            if (!coinId) return yield* Effect.fail(new BadRequestError({ message: 'id is required' }));

            const coinDoc = yield* coingeckoGetCoinById({ id: coinId });
            if (!coinDoc) {
                return yield* Effect.fail(new NotFoundError({ message: 'Coin not found', resource: 'coingeckoCoin' }));
            }

            const md = coinDoc.coin?.market_data;
            const marketCapUsdRaw = md?.market_cap?.usd;
            const volume24hUsdRaw = md?.total_volume?.usd;

            const marketCapUsd =
                typeof marketCapUsdRaw === 'number' && Number.isFinite(marketCapUsdRaw) ? marketCapUsdRaw : null;
            const volume24hUsd =
                typeof volume24hUsdRaw === 'number' && Number.isFinite(volume24hUsdRaw) ? volume24hUsdRaw : null;
            const volume7dUsd = estimate7dVolume(volume24hUsd);

            const marketScoreInput: MarketScoreInput = {
                liquidityUsd: null,
                marketCapUsd,
                holderCount: null,
                top10HoldersPercent: null,
                volume24hUsd,
                volume7dUsd,
                tokenMintTime: null,
                tokenAddress: pickAnyPlatformAddress(coinDoc.platforms) ?? coinDoc.id,
            };
            // Curated exemptions only apply when the coin maps to a Solana mint.
            marketScoreInput.curatedListSlugs = yield* Effect.promise(() =>
                getCuratedListSlugsForMint(marketScoreInput.tokenAddress),
            );

            return {
                ok: true,
                tokenData: null as WebacyTokenResponse | null,
                tradingData: null as WebacyTradingLiteResponse | null,
                marketScoreInput,
            } satisfies CoinRiskDetailsOk;
        }),
    { platform: { requiredScopes: ['internal:read'] } },
);
