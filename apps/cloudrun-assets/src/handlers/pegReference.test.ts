import { describe, expect, test } from 'bun:test';

import {
    PEG_GUARD_FX_STALE_MS,
    PEG_GUARD_MIN_LIQUIDITY_USD,
    PEG_GUARD_PRICE_STALE_MS,
    WEBACY_PEG_COVERAGE_MS,
    advanceHighWaterReference,
    evaluatePegObservation,
    impliedUsdPerUnit,
    pegDeviationPct,
    pegForStablecoinVariant,
    pegTierFromDeviation,
    resolvePegUsd,
    webacyCoversMint,
    type EvaluatePegObservationInput,
    type PegReference,
} from './pegReference';

const NOW = 1_789_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const USD_PEG: PegReference = { currency: 'USD', pegUsd: 1, reference: 'fixed' };
const FIXED = { pegUsd: 1, reference: 'fixed' as const };

describe('pegForStablecoinVariant', () => {
    test('usd:* native variants peg to a fixed USD 1.0', () => {
        expect(
            pegForStablecoinVariant({ assetId: 'usd', variantId: 'usd:usdc', symbol: 'USDC', kind: 'native' }),
        ).toEqual(USD_PEG);
    });

    test('usd:* yield variants track their own high-water price', () => {
        expect(
            pegForStablecoinVariant({ assetId: 'usd', variantId: 'usd:usdy', symbol: 'USDY', kind: 'yield' }),
        ).toEqual({ currency: 'USD', pegUsd: null, reference: 'high_water' });
    });

    test('eur:* variants and standalone fiat stables are fx-referenced with no rate yet', () => {
        expect(
            pegForStablecoinVariant({ assetId: 'eur', variantId: 'eur:eurc', symbol: 'EURC', kind: 'native' }),
        ).toEqual({ currency: 'EUR', pegUsd: null, reference: 'fx' });
        expect(
            pegForStablecoinVariant({ assetId: 'tryb', variantId: 'tryb:mint', symbol: 'TRYB', kind: 'stablecoin' }),
        ).toEqual({ currency: 'TRY', pegUsd: null, reference: 'fx' });
        expect(
            pegForStablecoinVariant({ assetId: 'tgbp', variantId: 'tgbp:mint', symbol: 'tGBP', kind: 'stablecoin' }),
        ).toEqual({ currency: 'GBP', pegUsd: null, reference: 'fx' });
        expect(
            pegForStablecoinVariant({ assetId: 'mxne', variantId: 'mxne:mint', symbol: 'MXNe', kind: 'stablecoin' }),
        ).toEqual({ currency: 'MXN', pegUsd: null, reference: 'fx' });
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

describe('advanceHighWaterReference', () => {
    test('seeds at max(1.00, price) only when liquidity is ok', () => {
        expect(advanceHighWaterReference({ prev: null, priceUsd: 1.14, liquidityOk: false, now: NOW })).toBeNull();
        expect(advanceHighWaterReference({ prev: null, priceUsd: 1.14, liquidityOk: true, now: NOW })).toEqual({
            referenceUsd: 1.14,
            referenceUpdatedAt: NOW,
        });
        expect(advanceHighWaterReference({ prev: null, priceUsd: 0.97, liquidityOk: true, now: NOW })).toEqual({
            referenceUsd: 1,
            referenceUpdatedAt: NOW,
        });
    });

    test('never falls and ignores thin observations', () => {
        const prev = { referenceUsd: 1.14, referenceUpdatedAt: NOW - DAY };
        expect(advanceHighWaterReference({ prev, priceUsd: 1.05, liquidityOk: true, now: NOW })).toBe(prev);
        expect(advanceHighWaterReference({ prev, priceUsd: 1.3, liquidityOk: false, now: NOW })).toBe(prev);
        expect(advanceHighWaterReference({ prev, priceUsd: null, liquidityOk: true, now: NOW })).toBe(prev);
    });

    test('caps a liquid wick to 0.1% per elapsed day', () => {
        const prev = { referenceUsd: 1.14, referenceUpdatedAt: NOW - DAY };
        const next = advanceHighWaterReference({ prev, priceUsd: 1.3, liquidityOk: true, now: NOW });
        expect(next?.referenceUsd).toBeCloseTo(1.14 * 1.001, 10);
        expect(next?.referenceUpdatedAt).toBe(NOW);
        // A genuine small rise inside the cap is taken as is.
        const small = advanceHighWaterReference({ prev, priceUsd: 1.1405, liquidityOk: true, now: NOW });
        expect(small?.referenceUsd).toBeCloseTo(1.1405, 10);
        // No time elapsed means no headroom at all.
        const same = advanceHighWaterReference({
            prev: { referenceUsd: 1.14, referenceUpdatedAt: NOW },
            priceUsd: 1.3,
            liquidityOk: true,
            now: NOW,
        });
        expect(same?.referenceUsd).toBe(1.14);
    });
});

describe('resolvePegUsd', () => {
    const rates = new Map([['EUR', { usdPerUnit: 1.1556, lastOkAt: NOW - HOUR }]]);

    test('fixed pegs resolve to 1', () => {
        expect(resolvePegUsd({ peg: USD_PEG, fxRates: rates, reference: null, now: NOW })).toEqual({ pegUsd: 1 });
    });

    test('fx pegs resolve from a fresh rate, stale_fx past 6h, no_fx_rate when absent', () => {
        const eur: PegReference = { currency: 'EUR', pegUsd: null, reference: 'fx' };
        expect(resolvePegUsd({ peg: eur, fxRates: rates, reference: null, now: NOW })).toEqual({ pegUsd: 1.1556 });
        expect(
            resolvePegUsd({ peg: eur, fxRates: rates, reference: null, now: NOW - HOUR + PEG_GUARD_FX_STALE_MS + 1 }),
        ).toEqual({ issue: 'stale_fx' });
        expect(resolvePegUsd({ peg: eur, fxRates: new Map(), reference: null, now: NOW })).toEqual({
            issue: 'no_fx_rate',
        });
    });

    test('high-water pegs resolve to the reference, no_reference before one exists', () => {
        const usdy: PegReference = { currency: 'USD', pegUsd: null, reference: 'high_water' };
        expect(
            resolvePegUsd({ peg: usdy, fxRates: rates, reference: { referenceUsd: 1.14, referenceUpdatedAt: NOW }, now: NOW }),
        ).toEqual({ pegUsd: 1.14 });
        expect(resolvePegUsd({ peg: usdy, fxRates: rates, reference: null, now: NOW })).toEqual({ issue: 'no_reference' });
        expect(resolvePegUsd({ peg: null, fxRates: rates, reference: null, now: NOW })).toEqual({ issue: 'unsupported_peg' });
    });
});

describe('impliedUsdPerUnit', () => {
    const payload = {
        'usd-coin': { usd: 0.9998, eur: 0.8652, gbp: 0.74, idr: 16_420.5, last_updated_at: 1_789_000_000 },
        tether: { usd: 1.0002, eur: 0.8655, gbp: 0.76, idr: 16_427.1 },
    };

    test('derives usd per unit from usd-coin and stamps the provider timestamp in ms', () => {
        const out = impliedUsdPerUnit(payload, ['EUR', 'IDR']);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ currency: 'EUR', source: 'coingecko_usd_coin', providerUpdatedAt: 1_789_000_000_000 });
        expect(out[0]!.usdPerUnit).toBeCloseTo(0.9998 / 0.8652, 10);
        expect(out[1]!.usdPerUnit).toBeCloseTo(0.9998 / 16_420.5, 12);
    });

    test('drops a currency when tether disagrees by more than 1%, falls back to tether when usd-coin lacks it', () => {
        expect(impliedUsdPerUnit(payload, ['GBP'])).toEqual([]);
        const out = impliedUsdPerUnit({ tether: { usd: 1, chf: 0.81 } }, ['CHF', 'EUR']);
        expect(out).toEqual([{ currency: 'CHF', usdPerUnit: 1 / 0.81, source: 'coingecko_tether', providerUpdatedAt: null }]);
        expect(impliedUsdPerUnit(null, ['EUR'])).toEqual([]);
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
    const fixed = { reference: 'fixed' as const };
    const highWater = { reference: 'high_water' as const };

    test('fixed/fx band edges: exactly -0.5 / -1 / -3 and just past each', () => {
        expect(pegTierFromDeviation(-0.5, fixed)).toBe('ok');
        expect(pegTierFromDeviation(-0.5001, fixed)).toBe('watch');
        expect(pegTierFromDeviation(-0.9999, fixed)).toBe('watch');
        expect(pegTierFromDeviation(-1, fixed)).toBe('warning');
        expect(pegTierFromDeviation(-2.9999, fixed)).toBe('warning');
        expect(pegTierFromDeviation(-3, fixed)).toBe('critical');
        expect(pegTierFromDeviation(-50, fixed)).toBe('critical');
        expect(pegTierFromDeviation(-1, { reference: 'fx' })).toBe('warning');
    });

    test('fixed variants read premium at +2% and above, ok below that', () => {
        expect(pegTierFromDeviation(0, fixed)).toBe('ok');
        expect(pegTierFromDeviation(1.99, fixed)).toBe('ok');
        expect(pegTierFromDeviation(2, fixed)).toBe('premium');
        expect(pegTierFromDeviation(10, fixed)).toBe('premium');
    });

    test('high-water band edges: exactly -1 / -2 / -5 and just past each; never premium', () => {
        expect(pegTierFromDeviation(12, highWater)).toBe('ok');
        expect(pegTierFromDeviation(0, highWater)).toBe('ok');
        expect(pegTierFromDeviation(-1, highWater)).toBe('ok');
        expect(pegTierFromDeviation(-1.0001, highWater)).toBe('watch');
        expect(pegTierFromDeviation(-1.9999, highWater)).toBe('watch');
        expect(pegTierFromDeviation(-2, highWater)).toBe('warning');
        expect(pegTierFromDeviation(-4.9999, highWater)).toBe('warning');
        expect(pegTierFromDeviation(-5, highWater)).toBe('critical');
    });
});

describe('evaluatePegObservation', () => {
    function input(overrides: Partial<EvaluatePegObservationInput> = {}): EvaluatePegObservationInput {
        return {
            resolved: FIXED,
            priceUsd: 0.98,
            priceUpdatedAt: NOW - 60_000,
            liquidityUsd: 5_000_000,
            now: NOW,
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

    test('check order: resolution issues beat no_price beats stale_price beats thin_liquidity', () => {
        expect(
            evaluatePegObservation(
                input({ resolved: { issue: 'no_fx_rate' }, priceUsd: null, priceUpdatedAt: null, liquidityUsd: 0 }),
            ),
        ).toEqual({ ok: false, issue: 'no_fx_rate', deviationPct: null });
        expect(evaluatePegObservation(input({ resolved: { issue: 'unsupported_peg' } }))).toEqual({
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

    test('stale at exactly the bound + 1 ms, fresh at exactly the bound', () => {
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

    test('the reference kind reaches the tier rule and deviation is against the resolved value', () => {
        const usdy = evaluatePegObservation(input({ priceUsd: 1.05, resolved: { pegUsd: 1.14, reference: 'high_water' } }));
        expect(usdy).toMatchObject({ ok: true, tier: 'critical' });
        if (usdy.ok) expect(usdy.deviationPct).toBeCloseTo((1.05 / 1.14 - 1) * 100, 10);
        const eurc = evaluatePegObservation(input({ priceUsd: 1.148, resolved: { pegUsd: 1.1556, reference: 'fx' } }));
        expect(eurc).toMatchObject({ ok: true, tier: 'watch' });
        const native = evaluatePegObservation(input({ priceUsd: 1.05 }));
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
