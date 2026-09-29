/**
 * Tests for the transactional SQL helpers using a recording fake `tx`:
 * atomic per-kind alias replacement (DELETE + INSERT with priorities) and
 * collection sync with in-tx `COALESCE(MAX(rank), -1) + 1` rank computation.
 */

import { describe, expect, it } from 'bun:test';

import type { TransactionSql } from 'postgres';

import { renameAssetId, replaceAliasesForKind, replaceCustomAliases, syncCollections } from './curatedTokensMutations';

interface RecordedQuery {
    text: string;
    params: unknown[];
}

/** `respond` lets a test return rows for a statement (default: no rows). */
function makeFakeTx(respond: (text: string) => unknown[] = () => []): {
    tx: TransactionSql;
    queries: RecordedQuery[];
} {
    const queries: RecordedQuery[] = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('$');
        queries.push({ text, params: values });
        return respond(text);
    }) as unknown as TransactionSql;
    return { tx, queries };
}

const NOW = 1_750_000_000_000;

describe('replaceAliasesForKind', () => {
    it('deletes the kind and inserts the alias with the right priority + normalized form', async () => {
        const { tx, queries } = makeFakeTx();
        await replaceAliasesForKind(tx, { assetId: 'bitcoin', kind: 'name', alias: 'Bitcoin', nowMs: NOW });
        expect(queries).toHaveLength(2);
        expect(queries[0]!.text).toContain('DELETE FROM asset_aliases');
        expect(queries[0]!.params).toEqual(['bitcoin', 'name']);
        expect(queries[1]!.text).toContain('INSERT INTO asset_aliases');
        // (id, normalized, alias, assetId, kind, priority, created, updated)
        const [, normalized, alias, assetId, kind, priority] = queries[1]!.params;
        expect(normalized).toBe('bitcoin');
        expect(alias).toBe('Bitcoin');
        expect(assetId).toBe('bitcoin');
        expect(kind).toBe('name');
        expect(priority).toBe(900);
    });

    it('uses priority 800 for symbol and 700 for coingeckoId', async () => {
        const { tx, queries } = makeFakeTx();
        await replaceAliasesForKind(tx, { assetId: 'a', kind: 'symbol', alias: 'BTC', nowMs: NOW });
        await replaceAliasesForKind(tx, { assetId: 'a', kind: 'coingeckoId', alias: 'bitcoin', nowMs: NOW });
        expect(queries[1]!.params[5]).toBe(800);
        expect(queries[3]!.params[5]).toBe(700);
    });

    it('only deletes when the alias is null (cleared)', async () => {
        const { tx, queries } = makeFakeTx();
        await replaceAliasesForKind(tx, { assetId: 'a', kind: 'symbol', alias: null, nowMs: NOW });
        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain('DELETE FROM asset_aliases');
    });
});

describe('replaceCustomAliases', () => {
    it('replaces atomically: one DELETE, then inserts with priority 500, deduped by lowercase', async () => {
        const { tx, queries } = makeFakeTx();
        await replaceCustomAliases(tx, { assetId: 'bitcoin', aliases: ['BTC', 'btc', 'Digital Gold'], nowMs: NOW });
        expect(queries[0]!.text).toContain('DELETE FROM asset_aliases');
        expect(queries[0]!.params).toEqual(['bitcoin']);
        const inserts = queries.slice(1);
        expect(inserts).toHaveLength(2); // 'btc' case-duplicate is dropped
        expect(inserts.map(q => q.params[1])).toEqual(['btc', 'digital gold']); // normalized
        expect(inserts.map(q => q.params[2])).toEqual(['BTC', 'Digital Gold']); // original alias
        for (const insert of inserts) {
            // 'custom' kind is a SQL literal, so priority sits at params[4] here.
            expect(insert.params[4]).toBe(500);
        }
    });

    it('deletes everything when the alias list is empty', async () => {
        const { tx, queries } = makeFakeTx();
        await replaceCustomAliases(tx, { assetId: 'bitcoin', aliases: [], nowMs: NOW });
        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain('DELETE FROM asset_aliases');
    });
});

describe('syncCollections', () => {
    it('deletes non-requested slugs and inserts requested ones at COALESCE(MAX(rank),-1)+1 in-tx', async () => {
        const { tx, queries } = makeFakeTx();
        await syncCollections(tx, { assetId: 'bitcoin', collections: ['majors', 'stocks'], nowMs: NOW });

        // One statement per curated slug, in canonical slug order.
        expect(queries).toHaveLength(6);
        // Both DELETE and INSERT carry the slug at params[1].
        const bySlug = new Map(queries.map(q => [q.params[1] as string, q]));

        const insertMajors = queries[0]!;
        expect(insertMajors.text).toContain('INSERT INTO asset_collection_members');
        expect(insertMajors.text).toContain('COALESCE(MAX(rank), -1) + 1');
        expect(insertMajors.text).toContain('WHERE NOT EXISTS');
        expect(insertMajors.params[1]).toBe('majors');
        expect(insertMajors.params[2]).toBe('bitcoin');
        expect(insertMajors.params[4]).toBe(NOW); // added_at epoch ms

        const insertStocks = queries[5]!;
        expect(insertStocks.text).toContain('INSERT INTO asset_collection_members');
        expect(insertStocks.params[1]).toBe('stocks');

        for (const slug of ['currencies', 'rwas', 'etfs', 'metals']) {
            const q = bySlug.get(slug);
            expect(q?.text).toContain('DELETE FROM asset_collection_members');
            expect(q?.params[0]).toBe('bitcoin');
            expect(q?.params[1]).toBe(slug);
        }
    });

    it('removes all curated memberships when the requested set is empty', async () => {
        const { tx, queries } = makeFakeTx();
        await syncCollections(tx, { assetId: 'bitcoin', collections: [], nowMs: NOW });
        expect(queries).toHaveLength(6);
        for (const q of queries) {
            expect(q.text).toContain('DELETE FROM asset_collection_members');
        }
    });
});

describe('renameAssetId', () => {
    const RENAMED_TABLES = [
        'assets',
        'asset_aliases',
        'asset_variants',
        'asset_collection_members',
        'asset_markets_latest',
        'asset_risk_latest',
        'stock_instruments_latest',
        'stock_prices_latest',
        'stock_ohlcv_candles',
        'trending_markets',
        'fresh_trending_markets',
    ];
    const writes = (queries: RecordedQuery[]) => queries.filter(q => !q.text.trim().startsWith('SELECT'));
    const updatedTable = (q: RecordedQuery) => /UPDATE\s+(\w+)/.exec(q.text)?.[1];

    it('rewrites asset_id on every table that carries a copy', async () => {
        const { tx, queries } = makeFakeTx();
        expect(await renameAssetId(tx, { from: 'bitcoin', to: 'btc', nowMs: NOW })).toBe('renamed');

        const updates = queries.filter(q => q.text.trim().startsWith('UPDATE'));
        expect(updates.map(updatedTable)).toEqual(RENAMED_TABLES);
        for (const update of updates) {
            expect(update.text).toContain('SET asset_id = $');
            expect(update.params[0]).toBe('btc');
            expect(update.params[update.params.length - 1]).toBe('bitcoin'); // WHERE asset_id = from
        }
    });

    it('records both ids as assetId aliases (priority 1000) pointing at the new id', async () => {
        const { tx, queries } = makeFakeTx();
        await renameAssetId(tx, { from: 'Old-Id', to: 'new-id', nowMs: NOW });

        const inserts = queries.filter(q => q.text.includes('INSERT INTO asset_aliases'));
        expect(inserts).toHaveLength(2);
        for (const insert of inserts) {
            expect(insert.text).toContain("'assetId'");
            expect(insert.text).toContain('ON CONFLICT (asset_id, normalized, kind) DO NOTHING');
            expect(insert.params[3]).toBe('new-id'); // asset_id
            expect(insert.params[4]).toBe(1000);
        }
        // (id, normalized, alias, ...): new id first, then the old id as the rename marker.
        expect(inserts.map(q => [q.params[1], q.params[2]])).toEqual([
            ['new-id', 'new-id'],
            ['old-id', 'Old-Id'],
        ]);
    });

    it('clears orphaned rows keyed by the new id before moving rows onto it, never tombstones', async () => {
        const { tx, queries } = makeFakeTx();
        await renameAssetId(tx, { from: 'bitcoin', to: 'btc', nowMs: NOW });

        const all = writes(queries);
        const firstUpdate = all.findIndex(q => q.text.trim().startsWith('UPDATE'));
        const deletes = all.slice(0, firstUpdate);
        expect(deletes.length).toBeGreaterThan(0);
        for (const del of deletes) {
            expect(del.text.trim().startsWith('DELETE')).toBe(true);
            expect(del.params[0]).toBe('btc'); // never the asset being renamed
            expect(del.params).not.toContain('bitcoin');
        }
        // Tombstones keep a hard-deleted asset dead; a rename must never remove them.
        expect(all.some(q => q.text.includes('asset_deletion_tombstones'))).toBe(false);
        // asset_variants is never cleared: existing variants refuse the rename instead.
        expect(deletes.some(q => q.text.includes('asset_variants'))).toBe(false);
    });

    it('refuses without writing when the new id is already an asset', async () => {
        const { tx, queries } = makeFakeTx(text => (text.includes('FROM assets') ? [{ '?column?': 1 }] : []));
        expect(await renameAssetId(tx, { from: 'bitcoin', to: 'ethereum', nowMs: NOW })).toBe('asset_id_exists');
        expect(writes(queries)).toEqual([]);
    });

    it('refuses without writing when variants already sit under the new id', async () => {
        const { tx, queries } = makeFakeTx(text => (text.includes('FROM asset_variants') ? [{ '?column?': 1 }] : []));
        expect(await renameAssetId(tx, { from: 'bitcoin', to: 'btc', nowMs: NOW })).toBe('asset_id_exists');
        expect(writes(queries)).toEqual([]);
    });

    it("refuses without writing when the new id is another asset's former id", async () => {
        const { tx, queries } = makeFakeTx(text => (text.includes('FROM asset_aliases') ? [{ kind: 'assetId' }] : []));
        expect(await renameAssetId(tx, { from: 'bitcoin', to: 'btc', nowMs: NOW })).toBe('asset_id_reserved');
        expect(writes(queries)).toEqual([]);
        const check = queries.find(q => q.text.includes('FROM asset_aliases'));
        // normalized target, then excludes rows owned by either side of this rename.
        expect(check?.params).toEqual(['btc', 'bitcoin', 'btc']);
    });

    it("refuses without writing when the new id is another asset's name, symbol or alias", async () => {
        for (const kind of ['name', 'symbol', 'coingeckoId', 'custom']) {
            const { tx, queries } = makeFakeTx(text => (text.includes('FROM asset_aliases') ? [{ kind }] : []));
            expect(await renameAssetId(tx, { from: 'wrapped-bitcoin', to: 'btc', nowMs: NOW })).toBe(
                'asset_id_aliased',
            );
            expect(writes(queries)).toEqual([]);
            // Every alias kind is checked, not only former ids.
            const check = queries.find(q => q.text.includes('FROM asset_aliases'));
            expect(check?.text).not.toContain("kind = 'assetId'");
        }
    });

    it('refuses without writing when the new id belongs to a hard-deleted asset', async () => {
        const { tx, queries } = makeFakeTx(text =>
            text.includes('FROM asset_deletion_tombstones') ? [{ '?column?': 1 }] : [],
        );
        expect(await renameAssetId(tx, { from: 'bitcoin', to: 'btc', nowMs: NOW })).toBe('asset_id_deleted');
        expect(writes(queries)).toEqual([]);
        const check = queries.find(q => q.text.includes('FROM asset_deletion_tombstones'));
        // Matches the deleted asset's own id and any tombstoned ref equal to the target.
        expect(check?.text).toContain('normalized_ref');
        expect(check?.params).toEqual(['btc', 'btc']);
    });
});
