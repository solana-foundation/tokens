import { describe, expect, test } from 'bun:test';

import {
    canonicalAssetFromV1Resolve,
    singletonMintOf,
    v1DetailToFallback,
    v1MarketToV2Market,
} from './v1-asset-fallback';

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

    test('keeps the advisory v1 attached to the variant', () => {
        const asset = canonicalAssetFromV1Resolve({
            assetId: `solana-${MINT}`,
            asset: { assetId: `solana-${MINT}`, category: 'crypto', aliases: [] },
            variant: {
                mint: MINT,
                kind: 'spot',
                trustTier: 'tier3',
                tags: [],
                advisory: { status: 'compromised', reason: 'exploit', url: null, since: 1 },
            },
        });
        expect(asset.variants[0]!.advisory?.status).toBe('compromised');
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

describe('v1 detail → fallback market data', () => {
    test('maps a v1 market block onto the v2 shape and drops non-finite values', () => {
        const market = v1MarketToV2Market({
            source: 'birdeye',
            price: 1.5,
            liquidity: 250_000,
            volume24hUSD: 'n/a',
            marketCap: Number.NaN,
            fdv: 1_000_000,
            logoURI: 'https://img/x.png',
        });
        expect(market.source).toBe('birdeye');
        expect(market.metricsSource).toBeNull();
        expect(market.price).toBe(1.5);
        expect(market.liquidity).toBe(250_000);
        expect(market.volume24hUSD).toBeNull();
        expect(market.marketCap).toBeNull();
        expect(market.fdv).toBe(1_000_000);
        expect(market.trade24h).toBeNull();
    });

    test('collects per-mint markets, logos and asset stats', () => {
        const out = v1DetailToFallback({
            asset: {
                stats: { price: 2, liquidity: 10, volume24hUSD: 3, marketCap: 4, fdv: 5, totalSupply: 6 },
                primaryVariant: { mint: MINT, market: { price: 2, logoURI: ' https://img/a.png ' } },
                variantGroups: {
                    spot: [
                        { mint: MINT, market: { price: 2 } },
                        { mint: 'nomarket', market: null },
                    ],
                    lst: [{ mint: 'grouped', market: { price: 7 } }],
                    yield: null,
                },
            },
        });
        expect(out.stats?.price).toBe(2);
        expect(out.stats?.volume30dUSD).toBeNull();
        expect(out.marketByMint.get(MINT)?.price).toBe(2);
        expect(out.marketByMint.has('nomarket')).toBe(false);
        expect(out.logoByMint.get(MINT)).toBe('https://img/a.png');
        expect(out.marketByMint.get('grouped')?.price).toBe(7);
    });

    test('a response without the asset envelope yields no data', () => {
        const out = v1DetailToFallback({});
        expect(out.stats).toBeNull();
        expect(out.marketByMint.size).toBe(0);
    });
});
