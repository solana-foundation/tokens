/**
 * Market-derived risk for a candidate. The archive repo's asset-risk cache
 * (Webacy tags, cached grades) was not ported, so the only risk signal here is
 * `computeMarketScore` over the candidate's own market fields — the same
 * formula v1 uses for `grade:A|B|C`. Pure; the score/gate/badge layers read
 * the result off `EnrichedCandidate.risk`.
 */

import { computeMarketScore, estimate7dVolume, type MarketScoreInput } from '@/lib/token-risk-helpers';
import type { EnrichedCandidate } from './types';

export interface RiskMarketInput {
    mint: string;
    liquidityUsd: number | null;
    marketCapUsd: number | null;
    holderCount: number | null;
    top10HoldersPercent: number | null;
    volume24hUsd: number | null;
    tokenMintTime: string | null;
    curatedListIds: readonly string[];
}

/**
 * Scorer input for a candidate. 7-day volume is estimated from 24h volume,
 * exactly as v1 does — candidates only carry 24h, and without the estimate
 * trading activity always scores zero (no candidate could reach grade A).
 */
export function marketScoreInputFromRiskMarket(input: RiskMarketInput): MarketScoreInput {
    return {
        liquidityUsd: input.liquidityUsd,
        marketCapUsd: input.marketCapUsd,
        holderCount: input.holderCount,
        top10HoldersPercent: input.top10HoldersPercent,
        volume24hUsd: input.volume24hUsd,
        volume7dUsd: estimate7dVolume(input.volume24hUsd),
        tokenMintTime: input.tokenMintTime,
        tokenAddress: input.mint,
        curatedListSlugs: input.curatedListIds,
    };
}

/**
 * `null` marketScore/grade when the helper reports insufficient data — the
 * score component treats unknown as neutral and the `minMarketScore` gate
 * only fires on a known score.
 */
export function riskFromMarket(input: RiskMarketInput): NonNullable<EnrichedCandidate['risk']> {
    const computed = computeMarketScore(marketScoreInputFromRiskMarket(input));
    if (computed.hasInsufficientData) {
        return { marketScore: null, grade: null, webacyTags: [] };
    }
    return { marketScore: computed.score, grade: computed.grade, webacyTags: [] };
}
