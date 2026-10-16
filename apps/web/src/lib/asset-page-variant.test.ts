import { describe, expect, test } from 'bun:test';

import type { V2Variant } from './api-v2-types';
import { resolveVariantDisplay, solanaMintOf, toAssetPageVariant } from './asset-page-variant';

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function v2(overrides: Partial<V2Variant> = {}): V2Variant {
    return {
        key: `base:${USDC_BASE}`,
        chain: 'base',
        address: USDC_BASE,
        assetId: 'usd',
        variantId: `base:${USDC_BASE}`,
        kind: 'stablecoin',
        issuance: 'native',
        symbol: 'USDC',
        name: 'USD Coin',
        label: 'USDC',
        decimals: 6,
        logoURI: null,
        issuer: null,
        issuerUrl: null,
        trustTier: 'tier1',
        liquidityTier: 'tier1',
        stockVariantTier: null,
        tags: [],
        advisory: null,
        rank: 0,
        explorerUrl: `https://basescan.org/token/${USDC_BASE}`,
        market: null,
        ...overrides,
    };
}

describe('resolveVariantDisplay', () => {
    test('uses the resolved symbol / name, falling back to the asset', () => {
        expect(resolveVariantDisplay(v2(), { symbol: 'USD', name: 'US Dollar' })).toEqual({
            displaySymbol: 'USDC',
            displayName: 'USD Coin',
        });
        expect(
            resolveVariantDisplay(v2({ symbol: null, name: null, label: null }), { symbol: 'USD', name: 'US Dollar' }),
        ).toEqual({
            displaySymbol: 'USD',
            displayName: 'US Dollar',
        });
        expect(
            resolveVariantDisplay(v2({ symbol: '???', name: null, label: null }), { symbol: null, name: null }),
        ).toEqual({
            displaySymbol: '???',
            displayName: '???',
        });
    });

    test('xStock / Ondo issuer labels synthesize the provider symbol', () => {
        expect(
            resolveVariantDisplay(v2({ symbol: 'TSLA', name: null, label: 'xStock' }), {
                symbol: 'TSLA',
                name: 'Tesla',
            }).displaySymbol,
        ).toBe('TSLAx');
        expect(
            resolveVariantDisplay(v2({ symbol: 'TSLA', name: null, label: 'Ondo' }), { symbol: 'TSLA', name: 'Tesla' })
                .displaySymbol,
        ).toBe('TSLAon');
        expect(
            resolveVariantDisplay(v2({ symbol: 'TSLAx', name: null, label: 'xStock' }), {
                symbol: 'TSLA',
                name: 'Tesla',
            }).displaySymbol,
        ).toBe('TSLAx');
        // A label equal to the asset's own symbol is not an issuer marker.
        expect(
            resolveVariantDisplay(v2({ symbol: 'ONDO', name: null, label: 'ONDO' }), { symbol: 'ONDO', name: 'Ondo' })
                .displaySymbol,
        ).toBe('ONDO');
    });
});

describe('toAssetPageVariant', () => {
    test('keeps enrichment keys only when the API sent them and normalizes the advisory', () => {
        const plain = toAssetPageVariant(v2(), { symbol: 'USD', name: 'US Dollar' });
        expect('executionQuality' in plain).toBe(false);
        expect(plain.advisory).toBeNull();
        const enriched = toAssetPageVariant(
            v2({
                executionQuality: null,
                pegHealth: null,
                preStocks: null,
                advisory: { status: 'caution', reason: 'x', url: null, since: 5, source: 'admin' },
            }),
            { symbol: 'USD', name: 'US Dollar' },
        );
        expect(enriched.executionQuality).toBeNull();
        expect(enriched.pegHealth).toBeNull();
        expect(enriched.advisory?.status).toBe('caution');
        expect(solanaMintOf(enriched)).toBe(undefined);
        expect(solanaMintOf({ chain: 'solana', address: 'EPjF' })).toBe('EPjF');
    });
});
