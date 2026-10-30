import { describe, expect, it } from 'bun:test';

import { applyGateOverrides, GATE_OVERRIDE_KEYS, POLICIES } from './policies';

describe('applyGateOverrides', () => {
    it('returns the preset untouched when nothing is overridden', () => {
        const { policy, overrides } = applyGateOverrides(POLICIES.strict, {});
        expect(policy).toBe(POLICIES.strict);
        expect(overrides).toEqual([]);
    });

    it('`null` disables a numeric gate and is reported as an override', () => {
        const { policy, overrides } = applyGateOverrides(POLICIES.strict, { minLiquidityUsd: null });
        expect(policy.gates.minLiquidityUsd).toBeNull();
        expect(overrides).toEqual(['minLiquidityUsd']);
        // Every other gate keeps the preset value.
        expect(policy.gates.requireMarketData).toBe(true);
        expect(policy.gates.minAgeDays).toBe(1);
        expect(policy.gates.suppressImpersonation).toBe(true);
        expect(policy.gates.requireRegistry).toBe(false);
    });

    it('boolean gates override in both directions', () => {
        const { policy, overrides } = applyGateOverrides(POLICIES.strict, {
            requireMarketData: false,
            requireRegistry: true,
        });
        expect(policy.gates.requireMarketData).toBe(false);
        expect(policy.gates.requireRegistry).toBe(true);
        expect(overrides).toEqual(['requireMarketData', 'requireRegistry']);
    });

    it('a value equal to the preset is not counted as an override', () => {
        const { policy, overrides } = applyGateOverrides(POLICIES.strict, { minLiquidityUsd: 10_000 });
        expect(policy).toBe(POLICIES.strict);
        expect(overrides).toEqual([]);
    });

    it('`undefined` entries are ignored', () => {
        const { overrides } = applyGateOverrides(POLICIES.default, { minAgeDays: undefined, minMarketScore: 40 });
        expect(overrides).toEqual(['minMarketScore']);
    });

    it('never mutates the preset', () => {
        const before = JSON.stringify(POLICIES.degen);
        applyGateOverrides(POLICIES.degen, { minLiquidityUsd: 1, minAgeDays: 30, suppressImpersonation: true });
        expect(JSON.stringify(POLICIES.degen)).toBe(before);
    });

    it('weights and refusal are never touched by gate overrides', () => {
        const { policy } = applyGateOverrides(POLICIES.default, { minLiquidityUsd: 0 });
        expect(policy.weights).toBe(POLICIES.default.weights);
        expect(policy.refusal).toBe(POLICIES.default.refusal);
    });

    it('every preset defines every overridable gate', () => {
        for (const preset of Object.values(POLICIES)) {
            for (const key of GATE_OVERRIDE_KEYS) expect(key in preset.gates).toBe(true);
        }
    });
});
