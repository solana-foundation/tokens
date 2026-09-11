import { describe, expect, it } from 'bun:test';

import {
    marketScoreInputFromVariantMarket,
    SOL_MINT,
    toRiskDetails,
    toRiskSummary,
    type AssetRiskPayload,
} from './_risk-loader';
import { computeMarketScore } from '@/lib/token-risk-helpers';

describe('risk loader helpers', () => {
    it('builds empty SOL market score input', () => {
        const input = marketScoreInputFromVariantMarket(SOL_MINT, null);
        expect(input.liquidityUsd).toBe(null);
        expect(input.marketCapUsd).toBe(null);
        expect(input.holderCount).toBe(null);
        expect(input.tokenAddress).toBe(SOL_MINT);
    });

    it('keeps non-SOL no-market as not_found payload shape', () => {
        const payload: AssetRiskPayload = {
            assetId: 'asset',
            mint: 'mint',
            risk: { ok: false, reason: 'not_found', message: 'Market snapshot not available in cache' },
        };
        expect(toRiskSummary(payload)).toBe(payload);
        expect(toRiskDetails(payload)).toBe(payload);
    });

    it('omits details-only fields from summary projection', () => {
        const marketScoreInput = marketScoreInputFromVariantMarket(SOL_MINT, null);
        const payload: AssetRiskPayload = {
            assetId: 'solana',
            mint: SOL_MINT,
            risk: {
                ok: true,
                marketScore: computeMarketScore(marketScoreInput),
                marketScoreInput,
                tags: [],
                advisory: null,
                lastUpdatedAt: null,
            },
        };

        const summary = toRiskSummary(payload);
        expect(summary.risk.ok).toBe(true);
        expect('marketScoreInput' in summary.risk).toBe(false);
        expect('advisory' in summary.risk).toBe(false);
        expect('marketScoreInput' in toRiskDetails(payload).risk).toBe(true);
    });
});
