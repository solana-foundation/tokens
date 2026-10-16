import { describe, expect, it } from 'bun:test';
import { getVariantByMint, resolveAlias } from '@tokens/asset-registry';

import { assetsApiSpeculativeBatchForApi, type SpeculativeBatchDeps } from './assetsApiSpeculativeBatch';
import type { AssetRow, AssetsRepo } from './assets';
import type { AssetVariantDocRow, AssetVariantsRepo } from './assetVariants';
import type { AssetDeletionTombstonesRepo } from './assetDeletionTombstones';
import type { SanctumLstsRepo } from './sanctumLsts';
import type { StockReadsRepo } from './stockReads';
import type { TokensReadsRepo } from './tokensReads';
import type { VariantMarketsRepo } from './variantMarkets';
import type { FillQualityReadsRepo } from './fillQualityReads';
import type { AssetMarketsRepo } from './assetMarkets';
import type { CoingeckoReadsRepo } from './coingeckoReads';

const NOW = new Date('2026-07-01T00:00:00Z');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DB_MINT = 'ZZQX111111111111111111111111111111111111111';
const DB_MINT_2 = 'ZZQX222222222222222222222222222222222222222';
const UNKNOWN_MINT = 'UNKN111111111111111111111111111111111111111';

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
    return {
        id: 'r1',
        asset_id: 'zzqx-coin',
        category: 'crypto',
        name: 'Zzqx Coin',
        symbol: 'ZZQX',
        aliases: ['ZZQX'],
        coingecko_id: null,
        description: null,
        image_url: null,
        is_active: true,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    } as AssetRow;
}

function variantRow(overrides: Partial<AssetVariantDocRow> = {}): AssetVariantDocRow {
    return {
        asset_id: 'zzqx-coin',
        chain: 'solana',
        mint: DB_MINT,
        variant_id: 'zzqx-coin:mint',
        kind: 'native',
        trust_tier: 'tier2',
        stock_variant_tier: null,
        tags: [],
        issuer: null,
        issuer_url: null,
        label: null,
        is_active: true,
        created_at: NOW.getTime(),
        updated_at: NOW.getTime(),
        ...overrides,
    } as AssetVariantDocRow;
}

interface Fakes {
    deletedRefs?: string[];
    assets?: Record<string, AssetRow>;
    variantsByMint?: Record<string, AssetVariantDocRow>;
    variantsByAssetId?: Record<string, AssetVariantDocRow[]>;
    sanctumMints?: string[];
    equityInstrument?: boolean;
    /** Mints that have a market row with full display metadata. */
    marketsFor?: string[];
    tokenByAddress?: Record<string, { symbol: string; name: string }>;
    solanaView?: Array<{ mint: string }>;
    throwOn?: string;
}

function makeDeps(fakes: Fakes = {}, extra: Partial<SpeculativeBatchDeps> = {}): SpeculativeBatchDeps {
    const maybeThrow = (name: string) => {
        if (fakes.throwOn === name) throw new Error(`${name} down`);
    };
    const assetsRepo = {
        async findByAssetId(assetId: string) {
            maybeThrow('findByAssetId');
            return fakes.assets?.[assetId] ?? null;
        },
        async listAssetIdRenames() {
            return [];
        },
        async isDeletedRef(ref: string) {
            return (fakes.deletedRefs ?? []).includes(ref.trim().toLowerCase());
        },
        async findAliasesByNormalized() {
            return [];
        },
        async findByAssetIds() {
            return [];
        },
        async findVariantByMint(mint: string) {
            const row = fakes.variantsByMint?.[mint];
            return row ? { asset_id: row.asset_id, mint: row.mint } : null;
        },
    } as unknown as AssetsRepo;
    const assetVariantsRepo = {
        async findVariantByMint(mint: string) {
            maybeThrow('findVariantByMint');
            return fakes.variantsByMint?.[mint] ?? null;
        },
        async findAssetIsActive() {
            return true;
        },
        async findVariantsByAssetIds(assetIds: readonly string[]) {
            maybeThrow('findVariantsByAssetIds');
            return assetIds.flatMap(id => fakes.variantsByAssetId?.[id] ?? []);
        },
        async findSolanaDefaultVariantsView() {
            return fakes.solanaView
                ? { asset_id: 'solana', variants_json: JSON.stringify(fakes.solanaView), updated_at: NOW }
                : null;
        },
    } as unknown as AssetVariantsRepo;
    const deletionTombstonesRepo: AssetDeletionTombstonesRepo = {
        async findDeletedNormalizedRefs(refs) {
            maybeThrow('findDeletedNormalizedRefs');
            return refs.filter(ref => (fakes.deletedRefs ?? []).includes(ref));
        },
    };
    const sanctumLstsRepo = {
        async findByMint(mint: string) {
            return (fakes.sanctumMints ?? []).includes(mint)
                ? { mint, symbol: 'xSOL', source_rank: 1, is_active: true }
                : null;
        },
        async findActiveBySymbolLower() {
            return [];
        },
        async listActive() {
            return [];
        },
    } as unknown as SanctumLstsRepo;
    const stockReadsRepo = {
        async findInstrumentByAssetId(assetId: string) {
            maybeThrow('findInstrumentByAssetId');
            return fakes.equityInstrument
                ? {
                      asset_id: assetId,
                      symbol: 'TSLA',
                      normalized_symbol: 'tsla',
                      name: 'Tesla',
                      instrument_id: 1,
                      dataset: 'xnas',
                      is_active: true,
                      source: 'clickhouse',
                      last_synced_at: NOW.getTime(),
                  }
                : null;
        },
        async findPriceByAssetId() {
            return null;
        },
    } as unknown as StockReadsRepo;
    const tokensReadsRepo = {
        async findTokenByAddress(address: string) {
            maybeThrow('findTokenByAddress');
            const token = fakes.tokenByAddress?.[address];
            return token
                ? {
                      id: 't1',
                      address,
                      symbol: token.symbol,
                      name: token.name,
                      decimals: 6,
                      logo_uri: null,
                      coingecko_id: null,
                      description: null,
                      website: null,
                      twitter: null,
                      discord: null,
                      telegram: null,
                      reddit: null,
                      github: null,
                      price: null,
                      price_change_24h_percent: null,
                      price_change_1h_percent: null,
                      volume_24h_usd: null,
                      liquidity: null,
                      market_cap: null,
                      last_fetched_at: NOW.getTime(),
                      created_at: NOW,
                      updated_at: NOW,
                  }
                : null;
        },
        async findTokenMarketsLatestByMint() {
            return null;
        },
        async findTokenMarketsLatestByMints() {
            return [];
        },
        async findTopMarketsByMints() {
            return [];
        },
    } as unknown as TokensReadsRepo;
    const variantMarketsRepo = {
        async findLatestByMints(mints: readonly string[]) {
            maybeThrow('findLatestByMints');
            return mints
                .filter(mint => (fakes.marketsFor ?? []).includes(mint))
                .map(mint => ({
                    mint,
                    source: 'birdeye',
                    metrics_source: null,
                    birdeye_metrics: null,
                    rwa_metrics: null,
                    clickhouse_metrics: null,
                    symbol: 'X',
                    name: 'X Coin',
                    decimals: 6,
                    logo_uri: null,
                    price: 1,
                    liquidity: 1,
                    volume_1h_usd: null,
                    volume_24h_usd: 1,
                    trade_1h: null,
                    trade_24h: null,
                    unique_wallet_1h: null,
                    unique_wallet_24h: null,
                    market_cap: 1,
                    fdv: 1,
                    price_change_24h_percent: null,
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
                }));
        },
    } as unknown as VariantMarketsRepo;
    const fillQualityReadsRepo = {
        async findLatestByMints() {
            return [];
        },
    } as unknown as FillQualityReadsRepo;
    const assetMarketsRepo = {
        async findLatestByAssetId() {
            return null;
        },
        async findLatestByAssetIds() {
            return [];
        },
    } as unknown as AssetMarketsRepo;
    const coingeckoReadsRepo = {
        async findCoinByCoinId() {
            return null;
        },
        async findPriceLatestByCoinId() {
            return null;
        },
    } as unknown as CoingeckoReadsRepo;
    return {
        assetsRepo,
        assetVariantsRepo,
        deletionTombstonesRepo,
        sanctumLstsRepo,
        stockReadsRepo,
        tokensReadsRepo,
        variantMarketsRepo,
        fillQualityReadsRepo,
        assetMarketsRepo,
        coingeckoReadsRepo,
        ...extra,
    };
}

const names = (out: { entries: Array<{ name: string }> }) => out.entries.map(e => e.name);
const argsOf = (out: { entries: Array<{ name: string; args: unknown }> }, name: string) =>
    out.entries.filter(e => e.name === name).map(e => e.args);

describe('assetsApiSpeculativeBatchForApi', () => {
    it('rejects bad args', async () => {
        await expect(assetsApiSpeculativeBatchForApi(makeDeps(), {})).rejects.toThrow();
        await expect(
            assetsApiSpeculativeBatchForApi(makeDeps(), { profile: 'other', mint: DB_MINT }),
        ).rejects.toThrow();
    });

    it('by mint, DB variant of a canonical asset: walks deleted → variant → asset → market, with exact args', async () => {
        const deps = makeDeps({
            variantsByMint: { [DB_MINT]: variantRow() },
            assets: { 'zzqx-coin': assetRow() },
        });
        const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'resolve', mint: DB_MINT });
        expect(names(out)).toEqual([
            'listDeletedRefs',
            'assetVariantsGetByMint',
            'getByAssetId',
            'variantMarketsGetLatestByMints',
        ]);
        expect(argsOf(out, 'listDeletedRefs')).toEqual([{ refs: [DB_MINT.toLowerCase()] }]);
        expect(argsOf(out, 'assetVariantsGetByMint')).toEqual([{ mint: DB_MINT }]);
        expect(argsOf(out, 'getByAssetId')).toEqual([{ assetId: 'zzqx-coin' }]);
        expect(argsOf(out, 'variantMarketsGetLatestByMints')).toEqual([{ mints: [DB_MINT] }]);
        // Results are the handlers' own outputs.
        const doc = out.entries.find(e => e.name === 'getByAssetId')?.result as { assetId: string; category: string };
        expect(doc.assetId).toBe('zzqx-coin');
        expect(doc.category).toBe('crypto');
    });

    it('by mint, equity asset: also reads the stock instrument', async () => {
        const deps = makeDeps({
            variantsByMint: { [DB_MINT]: variantRow({ asset_id: 'tesla' }) },
            assets: { tesla: assetRow({ asset_id: 'tesla', category: 'equity', symbol: 'TSLA', name: 'Tesla' }) },
            equityInstrument: true,
        });
        const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'resolve', mint: DB_MINT });
        expect(names(out)).toEqual([
            'listDeletedRefs',
            'assetVariantsGetByMint',
            'getByAssetId',
            'stockInstrumentsGetByAssetId',
            'variantMarketsGetLatestByMints',
        ]);
        expect(argsOf(out, 'stockInstrumentsGetByAssetId')).toEqual([{ assetId: 'tesla' }]);
    });

    it('by mint, registry-only (no DB variant): checks the registry asset tombstone and stops', async () => {
        const registry = getVariantByMint(USDC_MINT);
        expect(registry).not.toBeNull();
        const out = await assetsApiSpeculativeBatchForApi(makeDeps(), { profile: 'resolve', mint: USDC_MINT });
        expect(names(out)).toEqual(['listDeletedRefs', 'assetVariantsGetByMint', 'listDeletedRefs']);
        const expectedRef = (registry!.asset.coingeckoId ?? registry!.asset.assetId).toLowerCase();
        expect(argsOf(out, 'listDeletedRefs')).toEqual([{ refs: [USDC_MINT.toLowerCase()] }, { refs: [expectedRef] }]);
    });

    it('by mint, unknown everywhere: singleton reads (market + tokens row)', async () => {
        const out = await assetsApiSpeculativeBatchForApi(makeDeps(), { profile: 'resolve', mint: UNKNOWN_MINT });
        expect(names(out)).toEqual([
            'listDeletedRefs',
            'assetVariantsGetByMint',
            'variantMarketsGetLatestByMints',
            'tokensGetByAddress',
        ]);
        expect(argsOf(out, 'variantMarketsGetLatestByMints')).toEqual([{ mints: [UNKNOWN_MINT] }]);
        expect(argsOf(out, 'tokensGetByAddress')).toEqual([{ address: UNKNOWN_MINT }]);
    });

    it('by mint, hard-deleted: stops after the tombstone check', async () => {
        const out = await assetsApiSpeculativeBatchForApi(makeDeps({ deletedRefs: [DB_MINT.toLowerCase()] }), {
            profile: 'resolve',
            mint: DB_MINT,
        });
        expect(names(out)).toEqual(['listDeletedRefs']);
    });

    it('by ref, registry alias: tombstone checks, then asset → variants → markets in variant row order', async () => {
        const registry = resolveAlias('bitcoin');
        expect(registry).not.toBeNull();
        const assetId = registry!.assetId;
        const deps = makeDeps({
            assets: { [assetId]: assetRow({ asset_id: assetId, name: 'Bitcoin', symbol: 'BTC' }) },
            variantsByAssetId: {
                [assetId]: [
                    variantRow({ asset_id: assetId, mint: DB_MINT_2, variant_id: `${assetId}:b` }),
                    variantRow({ asset_id: assetId, mint: DB_MINT, variant_id: `${assetId}:a` }),
                ],
            },
        });
        const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'resolve', ref: 'bitcoin' });
        const cgRef = (registry!.coingeckoId ?? registry!.assetId).toLowerCase();
        const expectedNames = ['listDeletedRefs'];
        if (cgRef !== 'bitcoin') expectedNames.push('listDeletedRefs');
        expectedNames.push('getByAssetId', 'assetVariantsListByAssetIds', 'variantMarketsGetLatestByMints');
        expect(names(out)).toEqual(expectedNames);
        expect(argsOf(out, 'getByAssetId')).toEqual([{ assetId }]);
        expect(argsOf(out, 'assetVariantsListByAssetIds')).toEqual([{ assetIds: [assetId] }]);
        // Unsliced, in the order the variants handler returned them.
        expect(argsOf(out, 'variantMarketsGetLatestByMints')).toEqual([{ mints: [DB_MINT_2, DB_MINT] }]);
    });

    it('by ref, same ref checked twice within a walk is only fetched once (mirrors the route memo)', async () => {
        const out = await assetsApiSpeculativeBatchForApi(makeDeps(), { profile: 'resolve', ref: 'bitcoin' });
        const refs = argsOf(out, 'listDeletedRefs') as Array<{ refs: string[] }>;
        const flat = refs.flatMap(r => r.refs);
        expect(new Set(flat).size).toBe(flat.length);
    });

    it('by ref, solana-<mint> singleton id: variant lookup then singleton reads', async () => {
        const out = await assetsApiSpeculativeBatchForApi(makeDeps(), {
            profile: 'resolve',
            ref: `solana-${UNKNOWN_MINT}`,
        });
        expect(names(out)).toEqual([
            'listDeletedRefs',
            'assetVariantsGetByMint',
            'sanctumResolveRef',
            'variantMarketsGetLatestByMints',
            'tokensGetByAddress',
        ]);
        expect(argsOf(out, 'listDeletedRefs')).toEqual([{ refs: [`solana-${UNKNOWN_MINT}`.toLowerCase()] }]);
        expect(argsOf(out, 'sanctumResolveRef')).toEqual([{ ref: UNKNOWN_MINT }]);
    });

    it('by ref, sanctum LST mint: resolves to solana and reads its variants', async () => {
        const deps = makeDeps({
            sanctumMints: [UNKNOWN_MINT],
            assets: { solana: assetRow({ asset_id: 'solana', name: 'Solana', symbol: 'SOL' }) },
            variantsByAssetId: { solana: [variantRow({ asset_id: 'solana', mint: DB_MINT })] },
        });
        const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'resolve', ref: UNKNOWN_MINT });
        expect(names(out)).toEqual([
            'listDeletedRefs',
            'assetVariantsGetByMint',
            'sanctumResolveRef',
            'getByAssetId',
            'assetVariantsListByAssetIds',
            'variantMarketsGetLatestByMints',
        ]);
        expect(argsOf(out, 'getByAssetId')).toEqual([{ assetId: 'solana' }]);
    });

    it('by ref, unknown non-mint ref: sanctum miss then resolveAssetRefForApi null → stop', async () => {
        const out = await assetsApiSpeculativeBatchForApi(makeDeps(), { profile: 'resolve', ref: 'no-such-asset-xyz' });
        expect(names(out)).toEqual(['listDeletedRefs', 'sanctumResolveRef', 'resolveAssetRefForApi']);
        expect(argsOf(out, 'resolveAssetRefForApi')).toEqual([{ ref: 'no-such-asset-xyz' }]);
    });

    it('a throwing step ends the walk and keeps what was gathered', async () => {
        const deps = makeDeps({
            variantsByMint: { [DB_MINT]: variantRow() },
            assets: { 'zzqx-coin': assetRow() },
            throwOn: 'findByAssetId',
        });
        const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'resolve', mint: DB_MINT });
        expect(names(out)).toEqual(['listDeletedRefs', 'assetVariantsGetByMint']);
    });

    it('stops at the soft deadline', async () => {
        let t = 0;
        const deps = makeDeps(
            { variantsByMint: { [DB_MINT]: variantRow() }, assets: { 'zzqx-coin': assetRow() } },
            { now: () => (t += 300) },
        );
        const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'resolve', mint: DB_MINT });
        // start=300; step1 at 600 (ok, 300ms), step2 at 900 (600ms > 500 → ended)
        expect(names(out)).toEqual(['listDeletedRefs']);
    });

    describe('variants profile', () => {
        it('singleton: market, DEX doc, tokens row, fill quality', async () => {
            const out = await assetsApiSpeculativeBatchForApi(makeDeps(), { profile: 'variants', ref: UNKNOWN_MINT });
            expect(names(out)).toEqual([
                'listDeletedRefs',
                'assetVariantsGetByMint',
                'sanctumResolveRef',
                'variantMarketsGetLatestByMints',
                'tokenMarketsGetLatestByMint',
                'tokensGetByAddress',
                'variantFillQualityGetLatestByMints',
            ]);
            expect(argsOf(out, 'tokenMarketsGetLatestByMint')).toEqual([{ mint: UNKNOWN_MINT }]);
            expect(argsOf(out, 'variantFillQualityGetLatestByMints')).toEqual([{ mints: [UNKNOWN_MINT] }]);
        });

        it('DB asset without filters: doc, variants, markets + fill quality, DEX top markets for the rest, chunked like the route', async () => {
            const many = Array.from({ length: 260 }, (_, i) => `M${'a'.repeat(39)}${String(i).padStart(3, '0')}`);
            const deps = makeDeps({
                assets: { 'zzqx-coin': assetRow() },
                variantsByAssetId: { 'zzqx-coin': many.map((mint, i) => variantRow({ mint, variant_id: `v${i}` })) },
                marketsFor: many.slice(0, 200),
            });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'variants', ref: 'zzqx-coin' });
            expect(out.endedBy).toBeUndefined();
            const n = names(out);
            // Not in the registry: resolved through resolveAssetRefForApi, which finds it in the DB.
            expect(n.slice(0, 5)).toEqual([
                'listDeletedRefs',
                'sanctumResolveRef',
                'resolveAssetRefForApi',
                'getByAssetId',
                'assetVariantsListByAssetIds',
            ]);
            expect(argsOf(out, 'assetVariantsListByAssetIds')).toEqual([{ assetIds: ['zzqx-coin'] }]);
            const marketChunks = argsOf(out, 'variantMarketsGetLatestByMints') as Array<{ mints: string[] }>;
            const fillChunks = argsOf(out, 'variantFillQualityGetLatestByMints') as Array<{ mints: string[] }>;
            const topChunks = argsOf(out, 'tokenMarketsGetTopMarketsByMints') as Array<{ mints: string[] }>;
            expect(marketChunks.length).toBeGreaterThan(0);
            expect(fillChunks.length).toBeGreaterThan(0);
            expect(topChunks.length).toBeGreaterThan(0);
            for (const c of marketChunks) expect(c.mints.length).toBeLessThanOrEqual(250);
            for (const c of fillChunks) expect(c.mints.length).toBeLessThanOrEqual(250);
            for (const c of topChunks) expect(c.mints.length).toBeLessThanOrEqual(50);
            // Every market/fill mint comes from the variant rows; each chunk is a
            // contiguous slice of them (concurrent steps may record out of order).
            const marketMints = marketChunks.flatMap(c => c.mints);
            expect([...marketMints].sort()).toEqual([...fillChunks.flatMap(c => c.mints)].sort());
            for (const c of marketChunks) {
                const start = many.indexOf(c.mints[0]!);
                expect(start).toBeGreaterThanOrEqual(0);
                expect(many.slice(start, start + c.mints.length)).toEqual(c.mints);
            }
            // Mints with a market never go to the DEX top-markets fallback.
            for (const mint of topChunks.flatMap(c => c.mints)) expect(many.indexOf(mint)).toBeGreaterThanOrEqual(200);
        });

        it('registry asset without filters walks markets, fill quality and top markets with exact chunks', async () => {
            const registry = resolveAlias('bitcoin');
            const assetId = registry!.assetId;
            const dbMints = [DB_MINT, DB_MINT_2];
            const deps = makeDeps({
                assets: { [assetId]: assetRow({ asset_id: assetId }) },
                variantsByAssetId: {
                    [assetId]: dbMints.map((mint, i) => variantRow({ asset_id: assetId, mint, variant_id: `v${i}` })),
                },
                marketsFor: [DB_MINT],
            });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'variants', ref: 'bitcoin' });
            const n = names(out);
            expect(n).toContain('getByAssetId');
            expect(argsOf(out, 'assetVariantsListByAssetIds')).toEqual([{ assetIds: [assetId] }]);
            const registryOnly = registry!.variants.map(v => v.mint).filter(m => !dbMints.includes(m));
            const expectedMints = [...dbMints, ...registryOnly];
            expect(argsOf(out, 'variantMarketsGetLatestByMints')).toEqual([{ mints: expectedMints }]);
            expect(argsOf(out, 'variantFillQualityGetLatestByMints')).toEqual([{ mints: expectedMints }]);
            // Only DB_MINT has a market; everything else goes to the DEX top-markets fallback.
            expect(argsOf(out, 'tokenMarketsGetTopMarketsByMints')).toEqual([
                { mints: expectedMints.filter(m => m !== DB_MINT) },
            ]);
        });

        it('with filters stops after the variant rows', async () => {
            const registry = resolveAlias('bitcoin');
            const assetId = registry!.assetId;
            const deps = makeDeps({
                assets: { [assetId]: assetRow({ asset_id: assetId }) },
                variantsByAssetId: { [assetId]: [variantRow({ asset_id: assetId })] },
            });
            const out = await assetsApiSpeculativeBatchForApi(deps, {
                profile: 'variants',
                ref: 'bitcoin',
                hasFilters: true,
            });
            expect(names(out)).not.toContain('variantMarketsGetLatestByMints');
            expect(names(out)).toContain('assetVariantsListByAssetIds');
        });

        it('solana without filters: default view then fill quality for its mints', async () => {
            const deps = makeDeps({ solanaView: [{ mint: DB_MINT }, { mint: DB_MINT_2 }] });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'variants', ref: 'solana' });
            expect(names(out).slice(-2)).toEqual([
                'assetVariantsGetSolanaDefaultVariantsViewForApi',
                'variantFillQualityGetLatestByMints',
            ]);
            expect(argsOf(out, 'assetVariantsGetSolanaDefaultVariantsViewForApi')).toEqual([{}]);
            expect(argsOf(out, 'variantFillQualityGetLatestByMints')).toEqual([{ mints: [DB_MINT, DB_MINT_2] }]);
        });

        it('solana with filters stops after resolution', async () => {
            const out = await assetsApiSpeculativeBatchForApi(makeDeps(), {
                profile: 'variants',
                ref: 'solana',
                hasFilters: true,
            });
            expect(names(out)).not.toContain('assetVariantsGetSolanaDefaultVariantsViewForApi');
        });
    });

    describe('detail profile', () => {
        it('DB crypto asset: doc, variants, markets (+DEX gap), then fill quality / aggregates, then coin price', async () => {
            const registry = resolveAlias('bitcoin');
            const assetId = registry!.assetId;
            const deps = makeDeps({
                assets: { [assetId]: assetRow({ asset_id: assetId, coingecko_id: 'bitcoin' }) },
                variantsByAssetId: { [assetId]: [variantRow({ asset_id: assetId, mint: DB_MINT })] },
                marketsFor: [DB_MINT],
            });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'detail', ref: 'bitcoin' });
            const n = names(out);
            expect(n).toContain('getByAssetId');
            expect(argsOf(out, 'assetVariantsListByAssetIds')).toEqual([{ assetIds: [assetId] }]);
            const registryOnly = registry!.variants.map(v => v.mint).filter(m => m !== DB_MINT);
            const mints = [DB_MINT, ...registryOnly];
            expect(argsOf(out, 'variantMarketsGetLatestByMints')).toEqual([{ mints }]);
            // Registry-only mints have no market row → DEX fallback for up to 25 of them.
            expect(argsOf(out, 'tokenMarketsGetLatestByMints')).toEqual(
                registryOnly.length > 0 ? [{ mints: registryOnly.slice(0, 25) }] : [],
            );
            expect(argsOf(out, 'variantFillQualityGetLatestByMints')).toEqual([{ mints }]);
            expect(argsOf(out, 'assetMarketsGetLatestByAssetId')).toEqual([{ assetId }]);
            expect(argsOf(out, 'coingeckoReadsGetPriceLatestByCoinId')).toEqual([{ coinId: 'bitcoin' }]);
            expect(n).not.toContain('stockInstrumentsGetByAssetId');
            expect(n).not.toContain('coingeckoReadsGetCoinById');
        });

        it('equity asset with an instrument: stock instrument then stock price, never the coin price', async () => {
            const deps = makeDeps({
                variantsByMint: { [DB_MINT]: variantRow({ asset_id: 'tesla' }) },
                assets: { tesla: assetRow({ asset_id: 'tesla', category: 'equity', symbol: 'TSLA', name: 'Tesla' }) },
                variantsByAssetId: { tesla: [variantRow({ asset_id: 'tesla', mint: DB_MINT })] },
                equityInstrument: true,
            });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'detail', ref: DB_MINT });
            expect(argsOf(out, 'stockInstrumentsGetByAssetId')).toEqual([{ assetId: 'tesla' }]);
            expect(argsOf(out, 'stockPricesGetLatestByAssetId')).toEqual([{ assetId: 'tesla' }]);
            expect(names(out)).not.toContain('coingeckoReadsGetPriceLatestByCoinId');
        });

        it('singleton: tokens row, then market reads, fill quality and aggregates', async () => {
            const deps = makeDeps({ tokenByAddress: { [UNKNOWN_MINT]: { symbol: 'UNK', name: 'Unknown' } } });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'detail', ref: UNKNOWN_MINT });
            const n = names(out);
            expect(argsOf(out, 'getByAssetId')).toEqual([{ assetId: `solana-${UNKNOWN_MINT}` }]);
            expect(argsOf(out, 'tokensGetByAddress')).toEqual([{ address: UNKNOWN_MINT }]);
            // Identity came from the tokens row, so only loadVariantMarkets reads the market.
            expect(argsOf(out, 'variantMarketsGetLatestByMints')).toEqual([{ mints: [UNKNOWN_MINT] }]);
            expect(argsOf(out, 'assetMarketsGetLatestByAssetId')).toEqual([{ assetId: `solana-${UNKNOWN_MINT}` }]);
            expect(n).not.toContain('coingeckoReadsGetPriceLatestByCoinId');
        });

        it('solana reads the active Sanctum list', async () => {
            const deps = makeDeps({
                assets: { solana: assetRow({ asset_id: 'solana', coingecko_id: 'solana' }) },
                variantsByAssetId: { solana: [variantRow({ asset_id: 'solana' })] },
            });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'detail', ref: 'solana' });
            expect(argsOf(out, 'sanctumListActive')).toEqual([{ limit: 5000 }]);
        });
    });

    describe('price-chart profile', () => {
        it('crypto asset with a coin id stops before the chart reads', async () => {
            const registry = resolveAlias('bitcoin');
            const assetId = registry!.assetId;
            const deps = makeDeps({
                assets: { [assetId]: assetRow({ asset_id: assetId, coingecko_id: 'bitcoin' }) },
                variantsByAssetId: { [assetId]: [variantRow({ asset_id: assetId })] },
            });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'price-chart', ref: 'bitcoin' });
            expect(names(out)).toContain('assetVariantsListByAssetIds');
            expect(names(out)).not.toContain('variantMarketsGetLatestByMints');
        });

        it('on-chain asset without a coin id reads the variant markets for the fallback', async () => {
            const deps = makeDeps({
                variantsByMint: { [DB_MINT]: variantRow() },
                assets: { 'zzqx-coin': assetRow() },
                variantsByAssetId: { 'zzqx-coin': [variantRow(), variantRow({ mint: DB_MINT_2, variant_id: 'v2' })] },
            });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'price-chart', ref: DB_MINT });
            expect(argsOf(out, 'variantMarketsGetLatestByMints')).toEqual([{ mints: [DB_MINT, DB_MINT_2] }]);
        });

        it('equity asset reads the stock instrument and stops', async () => {
            const deps = makeDeps({
                variantsByMint: { [DB_MINT]: variantRow({ asset_id: 'tesla' }) },
                assets: { tesla: assetRow({ asset_id: 'tesla', category: 'equity' }) },
                variantsByAssetId: { tesla: [variantRow({ asset_id: 'tesla' })] },
            });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'price-chart', ref: DB_MINT });
            expect(names(out).slice(-1)).toEqual(['stockInstrumentsGetByAssetId']);
        });

        it('singleton reads the tokens row', async () => {
            const deps = makeDeps({ tokenByAddress: { [UNKNOWN_MINT]: { symbol: 'UNK', name: 'Unknown' } } });
            const out = await assetsApiSpeculativeBatchForApi(deps, { profile: 'price-chart', ref: UNKNOWN_MINT });
            expect(argsOf(out, 'tokensGetByAddress')).toEqual([{ address: UNKNOWN_MINT }]);
            expect(argsOf(out, 'variantMarketsGetLatestByMints')).toEqual([{ mints: [UNKNOWN_MINT] }]);
        });
    });
});
