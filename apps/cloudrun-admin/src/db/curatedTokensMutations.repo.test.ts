/**
 * `makePostgresAdminMutationsRepo` variant writes against a recording fake
 * `sql`/`tx`.
 *
 * Regression: `createVariant`/`updateVariant` bound `JSON.stringify(tags)`
 * into a `::jsonb` parameter. postgres-js serializes json/jsonb-typed
 * parameters with JSON.stringify itself, so tags were stored as a jsonb
 * *string* and read back as `[]` (readers only accept arrays). Migration
 * 0030 repairs rows written before the fix.
 */

import { describe, expect, it } from 'bun:test';

import type { Sql } from 'postgres';

import { makePostgresAdminMutationsRepo } from './curatedTokensMutations';

interface RecordedQuery {
    text: string;
    params: unknown[];
}

class JsonParam {
    constructor(readonly value: unknown) {}
}

/** Marker for `sql.unsafe(...)` fragments (column lists in the v2 mirror statements). */
class UnsafeSql {
    constructor(readonly text: string) {}
}

function makeFakeSql(respond: (text: string) => unknown[] = () => []): { sql: Sql; queries: RecordedQuery[] } {
    const queries: RecordedQuery[] = [];
    const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('$').replace(/\s+/g, ' ').trim();
        queries.push({ text, params: values });
        const rows = respond(text) as unknown[] & { count?: number };
        rows.count = rows.length;
        return rows;
    };
    const fake = Object.assign(run, {
        json: (value: unknown) => new JsonParam(value),
        array: (value: unknown) => ({ array: value }),
        unsafe: (text: string) => new UnsafeSql(text),
        begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
    });
    return { sql: fake as unknown as Sql, queries };
}

function jsonParams(query: RecordedQuery | undefined): unknown[] {
    return (query?.params ?? []).filter(p => p instanceof JsonParam).map(p => (p as JsonParam).value);
}

const NOW = 1_760_000_000_000;

describe('makePostgresAdminMutationsRepo asset region/industry', () => {
    const current = {
        category: 'equity',
        name: 'ASML',
        symbol: 'ASML',
        coingecko_id: null,
        description: null,
        image_url: null,
        is_active: true,
        region: 'europe',
        industry: 'semiconductors',
    };

    it('updateCanonicalAsset keeps current tags when untouched and binds null when cleared', async () => {
        {
            const { sql, queries } = makeFakeSql(text => (text.includes('FOR UPDATE') ? [current] : []));
            const repo = makePostgresAdminMutationsRepo(sql);
            expect(await repo.updateCanonicalAsset({ assetId: 'asml', name: 'ASML Holding', clearImage: false, nowMs: NOW })).toBe(
                'updated',
            );
            const update = queries.find(q => q.text.startsWith('UPDATE assets SET'));
            expect(update).toBeDefined();
            expect(update!.text).toContain('region = $');
            expect(update!.params).toContain('europe');
            expect(update!.params).toContain('semiconductors');
        }
        {
            const { sql, queries } = makeFakeSql(text => (text.includes('FOR UPDATE') ? [current] : []));
            const repo = makePostgresAdminMutationsRepo(sql);
            expect(
                await repo.updateCanonicalAsset({ assetId: 'asml', region: null, industry: 'hardware', clearImage: false, nowMs: NOW }),
            ).toBe('updated');
            const update = queries.find(q => q.text.startsWith('UPDATE assets SET'));
            expect(update!.params).not.toContain('europe');
            expect(update!.params).not.toContain('semiconductors');
            expect(update!.params).toContain('hardware');
        }
    });

    it('createCanonicalAsset inserts region/industry columns', async () => {
        const { sql, queries } = makeFakeSql(() => []);
        const repo = makePostgresAdminMutationsRepo(sql);
        await repo.createCanonicalAsset({
            assetId: 'sk-hynix',
            category: 'equity',
            name: 'SK Hynix',
            symbol: 'SKHY',
            coingeckoId: null,
            description: null,
            imageUrl: null,
            region: 'asia',
            industry: 'semiconductors',
            aliases: [],
            collections: [],
            nowMs: NOW,
        });
        const insert = queries.find(q => q.text.startsWith('INSERT INTO assets'));
        expect(insert).toBeDefined();
        expect(insert!.text).toContain('region, industry');
        expect(insert!.params).toContain('asia');
        expect(insert!.params).toContain('semiconductors');
    });
});

describe('makePostgresAdminMutationsRepo variant tags', () => {
    it('createVariant binds tags through sql.json', async () => {
        const { sql, queries } = makeFakeSql(text => (text.startsWith('SELECT 1 FROM assets') ? [{ '?column?': 1 }] : []));
        const repo = makePostgresAdminMutationsRepo(sql);

        const outcome = await repo.createVariant({
            assetId: 'oura',
            mint: 'Pre9atBqkocK1QngFy7Q7zvyQictEFpXdLi6bZ2qnYy',
            variantId: 'oura:prestocks',
            kind: 'tokenized_equity',
            trustTier: 'tier2',
            tags: ['PreStocks', 'curated:stocks'],
            label: 'PreStocks',
            issuer: 'PreStocks',
            issuerUrl: 'https://prestocks.com/',
            stockVariantTier: 'not_redeemable',
            isActive: true,
            nowMs: NOW,
        });

        expect(outcome).toEqual({ status: 'created' });
        const insert = queries.find(q => q.text.startsWith('INSERT INTO asset_variants'));
        expect(insert).toBeDefined();
        expect(jsonParams(insert)).toEqual([['PreStocks', 'curated:stocks']]);
        expect(insert!.params.some(p => typeof p === 'string' && p.startsWith('['))).toBe(false);
    });

    it('updateVariant binds the next tags through sql.json and keeps current tags when untouched', async () => {
        const current = {
            id: 'avr_1',
            asset_id: 'neuralink',
            variant_id: 'neuralink:mint',
            kind: 'wrapped',
            trust_tier: 'tier2',
            tags: ['category:crypto'],
            label: 'NEURALINK',
            issuer: null,
            issuer_url: null,
            stock_variant_tier: null,
            is_active: true,
        };
        {
            const { sql, queries } = makeFakeSql(text => (text.includes('FOR UPDATE') ? [current] : []));
            const repo = makePostgresAdminMutationsRepo(sql);
            expect(await repo.updateVariant({ chain: 'solana', address: 'm', mint: 'm', tags: ['PreStocks', 'curated:stocks'], nowMs: NOW })).toBe(
                'updated',
            );
            const update = queries.find(q => q.text.startsWith('UPDATE asset_variants SET'));
            expect(jsonParams(update)).toEqual([['PreStocks', 'curated:stocks']]);
            expect(update!.params.some(p => typeof p === 'string' && p.startsWith('['))).toBe(false);
        }
        {
            const { sql, queries } = makeFakeSql(text => (text.includes('FOR UPDATE') ? [current] : []));
            const repo = makePostgresAdminMutationsRepo(sql);
            expect(await repo.updateVariant({ chain: 'solana', address: 'm', mint: 'm', label: 'PreStocks', nowMs: NOW })).toBe('updated');
            const update = queries.find(q => q.text.startsWith('UPDATE asset_variants SET'));
            expect(jsonParams(update)).toEqual([['category:crypto']]);
        }
    });
});

/* ------------------------------------------------------------------------- *
 * v2 consistency: every Solana variant mutation mirrors its row into the v2
 * tables inside the same transaction; non-Solana refs write v2 directly and
 * adopt the row (origin = 'admin') so the CoinGecko derivation leaves it alone.
 * ------------------------------------------------------------------------- */

const SOL_MINT = 'AMZNw7cwU9L9c7ewZXxTws2PwQYxBGm2Rxg3FLDBJz9B';
const EVM_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const CURRENT_V1 = {
    id: 'avr_1',
    asset_id: 'amazon',
    variant_id: 'amazon:amznw7cw',
    kind: 'tokenized_equity',
    trust_tier: 'tier3',
    tags: ['category:equity'],
    label: 'AMZN',
    issuer: null,
    issuer_url: null,
    stock_variant_tier: 'share_redeemable',
    is_active: true,
};
const CURRENT_V2 = {
    asset_id: 'usdc',
    variant_id: 'ethereum:0xa0b8',
    kind: 'native',
    trust_tier: 'tier3',
    tags: ['category:stablecoin'],
    label: 'USDC',
    issuer: null,
    issuer_url: null,
    stock_variant_tier: null,
    is_active: true,
    origin: 'coingecko',
};
const SOL_REF = { chain: 'solana' as const, address: SOL_MINT, mint: SOL_MINT };
const EVM_REF = { chain: 'ethereum' as const, address: EVM_ADDRESS, mint: EVM_ADDRESS, assetId: 'usdc' };

const statements = (queries: RecordedQuery[]) => queries.map(q => q.text.split(' ').slice(0, 3).join(' '));

describe('makePostgresAdminMutationsRepo v2 mirror (Solana refs)', () => {
    it('createVariant mirrors the new row into v2 in the same transaction', async () => {
        const { sql, queries } = makeFakeSql(text =>
            text.startsWith('SELECT 1 FROM assets') ? [{ '?column?': 1 }] : text.startsWith('INSERT INTO v2_asset_variants') ? [{ address: SOL_MINT }] : [],
        );
        const repo = makePostgresAdminMutationsRepo(sql);
        await repo.createVariant({
            assetId: 'amazon',
            mint: SOL_MINT,
            variantId: 'amazon:backpack',
            kind: 'tokenized_equity',
            trustTier: 'tier3',
            tags: [],
            label: null,
            issuer: null,
            issuerUrl: null,
            stockVariantTier: null,
            isActive: true,
            nowMs: NOW,
        });
        const mirror = queries.find(q => q.text.startsWith('INSERT INTO v2_asset_variants'));
        expect(mirror).toBeDefined();
        expect(mirror!.params).toEqual(['amazon', SOL_MINT, NOW]);
        expect(queries.some(q => q.text.startsWith('INSERT INTO v2_variant_markets_latest'))).toBe(true);
    });

    it('updateVariant re-mirrors the row after the v1 UPDATE', async () => {
        const { sql, queries } = makeFakeSql(text =>
            text.includes('FOR UPDATE') ? [CURRENT_V1] : text.startsWith('INSERT INTO v2_asset_variants') ? [{ address: SOL_MINT }] : [],
        );
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.updateVariant({ ...SOL_REF, label: 'Backpack AMZN', nowMs: NOW })).toBe('updated');
        const order = statements(queries);
        expect(order.indexOf('UPDATE asset_variants SET')).toBeLessThan(order.indexOf('INSERT INTO v2_asset_variants'));
        const mirror = queries.find(q => q.text.startsWith('INSERT INTO v2_asset_variants'));
        expect(mirror!.params).toEqual(['amazon', SOL_MINT, NOW]);
        // Solana refs never touch the v2-native write path.
        expect(queries.some(q => q.text.startsWith('UPDATE v2_asset_variants'))).toBe(false);
    });

    it('deactivateVariant mirrors the flipped is_active', async () => {
        const { sql, queries } = makeFakeSql(text =>
            text.includes('FOR UPDATE') ? [{ id: 'avr_1', asset_id: 'amazon' }] : text.startsWith('INSERT INTO v2_asset_variants') ? [{ address: SOL_MINT }] : [],
        );
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.deactivateVariant({ ...SOL_REF, isActive: false, nowMs: NOW })).toBe('updated');
        expect(statements(queries)).toEqual([
            'SELECT id, asset_id',
            'UPDATE asset_variants SET',
            'SELECT pg_advisory_xact_lock($)',
            'INSERT INTO v2_asset_variants',
            'INSERT INTO v2_variant_markets_latest',
        ]);
    });

    it('deleteVariant drops the v2 mirror row for (asset, mint)', async () => {
        const { sql, queries } = makeFakeSql(text => (text.includes('FOR UPDATE') ? [{ id: 'avr_1', asset_id: 'amazon' }] : []));
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.deleteVariant(SOL_REF)).toBe('deleted');
        const v2Delete = queries.find(q => q.text.startsWith('DELETE FROM v2_asset_variants'));
        expect(v2Delete).toBeDefined();
        expect(v2Delete!.params).toEqual([SOL_MINT, 'amazon']);
        expect(v2Delete!.text).toContain("origin = 'solana_v1'");
    });

    it('moveVariantToCanonical re-homes the mirror row (delete old, insert new)', async () => {
        const { sql, queries } = makeFakeSql(text =>
            text.includes('FOR UPDATE')
                ? [{ id: 'avr_1', asset_id: 'amazon', variant_id: 'amazon:backpack' }]
                : text.startsWith('SELECT 1 FROM assets')
                  ? [{ '?column?': 1 }]
                  : text.startsWith('INSERT INTO v2_asset_variants')
                    ? [{ address: SOL_MINT }]
                    : [],
        );
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.moveVariantToCanonical({ ...SOL_REF, toAssetId: 'amazon-xstock', nowMs: NOW })).toEqual({
            status: 'moved',
            fromAssetId: 'amazon',
        });
        const v2Delete = queries.find(q => q.text.startsWith('DELETE FROM v2_asset_variants'));
        const v2Insert = queries.find(q => q.text.startsWith('INSERT INTO v2_asset_variants'));
        expect(v2Delete!.params).toEqual([SOL_MINT, 'amazon']);
        expect(v2Insert!.params).toEqual(['amazon-xstock', SOL_MINT, NOW]);
    });

    it('deleteCanonicalAsset removes the v2 rows (derived EVM included) before the asset row', async () => {
        const { sql, queries } = makeFakeSql(text => (text.startsWith('SELECT 1 FROM assets') ? [{ '?column?': 1 }] : []));
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.deleteCanonicalAsset({ assetId: 'polygon' })).toBe('deleted');
        const order = statements(queries);
        expect(order).toContain('DELETE FROM v2_asset_variants');
        expect(order).toContain('DELETE FROM v2_asset_chain_markets_latest');
        expect(order.indexOf('DELETE FROM v2_asset_variants')).toBeLessThan(order.indexOf('DELETE FROM assets'));
    });

    it('deleteCanonicalAsset refuses while the asset still has ACTIVE v2 variants (EVM-only assets)', async () => {
        const { sql, queries } = makeFakeSql(text =>
            text.startsWith('SELECT 1 FROM assets')
                ? [{ '?column?': 1 }]
                : text.startsWith('SELECT 1 FROM asset_variants')
                  ? [{ '?column?': 1 }]
                  : [],
        );
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.deleteCanonicalAsset({ assetId: 'polygon' })).toBe('has_variants');
        const guard = queries.find(q => q.text.startsWith('SELECT 1 FROM asset_variants'));
        expect(guard!.text).toContain('UNION ALL SELECT 1 FROM v2_asset_variants WHERE asset_id = $ AND is_active = true');
        expect(statements(queries)).not.toContain('DELETE FROM v2_asset_variants');
        expect(statements(queries)).not.toContain('DELETE FROM assets');
    });
});

describe('makePostgresAdminMutationsRepo v2-native (EVM refs)', () => {
    it('updateVariant edits v2_asset_variants by (chain, address, asset_id) and adopts the row', async () => {
        const { sql, queries } = makeFakeSql(text => (text.includes('FOR UPDATE') ? [CURRENT_V2] : []));
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.updateVariant({ ...EVM_REF, label: 'USDC (Circle)', tags: ['category:stablecoin', 'issuer:circle'], nowMs: NOW })).toBe('updated');

        const lock = queries.find(q => q.text.includes('FOR UPDATE'));
        expect(lock!.text).toContain('FROM v2_asset_variants WHERE chain = $ AND address = $ AND asset_id = $');
        expect(lock!.params).toEqual(['ethereum', EVM_ADDRESS, 'usdc']);
        const update = queries.find(q => q.text.startsWith('UPDATE v2_asset_variants SET'));
        expect(update).toBeDefined();
        expect(update!.text).toContain("origin = 'admin'");
        expect(update!.text).toContain("source = 'admin'");
        expect(jsonParams(update)).toEqual([['category:stablecoin', 'issuer:circle']]);
        expect(update!.params).toContain('USDC (Circle)');
        // No v1 statements and no mirror for a v2-native row.
        expect(queries.some(q => q.text.includes('asset_variants ') && !q.text.includes('v2_asset_variants'))).toBe(false);
        expect(queries.some(q => q.text.startsWith('INSERT INTO v2_asset_variants'))).toBe(false);
    });

    it('updateVariant returns not_found without an owning asset id or a missing row', async () => {
        const { sql, queries } = makeFakeSql(() => []);
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.updateVariant({ ...EVM_REF, assetId: undefined, label: 'x', nowMs: NOW })).toBe('not_found');
        expect(queries).toHaveLength(0);
        expect(await repo.updateVariant({ ...EVM_REF, label: 'x', nowMs: NOW })).toBe('not_found');
    });

    it('updateVariant refuses a variant_id another row of the asset already uses', async () => {
        const { sql } = makeFakeSql(text =>
            text.includes('FOR UPDATE') ? [CURRENT_V2] : text.includes('AND variant_id = $') ? [{ address: '0xother' }] : [],
        );
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.updateVariant({ ...EVM_REF, variantId: 'usdc:taken', nowMs: NOW })).toBe('variant_id_collision');
    });

    it('updateVariant writes display fields onto the v2 market row when one exists', async () => {
        const { sql, queries } = makeFakeSql(text =>
            text.includes('FROM v2_asset_variants') && text.includes('FOR UPDATE')
                ? [CURRENT_V2]
                : text.includes('FROM v2_variant_markets_latest')
                  ? [{ symbol: 'USDC', name: 'USD Coin', logo_uri: null }]
                  : [],
        );
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.updateVariant({ ...EVM_REF, marketLogoURI: 'https://img/usdc.png', nowMs: NOW })).toBe('updated');
        const market = queries.find(q => q.text.startsWith('UPDATE v2_variant_markets_latest'));
        expect(market).toBeDefined();
        expect(market!.params.slice(0, 3)).toEqual(['USDC', 'USD Coin', 'https://img/usdc.png']);
    });

    it('deactivateVariant flips is_active on the v2 row and adopts it', async () => {
        const { sql, queries } = makeFakeSql(text => (text.startsWith('UPDATE v2_asset_variants') ? [{ address: EVM_ADDRESS }] : []));
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.deactivateVariant({ ...EVM_REF, isActive: false, nowMs: NOW })).toBe('updated');
        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain("SET is_active = $, origin = 'admin', source = 'admin'");
        expect(queries[0]!.params).toEqual([false, new Date(NOW), 'ethereum', EVM_ADDRESS, 'usdc']);
    });

    it('deleteVariant deletes the v2 row by key and leaves the market row', async () => {
        const { sql, queries } = makeFakeSql(text => (text.startsWith('DELETE FROM v2_asset_variants') ? [{ address: EVM_ADDRESS }] : []));
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.deleteVariant(EVM_REF)).toBe('deleted');
        expect(queries).toHaveLength(1);
        expect(queries[0]!.params).toEqual(['ethereum', EVM_ADDRESS, 'usdc']);
        expect(queries[0]!.text).not.toContain('origin');
    });

    it('moveVariantToCanonical copies the row under the destination and leaves an inactive admin row behind', async () => {
        const { sql, queries } = makeFakeSql(text =>
            text.includes('FOR UPDATE') ? [CURRENT_V2] : text.startsWith('SELECT 1 FROM assets') ? [{ '?column?': 1 }] : [],
        );
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.moveVariantToCanonical({ ...EVM_REF, toAssetId: 'usd', nowMs: NOW })).toEqual({
            status: 'moved',
            fromAssetId: 'usdc',
        });
        // No row at the destination key: the reuse UPDATE matched nothing, so a
        // fresh copy is inserted (adopted) carrying the SOURCE's is_active.
        const reuse = queries.find(q => q.text.startsWith('UPDATE v2_asset_variants d SET'));
        expect(reuse!.text).toContain("origin = 'admin', source = 'admin', is_active = s.is_active");
        expect(reuse!.params).toEqual([NOW, new Date(NOW), 'ethereum', EVM_ADDRESS, 'usdc', 'ethereum', EVM_ADDRESS, 'usd']);
        const copy = queries.find(q => q.text.startsWith('INSERT INTO v2_asset_variants'));
        expect(copy!.text).toContain("SELECT chain, address, $, variant_id, kind, trust_tier, stock_variant_tier, tags, label, issuer, issuer_url, decimals, 'admin', 'admin', is_active, first_seen_at, $, $, $ FROM v2_asset_variants");
        expect(copy!.text).not.toContain("'admin', 'admin', true");
        expect(copy!.params).toEqual(['usd', NOW, new Date(NOW), new Date(NOW), 'ethereum', EVM_ADDRESS, 'usdc']);
        // Source row stays as an INACTIVE admin-owned tombstone so the daily
        // derivation (which skips non-derived rows) cannot re-insert it there.
        const tombstone = queries.find(q => q.text.startsWith('UPDATE v2_asset_variants SET is_active = false'));
        expect(tombstone!.text).toContain("SET is_active = false, origin = 'admin', source = 'admin'");
        expect(tombstone!.params).toEqual([new Date(NOW), 'ethereum', EVM_ADDRESS, 'usdc']);
        expect(queries.some(q => q.text.startsWith('DELETE FROM v2_asset_variants'))).toBe(false);
    });

    it('moveVariantToCanonical reuses an existing row at the destination key (moving back over a tombstone)', async () => {
        const { sql, queries } = makeFakeSql(text =>
            text.includes('FOR UPDATE')
                ? [CURRENT_V2]
                : text.startsWith('SELECT 1 FROM assets')
                  ? [{ '?column?': 1 }]
                  : text.startsWith('UPDATE v2_asset_variants d SET')
                    ? [{ address: EVM_ADDRESS }]
                    : [],
        );
        const repo = makePostgresAdminMutationsRepo(sql);
        expect(await repo.moveVariantToCanonical({ ...EVM_REF, toAssetId: 'usd', nowMs: NOW })).toEqual({
            status: 'moved',
            fromAssetId: 'usdc',
        });
        const order = statements(queries);
        // The destination row (an earlier move's tombstone or a derived row) is
        // adopted in place: no collision check, no INSERT, and the source is
        // tombstoned as usual.
        expect(order).not.toContain('INSERT INTO v2_asset_variants');
        expect(queries.some(q => q.text.startsWith('SELECT 1 FROM v2_asset_variants'))).toBe(false);
        expect(order.filter(s => s === 'UPDATE v2_asset_variants d')).toHaveLength(1);
        expect(queries.some(q => q.text.startsWith('UPDATE v2_asset_variants SET is_active = false'))).toBe(true);
    });

    it('moveVariantToCanonical reports noop / asset_not_found / collision like the v1 path', async () => {
        const noop = makePostgresAdminMutationsRepo(
            makeFakeSql(text => (text.includes('FOR UPDATE') ? [CURRENT_V2] : text.startsWith('SELECT 1 FROM assets') ? [{ '?column?': 1 }] : [])).sql,
        );
        expect(await noop.moveVariantToCanonical({ ...EVM_REF, toAssetId: 'usdc', nowMs: NOW })).toEqual({ status: 'noop', fromAssetId: 'usdc' });

        const noAsset = makePostgresAdminMutationsRepo(makeFakeSql(text => (text.includes('FOR UPDATE') ? [CURRENT_V2] : [])).sql);
        expect(await noAsset.moveVariantToCanonical({ ...EVM_REF, toAssetId: 'ghost', nowMs: NOW })).toEqual({ status: 'asset_not_found' });

        const collision = makePostgresAdminMutationsRepo(
            makeFakeSql(text =>
                text.includes('FOR UPDATE') ? [CURRENT_V2] : text.startsWith('SELECT 1 FROM') ? [{ '?column?': 1 }] : [],
            ).sql,
        );
        expect(await collision.moveVariantToCanonical({ ...EVM_REF, toAssetId: 'usd', nowMs: NOW })).toEqual({ status: 'variant_id_collision' });
    });
});
