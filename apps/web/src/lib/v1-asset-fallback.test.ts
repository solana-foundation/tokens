import { describe, expect, test } from 'bun:test';

import { canonicalAssetFromV1Resolve, singletonMintOf } from './v1-asset-fallback';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('singletonMintOf', () => {
    test('extracts the mint from a v1 singleton id and rejects everything else', () => {
        expect(singletonMintOf(`solana-${MINT}`)).toBe(MINT);
        expect(singletonMintOf(MINT)).toBeNull();
        expect(singletonMintOf('solana-not-a-mint')).toBeNull();
        expect(singletonMintOf('usd-coin')).toBeNull();
    });
});

describe('canonicalAssetFromV1Resolve', () => {
    test('shapes a launch-coin singleton like a one-variant registry asset', () => {
        const asset = canonicalAssetFromV1Resolve({
            assetId: `solana-${MINT}`,
            asset: { assetId: `solana-${MINT}`, name: ' Launch ', symbol: 'LNCH', category: 'crypto', aliases: [] },
            variant: {
                mint: MINT,
                kind: 'spot',
                trustTier: 'tier3',
                tags: ['launchpad'],
                symbol: 'LNCH',
                advisory: null,
            },
        });
        expect(asset.name).toBe('Launch');
        expect(asset.symbol).toBe('LNCH');
        expect(asset.variants).toHaveLength(1);
        expect(asset.variants[0]!.mint).toBe(MINT);
        expect(asset.variants[0]!.variantId).toBe(`solana-${MINT}:${MINT.slice(0, 8)}`);
        expect(asset.variants[0]!.advisory).toBe(undefined);
    });

    test('an asset without a variant yields no variants', () => {
        const asset = canonicalAssetFromV1Resolve({
            assetId: 'x',
            asset: { assetId: 'x', category: 'crypto', aliases: [] },
            variant: null,
        });
        expect(asset.variants).toEqual([]);
        expect(asset.name).toBe(undefined);
    });
});
