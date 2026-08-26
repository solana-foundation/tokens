import { describe, expect, it } from 'bun:test';

import type { ExecutionRouteStep } from '../evaluate/contract';

import { analyzeLegIndependence, UNKNOWN_AMM_KEY } from './leg-independence';

const USDC = 'USDCmint';

function hop(inputMint: string, outputMint: string, ammKey: string | null, label = 'Pool'): ExecutionRouteStep {
    return {
        ammKey,
        label,
        percent: 100,
        inputMint,
        outputMint,
        inAmountRaw: '1',
        outAmountRaw: '1',
        feeAmountRaw: null,
        feeMint: null,
    };
}

describe('analyzeLegIndependence', () => {
    it('detects the live bitcoin shape: one leg routing through another leg variant', () => {
        const result = analyzeLegIndependence({
            legs: [
                { mint: 'cbBTCmint', steps: [hop(USDC, 'cbBTCmint', 'poolA')] },
                // wBTC leg buys cbBTC as an intermediate hop.
                {
                    mint: 'wBTCmint',
                    steps: [hop(USDC, 'cbBTCmint', 'poolB'), hop('cbBTCmint', 'wBTCmint', 'poolC')],
                },
            ],
        });
        expect(result.independent).toBe(false);
        expect(result.passThrough).toEqual([{ legMint: 'wBTCmint', viaVariantMint: 'cbBTCmint' }]);
    });

    it('masked ammKeys never form shared pools but pass-through still fires', () => {
        const result = analyzeLegIndependence({
            legs: [
                { mint: 'A', steps: [hop(USDC, 'A', UNKNOWN_AMM_KEY)] },
                { mint: 'B', steps: [hop(USDC, 'A', UNKNOWN_AMM_KEY), hop('A', 'B', UNKNOWN_AMM_KEY)] },
            ],
        });
        expect(result.sharedPools).toEqual([]);
        expect(result.passThrough).toEqual([{ legMint: 'B', viaVariantMint: 'A' }]);
        expect(result.independent).toBe(false);
    });

    it('flags a real pool shared by two legs even without pass-through', () => {
        const result = analyzeLegIndependence({
            legs: [
                { mint: 'A', steps: [hop(USDC, 'A', 'sharedUSDCPool', 'Whirlpool')] },
                { mint: 'B', steps: [hop(USDC, 'B', 'sharedUSDCPool', 'Whirlpool')] },
            ],
        });
        expect(result.passThrough).toEqual([]);
        expect(result.sharedPools).toEqual([
            { ammKey: 'sharedUSDCPool', label: 'Whirlpool', legMints: ['A', 'B'] },
        ]);
        expect(result.independent).toBe(false);
    });

    it('disjoint routes are independent; own mint in own route is not pass-through', () => {
        const result = analyzeLegIndependence({
            legs: [
                { mint: 'A', steps: [hop(USDC, 'A', 'poolA')] },
                { mint: 'B', steps: [hop(USDC, 'X', 'poolB'), hop('X', 'B', 'poolC')] },
            ],
        });
        expect(result.independent).toBe(true);
        expect(result.passThrough).toEqual([]);
        expect(result.sharedPools).toEqual([]);
    });

    it('single-leg plans are trivially independent', () => {
        const result = analyzeLegIndependence({
            legs: [{ mint: 'A', steps: [hop(USDC, 'B', 'poolA'), hop('B', 'A', 'poolB')] }],
        });
        // B is not a plan leg, so hopping through it is not sibling overlap.
        expect(result.independent).toBe(true);
    });
});
