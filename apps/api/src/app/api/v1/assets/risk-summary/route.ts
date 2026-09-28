import { Effect } from 'effect';

import { BadRequestError, ForbiddenError } from '@tokens/effect';
import { route } from '@/effect/next-route';
import { decodeUnknownOrBadRequest, SolanaAddress } from '@tokens/effect';
import { variantMarketsGetLatestByMints } from '@/lib/cloudrun';
import { computeMarketScore, createInsufficientDataResult, type MarketScoreResult } from '@/lib/token-risk-helpers';
import { getCuratedListSlugsForMint } from '@/lib/curated-membership';

import { marketScoreInputFromVariantMarket, SOL_MINT } from '../_risk-loader';

function hasAnyScope(granted: string[], requiredAny: readonly string[]): boolean {
    if (requiredAny.length === 0) return true;
    const set = new Set(granted);
    for (const scope of requiredAny) if (set.has(scope)) return true;
    return false;
}

const REQUIRED_ANY_SCOPES = ['assets:read', 'assets:risk:read'] as const;

const NO_SNAPSHOT_REASON = 'Market snapshot not available in cache';

function toRiskSummaryBody(marketScore: MarketScoreResult) {
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

            // Native SOL is pinned by the scorer and needs no snapshot.
            const rows = address === SOL_MINT ? [] : yield* variantMarketsGetLatestByMints({ mints: [address] });
            const market = rows[0]?.market ?? null;

            // No data means "unscored", never a grade: return the insufficient
            // result directly instead of running the scorer on placeholders.
            if (!market && address !== SOL_MINT) {
                return toRiskSummaryBody(createInsufficientDataResult(NO_SNAPSHOT_REASON));
            }

            const curatedListSlugs = yield* Effect.promise(() => getCuratedListSlugsForMint(address));
            const marketScore = computeMarketScore({
                ...marketScoreInputFromVariantMarket(address, market),
                curatedListSlugs,
            });

            return toRiskSummaryBody(marketScore);
        }),
    { platform: {} },
);
