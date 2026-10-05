import { describe, expect, it } from 'bun:test';

import { assetsApiCuratedPrefetchForApi, type CuratedPrefetchDeps } from './assetsApiCuratedPrefetch';
import type { AssetsRepo, AssetRow } from './assets';
import type { AssetVariantDocRow, AssetVariantsRepo } from './assetVariants';
import type { AssetMarketRow, AssetMarketsRepo } from './assetMarkets';
import type { VariantMarketRow, VariantMarketsRepo } from './variantMarkets';
import type { FillQualityRow, FillQualityReadsRepo } from './fillQualityReads';
import type { SanctumLstRow, SanctumLstsRepo } from './sanctumLsts';
import type { StockInstrumentRow, StockPriceRow, StockReadsRepo } from './stockReads';
import type { AssetCollectionMemberRow, AssetCollectionsReadsRepo } from './assetCollectionsReads';
import type { AssetDeletionTombstonesRepo } from './assetDeletionTombstones';
import type { CoingeckoReadsRepo } from './coingeckoReads';
import type { TokensReadsRepo } from './tokensReads';

const NOW = new Date('2026-07-01T00:00:00Z');

function makeAssetRow(overrides: Partial<AssetRow> = {}): AssetRow {
    return {
        id: 'r1',
        asset_id: 'solana',
        category: 'crypto',
        name: 'Solana',
        symbol: 'SOL',
        aliases: ['SOL'],
        coingecko_id: 'solana',
        description: null,
        image_url: null,
        is_active: true,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

function makeVariantRow(overrides: Partial<AssetVariantDocRow> = {}): AssetVariantDocRow {
    return {
        asset_id: 'solana',
        chain: 'solana',
        mint: 'So11111111111111111111111111111111111111112',
        variant_id: 'solana:mint',
        kind: 'native',
        trust_tier: 'tier1',
        stock_variant_tier: null,
        tags: [],
        issuer: null,
        issuer_url: null,
        label: null,
        is_active: true,
        created_at: NOW.getTime(),
        updated_at: NOW.getTime(),
        ...overrides,
    };
}

function makeEmptyDeps(overrides: Partial<CuratedPrefetchDeps> = {}): CuratedPrefetchDeps {
    const assetsRepo: AssetsRepo = {
        async findByAssetId() {
            return null;
        },
        async findByAssetIds() {
            return [];
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
        async listAssetIdRenames() {
            return [];
        },
        async isDeletedRef() {
            return false;
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

    const collectionsRepo: AssetCollectionsReadsRepo = {
        async listMembersBySlug(): Promise<AssetCollectionMemberRow[]> {
            return [];
        },
        async listMemberMintsBySlug() {
            return [];
        },
        async getSummariesBySlugs() {
            return [];
        },
    };

    const variantsRepo: AssetVariantsRepo = {
        async findVariantByMint() {
            return null;
        },
        async findVariantsByMints() {
            return [];
        },
        async findVariantsByAssetIds() {
            return [];
        },
        async findActiveSolanaVariants() {
            return [];
        },
        async findAssetIsActive() {
            return null;
        },
        async findSolanaDefaultVariantsView() {
            return null;
        },
        async upsertSolanaDefaultVariantsView() {},
        async findVariantMarketsByMints() {
            return [];
        },
        async findTokenMarketsByMints() {
            return [];
        },
    };

    const variantMarketsRepo: VariantMarketsRepo = {
        async findLatestByMints(): Promise<VariantMarketRow[]> {
            return [];
        },
    };

    const fillQualityRepo: FillQualityReadsRepo = {
        async findLatestByMints(): Promise<FillQualityRow[]> {
            return [];
        },
    };

    const assetMarketsRepo: AssetMarketsRepo = {
        async findLatestByAssetId() {
            return null;
        },
        async findLatestByAssetIds(): Promise<AssetMarketRow[]> {
            return [];
        },
    };

    const sanctumRepo: SanctumLstsRepo = {
        async listActive(): Promise<SanctumLstRow[]> {
            return [];
        },
        async findByMint() {
            return null;
        },
        async findActiveBySymbolLower() {
            return [];
        },
    };

    const deletionRepo: AssetDeletionTombstonesRepo = {
        async findDeletedNormalizedRefs(): Promise<string[]> {
            return [];
        },
    };

    const stockRepo: StockReadsRepo = {
        async findInstrumentByAssetId() {
            return null;
        },
        async findInstrumentsByAssetIds(): Promise<StockInstrumentRow[]> {
            return [];
        },
        async findPriceByAssetId() {
            return null;
        },
        async findPricesByAssetIds(): Promise<StockPriceRow[]> {
            return [];
        },
    };

    const coingeckoRepo: CoingeckoReadsRepo = {
        async findCoinByCoinId() {
            return null;
        },
        async searchCoinsById() {
            return [];
        },
        async searchCoinsBySymbol() {
            return [];
        },
        async searchCoinsByName() {
            return [];
        },
        async listOhlcv() {
            return [];
        },
        async findPriceLatestByCoinId() {
            return null;
        },
        async findPriceLatestByCoinIds() {
            return [];
        },
        async findTickersLatestByCoinId() {
            return null;
        },
    };

    const tokensRepo: TokensReadsRepo = {
        async findTokenByAddress() {
            return null;
        },
        async findTokensByAddresses() {
            return [];
        },
        async searchTokensBySymbol() {
            return [];
        },
        async searchTokensByName() {
            return [];
        },
        async findTokenMarketsLatestByMint() {
            return null;
        },
        async findTokenMarketsLatestByMints() {
            return [];
        },
        async findTokenDescriptionSummaryByAddress() {
            return null;
        },
    };

    return {
        assetsRepo,
        assetCollectionsReadsRepo: collectionsRepo,
        assetVariantsRepo: variantsRepo,
        variantMarketsRepo,
        fillQualityReadsRepo: fillQualityRepo,
        assetMarketsRepo,
        sanctumLstsRepo: sanctumRepo,
        deletionTombstonesRepo: deletionRepo,
        stockReadsRepo: stockRepo,
        coingeckoReadsRepo: coingeckoRepo,
        tokensReadsRepo: tokensRepo,
        ...overrides,
    };
}

describe('assetsApiCuratedPrefetchForApi', () => {
    it('rejects non-object args with InvalidArgsError', async () => {
        const deps = makeEmptyDeps();
        await expect(assetsApiCuratedPrefetchForApi(deps, null)).rejects.toThrow(/args must be/);
    });

    it('bounds all chunked DB work in a composite request to four concurrent operations', async () => {
        const base = makeEmptyDeps();
        let active = 0;
        let maximum = 0;
        const tracked = async <T>(value: T): Promise<T> => {
            active += 1;
            maximum = Math.max(maximum, active);
            await Bun.sleep(2);
            active -= 1;
            return value;
        };

        const deps = makeEmptyDeps({
            assetsRepo: {
                ...base.assetsRepo,
                findByAssetIds: async () => tracked([]),
            },
            assetCollectionsReadsRepo: {
                ...base.assetCollectionsReadsRepo,
                listMembersBySlug: async () => tracked([]),
            },
            assetVariantsRepo: {
                ...base.assetVariantsRepo,
                findVariantsByAssetIds: async () => tracked([]),
            },
            variantMarketsRepo: { findLatestByMints: async () => tracked([]) },
            fillQualityReadsRepo: {
                findLatestByMints: async () => tracked([]),
            },
            assetMarketsRepo: {
                ...base.assetMarketsRepo,
                findLatestByAssetIds: async () => tracked([]),
            },
            deletionTombstonesRepo: {
                findDeletedNormalizedRefs: async () => tracked([]),
            },
            stockReadsRepo: {
                ...base.stockReadsRepo,
                findInstrumentsByAssetIds: async () => tracked([]),
                findPricesByAssetIds: async () => tracked([]),
            },
            coingeckoReadsRepo: {
                ...base.coingeckoReadsRepo,
                findPriceLatestByCoinIds: async () => tracked([]),
            },
            tokensReadsRepo: {
                ...base.tokensReadsRepo,
                findTokenMarketsLatestByMints: async () => tracked([]),
            },
        });

        await assetsApiCuratedPrefetchForApi(deps, {
            listId: 'all',
            memberAssetIds: Array.from({ length: 2_001 }, (_, i) => `asset-${i}`),
            memberMints: Array.from({ length: 1_001 }, (_, i) => `mint-${i}`),
            additionalCoingeckoIds: Array.from({ length: 120 }, (_, i) => `coin-${i}`),
            includeStock: true,
            includeSanctum: true,
        });

        expect(maximum).toBe(4);
    });

    it('does not turn an optional-read connection timeout into a hollow success', async () => {
        const base = makeEmptyDeps();
        const deps = makeEmptyDeps({
            fillQualityReadsRepo: {
                async findLatestByMints() {
                    throw Object.assign(new Error('connection timed out'), {
                        code: 'CONNECT_TIMEOUT',
                    });
                },
            },
            assetsRepo: {
                ...base.assetsRepo,
                async findByAssetIds() {
                    return [makeAssetRow()];
                },
            },
        });

        let thrown: unknown;
        try {
            await assetsApiCuratedPrefetchForApi(deps, {
                listId: 'majors',
                memberMints: ['So11111111111111111111111111111111111111112'],
                memberAssetIds: ['solana'],
                includeSanctum: false,
                includeStock: false,
            });
        } catch (error) {
            thrown = error;
        }

        expect((thrown as { code?: string } | undefined)?.code).toBe('CONNECT_TIMEOUT');
    });

    it('returns empty envelopes when list has no members', async () => {
        const deps = makeEmptyDeps();
        const out = await assetsApiCuratedPrefetchForApi(deps, {
            listId: 'majors',
            memberMints: [],
            memberAssetIds: [],
            includeSanctum: false,
            includeStock: false,
        });
        expect(out.listId).toBe('majors');
        expect(out.assets).toEqual([]);
        expect(out.variants).toEqual([]);
        expect(out.variantMarkets).toEqual([]);
        expect(out.fillQuality).toEqual([]);
        expect(out.assetAggregates).toEqual([]);
        expect(out.stockInstruments).toEqual([]);
        expect(out.stockPrices).toEqual([]);
        expect(out.sanctumLsts).toEqual([]);
        expect(out.collectionAssetIds).toEqual([[]]);
    });

    it('fans out to majors: collections + registry membership are unioned', async () => {
        // The registry-derived membership carries `solana` in memberAssetIds.
        // The collection repo also returns `solana` — dedupe should give us
        // one row.
        const deps = makeEmptyDeps({
            assetCollectionsReadsRepo: {
                async listMembersBySlug(slug) {
                    if (slug === 'majors') return [{ asset_id: 'solana' }];
                    return [];
                },
                async listMemberMintsBySlug() {
                    return [];
                },
                async getSummariesBySlugs() {
                    return [];
                },
            },
            assetsRepo: {
                ...makeEmptyDeps().assetsRepo,
                async findByAssetIds(assetIds) {
                    return assetIds.includes('solana') ? [makeAssetRow()] : [];
                },
            },
            assetVariantsRepo: {
                ...makeEmptyDeps().assetVariantsRepo,
                async findVariantsByAssetIds(assetIds) {
                    return assetIds.includes('solana') ? [makeVariantRow()] : [];
                },
            },
            variantMarketsRepo: {
                async findLatestByMints(mints) {
                    if (!mints.includes('So11111111111111111111111111111111111111112')) return [];
                    return [
                        {
                            mint: 'So11111111111111111111111111111111111111112',
                            source: 'birdeye',
                            metrics_source: null,
                            birdeye_metrics: null,
                            rwa_metrics: null,
                            clickhouse_metrics: null,
                            symbol: 'SOL',
                            name: 'Solana',
                            decimals: 9,
                            logo_uri: null,
                            price: 150,
                            liquidity: 5_000_000,
                            volume_1h_usd: null,
                            volume_24h_usd: 100_000_000,
                            trade_1h: null,
                            trade_24h: null,
                            unique_wallet_1h: null,
                            unique_wallet_24h: null,
                            market_cap: 60_000_000_000,
                            fdv: 65_000_000_000,
                            price_change_24h_percent: 2.5,
                            price_change_1h_percent: null,
                            holder: null,
                            total_supply: null,
                            circulating_supply: null,
                            last_trade_human_time: null,
                            extensions: null,
                            as_of: NOW.getTime(),
                            last_trade_at: null,
                            last_fetched_at: NOW.getTime(),
                            overview_last_fetched_at: null,
                        },
                    ];
                },
            },
        });
        const out = await assetsApiCuratedPrefetchForApi(deps, {
            listId: 'majors',
            memberMints: ['So11111111111111111111111111111111111111112'],
            memberAssetIds: ['solana'],
            includeSanctum: false,
            includeStock: false,
        });
        expect(out.assets.length).toBe(1);
        expect(out.assets[0]?.assetId).toBe('solana');
        expect(out.variants.length).toBe(1);
        expect(out.variants[0]?.variants[0]?.mint).toBe('So11111111111111111111111111111111111111112');
        expect(out.variantMarkets.length).toBe(1);
        expect(out.variantMarkets[0]?.market?.price).toBe(150);
    });

    it('loads sanctum when includeSanctum=true and passes through on failure', async () => {
        const deps = makeEmptyDeps({
            sanctumLstsRepo: {
                async listActive() {
                    return [
                        {
                            mint: 'JitoSOL111',
                            symbol: 'jitoSOL',
                            symbol_lower: 'jitosol',
                            name: 'Jito Staked SOL',
                            logo_uri: null,
                            website_url: null,
                            tvl_usd: null,
                            apy: null,
                            source_rank: 1,
                            is_active: true,
                            last_seen_at: NOW.getTime(),
                            last_synced_at: NOW.getTime(),
                            created_at: NOW.getTime(),
                            updated_at: NOW.getTime(),
                        },
                    ];
                },
                async findByMint() {
                    return null;
                },
                async findActiveBySymbolLower() {
                    return [];
                },
            },
        });
        const out = await assetsApiCuratedPrefetchForApi(deps, {
            listId: 'lsts',
            memberMints: [],
            memberAssetIds: [],
            includeSanctum: true,
            includeStock: false,
        });
        expect(out.sanctumLsts.length).toBe(1);
        expect(out.sanctumLsts[0]?.mint).toBe('JitoSOL111');
        expect(out.sanctumLsts[0]?.sourceRank).toBe(1);
    });

    it('phase-3: fetches coingecko prices for coinIds on Convex assets + caller additions', async () => {
        const seenCoinIds: string[] = [];
        const deps = makeEmptyDeps({
            assetCollectionsReadsRepo: {
                async listMembersBySlug() {
                    return [{ asset_id: 'solana' }];
                },
                async listMemberMintsBySlug() {
                    return [];
                },
                async getSummariesBySlugs() {
                    return [];
                },
            },
            assetsRepo: {
                ...makeEmptyDeps().assetsRepo,
                async findByAssetIds(ids) {
                    return ids.includes('solana') ? [makeAssetRow({ coingecko_id: 'solana' })] : [];
                },
            },
            coingeckoReadsRepo: {
                ...makeEmptyDeps().coingeckoReadsRepo,
                async findPriceLatestByCoinIds(coinIds) {
                    seenCoinIds.push(...coinIds);
                    return coinIds.map(coin_id => ({
                        coin_id,
                        price_usd: 100,
                        market_cap_usd: null,
                        volume_24h_usd: null,
                        price_change_24h_percent: null,
                        provider_last_updated_at: NOW.getTime(),
                        last_fetched_at: NOW.getTime(),
                    }));
                },
            },
        });
        const out = await assetsApiCuratedPrefetchForApi(deps, {
            listId: 'majors',
            memberMints: [],
            memberAssetIds: ['solana'],
            includeSanctum: false,
            includeStock: false,
            additionalCoingeckoIds: ['bitcoin'],
        });
        expect(seenCoinIds).toContain('solana');
        expect(seenCoinIds).toContain('bitcoin');
        expect(out.coingeckoPrices.length).toBeGreaterThan(0);
    });

    it('phase-3: applies bnb→binancecoin back-compat when normalizing coinIds', async () => {
        const seenCoinIds: string[] = [];
        const deps = makeEmptyDeps({
            assetCollectionsReadsRepo: {
                async listMembersBySlug() {
                    return [{ asset_id: 'bnb' }];
                },
                async listMemberMintsBySlug() {
                    return [];
                },
                async getSummariesBySlugs() {
                    return [];
                },
            },
            assetsRepo: {
                ...makeEmptyDeps().assetsRepo,
                async findByAssetIds(ids) {
                    return ids.includes('bnb')
                        ? [
                              makeAssetRow({
                                  asset_id: 'bnb',
                                  coingecko_id: 'bnb',
                              }),
                          ]
                        : [];
                },
            },
            coingeckoReadsRepo: {
                ...makeEmptyDeps().coingeckoReadsRepo,
                async findPriceLatestByCoinIds(coinIds) {
                    seenCoinIds.push(...coinIds);
                    return [];
                },
            },
        });
        await assetsApiCuratedPrefetchForApi(deps, {
            listId: 'majors',
            memberMints: [],
            memberAssetIds: ['bnb'],
            includeSanctum: false,
            includeStock: false,
        });
        expect(seenCoinIds).toContain('binancecoin');
        expect(seenCoinIds).not.toContain('bnb');
    });

    it('phase-3: falls back to tokenMarkets for mints missing variantMarkets coverage', async () => {
        const seenMissingMints: string[] = [];
        const missingMint = 'MissingMint111111111111111111111111111111111';
        const deps = makeEmptyDeps({
            tokensReadsRepo: {
                ...makeEmptyDeps().tokensReadsRepo,
                async findTokenMarketsLatestByMints(mints) {
                    seenMissingMints.push(...mints);
                    return mints.map(mint => ({
                        mint,
                        source: 'birdeye' as const,
                        markets: [],
                        total: 0,
                        last_fetched_at: NOW.getTime(),
                    }));
                },
            },
        });
        const out = await assetsApiCuratedPrefetchForApi(deps, {
            listId: 'majors',
            memberMints: [missingMint],
            memberAssetIds: [],
            includeSanctum: false,
            includeStock: false,
        });
        expect(seenMissingMints).toContain(missingMint);
        expect(out.tokenMarketsDocs.length).toBeGreaterThan(0);
    });

    it('filters out tombstoned refs before fanning out downstream fetches', async () => {
        const queriedAssetIds: string[] = [];
        const deps = makeEmptyDeps({
            deletionTombstonesRepo: {
                async findDeletedNormalizedRefs(refs) {
                    if (refs.includes('legacy-asset')) return ['legacy-asset'];
                    return [];
                },
            },
            assetCollectionsReadsRepo: {
                async listMembersBySlug() {
                    return [{ asset_id: 'legacy-asset' }, { asset_id: 'solana' }];
                },
                async listMemberMintsBySlug() {
                    return [];
                },
                async getSummariesBySlugs() {
                    return [];
                },
            },
            assetsRepo: {
                ...makeEmptyDeps().assetsRepo,
                async findByAssetIds(ids) {
                    queriedAssetIds.push(...ids);
                    return [];
                },
            },
        });
        const out = await assetsApiCuratedPrefetchForApi(deps, {
            listId: 'majors',
            memberMints: [],
            memberAssetIds: [],
            includeSanctum: false,
            includeStock: false,
        });
        expect(out.deletedAssetRefs).toContain('legacy-asset');
        expect(queriedAssetIds).toContain('solana');
        expect(queriedAssetIds).not.toContain('legacy-asset');
    });
});
