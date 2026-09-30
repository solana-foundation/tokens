import { describe, expect, it } from 'bun:test';

import { assetsApiSearchPrefetchForApi, type SearchPrefetchDeps } from './assetsApiSearchPrefetch';
import type { AssetsRepo, AssetRow, AssetAliasRow } from './assets';
import type { AssetVariantDocRow, AssetVariantsRepo } from './assetVariants';
import type { SanctumLstRow, SanctumLstsRepo } from './sanctumLsts';
import type { TokenRow, TokensReadsRepo } from './tokensReads';
import type { VariantMarketRow, VariantMarketsRepo } from './variantMarkets';
import type { FillQualityRow, FillQualityReadsRepo } from './fillQualityReads';
import type { AssetMarketRow, AssetMarketsRepo } from './assetMarkets';
import type { StockInstrumentRow, StockPriceRow, StockReadsRepo } from './stockReads';
import type { CoingeckoReadsRepo } from './coingeckoReads';

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

function makeTokenRow(overrides: Partial<TokenRow> = {}): TokenRow {
    return {
        id: 't1',
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        name: 'Wrapped SOL',
        decimals: 9,
        logo_uri: null,
        coingecko_id: null,
        description: null,
        website: null,
        twitter: null,
        discord: null,
        telegram: null,
        reddit: null,
        github: null,
        price: 150,
        price_change_24h_percent: 2.5,
        price_change_1h_percent: null,
        volume_24h_usd: 100_000_000,
        liquidity: 5_000_000,
        market_cap: 60_000_000_000,
        last_fetched_at: NOW.getTime(),
        created_at: NOW,
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

function makeEmptyDeps(overrides: Partial<SearchPrefetchDeps> = {}): SearchPrefetchDeps {
    const assetsRepo: AssetsRepo = {
        async findByAssetId() {
            return null;
        },
        async findByAssetIds() {
            return [];
        },
        async findAliasesByNormalized(): Promise<AssetAliasRow[]> {
            return [];
        },
        async findAliasesByFuzzy(): Promise<AssetAliasRow[]> {
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

    return {
        assetsRepo,
        assetVariantsRepo: variantsRepo,
        sanctumLstsRepo: sanctumRepo,
        tokensReadsRepo: tokensRepo,
        variantMarketsRepo,
        fillQualityReadsRepo: fillQualityRepo,
        assetMarketsRepo,
        stockReadsRepo: stockRepo,
        coingeckoReadsRepo: coingeckoRepo,
        ...overrides,
    };
}

describe('assetsApiSearchPrefetchForApi', () => {
    it('rejects non-object args with InvalidArgsError', async () => {
        const deps = makeEmptyDeps();
        await expect(assetsApiSearchPrefetchForApi(deps, null)).rejects.toThrow(/args must be/);
    });

    it('rejects empty query', async () => {
        const deps = makeEmptyDeps();
        await expect(
            assetsApiSearchPrefetchForApi(deps, {
                query: '   ',
                searchLimit: 40,
                tokensLimit: 40,
                includeSanctum: true,
                includeTokensSearch: true,
            }),
        ).rejects.toThrow(/query must be a non-empty string/);
    });

    it('rejects invalid category', async () => {
        const deps = makeEmptyDeps();
        await expect(
            assetsApiSearchPrefetchForApi(deps, {
                query: 'sol',
                category: 'not-a-category',
                searchLimit: 40,
                tokensLimit: 40,
                includeSanctum: true,
                includeTokensSearch: true,
            }),
        ).rejects.toThrow(/category must be/);
    });

    it('returns empty envelopes when nothing matches', async () => {
        const deps = makeEmptyDeps();
        const out = await assetsApiSearchPrefetchForApi(deps, {
            query: 'zzz-no-match',
            searchLimit: 40,
            tokensLimit: 40,
            includeSanctum: true,
            includeTokensSearch: true,
        });
        expect(out.sanctumMatch).toBeNull();
        expect(out.assets).toEqual([]);
        expect(out.tokens).toEqual([]);
        expect(out.variantsByTokenMint).toEqual([]);
        expect(out.effectiveAssetQuery).toBe('zzz-no-match');
    });

    it('happy path: q=sol returns assets and tokens together', async () => {
        // Route pattern: search by normalized alias hits (`sol` normalized) →
        // return assets; tokens search also returns SOL — variants-by-token-mint
        // ties them together.
        const solMint = 'So11111111111111111111111111111111111111112';
        const deps = makeEmptyDeps({
            assetsRepo: {
                ...makeEmptyDeps().assetsRepo,
                async findAliasesByNormalized(normalized) {
                    if (normalized === 'sol') {
                        return [
                            {
                                asset_id: 'solana',
                                alias: 'SOL',
                                normalized: 'sol',
                                priority: 100,
                            } as AssetAliasRow,
                        ];
                    }
                    return [];
                },
                async findByAssetIds(ids) {
                    return ids.includes('solana') ? [makeAssetRow()] : [];
                },
            },
            tokensReadsRepo: {
                ...makeEmptyDeps().tokensReadsRepo,
                async searchTokensBySymbol(q) {
                    return q.toLowerCase().includes('sol') ? [makeTokenRow()] : [];
                },
            },
            assetVariantsRepo: {
                ...makeEmptyDeps().assetVariantsRepo,
                async findVariantsByMints(mints) {
                    return mints.includes(solMint) ? [makeVariantRow()] : [];
                },
                async findAssetIsActive() {
                    return true;
                },
            },
        });
        const out = await assetsApiSearchPrefetchForApi(deps, {
            query: 'sol',
            searchLimit: 40,
            tokensLimit: 40,
            includeSanctum: true,
            includeTokensSearch: true,
        });
        expect(out.assets.length).toBe(1);
        expect(out.assets[0]?.assetId).toBe('solana');
        expect(out.tokens.length).toBe(1);
        expect(out.tokens[0]?.address).toBe(solMint);
        expect(out.variantsByTokenMint.length).toBe(1);
        expect(out.variantsByTokenMint[0]?.mint).toBe(solMint);
        expect(out.variantsByTokenMint[0]?.variant?.assetId).toBe('solana');
    });

    it('sanctum match overrides effective query to solana', async () => {
        const deps = makeEmptyDeps({
            sanctumLstsRepo: {
                async listActive() {
                    return [];
                },
                async findByMint() {
                    return null;
                },
                async findActiveBySymbolLower(symbolLower) {
                    if (symbolLower === 'jitosol') {
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
                    }
                    return [];
                },
            },
            assetsRepo: {
                ...makeEmptyDeps().assetsRepo,
                async findAliasesByNormalized(normalized) {
                    if (normalized === 'solana') {
                        return [
                            {
                                id: 'a1',
                                asset_id: 'solana',
                                alias: 'solana',
                                normalized: 'solana',
                                priority: 100,
                                created_at: NOW,
                            } as AssetAliasRow,
                        ];
                    }
                    return [];
                },
                async findByAssetIds(ids) {
                    return ids.includes('solana') ? [makeAssetRow()] : [];
                },
            },
        });
        const out = await assetsApiSearchPrefetchForApi(deps, {
            query: 'jitoSOL',
            searchLimit: 40,
            tokensLimit: 40,
            includeSanctum: true,
            includeTokensSearch: false,
        });
        expect(out.sanctumMatch).not.toBeNull();
        expect(out.sanctumMatch?.mint).toBe('JitoSOL111');
        expect(out.effectiveAssetQuery).toBe('solana');
        expect(out.assets.length).toBe(1);
        expect(out.assets[0]?.assetId).toBe('solana');
    });

    it('skips sanctum when includeSanctum=false', async () => {
        let sanctumCalled = false;
        const deps = makeEmptyDeps({
            sanctumLstsRepo: {
                async listActive() {
                    return [];
                },
                async findByMint() {
                    sanctumCalled = true;
                    return null;
                },
                async findActiveBySymbolLower() {
                    sanctumCalled = true;
                    return [];
                },
            },
        });
        const out = await assetsApiSearchPrefetchForApi(deps, {
            query: 'apple',
            searchLimit: 40,
            tokensLimit: 40,
            includeSanctum: false,
            includeTokensSearch: false,
        });
        expect(sanctumCalled).toBe(false);
        expect(out.sanctumMatch).toBeNull();
        expect(out.effectiveAssetQuery).toBe('apple');
    });

    it('skips tokens search when includeTokensSearch=false', async () => {
        let tokensCalled = false;
        const deps = makeEmptyDeps({
            tokensReadsRepo: {
                ...makeEmptyDeps().tokensReadsRepo,
                async searchTokensBySymbol() {
                    tokensCalled = true;
                    return [];
                },
                async searchTokensByName() {
                    tokensCalled = true;
                    return [];
                },
            },
        });
        const out = await assetsApiSearchPrefetchForApi(deps, {
            query: 'aapl',
            searchLimit: 40,
            tokensLimit: 40,
            includeSanctum: false,
            includeTokensSearch: false,
        });
        expect(tokensCalled).toBe(false);
        expect(out.tokens).toEqual([]);
        expect(out.variantsByTokenMint).toEqual([]);
    });

    it('recovers when sanctum resolveRef throws', async () => {
        const deps = makeEmptyDeps({
            sanctumLstsRepo: {
                async listActive() {
                    return [];
                },
                async findByMint() {
                    throw new Error('sanctum down');
                },
                async findActiveBySymbolLower() {
                    throw new Error('sanctum down');
                },
            },
        });
        const out = await assetsApiSearchPrefetchForApi(deps, {
            query: 'sol',
            searchLimit: 40,
            tokensLimit: 40,
            includeSanctum: true,
            includeTokensSearch: false,
        });
        expect(out.sanctumMatch).toBeNull();
        expect(out.effectiveAssetQuery).toBe('sol');
    });

    it('phase-3: fetches variantMarkets/fillQuality/aggregates/coingecko for the combined universe', async () => {
        const solMint = 'So11111111111111111111111111111111111111112';
        const seenAggregateAssetIds: string[] = [];
        const seenMarketMints: string[] = [];
        const seenFillMints: string[] = [];
        const seenCoinIds: string[] = [];
        const deps = makeEmptyDeps({
            assetsRepo: {
                ...makeEmptyDeps().assetsRepo,
                async findAliasesByNormalized(normalized) {
                    if (normalized === 'sol') {
                        return [
                            {
                                asset_id: 'solana',
                                alias: 'SOL',
                                normalized: 'sol',
                                priority: 100,
                            } as AssetAliasRow,
                        ];
                    }
                    return [];
                },
                async findByAssetIds(ids) {
                    return ids.includes('solana') ? [makeAssetRow()] : [];
                },
            },
            tokensReadsRepo: {
                ...makeEmptyDeps().tokensReadsRepo,
                async searchTokensBySymbol(q) {
                    return q.toLowerCase().includes('sol') ? [makeTokenRow()] : [];
                },
            },
            assetVariantsRepo: {
                ...makeEmptyDeps().assetVariantsRepo,
                async findVariantsByMints(mints) {
                    return mints.includes(solMint) ? [makeVariantRow()] : [];
                },
                async findVariantsByAssetIds(ids) {
                    return ids.includes('solana') ? [makeVariantRow()] : [];
                },
                async findAssetIsActive() {
                    return true;
                },
            },
            variantMarketsRepo: {
                async findLatestByMints(mints) {
                    seenMarketMints.push(...mints);
                    return [];
                },
            },
            fillQualityReadsRepo: {
                async findLatestByMints(mints) {
                    seenFillMints.push(...mints);
                    return [];
                },
            },
            assetMarketsRepo: {
                ...makeEmptyDeps().assetMarketsRepo,
                async findLatestByAssetIds(ids) {
                    seenAggregateAssetIds.push(...ids);
                    return [];
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
        const out = await assetsApiSearchPrefetchForApi(deps, {
            query: 'sol',
            searchLimit: 40,
            tokensLimit: 40,
            includeSanctum: false,
            includeTokensSearch: true,
        });
        // Combined assetIds universe should include 'solana' (from search).
        expect(seenAggregateAssetIds).toContain('solana');
        // Mints universe should include the SOL mint (from tokens search).
        expect(seenMarketMints).toContain(solMint);
        expect(seenFillMints).toContain(solMint);
        // 'solana' has coingecko_id='solana' via makeAssetRow.
        expect(seenCoinIds).toContain('solana');
        expect(out.assetAggregates).toBeDefined();
        expect(out.variantMarkets).toBeDefined();
        expect(out.fillQuality).toBeDefined();
        expect(out.coingeckoPrices).toBeDefined();
    });

    it('phase-2b: batches extras hydration when variantsByTokenMint reveals canonical assetIds', async () => {
        const solMint = 'So11111111111111111111111111111111111111112';
        const seenGetAssetIds: string[][] = [];
        const deps = makeEmptyDeps({
            assetsRepo: {
                ...makeEmptyDeps().assetsRepo,
                async findAliasesByNormalized() {
                    return [];
                },
                async findByAssetIds(ids) {
                    seenGetAssetIds.push([...ids]);
                    return ids.includes('solana') ? [makeAssetRow()] : [];
                },
            },
            tokensReadsRepo: {
                ...makeEmptyDeps().tokensReadsRepo,
                async searchTokensBySymbol() {
                    return [makeTokenRow()];
                },
            },
            assetVariantsRepo: {
                ...makeEmptyDeps().assetVariantsRepo,
                async findVariantsByMints(mints) {
                    return mints.includes(solMint) ? [makeVariantRow()] : [];
                },
                async findAssetIsActive() {
                    return true;
                },
            },
        });
        const out = await assetsApiSearchPrefetchForApi(deps, {
            query: 'sol',
            searchLimit: 40,
            tokensLimit: 40,
            includeSanctum: false,
            includeTokensSearch: true,
        });
        // findByAssetIds should have been called with ['solana'] for the extras hydration.
        const flat = seenGetAssetIds.flat();
        expect(flat).toContain('solana');
        expect(out.extraAssets.length).toBeGreaterThan(0);
        expect(out.extraAssets[0]?.assetId).toBe('solana');
    });

    it('phase-3: additionalMints/AssetIds/CoingeckoIds from the caller extend the universe', async () => {
        const extraMint = 'ExtraMint1111111111111111111111111111111111';
        const seenAggregateAssetIds: string[] = [];
        const seenMarketMints: string[] = [];
        const seenCoinIds: string[] = [];
        const deps = makeEmptyDeps({
            variantMarketsRepo: {
                async findLatestByMints(mints) {
                    seenMarketMints.push(...mints);
                    return [];
                },
            },
            assetMarketsRepo: {
                ...makeEmptyDeps().assetMarketsRepo,
                async findLatestByAssetIds(ids) {
                    seenAggregateAssetIds.push(...ids);
                    return [];
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
        await assetsApiSearchPrefetchForApi(deps, {
            query: 'zzz-no-match',
            searchLimit: 40,
            tokensLimit: 40,
            includeSanctum: false,
            includeTokensSearch: false,
            additionalAssetIds: ['ethereum'],
            additionalMints: [extraMint],
            additionalCoingeckoIds: ['bitcoin'],
        });
        expect(seenAggregateAssetIds).toContain('ethereum');
        expect(seenMarketMints).toContain(extraMint);
        expect(seenCoinIds).toContain('bitcoin');
    });

    it('honors category filter on assets search', async () => {
        const deps = makeEmptyDeps({
            assetsRepo: {
                ...makeEmptyDeps().assetsRepo,
                async findAliasesByNormalized(normalized) {
                    if (normalized === 'sol') {
                        return [
                            {
                                asset_id: 'solana',
                                alias: 'SOL',
                                normalized: 'sol',
                                priority: 100,
                            } as AssetAliasRow,
                        ];
                    }
                    return [];
                },
                async findByAssetIds(ids) {
                    return ids.includes('solana') ? [makeAssetRow({ category: 'crypto' })] : [];
                },
            },
        });
        // category='equity' should filter out the crypto asset.
        const out = await assetsApiSearchPrefetchForApi(deps, {
            query: 'sol',
            category: 'equity',
            searchLimit: 40,
            tokensLimit: 40,
            includeSanctum: false,
            includeTokensSearch: false,
        });
        expect(out.assets).toEqual([]);
    });
});
