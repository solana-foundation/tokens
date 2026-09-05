import { Effect } from 'effect';

import { BadRequestError, ForbiddenError } from '@tokens/effect';
import { route } from '@/effect/next-route';
import { decodeUnknownOrBadRequest, SolanaAddress } from '@tokens/effect';
import { variantMarketsGetLatestByMints } from '@/lib/cloudrun';
import { computeMarketScore, type MarketScoreInput } from '@/lib/token-risk-helpers';
import { getCuratedListSlugsForMint } from '@/lib/curated-membership';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function estimate7dVolume(volume24h: number | null): number | null {
    if (volume24h == null || volume24h <= 0) return null;
    return volume24h * 7;
}

function hasAnyScope(granted: string[], requiredAny: readonly string[]): boolean {
    if (requiredAny.length === 0) return true;
    const set = new Set(granted);
    for (const scope of requiredAny) if (set.has(scope)) return true;
    return false;
}

const REQUIRED_ANY_SCOPES = ['assets:read', 'assets:risk:read'] as const;

function buildMarketScoreInput(
    address: string,
    market?: {
        liquidity?: number | null;
        marketCap?: number | null;
        holder?: number | null;
        volume24hUSD?: number | null;
    } | null,
): MarketScoreInput {
    const volume24hUsd = market?.volume24hUSD ?? null;
    return {
        liquidityUsd: market?.liquidity ?? null,
        marketCapUsd: market?.marketCap ?? null,
        holderCount: market?.holder ?? null,
        top10HoldersPercent: null,
        volume24hUsd,
        volume7dUsd: estimate7dVolume(volume24hUsd),
        tokenMintTime: null,
        tokenAddress: address,
    };
}

function insufficient(reason: string) {
    const marketScore = computeMarketScore(
        buildMarketScoreInput(SOL_MINT, {
            liquidity: null,
            marketCap: null,
            holder: null,
            volume24hUSD: null,
        }),
    );

    return {
        score: marketScore.score,
        grade: marketScore.grade,
        label: marketScore.label,
        tone: marketScore.tone,
        isTrustedLaunch: marketScore.isTrustedLaunch,
        caps: marketScore.caps,
        hasInsufficientData: marketScore.hasInsufficientData,
        insufficientDataReason: reason,
    };
}

export const GET = route(
    (request: Request, ctx: { platformAuth: { scopes: string[] } }) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const rawMint = url.searchParams.get('mint') ?? url.searchParams.get('address') ?? '';
            const mintInput = rawMint.trim();
            if (!mintInput) return yield* Effect.fail(new BadRequestError({ message: 'mint is required' }));

            const granted = ctx.platformAuth.scopes;
            if (!hasAnyScope(granted, REQUIRED_ANY_SCOPES)) {
                return yield* Effect.fail(
                    new ForbiddenError({
                        message: 'Insufficient scope',
                        details: { requiredAny: REQUIRED_ANY_SCOPES, granted },
                    }),
                );
            }

            const address = yield* decodeUnknownOrBadRequest(SolanaAddress, mintInput, 'Invalid mint');

            if (address === SOL_MINT) {
                const solSlugs = yield* Effect.promise(() => getCuratedListSlugsForMint(address));
                const marketScore = computeMarketScore({
                    ...buildMarketScoreInput(address),
                    curatedListSlugs: solSlugs,
                });

                return {
                    score: marketScore.score,
                    grade: marketScore.grade,
                    label: marketScore.label,
                    tone: marketScore.tone,
                    isTrustedLaunch: marketScore.isTrustedLaunch,
                    caps: marketScore.caps,
                    hasInsufficientData: marketScore.hasInsufficientData,
                    insufficientDataReason: marketScore.insufficientDataReason,
                };
            }

            const rows = yield* variantMarketsGetLatestByMints({
                    mints: [address],
                });

            const market = rows[0]?.market ?? null;
            if (!market) return insufficient('Market snapshot not available in cache');

            const curatedListSlugs = yield* Effect.promise(() => getCuratedListSlugsForMint(address));
            const marketScore = computeMarketScore({
                ...buildMarketScoreInput(address, market),
                curatedListSlugs,
            });

            return {
                score: marketScore.score,
                grade: marketScore.grade,
                label: marketScore.label,
                tone: marketScore.tone,
                isTrustedLaunch: marketScore.isTrustedLaunch,
                caps: marketScore.caps,
                hasInsufficientData: marketScore.hasInsufficientData,
                insufficientDataReason: marketScore.insufficientDataReason,
            };
        }),
    { platform: {} },
);
