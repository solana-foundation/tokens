import { describe, expect, it } from 'bun:test';

import type { ExecutionQuoteRow } from '../evaluate/contract';

import { buildVariantCurve } from './curve';

/** Minimal available row: only the fields the curve reads. */
function availableRow(sizeUsd: number, inRaw: string, outRaw: string, provider: 'jupiter' | 'titan' = 'jupiter') {
    return {
        request: { unit: 'usd', amount: String(sizeUsd), rawAmount: inRaw },
        status: 'available',
        best: {
            provider,
            status: 'available',
            input: { rawAmount: inRaw },
            output: { rawAmount: outRaw },
            effectivePrice: String(Number(outRaw) / Number(inRaw)),
        },
        edge: null,
        providerQuotes: [],
    } as unknown as ExecutionQuoteRow;
}

function unavailableRow(sizeUsd: number, inRaw: string) {
    return {
        request: { unit: 'usd', amount: String(sizeUsd), rawAmount: inRaw },
        status: 'unavailable',
        reason: 'no_route',
        best: null,
        edge: null,
        providerQuotes: [],
    } as unknown as ExecutionQuoteRow;
}

describe('buildVariantCurve', () => {
    it('derives impact against the smallest successful rung', () => {
        const rows = [
            // $10k at 100 out per unit-in, $100k slightly worse, $1M much worse.
            availableRow(10_000, '10000000000', '1000000000'),
            availableRow(100_000, '100000000000', '9990000000'),
            availableRow(1_000_000, '1000000000000', '95000000000', 'titan'),
        ];
        const curve = buildVariantCurve(rows);
        expect(curve.points.map(point => point.impactBps)).toEqual([0, 10, 500]);
        expect(curve.rungs.map(rung => rung.provider)).toEqual(['jupiter', 'jupiter', 'titan']);
        expect(curve.maxProvenSizeUsd).toBe(1_000_000);
        expect(curve.baseEffectivePrice).not.toBeNull();
    });

    it('keeps failed rungs in the response with null impact', () => {
        const rows = [availableRow(10_000, '10000000000', '1000000000'), unavailableRow(5_000_000, '5000000000000')];
        const curve = buildVariantCurve(rows);
        expect(curve.rungs).toEqual([
            { sizeUsd: 10_000, impactBps: 0, provider: 'jupiter', reason: null },
            // The fixture row has no provider quotes, so the failure defaults
            // to 'error' — depth unknown, not proven absent.
            { sizeUsd: 5_000_000, impactBps: null, provider: null, reason: 'error' },
        ]);
        expect(curve.maxProvenSizeUsd).toBe(10_000);
    });

    it('handles a variant with no successful rungs', () => {
        const curve = buildVariantCurve([unavailableRow(10_000, '10000000000')]);
        expect(curve.points).toEqual([]);
        expect(curve.baseEffectivePrice).toBeNull();
        expect(curve.maxProvenSizeUsd).toBeNull();
    });

    it('floors negative impact at zero (a bigger rung quoting better than base)', () => {
        const rows = [
            availableRow(10_000, '10000000000', '1000000000'),
            // Better effective price at size — impact must clamp to 0, not go negative.
            availableRow(100_000, '100000000000', '10100000000'),
        ];
        const curve = buildVariantCurve(rows);
        expect(curve.points[1]!.impactBps).toBe(0);
    });

    it('survives 18-decimal raw amounts beyond Number.MAX_SAFE_INTEGER', () => {
        const rows = [
            availableRow(10_000, '10000000000', '123456789012345678901'),
            availableRow(100_000, '100000000000', '1222222222222222222219'),
        ];
        const curve = buildVariantCurve(rows);
        // eff drops ~1.0% from base: ~100bps.
        expect(curve.points[1]!.impactBps).toBeGreaterThan(98);
        expect(curve.points[1]!.impactBps).toBeLessThan(102);
    });
});
