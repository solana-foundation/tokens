import { describe, expect, it } from 'bun:test';

import {
    WEBACY_PEG_COVERAGE_MS,
    parseCategoryScores,
    stablecoinHealthGetByMints,
    toPegHealthRead,
    webacyCoversRow,
    type StablecoinHealthReadsRepo,
    type StablecoinHealthRow,
} from './stablecoinHealthReads';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
/** Fixed clock so the 9h Webacy coverage rule is deterministic; 1h after the fixture's last fetch. */
const NOW = 1757703600000 + 60 * 60_000;

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
        const result = await stablecoinHealthGetByMints(repoWith([row()]), { mints: [USDT, USDC, USDT] }, NOW);
        expect(result.map(e => e.mint)).toEqual([USDT, USDC]);
        expect(result[0]).toEqual({ mint: USDT, pegHealth: null, structuralHealth: null });
        expect(result[1]!.pegHealth).toEqual({
            provider: 'webacy',
            pegCurrency: null,
            referenceKind: 'fixed',
            tier: 'ok',
            overallRisk: 3.5,
            deviationPct: -0.02,
            priceUsd: 0.9998,
            pegUsd: 1,
            liquidityUsd: null,
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
            NOW,
        );
        expect(entry!.pegHealth?.ok).toBe(false);
        expect(entry!.pegHealth?.errorMessage).toBe('HTTP 502');
        expect(entry!.pegHealth?.tier).toBe('ok');
        expect(entry!.structuralHealth).toBeNull();

        const [unknownTier] = await stablecoinHealthGetByMints(
            repoWith([row({ depeg_tier: 'meh' })]),
            { mints: [USDC] },
            NOW,
        );
        expect(unknownTier!.pegHealth).toBeNull();
    });

    it('fills missing categories with unknown status and ignores extra keys', () => {
        const parsed = parseCategoryScores({
            asset_collateral: { score: '7', weight: 0.3, status: 'FAIL' },
            bogus: {},
        });
        expect(parsed).toHaveLength(5);
        expect(parsed[0]).toEqual({ key: 'asset_collateral', score: 7, weight: 0.3, status: 'unknown' });
        expect(parsed[1]).toEqual({ key: 'market_liquidity', score: null, weight: null, status: 'unknown' });
        expect(parseCategoryScores(null)).toHaveLength(5);
    });

    it('prefers last_ok_at over last_fetched_at for updatedAt', async () => {
        const [entry] = await stablecoinHealthGetByMints(
            repoWith([
                row({ depeg_ok: false, depeg_last_fetched_at: 2000, depeg_last_ok_at: 1500, sh_last_ok_at: '900' }),
            ]),
            { mints: [USDC] },
            NOW,
        );
        expect(entry!.pegHealth?.updatedAt).toBe(1500);
        expect(entry!.structuralHealth?.updatedAt).toBe(900);
    });

    it('caps the request size', async () => {
        const mints = Array.from({ length: 201 }, (_, i) => `mint${i}`);
        await expect(stablecoinHealthGetByMints(repoWith([]), { mints })).rejects.toThrow(/at most 200/);
    });
});

describe('toPegHealthRead provider preference', () => {
    const pegGuard: Partial<StablecoinHealthRow> = {
        pg_ok: true,
        pg_tier: 'warning',
        pg_peg_currency: 'USD',
        pg_reference_kind: 'fixed',
        pg_deviation_pct: '-1.8',
        pg_price_usd: 0.982,
        pg_peg_usd: 1,
        pg_liquidity_usd: '1250000',
        pg_tier_since_at: '1757690000000',
        pg_last_fetched_at: NOW - 5 * 60_000,
        pg_last_ok_at: NOW - 5 * 60_000,
        pg_error_message: null,
    };

    it('serves Webacy when its row is fresh, even with a peg guard row present', () => {
        const read = toPegHealthRead(row({ ...pegGuard, depeg_last_ok_at: NOW - 60 * 60_000 }), NOW);
        expect(read?.provider).toBe('webacy');
        expect(read?.tier).toBe('ok');
        expect(read?.overallRisk).toBe(3.5);
        expect(read?.liquidityUsd).toBeNull();
    });

    it('falls through to the peg guard when the Webacy observation is older than 9h', () => {
        const stale = row({
            ...pegGuard,
            depeg_last_ok_at: NOW - 10 * 60 * 60_000,
            depeg_last_fetched_at: NOW - 10 * 60 * 60_000,
        });
        expect(webacyCoversRow(stale, NOW)).toBe(false);
        expect(toPegHealthRead(stale, NOW)).toEqual({
            provider: 'tokens',
            pegCurrency: 'USD',
            referenceKind: 'fixed',
            tier: 'warning',
            overallRisk: null,
            deviationPct: -1.8,
            priceUsd: 0.982,
            pegUsd: 1,
            liquidityUsd: 1250000,
            tierSince: 1757690000000,
            updatedAt: NOW - 5 * 60_000,
            ok: true,
            errorMessage: null,
        });
    });

    it('treats the coverage bound as inclusive and a failing or tierless Webacy row as not covering', () => {
        const atBound = row({ depeg_last_ok_at: NOW - WEBACY_PEG_COVERAGE_MS });
        const pastBound = row({ depeg_last_ok_at: NOW - WEBACY_PEG_COVERAGE_MS - 1 });
        expect(webacyCoversRow(atBound, NOW)).toBe(true);
        expect(webacyCoversRow(pastBound, NOW)).toBe(false);
        expect(webacyCoversRow(row({ depeg_ok: false, depeg_last_ok_at: NOW }), NOW)).toBe(false);
        expect(webacyCoversRow(row({ depeg_tier: null, depeg_last_ok_at: NOW }), NOW)).toBe(false);
        expect(toPegHealthRead(row({ ...pegGuard, depeg_ok: false, depeg_last_ok_at: NOW }), NOW)?.provider).toBe(
            'tokens',
        );
    });

    it('serves the peg guard alone for mints Webacy does not list', () => {
        const only = row({
            ...pegGuard,
            depeg_ok: null,
            depeg_tier: null,
            depeg_overall_risk: null,
            depeg_deviation_pct: null,
            depeg_price_usd: null,
            depeg_peg_usd: null,
            depeg_tier_since_at: null,
            depeg_last_fetched_at: null,
            depeg_last_ok_at: null,
        });
        const read = toPegHealthRead(only, NOW);
        expect(read?.provider).toBe('tokens');
        expect(read?.tier).toBe('warning');
        expect(read?.liquidityUsd).toBe(1250000);
    });

    it('keeps a failing peg guard row on its last good tier with the error surfaced', () => {
        const failing = row({
            ...pegGuard,
            depeg_tier: null,
            pg_ok: false,
            pg_error_message: 'thin_liquidity',
            pg_last_fetched_at: NOW,
            pg_last_ok_at: NOW - 30 * 60_000,
        });
        const read = toPegHealthRead(failing, NOW);
        expect(read?.provider).toBe('tokens');
        expect(read?.ok).toBe(false);
        expect(read?.errorMessage).toBe('thin_liquidity');
        expect(read?.updatedAt).toBe(NOW - 30 * 60_000);
    });

    it('returns null when neither observer has a tier, and ignores a peg guard row without one', () => {
        expect(toPegHealthRead(row({ depeg_tier: null, pg_tier: null, pg_ok: true }), NOW)).toBeNull();
        expect(
            toPegHealthRead(
                row({ depeg_tier: null, pg_ok: false, pg_tier: null, pg_error_message: 'unsupported_peg' }),
                NOW,
            ),
        ).toBeNull();
    });

    it('falls back to the stale Webacy row when there is no peg guard row (pre-0020 row shape)', () => {
        const legacy = row({ depeg_last_ok_at: NOW - 10 * 60 * 60_000 });
        expect('pg_tier' in legacy).toBe(false);
        const read = toPegHealthRead(legacy, NOW);
        expect(read?.provider).toBe('webacy');
        expect(read?.tier).toBe('ok');
        expect(read?.updatedAt).toBe(NOW - 10 * 60 * 60_000);
    });

    it('defaults nowMs to the wall clock for the RPC entry point', async () => {
        const [entry] = await stablecoinHealthGetByMints(repoWith([row({ depeg_last_ok_at: Date.now() })]), {
            mints: [USDC],
        });
        expect(entry!.pegHealth?.provider).toBe('webacy');
    });
});

describe('toPegHealthRead peg reference (phase 2)', () => {
    const pegGuardOnly: Partial<StablecoinHealthRow> = {
        depeg_ok: null,
        depeg_tier: null,
        depeg_last_fetched_at: null,
        pg_ok: true,
        pg_tier: 'watch',
        pg_deviation_pct: -1.4,
        pg_price_usd: 1.124,
        pg_peg_usd: 1.14,
        pg_liquidity_usd: 900000,
        pg_tier_since_at: NOW - 10 * 60_000,
        pg_last_fetched_at: NOW - 60_000,
        pg_last_ok_at: NOW - 60_000,
        pg_error_message: null,
    };

    it('carries the peg guard reference kind and currency for high_water and fx rows', () => {
        const yieldRow = toPegHealthRead(
            row({ ...pegGuardOnly, pg_peg_currency: 'USD', pg_reference_kind: 'high_water' }),
            NOW,
        );
        expect(yieldRow?.provider).toBe('tokens');
        expect(yieldRow?.referenceKind).toBe('high_water');
        expect(yieldRow?.pegCurrency).toBe('USD');
        expect(yieldRow?.pegUsd).toBe(1.14);

        const fxRow = toPegHealthRead(
            row({ ...pegGuardOnly, pg_peg_currency: 'eur', pg_reference_kind: 'fx', pg_peg_usd: 1.1556 }),
            NOW,
        );
        expect(fxRow?.referenceKind).toBe('fx');
        expect(fxRow?.pegCurrency).toBe('EUR');
        expect(fxRow?.pegUsd).toBe(1.1556);
    });

    it('nulls an unknown reference kind and a blank currency', () => {
        const read = toPegHealthRead(
            row({ ...pegGuardOnly, pg_peg_currency: '  ', pg_reference_kind: 'moving_average' }),
            NOW,
        );
        expect(read?.referenceKind).toBeNull();
        expect(read?.pegCurrency).toBeNull();
    });

    it('reads null for peg guard rows from before phase 2 (columns absent from the SELECT)', () => {
        const legacy = row({ ...pegGuardOnly });
        expect('pg_reference_kind' in legacy).toBe(false);
        const read = toPegHealthRead(legacy, NOW);
        expect(read?.provider).toBe('tokens');
        expect(read?.referenceKind).toBeNull();
        expect(read?.pegCurrency).toBeNull();
    });

    it('always reports Webacy rows as fixed, with the denomination code only when the row exposes it', () => {
        const plain = toPegHealthRead(row(), NOW);
        expect(plain?.provider).toBe('webacy');
        expect(plain?.referenceKind).toBe('fixed');
        expect(plain?.pegCurrency).toBeNull();

        const withCode = toPegHealthRead(row({ depeg_peg_currency: 'usd' }), NOW);
        expect(withCode?.referenceKind).toBe('fixed');
        expect(withCode?.pegCurrency).toBe('USD');
    });
});
