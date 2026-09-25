import { describe, expect, it } from 'bun:test';

import {
    parseCategoryScores,
    stablecoinHealthGetByMints,
    type StablecoinHealthReadsRepo,
    type StablecoinHealthRow,
} from './stablecoinHealthReads';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

function row(overrides: Partial<StablecoinHealthRow> = {}): StablecoinHealthRow {
    return {
        mint: USDC,
        depeg_ok: true,
        depeg_tier: 'ok',
        depeg_overall_risk: '3.5',
        depeg_deviation_pct: -0.02,
        depeg_price_usd: 0.9998,
        depeg_peg_usd: 1,
        depeg_tier_since_at: '1757700000000',
        depeg_last_fetched_at: 1757703600000n,
        depeg_error_message: null,
        sh_ok: true,
        sh_composite_grade: 'A',
        sh_composite_score: 4.2,
        sh_category_scores: {
            asset_collateral: { score: 2, weight: 0.3, status: 'pass' },
            market_liquidity: { score: 5, weight: 0.2, status: 'pass' },
            smart_contract: { score: 10, weight: 0.2, status: 'warn' },
            operational_governance: { score: 1, weight: 0.15, status: 'pass' },
            hack_exploit_history: { score: 0, weight: 0.15, status: 'pass' },
            counterparty: { score: 0, weight: 0, status: 'pass' },
        },
        sh_last_fetched_at: 1757650000000,
        ...overrides,
    };
}

function repoWith(rows: StablecoinHealthRow[]): StablecoinHealthReadsRepo {
    return { findLatestByMints: async () => rows };
}

describe('stablecoinHealthGetByMints', () => {
    it('rejects non-array mints and returns [] for an empty list', async () => {
        await expect(stablecoinHealthGetByMints(repoWith([]), { mints: 'x' })).rejects.toThrow();
        await expect(stablecoinHealthGetByMints(repoWith([]), {})).rejects.toThrow();
        expect(await stablecoinHealthGetByMints(repoWith([]), { mints: [] })).toEqual([]);
    });

    it('returns one entry per requested mint in input order, nulls when no row', async () => {
        const result = await stablecoinHealthGetByMints(repoWith([row()]), { mints: [USDT, USDC, USDT] });
        expect(result.map(e => e.mint)).toEqual([USDT, USDC]);
        expect(result[0]).toEqual({ mint: USDT, pegHealth: null, structuralHealth: null });
        expect(result[1]!.pegHealth).toEqual({
            tier: 'ok',
            overallRisk: 3.5,
            deviationPct: -0.02,
            priceUsd: 0.9998,
            pegUsd: 1,
            tierSince: 1757700000000,
            updatedAt: 1757703600000,
            ok: true,
            errorMessage: null,
        });
        expect(result[1]!.structuralHealth?.grade).toBe('A');
        expect(result[1]!.structuralHealth?.score).toBe(4.2);
        expect(result[1]!.structuralHealth?.updatedAt).toBe(1757650000000);
        expect(result[1]!.structuralHealth?.categories.map(c => c.key)).toEqual([
            'asset_collateral',
            'market_liquidity',
            'smart_contract',
            'operational_governance',
            'hack_exploit_history',
        ]);
        expect(result[1]!.structuralHealth?.categories[2]).toEqual({
            key: 'smart_contract',
            score: 10,
            weight: 0.2,
            status: 'warn',
        });
    });

    it('drops unknown tiers/grades to null and keeps last-good values on a failed fetch', async () => {
        const [entry] = await stablecoinHealthGetByMints(
            repoWith([
                row({
                    depeg_ok: false,
                    depeg_error_message: 'HTTP 502',
                    sh_composite_grade: 'Z',
                }),
            ]),
            { mints: [USDC] },
        );
        expect(entry!.pegHealth?.ok).toBe(false);
        expect(entry!.pegHealth?.errorMessage).toBe('HTTP 502');
        expect(entry!.pegHealth?.tier).toBe('ok');
        expect(entry!.structuralHealth).toBeNull();

        const [unknownTier] = await stablecoinHealthGetByMints(repoWith([row({ depeg_tier: 'meh' })]), {
            mints: [USDC],
        });
        expect(unknownTier!.pegHealth).toBeNull();
    });

    it('fills missing categories with unknown status and ignores extra keys', () => {
        const parsed = parseCategoryScores({ asset_collateral: { score: '7', weight: 0.3, status: 'FAIL' }, bogus: {} });
        expect(parsed).toHaveLength(5);
        expect(parsed[0]).toEqual({ key: 'asset_collateral', score: 7, weight: 0.3, status: 'unknown' });
        expect(parsed[1]).toEqual({ key: 'market_liquidity', score: null, weight: null, status: 'unknown' });
        expect(parseCategoryScores(null)).toHaveLength(5);
    });

    it('caps the request size', async () => {
        const mints = Array.from({ length: 201 }, (_, i) => `mint${i}`);
        await expect(stablecoinHealthGetByMints(repoWith([]), { mints })).rejects.toThrow(/at most 200/);
    });
});
