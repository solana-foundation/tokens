import { describe, expect, test } from 'bun:test';

import {
    PEG_GUARD_MIN_LIQUIDITY_USD,
    PEG_GUARD_PRICE_STALE_MS,
    WEBACY_PEG_COVERAGE_MS,
    evaluatePegObservation,
    pegDeviationPct,
    pegForStablecoinVariant,
    pegTierFromDeviation,
    webacyCoversMint,
    type EvaluatePegObservationInput,
} from './pegReference';

const NOW = 1_789_000_000_000;
const HOUR = 60 * 60_000;
const USD_PEG = { currency: 'USD' as const, pegUsd: 1 };

describe('pegForStablecoinVariant', () => {
    test('usd:* variants peg to USD at 1.0', () => {
        expect(
            pegForStablecoinVariant({ assetId: 'usd', variantId: 'usd:usdc', symbol: 'USDC', kind: 'native' }),
        ).toEqual(USD_PEG);
        expect(
            pegForStablecoinVariant({ assetId: 'usd', variantId: 'usd:usdy', symbol: 'USDY', kind: 'yield' }),
        ).toEqual(USD_PEG);
    });

    test('eur:* variants are recognised but have no USD reference yet', () => {
        expect(
            pegForStablecoinVariant({ assetId: 'eur', variantId: 'eur:eurc', symbol: 'EURC', kind: 'native' }),
        ).toEqual({
            currency: 'EUR',
            pegUsd: null,
        });
    });

    test('standalone fiat stables map by symbol with a null reference', () => {
        expect(
            pegForStablecoinVariant({ assetId: 'tryb', variantId: 'tryb:mint', symbol: 'TRYB', kind: 'stablecoin' }),
        ).toEqual({
            currency: 'TRY',
            pegUsd: null,
        });
        expect(
            pegForStablecoinVariant({ assetId: 'tgbp', variantId: 'tgbp:mint', symbol: 'tGBP', kind: 'stablecoin' }),
        ).toEqual({
            currency: 'GBP',
            pegUsd: null,
        });
        expect(
            pegForStablecoinVariant({ assetId: 'mxne', variantId: 'mxne:mint', symbol: 'MXNe', kind: 'stablecoin' }),
        ).toEqual({
            currency: 'MXN',
            pegUsd: null,
        });
    });

    test('BUIDL and unknown symbols have no peg', () => {
        expect(
            pegForStablecoinVariant({ assetId: 'buidl', variantId: 'buidl:mint', symbol: 'BUIDL', kind: 'stablecoin' }),
        ).toBeNull();
        expect(
            pegForStablecoinVariant({ assetId: 'x', variantId: 'x:mint', symbol: 'WHAT', kind: 'stablecoin' }),
        ).toBeNull();
        expect(
            pegForStablecoinVariant({ assetId: 'x', variantId: 'x:mint', symbol: null, kind: 'stablecoin' }),
        ).toBeNull();
    });
});

describe('pegDeviationPct', () => {
    test('is signed percent from peg', () => {
        expect(pegDeviationPct(0.99, 1)).toBeCloseTo(-1, 10);
        expect(pegDeviationPct(1.02, 1)).toBeCloseTo(2, 10);
        expect(pegDeviationPct(1, 1)).toBe(0);
    });
});

describe('pegTierFromDeviation', () => {
    const native = { yield: false };
    const yieldOpts = { yield: true };

    test('band edges: exactly -0.5 / -1 / -3 and just past each', () => {
        expect(pegTierFromDeviation(-0.5, native)).toBe('ok');
        expect(pegTierFromDeviation(-0.5001, native)).toBe('watch');
        expect(pegTierFromDeviation(-0.9999, native)).toBe('watch');
        expect(pegTierFromDeviation(-1, native)).toBe('warning');
        expect(pegTierFromDeviation(-2.9999, native)).toBe('warning');
        expect(pegTierFromDeviation(-3, native)).toBe('critical');
        expect(pegTierFromDeviation(-50, native)).toBe('critical');
    });

    test('non-yield variants read premium at +2% and above, ok below that', () => {
        expect(pegTierFromDeviation(0, native)).toBe('ok');
        expect(pegTierFromDeviation(1.99, native)).toBe('ok');
        expect(pegTierFromDeviation(2, native)).toBe('premium');
        expect(pegTierFromDeviation(10, native)).toBe('premium');
    });

    test('yield variants clamp any non-negative deviation to ok (never premium)', () => {
        expect(pegTierFromDeviation(0, yieldOpts)).toBe('ok');
        expect(pegTierFromDeviation(2, yieldOpts)).toBe('ok');
        expect(pegTierFromDeviation(12, yieldOpts)).toBe('ok');
        expect(pegTierFromDeviation(-1.5, yieldOpts)).toBe('warning');
    });
});

describe('evaluatePegObservation', () => {
    function input(overrides: Partial<EvaluatePegObservationInput> = {}): EvaluatePegObservationInput {
        return {
            peg: USD_PEG,
            priceUsd: 0.98,
            priceUpdatedAt: NOW - 60_000,
            liquidityUsd: 5_000_000,
            now: NOW,
            isYield: false,
            priceStaleMs: PEG_GUARD_PRICE_STALE_MS,
            minLiquidityUsd: PEG_GUARD_MIN_LIQUIDITY_USD,
            ...overrides,
        };
    }

    test('healthy observation returns the tier and deviation', () => {
        const out = evaluatePegObservation(input());
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.tier).toBe('warning');
            expect(out.deviationPct).toBeCloseTo(-2, 10);
        }
    });

    test('check order: unsupported_peg beats no_price beats stale_price beats thin_liquidity', () => {
        expect(
            evaluatePegObservation(
                input({
                    peg: { currency: 'EUR', pegUsd: null },
                    priceUsd: null,
                    priceUpdatedAt: null,
                    liquidityUsd: 0,
                }),
            ),
        ).toEqual({ ok: false, issue: 'unsupported_peg', deviationPct: null });
        expect(evaluatePegObservation(input({ peg: null }))).toEqual({
            ok: false,
            issue: 'unsupported_peg',
            deviationPct: null,
        });
        expect(evaluatePegObservation(input({ priceUsd: null, priceUpdatedAt: null, liquidityUsd: 0 }))).toEqual({
            ok: false,
            issue: 'no_price',
            deviationPct: null,
        });
        const stale = evaluatePegObservation(input({ priceUpdatedAt: NOW - 7 * HOUR, liquidityUsd: 0 }));
        expect(stale.ok).toBe(false);
        if (!stale.ok) {
            expect(stale.issue).toBe('stale_price');
            expect(stale.deviationPct).toBeCloseTo(-2, 10);
        }
    });

    test('thin liquidity at 99,999 fails with the deviation kept; 100,000 passes', () => {
        const thin = evaluatePegObservation(input({ liquidityUsd: 99_999 }));
        expect(thin.ok).toBe(false);
        if (!thin.ok) {
            expect(thin.issue).toBe('thin_liquidity');
            expect(thin.deviationPct).toBeCloseTo(-2, 10);
        }
        expect(evaluatePegObservation(input({ liquidityUsd: 100_000 })).ok).toBe(true);
        expect(evaluatePegObservation(input({ liquidityUsd: null }))).toMatchObject({
            ok: false,
            issue: 'thin_liquidity',
        });
    });

    test('stale at exactly 30 min + 1 ms, fresh at exactly 30 min', () => {
        expect(evaluatePegObservation(input({ priceUpdatedAt: NOW - PEG_GUARD_PRICE_STALE_MS })).ok).toBe(true);
        expect(evaluatePegObservation(input({ priceUpdatedAt: NOW - PEG_GUARD_PRICE_STALE_MS - 1 }))).toMatchObject({
            ok: false,
            issue: 'stale_price',
        });
        expect(evaluatePegObservation(input({ priceUpdatedAt: null }))).toMatchObject({
            ok: false,
            issue: 'stale_price',
        });
    });

    test('yield flag reaches the tier rule', () => {
        const out = evaluatePegObservation(input({ priceUsd: 1.05, isYield: true }));
        expect(out).toMatchObject({ ok: true, tier: 'ok' });
        const native = evaluatePegObservation(input({ priceUsd: 1.05, isYield: false }));
        expect(native).toMatchObject({ ok: true, tier: 'premium' });
    });
});

describe('webacyCoversMint', () => {
    const fresh = { ok: true, tier: 'ok' as const, lastOkAt: NOW - HOUR };

    test('covers a fresh, successful, tiered row', () => {
        expect(webacyCoversMint(fresh, NOW)).toBe(true);
    });

    test('boundary at 9h: exactly 9h is covered, 9h + 1 ms is not', () => {
        expect(webacyCoversMint({ ...fresh, lastOkAt: NOW - WEBACY_PEG_COVERAGE_MS }, NOW)).toBe(true);
        expect(webacyCoversMint({ ...fresh, lastOkAt: NOW - WEBACY_PEG_COVERAGE_MS - 1 }, NOW)).toBe(false);
        expect(webacyCoversMint({ ...fresh, lastOkAt: NOW - 2 * HOUR }, NOW, HOUR)).toBe(false);
    });

    test('ok:false, tier:null, missing lastOkAt and missing row do not cover', () => {
        expect(webacyCoversMint({ ...fresh, ok: false }, NOW)).toBe(false);
        expect(webacyCoversMint({ ...fresh, tier: null }, NOW)).toBe(false);
        expect(webacyCoversMint({ ...fresh, lastOkAt: null }, NOW)).toBe(false);
        expect(webacyCoversMint(null, NOW)).toBe(false);
        expect(webacyCoversMint(undefined, NOW)).toBe(false);
    });
});
