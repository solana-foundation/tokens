import { describe, expect, test } from 'bun:test';

import { resolveAssetPageCapabilities } from './asset-page-capabilities';

describe('resolveAssetPageCapabilities', () => {
    test('solana variant view: everything on, no trade fallback', () => {
        expect(
            resolveAssetPageCapabilities({
                activeChain: 'solana',
                isVariantView: true,
                assetChains: ['solana', 'base'],
                isStablecoin: false,
                variantCount: 3,
            }),
        ).toEqual({
            chart: 'variant',
            dexMarkets: true,
            marketsOverview: false,
            risk: true,
            executionQuality: true,
            swap: true,
            tradeOnChain: null,
        });
    });

    test('base variant view: canonical chart, nothing Solana-only, trade on solana', () => {
        expect(
            resolveAssetPageCapabilities({
                activeChain: 'base',
                isVariantView: true,
                assetChains: ['solana', 'base'],
                isStablecoin: true,
                variantCount: 3,
            }),
        ).toEqual({
            chart: 'canonical',
            dexMarkets: false,
            marketsOverview: false,
            risk: false,
            executionQuality: false,
            swap: false,
            tradeOnChain: 'solana',
        });
    });

    test('canonical view of an EVM-only asset: no markets overview, no swap, no fallback', () => {
        expect(
            resolveAssetPageCapabilities({
                activeChain: 'ethereum',
                isVariantView: false,
                assetChains: ['ethereum', 'base'],
                isStablecoin: false,
                variantCount: 2,
            }),
        ).toEqual({
            chart: 'canonical',
            dexMarkets: false,
            marketsOverview: false,
            risk: false,
            executionQuality: false,
            swap: false,
            tradeOnChain: null,
        });
    });

    test('single-variant stablecoin shows risk on the canonical view; no active variant → no chart', () => {
        expect(
            resolveAssetPageCapabilities({
                activeChain: 'solana',
                isVariantView: false,
                assetChains: ['solana'],
                isStablecoin: true,
                variantCount: 1,
            }).risk,
        ).toBe(true);
        expect(
            resolveAssetPageCapabilities({
                activeChain: null,
                isVariantView: false,
                assetChains: [],
                isStablecoin: false,
                variantCount: 0,
            }).chart,
        ).toBe('none');
    });
});
