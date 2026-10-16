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
            return fakes.equityInstrument ? { asset_id: assetId, symbol: 'TSLA', name: 'Tesla' } : null;
        },
    } as unknown as StockReadsRepo;
    const tokensReadsRepo = {
        async findTokenByAddress() {
            maybeThrow('findTokenByAddress');
            return null;
        },
    } as unknown as TokensReadsRepo;
    const variantMarketsRepo = {
        async findLatestByMints() {
            maybeThrow('findLatestByMints');
            return [];
        },
    } as unknown as VariantMarketsRepo;
    return {
        assetsRepo,
        assetVariantsRepo,
        deletionTombstonesRepo,
        sanctumLstsRepo,
        stockReadsRepo,
        tokensReadsRepo,
        variantMarketsRepo,
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
});
