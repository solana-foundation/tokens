import { describe, expect, test } from 'bun:test';

import type { AssetResult, AssetRow, AssetsRepo } from './assets';
import type { AssetCollectionsReadsRepo } from './assetCollectionsReads';
import type { AssetDeletionTombstonesRepo } from './assetDeletionTombstones';
import type { CoingeckoReadsRepo } from './coingeckoReads';
import type { StockReadsRepo } from './stockReads';
import {
    rowToMarketResult,
    rowToRollupResult,
    rowToVariantResult,
    v2AssetsChains,
    v2AssetsGetMarketsByKeys,
    v2AssetsGetVariant,
    v2AssetsListVariantsByAssetIds,
    type V2AssetsReadsDeps,
    type V2AssetsReadsRepo,
    type V2MarketDbRow,
    type V2VariantDbRow,
} from './v2AssetsReads';

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function variantRow(overrides: Partial<V2VariantDbRow> = {}): V2VariantDbRow {
    return {
        chain: 'base',
        address: USDC_BASE,
        asset_id: 'usd',
        variant_id: `base:${USDC_BASE}`,
        kind: 'stablecoin',
        trust_tier: 'tier3',
        stock_variant_tier: null,
        tags: ['coingecko-derived'],
        label: 'USDC',
        issuer: null,
        issuer_url: null,
        decimals: 6,
        origin: 'coingecko',
        source: 'coingecko',
        is_active: true,
        ...overrides,
    };
}

function marketRow(overrides: Partial<V2MarketDbRow> = {}): V2MarketDbRow {
    return {
        chain: 'base',
        address: USDC_BASE,
        mint: USDC_BASE,
        origin: 'birdeye',
        source: 'birdeye',
        metrics_source: 'birdeye',
        birdeye_metrics: {
            source: 'birdeye',
            symbol: 'USDC',
            name: 'USD Coin',
            price: 1,
            liquidity: 10,
            lastFetchedAt: 5,
        },
        rwa_metrics: null,
        clickhouse_metrics: null,
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        logo_uri: 'https://logo.test/usdc.png',
        price: 1,
        liquidity: 10,
        volume_1h_usd: null,
        volume_24h_usd: 20,
        trade_1h: null,
        trade_24h: null,
        unique_wallet_1h: null,
        unique_wallet_24h: null,
        market_cap: null,
        fdv: null,
        price_change_24h_percent: null,
        price_change_1h_percent: null,
        holder: null,
        total_supply: null,
        circulating_supply: null,
        last_trade_human_time: null,
        extensions: null,
        as_of: null,
        last_trade_at: null,
        last_fetched_at: 5,
        overview_last_fetched_at: 5,
        ...overrides,
    };
}

const assetRow: AssetRow = {
    id: 'a1',
    asset_id: 'usd',
    category: 'stablecoin',
    name: 'US Dollar',
    symbol: 'USD',
    aliases: ['usd'],
    coingecko_id: null,
    description: null,
    image_url: null,
    is_active: true,
    region: null,
    industry: null,
    created_at: new Date(0),
    updated_at: new Date(0),
};

function fakeV2(overrides: Partial<V2AssetsReadsRepo> = {}): V2AssetsReadsRepo {
    return {
        async chainSummary() {
            return [];
        },
        async findVariantsByAssetIds() {
            return [];
        },
        async findVariantsByKey() {
            return [];
        },
        async findVariantsByKeys() {
            return [];
        },
        async findMarketsByKeys() {
            return [];
        },
        async findRollupsByAssetIds() {
            return [];
        },
        ...overrides,
    };
}

function deps(v2: V2AssetsReadsRepo): V2AssetsReadsDeps {
    const assetsRepo: AssetsRepo = {
        async findByAssetId(assetId) {
            return assetId === 'usd' ? assetRow : null;
        },
        async findByAssetIds(assetIds) {
            return assetIds.includes('usd') ? [assetRow] : [];
        },
        async findAliasesByNormalized() {
            return [];
        },
        async findAliasesByFuzzy() {
            return [];
        },
        async findAssetsByNameFuzzy() {
            return [];
        },
        async findAssetsBySymbolFuzzy() {
            return [];
        },
        async findVariantByMint() {
            return null;
        },
        async isDeletedRef() {
            return false;
        },
        async listAssetIdRenames() {
            return [];
        },
        async listByCategory() {
            return [];
        },
        async listActiveWithCoinGecko() {
            return [];
        },
        async setDescriptionByAssetId() {
            return false;
        },
    };
    return {
        v2,
        assetsRepo,
        assetCollectionsReadsRepo: {} as AssetCollectionsReadsRepo,
        deletionTombstonesRepo: {} as AssetDeletionTombstonesRepo,
        stockReadsRepo: {} as StockReadsRepo,
        coingeckoReadsRepo: {} as CoingeckoReadsRepo,
    };
}

describe('row mappers', () => {
    test('rollup rows: the Solana mirror is a complete 30-day window, computed rows carry their sampled days', () => {
        const base = { asset_id: 'usd', chain: 'solana', liquidity: 1, volume_24h_usd: 2, volume_30d_usd: 60, primary_address: null, variant_count: 1, last_computed_at: 5 };
        expect(rowToRollupResult(base)).toEqual(expect.objectContaining({ origin: 'solana_v1', volume30dDays: 30, volume30dUSD: 60 }));
        expect(rowToRollupResult({ ...base, chain: 'base', origin: 'computed', volume_30d_days: 12 })).toEqual(
            expect.objectContaining({ origin: 'computed', volume30dDays: 12 }),
        );
        expect(rowToRollupResult({ ...base, chain: 'base', origin: 'computed', volume_30d_days: null })?.volume30dDays).toBe(0);
        expect(rowToRollupResult({ ...base, chain: 'base', origin: 'computed', volume_30d_days: 12, volume_30d_by_address: { '0xabc': { volume: 7, days: 12 }, '0xdef': { volume: '5', days: '3' }, bad: 1 } })?.volume30dByAddress).toEqual({ '0xabc': { volume: 7, days: 12 }, '0xdef': { volume: 5, days: 3 } });
        expect(rowToRollupResult({ ...base, origin: 'solana_v1', volume_30d_by_address: { x: { volume: 1, days: 2 } } })?.volume30dByAddress).toEqual({ x: { volume: 1, days: 2 } });
        expect(rowToRollupResult({ ...base, origin: 'solana_v1', volume_30d_by_address: null })?.volume30dByAddress).toBeNull();
    });

    test('variant rows carry the key and explorer url; unknown chains are dropped', () => {
        const out = rowToVariantResult(variantRow())!;
        expect(out.key).toBe(`base:${USDC_BASE}`);
        expect(out.explorerUrl).toBe(`https://basescan.org/token/${USDC_BASE}`);
        expect(out.tags).toEqual(['coingecko-derived']);
        expect(out.coingeckoId).toBeNull();
        expect(rowToVariantResult(variantRow({ coingecko_id: 'usd-coin', coingecko_id_source: 'resolved' }))?.coingeckoId).toBe(
            'usd-coin',
        );
        expect(rowToVariantResult(variantRow({ coingecko_id: '  ' }))?.coingeckoId).toBeNull();
        expect(rowToVariantResult(variantRow({ chain: 'tron' }))).toBeNull();
    });

    test('market rows go through the shared snapshot builder', () => {
        const out = rowToMarketResult(marketRow())!;
        expect(out.key).toBe(`base:${USDC_BASE}`);
        expect(out.market?.price).toBe(1);
        expect(out.market?.symbol).toBe('USDC');
        expect(
            rowToMarketResult(
                marketRow({
                    source: 'touch',
                    metrics_source: null,
                    birdeye_metrics: null,
                    symbol: null,
                    name: null,
                    price: null,
                    liquidity: null,
                    volume_24h_usd: null,
                    decimals: null,
                    logo_uri: null,
                }),
            )?.market,
        ).toBeNull();
    });
});

describe('v2AssetsChains', () => {
    test('answers every registry chain, zeros when the table has no rows', async () => {
        const out = await v2AssetsChains(
            deps(
                fakeV2({
                    async chainSummary() {
                        return [
                            {
                                chain: 'base',
                                active_variants: '3',
                                asset_count: 2n,
                                with_markets: 1,
                                max_market_fetched_at: '5',
                            },
                        ];
                    },
                }),
            ),
            {},
        );
        expect(out.chains).toHaveLength(6);
        expect(out.chains.find(c => c.id === 'base')).toEqual({
            id: 'base',
            activeVariants: 3,
            assetCount: 2,
            withMarkets: 1,
            maxMarketFetchedAt: 5,
        });
        expect(out.chains.find(c => c.id === 'polygon')).toEqual({
            id: 'polygon',
            activeVariants: 0,
            assetCount: 0,
            withMarkets: 0,
            maxMarketFetchedAt: null,
        });
    });
});

describe('v2AssetsGetVariant', () => {
    test('requires chain, normalizes the address, and returns the owning asset + market', async () => {
        const v2 = fakeV2({
            async findVariantsByKey(chain, address) {
                expect(chain).toBe('base');
                expect(address).toBe(USDC_BASE);
                return [variantRow()];
            },
            async findMarketsByKeys() {
                return [marketRow()];
            },
        });
        const out = await v2AssetsGetVariant(deps(v2), {
            chain: 'base',
            address: USDC_BASE.toUpperCase().replace('0X', '0x'),
        });
        expect(out?.variants[0]?.key).toBe(`base:${USDC_BASE}`);
        expect(out?.assets[0]?.assetId).toBe('usd');
        expect(out?.market?.price).toBe(1);
        await expect(v2AssetsGetVariant(deps(v2), { address: USDC_BASE })).rejects.toThrow(/chain is required/);
        await expect(v2AssetsGetVariant(deps(v2), { chain: 'base', address: USDC_SOLANA })).rejects.toThrow(
            /not a valid evm address/,
        );
        await expect(v2AssetsGetVariant(deps(v2), { chain: 'tron', address: USDC_BASE })).rejects.toThrow(
            /chain must be one of/,
        );
    });

    test('null when nothing active claims the key or the asset is gone', async () => {
        expect(await v2AssetsGetVariant(deps(fakeV2()), { chain: 'base', address: USDC_BASE })).toBeNull();
        const inactive = fakeV2({
            async findVariantsByKey() {
                return [variantRow({ is_active: false })];
            },
        });
        expect(await v2AssetsGetVariant(deps(inactive), { chain: 'base', address: USDC_BASE })).toBeNull();
        const orphan = fakeV2({
            async findVariantsByKey() {
                return [variantRow({ asset_id: 'missing' })];
            },
        });
        expect(await v2AssetsGetVariant(deps(orphan), { chain: 'base', address: USDC_BASE })).toBeNull();
    });
});

describe('v2AssetsGetMarketsByKeys', () => {
    test('keeps request order, dedupes, and answers unknown keys with empty variants', async () => {
        const v2 = fakeV2({
            async findVariantsByKeys() {
                return [variantRow(), variantRow({ is_active: false, asset_id: 'other' })];
            },
            async findMarketsByKeys() {
                return [marketRow()];
            },
        });
        const out = await v2AssetsGetMarketsByKeys(deps(v2), {
            keys: [
                { chain: 'solana', address: USDC_SOLANA },
                { chain: 'base', address: USDC_BASE },
                { chain: 'base', address: USDC_BASE },
            ],
        });
        expect(out.map(e => e.key)).toEqual([`solana:${USDC_SOLANA}`, `base:${USDC_BASE}`]);
        expect(out[0]?.variants).toEqual([]);
        expect(out[0]?.market).toBeNull();
        expect(out[1]?.variants.map(v => v.assetId)).toEqual(['usd']);
        expect(out[1]?.market?.liquidity).toBe(10);
    });

    test('an active variant whose asset is inactive or missing is not returned, as in the single lookup', async () => {
        const v2 = fakeV2({
            async findVariantsByKeys() {
                // Both rows active; only `usd` exists as a live asset in the fake assets repo.
                return [variantRow(), variantRow({ asset_id: 'ghost' })];
            },
        });
        const out = await v2AssetsGetMarketsByKeys(deps(v2), { keys: [{ chain: 'base', address: USDC_BASE }] });
        expect(out[0]?.variants.map(v => v.assetId)).toEqual(['usd']);
    });

    test('rejects more than 250 keys', async () => {
        const keys = Array.from({ length: 251 }, () => ({ chain: 'base', address: USDC_BASE }));
        await expect(v2AssetsGetMarketsByKeys(deps(fakeV2()), { keys })).rejects.toThrow(/max 250/);
    });
});

describe('v2AssetsListVariantsByAssetIds', () => {
    test('groups by asset id and passes the chain filter through', async () => {
        const v2 = fakeV2({
            async findVariantsByAssetIds(assetIds, options) {
                expect(assetIds).toEqual(['usd', 'bitcoin']);
                expect(options).toEqual({ chain: 'base', includeInactive: false });
                return [variantRow()];
            },
        });
        const out = await v2AssetsListVariantsByAssetIds(deps(v2), {
            assetIds: ['usd', 'bitcoin', 'usd'],
            chain: 'base',
        });
        expect(out).toEqual([
            { assetId: 'usd', variants: [rowToVariantResult(variantRow())!] },
            { assetId: 'bitcoin', variants: [] },
        ]);
    });
});

export type { AssetResult };
