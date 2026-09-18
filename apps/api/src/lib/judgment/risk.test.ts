import { describe, expect, it } from 'bun:test';

import { fakeUsdc, lowLiqDogToken, realUsdc, SOL_MINT } from './fixtures';
import { riskFromMarket } from './risk';
import type { EnrichedCandidate } from './types';

function input(candidate: EnrichedCandidate) {
    return {
        mint: candidate.mint,
        liquidityUsd: candidate.liquidityUsd,
        marketCapUsd: candidate.marketCapUsd,
        holderCount: candidate.holderCount,
        top10HoldersPercent: candidate.top10HoldersPercent,
        volume24hUsd: candidate.volume24hUsd,
        tokenMintTime: candidate.tokenMintTime,
        curatedListIds: candidate.curatedListIds,
    };
}

describe('riskFromMarket', () => {
    it('returns null score/grade when market data is insufficient (dust)', () => {
        expect(riskFromMarket(input(lowLiqDogToken()))).toEqual({ marketScore: null, grade: null, webacyTags: [] });
    });

    it('returns null score/grade when there is no market data at all', () => {
        expect(
            riskFromMarket({
                mint: 'NoMarketMint1111111111111111111111111111111',
                liquidityUsd: null,
                marketCapUsd: null,
                holderCount: null,
                top10HoldersPercent: null,
                volume24hUsd: null,
                tokenMintTime: null,
                curatedListIds: [],
            }),
        ).toEqual({ marketScore: null, grade: null, webacyTags: [] });
    });

    it('grades a deep, established, curated token at least B (speculative or better)', () => {
        const risk = riskFromMarket(input(realUsdc()));
        expect(['A', 'B']).toContain(risk.grade);
        expect(risk.marketScore).toBeGreaterThanOrEqual(70);
    });

    it('grades a shallow, concentrated, brand-new token below A', () => {
        const risk = riskFromMarket(input(fakeUsdc()));
        expect(risk.marketScore).not.toBeNull();
        expect(risk.grade).not.toBe('A');
        expect(risk.marketScore!).toBeLessThan(riskFromMarket(input(realUsdc())).marketScore ?? 0);
    });

    it('native SOL is pinned to 100 / A', () => {
        const risk = riskFromMarket({ ...input(lowLiqDogToken()), mint: SOL_MINT });
        expect(risk).toEqual({ marketScore: 100, grade: 'A', webacyTags: [] });
    });

    it('webacyTags is always empty (asset-risk cache not ported)', () => {
        expect(riskFromMarket(input(realUsdc())).webacyTags).toEqual([]);
    });
});
