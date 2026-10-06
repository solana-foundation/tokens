import { describe, expect, test } from 'bun:test';

import { buildHeatmapData } from './build-heatmap';
import type { HeatmapSectorMembership, RawAsset, RawVariant } from './types';

function variant(mint: string, overrides: Partial<RawVariant> = {}): RawVariant {
    return {
        mint,
        symbol: mint.toUpperCase(),
        kind: 'wrapped',
        tags: [],
        market: { marketCap: 100, price: 1 },
        ...overrides,
    };
}

function asset(overrides: Partial<RawAsset>): RawAsset {
    const variants = overrides.variants ?? [variant('aaa')];
    return {
        assetId: 'test',
        symbol: 'TST',
        name: 'Test',
        stats: null,
        primaryVariant: variants[0] ?? null,
        variants,
        ...overrides,
    };
}

const LISTS: HeatmapSectorMembership[] = [
    { id: 'majors', label: 'Crypto', assetIds: ['bitcoin', 'test', 'single', 'dup', 'both'] },
    { id: 'currencies', label: 'Currencies', assetIds: ['usd'] },
    { id: 'stocks', label: 'Stocks', assetIds: ['nvidia', 'acme', 'both'] },
];

function build(assets: RawAsset[], membership = LISTS) {
    return buildHeatmapData({ listId: 'all', assets }, membership, 1_700_000_000_000);
}

describe('buildHeatmapData', () => {
    test('groups assets into the home page categories, in their order', () => {
        const data = build([
            asset({ assetId: 'nvidia' }),
            asset({ assetId: 'bitcoin' }),
            asset({ assetId: 'unlisted' }),
        ]);

        expect(data.sectors.map(sector => [sector.id, sector.label, sector.assets.map(a => a.assetId)])).toEqual([
            ['majors', 'Crypto', ['bitcoin']],
            ['stocks', 'Stocks', ['nvidia']],
            ['other', 'Other', ['unlisted']],
        ]);
        expect(data.assetCount).toBe(3);
        expect(data.generatedAt).toBe(1_700_000_000_000);
    });

    test('an asset on several lists belongs to the first', () => {
        const data = build([asset({ assetId: 'both' })]);

        expect(data.sectors.map(sector => sector.id)).toEqual(['majors']);
        expect(data.sectors[0]!.assets[0]!.sectorId).toBe('majors');
    });

    test('prefers the underlying market cap and records where the figure came from', () => {
        const [underlying, onchainOnly] = build([
            asset({
                assetId: 'bitcoin',
                canonicalMarket: { source: 'coingecko', marketCap: 1_700_000_000_000 },
                stats: { marketCap: 5 },
                variants: [variant('a', { market: { marketCap: 300 } }), variant('b', { market: { marketCap: 200 } })],
            }),
            asset({
                assetId: 'usd',
                canonicalMarket: { source: 'coingecko', marketCap: 0 },
                stats: { marketCap: null },
                variants: [variant('c', { market: { marketCap: 700 } }), variant('d', { market: { marketCap: null } })],
            }),
        ]).sectors.flatMap(sector => sector.assets);

        expect(underlying).toMatchObject({
            marketCap: 1_700_000_000_000,
            marketCapSource: 'underlying',
        });
        expect(onchainOnly).toMatchObject({ marketCap: 700, marketCapSource: 'onchain' });
    });

    test('keeps a missing price change as null instead of treating it as flat', () => {
        const [stock] = build([
            asset({
                assetId: 'acme',
                canonicalMarket: { source: 'clickhouse_stock', marketCap: 10, priceChange24hPercent: null },
                stats: { priceChange24hPercent: null, priceChange1hPercent: Number.NaN },
            }),
        ]).sectors[0]!.assets;

        expect(stock!.change24h).toBeNull();
        expect(stock!.change1h).toBeNull();
    });

    test('stock canonicals take the on-chain token change first, others the canonical change', () => {
        const assets = build([
            asset({
                assetId: 'acme',
                canonicalMarket: { source: 'clickhouse_stock', priceChange24hPercent: 1 },
                stats: { priceChange24hPercent: -2.345 },
            }),
            asset({
                assetId: 'bitcoin',
                canonicalMarket: { source: 'coingecko', priceChange24hPercent: 3.14159 },
                stats: { priceChange24hPercent: -9 },
            }),
        ]).sectors.flatMap(sector => sector.assets);

        expect(assets.find(a => a.assetId === 'acme')!.change24h).toBe(-2.35);
        expect(assets.find(a => a.assetId === 'bitcoin')!.change24h).toBe(3.14);
    });

    test('takes on-Solana volume from asset stats, else from the variants', () => {
        const assets = build([
            asset({ assetId: 'bitcoin', stats: { volume24hUSD: 900.4 } }),
            asset({
                assetId: 'usd',
                stats: { volume24hUSD: null },
                variants: [
                    variant('a', { market: { volume24hUSD: 30 } }),
                    variant('b', { market: { volume24hUSD: 12 } }),
                ],
            }),
            asset({ assetId: 'nvidia', stats: { volume24hUSD: 0 } }),
        ]).sectors.flatMap(sector => sector.assets);

        expect(assets.map(a => [a.assetId, a.volume24h])).toEqual([
            ['bitcoin', 900],
            ['usd', 42],
            ['nvidia', null],
        ]);
    });

    test('only multi-variant assets carry their variants, grouped by display category', () => {
        const [single, multi] = build([
            asset({ assetId: 'single', variants: [variant('only')] }),
            asset({
                assetId: 'bitcoin',
                variants: [
                    variant('cb', { kind: 'wrapped' }),
                    variant('wb', { kind: 'bridged', symbol: null, name: null }),
                ],
            }),
        ]).sectors[0]!.assets;

        expect(single).toMatchObject({ variantCount: 1, variants: [] });
        expect(multi!.variantCount).toBe(2);
        expect(multi!.variants.map(v => [v.mint, v.groupLabel])).toEqual([
            ['cb', 'Wrapped'],
            ['wb', 'Bridged'],
        ]);
        // No symbol anywhere: fall back to a shortened mint rather than an empty label.
        expect(multi!.variants[1]!.symbol).toBe('wb…');
    });

    test('keeps one address on two chains as two variants, and only links Solana mints', () => {
        const evm = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
        const solana = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
        const [bitcoin] = build([
            asset({
                assetId: 'bitcoin',
                variants: [
                    variant(evm, { variantId: `base:${evm}` }),
                    variant(evm, { variantId: `ethereum:${evm}` }),
                    variant(solana, { variantId: 'bitcoin:cbBTC' }),
                ],
            }),
        ]).sectors[0]!.assets;

        expect(bitcoin!.variants.map(v => [v.id, v.hasTokenPage])).toEqual([
            [`base:${evm}`, false],
            [`ethereum:${evm}`, false],
            ['bitcoin:cbBTC', true],
        ]);
    });

    test('drops duplicates and assets with no variants at all', () => {
        const data = build([
            asset({ assetId: 'dup' }),
            asset({ assetId: 'dup' }),
            asset({ assetId: 'empty', primaryVariant: null, variants: [] }),
            asset({ assetId: '  ' }),
        ]);

        expect(data.sectors.flatMap(sector => sector.assets).map(a => a.assetId)).toEqual(['dup']);
        expect(data.variantCount).toBe(1);
    });
});
