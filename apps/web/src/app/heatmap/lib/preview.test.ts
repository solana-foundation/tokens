import { describe, expect, test } from 'bun:test';

import { miniPreview, trendingSector } from './preview';
import type { HeatmapAsset, HeatmapData, HeatmapVariant } from './types';

function variant(id: string): HeatmapVariant {
    return {
        id,
        mint: id,
        symbol: id,
        name: id,
        groupId: 'wrapped',
        groupLabel: 'Wrapped',
        groupOrder: 50,
        price: 1,
        change24h: 0.1,
        change1h: null,
        marketCap: null,
        volume24h: 1,
        liquidity: null,
    };
}

function asset(assetId: string, change24h: number | null, variants: HeatmapVariant[] = []): HeatmapAsset {
    return {
        assetId,
        symbol: assetId,
        name: assetId,
        sectorId: 'majors',
        price: 1,
        change24h,
        change1h: null,
        marketCap: null,
        marketCapSource: 'underlying',
        volume24h: 1,
        variantCount: variants.length,
        variants,
    };
}

describe('miniPreview', () => {
    const full: HeatmapData = {
        sectors: [
            {
                id: 'majors',
                label: 'Crypto',
                assets: [asset('bitcoin', 0.1, [variant('a'), variant('b')]), asset('zcash', 2), asset('buidl', null)],
            },
            { id: 'etfs', label: 'ETFs', assets: [asset('spy', 0.4)] },
            {
                id: 'stocks',
                label: 'Stocks',
                assets: [
                    { ...asset('small', 1), volume24h: 10 },
                    { ...asset('big', -1), volume24h: 1000 },
                    { ...asset('mid', 0.5), volume24h: 100 },
                ],
            },
        ],
        assetCount: 7,
        variantCount: 2,
        generatedAt: 0,
    };
    const trending = { id: 'trending', label: 'Trending', assets: [asset('near', -1.2)] };

    test('offers Stocks, Crypto and Trending, in that order', () => {
        expect(miniPreview(full, 'majors', { extraSectors: [trending] })!.sectors).toEqual([
            { id: 'stocks', label: 'Stocks' },
            { id: 'majors', label: 'Crypto' },
            { id: 'trending', label: 'Trending' },
        ]);
    });

    test('skips Trending when it is unavailable', () => {
        expect(miniPreview(full, 'trending')!.sectors.map(s => s.id)).toEqual(['stocks', 'majors']);
        expect(miniPreview(full, 'trending')!.sector.id).toBe('stocks');
    });

    test('returns the category without dead assets or variant lists, keeping hover-card fields', () => {
        const { sector } = miniPreview(full, 'majors')!;

        expect(sector.label).toBe('Crypto');
        expect(sector.assets.map(a => a.assetId)).toEqual(['bitcoin', 'zcash']);
        expect(sector.assets.every(a => a.variants.length === 0)).toBe(true);
        expect(sector.assets[0]).toMatchObject({ name: 'bitcoin', price: 1 });
    });

    test('keeps the highest-volume assets when limited', () => {
        expect(miniPreview(full, 'stocks', { limit: 2 })!.sector.assets.map(a => a.assetId)).toEqual(['big', 'mid']);
    });

    test('falls back to Stocks for a category it does not offer', () => {
        expect(miniPreview(full, 'etfs')!.sector.id).toBe('stocks');
        expect(miniPreview(full, 'nope')!.sector.id).toBe('stocks');
    });
});

describe('trendingSector', () => {
    test('one populated tile per asset, keeping the best-ranked token', () => {
        const sector = trendingSector([
            {
                assetId: 'near',
                mint: '3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG',
                symbol: 'NEAR',
                name: 'NEAR (Bridged)',
                market: { priceChange24hPercent: -1.2, volume24hUSD: 12e6, price: 5 },
            },
            { assetId: 'near', symbol: 'wNEAR', market: { priceChange24hPercent: 3, volume24hUSD: 1e6 } },
            { assetId: 'quiet', symbol: 'Q', market: { priceChange24hPercent: null, volume24hUSD: 50 } },
            { assetId: '', symbol: 'X', market: { priceChange24hPercent: 1, volume24hUSD: 5 } },
        ]);

        expect(sector).toMatchObject({ id: 'trending', label: 'Trending' });
        expect(sector.assets.map(a => [a.assetId, a.symbol, a.change24h, a.volume24h])).toEqual([
            ['near', 'NEAR', -1.2, 12e6],
        ]);
        expect(sector.assets[0]).toMatchObject({
            name: 'NEAR (Bridged)',
            price: 5,
            marketCap: null,
            mint: '3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG',
        });
    });
});
