/**
 * Market-derived risk for a candidate. The archive repo's asset-risk cache
 * (Webacy tags, cached grades) was not ported, so the only risk signal here is
 * `computeMarketScore` over the candidate's own market fields — the same
 * formula v1 uses for `grade:A|B|C`. Pure; the score/gate/badge layers read
 * the result off `EnrichedCandidate.risk`.
 */

import { computeMarketScore } from '@/lib/token-risk-helpers';
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
 * `null` marketScore/grade when the helper reports insufficient data — the
 * score component treats unknown as neutral and the `minMarketScore` gate
 * only fires on a known score.
 */
export function riskFromMarket(input: RiskMarketInput): NonNullable<EnrichedCandidate['risk']> {
    const computed = computeMarketScore({
        liquidityUsd: input.liquidityUsd,
        marketCapUsd: input.marketCapUsd,
        holderCount: input.holderCount,
        top10HoldersPercent: input.top10HoldersPercent,
        volume24hUsd: input.volume24hUsd,
        volume7dUsd: null,
        tokenMintTime: input.tokenMintTime,
        tokenAddress: input.mint,
        curatedListSlugs: input.curatedListIds,
    });
    if (computed.hasInsufficientData) {
        return { marketScore: null, grade: null, webacyTags: [] };
    }
    return { marketScore: computed.score, grade: computed.grade, webacyTags: [] };
}
