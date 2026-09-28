import { describe, expect, it, mock } from 'bun:test';

import { computeMarketScore } from '@/lib/token-risk-helpers';

import { fakeUsdc, lowLiqDogToken, realUsdc, SOL_MINT } from './fixtures';
import { marketScoreInputFromRiskMarket, riskFromMarket } from './risk';
import type { EnrichedCandidate } from './types';

mock.module('server-only', () => ({}));

const { marketScoreInputFromVariantMarket } = await import('@/app/api/v1/assets/_risk-loader');

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

describe('v2 risk agrees with v1', () => {
    const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    type Market = {
        liquidity: number | null;
        marketCap: number | null;
        holder: number | null;
        volume24hUSD: number | null;
    };
    const markets: Market[] = [
        { liquidity: 28_000_000, marketCap: 1_190_000_000, holder: 300_000, volume24hUSD: 40_000_000 },
        { liquidity: 28_000_000, marketCap: 1_190_000_000, holder: null, volume24hUSD: 40_000_000 },
        { liquidity: 900_000, marketCap: 12_000_000, holder: 4_000, volume24hUSD: 250_000 },
        { liquidity: 40_000, marketCap: 300_000, holder: 150, volume24hUSD: 2_000 },
        { liquidity: 5_000_000, marketCap: 60_000_000, holder: 9_000, volume24hUSD: null },
        { liquidity: 5_000_000, marketCap: 60_000_000, holder: 9_000, volume24hUSD: 0 },
        { liquidity: null, marketCap: null, holder: null, volume24hUSD: null },
    ];

    function v2Input(market: Market) {
        return {
            mint: MINT,
            liquidityUsd: market.liquidity,
            marketCapUsd: market.marketCap,
            holderCount: market.holder,
            top10HoldersPercent: null,
            volume24hUsd: market.volume24hUSD,
            tokenMintTime: null,
            curatedListIds: [],
        };
    }

    it('builds the same scorer input from the same market', () => {
        for (const market of markets) {
            expect(marketScoreInputFromRiskMarket(v2Input(market))).toEqual({
                ...marketScoreInputFromVariantMarket(MINT, market),
                curatedListSlugs: [],
            });
        }
    });

    it('gives the same score and grade for the same market', () => {
        for (const market of markets) {
            const v1 = computeMarketScore(marketScoreInputFromVariantMarket(MINT, market));
            const v2 = riskFromMarket(v2Input(market));

            if (v1.hasInsufficientData) {
                expect(v2).toEqual({ marketScore: null, grade: null, webacyTags: [] });
            } else {
                expect(v2).toEqual({ marketScore: v1.score, grade: v1.grade, webacyTags: [] });
            }
        }
    });

    // Without a 7-day volume estimate, trading activity scored zero and the
    // best possible v2 score was 76 (grade B).
    it('can grade a deep, actively traded token A', () => {
        const risk = riskFromMarket(v2Input(markets[0]!));
        expect(risk.grade).toBe('A');
        expect(risk.marketScore).toBeGreaterThanOrEqual(85);
    });

    it('does not score trading activity for a token with no volume', () => {
        const withVolume = riskFromMarket(v2Input(markets[0]!));
        const noVolume = riskFromMarket(v2Input({ ...markets[0]!, volume24hUSD: 0 }));
        expect(noVolume.marketScore!).toBeLessThan(withVolume.marketScore!);
        expect(noVolume.grade).not.toBe('A');
    });
});
