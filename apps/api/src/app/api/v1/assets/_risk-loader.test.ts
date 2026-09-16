import { describe, expect, it } from 'bun:test';
import type { PegHealth, StructuralHealth } from '@tokens/asset-registry';

import {
    marketScoreInputFromVariantMarket,
    SOL_MINT,
    toRiskDetails,
    toRiskSummary,
    toStructuralHealthSummary,
    type AssetRiskPayload,
} from './_risk-loader';
import { computeMarketScore } from '@/lib/token-risk-helpers';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = 1_800_000_000_000;

const pegHealth: PegHealth = {
    provider: 'webacy',
    tier: 'warning',
    overallRisk: 62.5,
    deviationPct: -2.4,
    priceUsd: 0.976,
    pegUsd: 1,
    tierSince: NOW - 60_000,
    updatedAt: NOW - 1_000,
    stale: false,
};

const structuralHealth: StructuralHealth = {
    provider: 'webacy',
    grade: 'B+',
    score: 31.2,
    categories: [
        { key: 'asset_collateral', label: 'Asset & collateral', score: 20, weight: 0.3, status: 'pass' },
        { key: 'market_liquidity', label: 'Market liquidity', score: 45, weight: 0.25, status: 'warn' },
        { key: 'smart_contract', label: 'Smart contract', score: 10, weight: 0.2, status: 'pass' },
        {
            key: 'operational_governance',
            label: 'Operations & governance',
            score: null,
            weight: 0.15,
            status: 'unknown',
        },
        { key: 'hack_exploit_history', label: 'Exploit history', score: 80, weight: 0.1, status: 'fail' },
    ],
    updatedAt: NOW - 5_000,
    stale: false,
};

function okPayload(mint: string, health: { pegHealth: PegHealth | null; structuralHealth: StructuralHealth | null }) {
    const marketScoreInput = marketScoreInputFromVariantMarket(mint, null);
    return {
        assetId: mint === SOL_MINT ? 'solana' : 'usd',
        mint,
        risk: {
            ok: true as const,
            marketScore: computeMarketScore(marketScoreInput),
            marketScoreInput,
            tags: [] as [],
            advisory: null,
            pegHealth: health.pegHealth,
            structuralHealth: health.structuralHealth,
            lastUpdatedAt: null,
        },
    } satisfies AssetRiskPayload;
}

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
        const payload = okPayload(SOL_MINT, { pegHealth: null, structuralHealth: null });

        const summary = toRiskSummary(payload);
        expect(summary.risk.ok).toBe(true);
        expect('marketScoreInput' in summary.risk).toBe(false);
        expect('advisory' in summary.risk).toBe(false);
        expect('marketScoreInput' in toRiskDetails(payload).risk).toBe(true);
    });

    it('carries null pegHealth/structuralHealth on both projections for unmonitored mints', () => {
        const payload = okPayload(SOL_MINT, { pegHealth: null, structuralHealth: null });

        const summary = toRiskSummary(payload);
        if (!summary.risk.ok) throw new Error('expected ok');
        expect('pegHealth' in summary.risk).toBe(true);
        expect('structuralHealth' in summary.risk).toBe(true);
        expect(summary.risk.pegHealth).toBeNull();
        expect(summary.risk.structuralHealth).toBeNull();

        const details = toRiskDetails(payload);
        if (!details.risk.ok) throw new Error('expected ok');
        expect(details.risk.pegHealth).toBeNull();
        expect(details.risk.structuralHealth).toBeNull();
    });

    it('summary keeps full pegHealth but reduces structuralHealth to the grade block', () => {
        const payload = okPayload(USDC, { pegHealth, structuralHealth });

        const summary = toRiskSummary(payload);
        if (!summary.risk.ok) throw new Error('expected ok');
        expect(summary.risk.pegHealth).toEqual(pegHealth);
        expect(summary.risk.structuralHealth).toEqual({
            provider: 'webacy',
            grade: 'B+',
            updatedAt: NOW - 5_000,
            stale: false,
        });
        expect('categories' in (summary.risk.structuralHealth as object)).toBe(false);
        expect('score' in (summary.risk.structuralHealth as object)).toBe(false);
    });

    it('details passes pegHealth and the full structuralHealth (categories + score) through', () => {
        const payload = okPayload(USDC, { pegHealth, structuralHealth });

        const details = toRiskDetails(payload);
        if (!details.risk.ok) throw new Error('expected ok');
        expect(details.risk.pegHealth).toEqual(pegHealth);
        expect(details.risk.structuralHealth).toEqual(structuralHealth);
        expect(details.risk.structuralHealth?.categories.length).toBe(5);
        expect(details.risk.structuralHealth?.score).toBe(31.2);
    });

    it('toStructuralHealthSummary maps null to null', () => {
        expect(toStructuralHealthSummary(null)).toBeNull();
    });
});
