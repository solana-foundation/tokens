/**
 * Per-row v2 mirror helpers against a recording fake `tx`. These run inside
 * the admin mutation transactions so the tokens.xyz asset page (v2-only
 * reader) sees a Solana edit immediately instead of on the next
 * `sync-v2-solana-variants` tick.
 */

import { describe, expect, it } from 'bun:test';

import type { TransactionSql } from 'postgres';

import {
    V2_MARKET_METRIC_COLUMNS,
    deleteSolanaVariantRow,
    deleteV2AssetRows,
    hardDeleteV2,
    mirrorSolanaMarketRow,
    mirrorSolanaVariantRow,
    moveSolanaVariantRow,
    renameV2AssetId,
} from './v2Mirror';

interface RecordedQuery {
    text: string;
    params: unknown[];
}

class UnsafeSql {
    constructor(readonly text: string) {}
}

/** Inline `tx.unsafe(...)` fragments so assertions see the final column lists. */
function render(strings: TemplateStringsArray, values: unknown[]): { text: string; params: unknown[] } {
    let text = '';
    const params: unknown[] = [];
    strings.forEach((part, i) => {
        text += part;
        if (i < values.length) {
            const value = values[i];
            if (value instanceof UnsafeSql) text += value.text;
            else {
                text += '$';
                params.push(value);
            }
        }
    });
    return { text: text.replace(/\s+/g, ' ').trim(), params };
}

function makeFakeTx(respond: (text: string) => unknown[] = () => []): { tx: TransactionSql; queries: RecordedQuery[] } {
    const queries: RecordedQuery[] = [];
    const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const { text, params } = render(strings, values);
        queries.push({ text, params });
        return respond(text);
    };
    const tx = Object.assign(run, {
        unsafe: (text: string) => new UnsafeSql(text),
        array: (value: unknown) => ({ array: value }),
    });
    return { tx: tx as unknown as TransactionSql, queries };
}

const MINT = 'AMZNw7cwU9L9c7ewZXxTws2PwQYxBGm2Rxg3FLDBJz9B';
const NOW = 1_761_160_000_000;

describe('mirrorSolanaVariantRow', () => {
    it('copies the one v1 row into v2_asset_variants with the worker mirror guards, then its market', async () => {
        const { tx, queries } = makeFakeTx(text => (text.startsWith('INSERT INTO v2_asset_variants') ? [{ address: MINT }] : []));
        expect(await mirrorSolanaVariantRow(tx, { assetId: 'amazon', mint: MINT, nowMs: NOW })).toBe('mirrored');

        expect(queries).toHaveLength(2);
        const [variants, markets] = queries;
        expect(variants!.text).toContain('INSERT INTO v2_asset_variants');
        expect(variants!.text).toContain("SELECT 'solana', av.mint, av.asset_id, av.variant_id");
        expect(variants!.text).toContain("'solana_v1', av.source, av.is_active");
        expect(variants!.text).toContain("WHERE chain = 'solana' AND asset_id = $ AND mint = $");
        expect(variants!.text).toContain('LEFT JOIN variant_markets_latest vml ON vml.mint = av.mint');
        expect(variants!.text).toContain('ON CONFLICT (chain, address, asset_id) DO UPDATE SET');
        // Only mirror rows, and never roll last_seen_at backwards past an overlapping cron tick.
        expect(variants!.text).toContain("WHERE v2_asset_variants.origin = 'solana_v1'");
        expect(variants!.text).toContain('AND EXCLUDED.last_seen_at >= v2_asset_variants.last_seen_at');
        // first_seen_at = last_seen_at = nowMs, then (asset_id, mint) in the subselect.
        expect(variants!.params).toEqual([NOW, NOW, 'amazon', MINT]);

        expect(markets!.text).toContain('INSERT INTO v2_variant_markets_latest');
        expect(markets!.text).toContain("WHERE v2_variant_markets_latest.origin = 'solana_v1'");
        expect(markets!.params).toEqual([MINT]);
    });

    it('skips the market copy when v1 has no such variant', async () => {
        const { tx, queries } = makeFakeTx(() => []);
        expect(await mirrorSolanaVariantRow(tx, { assetId: 'amazon', mint: MINT, nowMs: NOW })).toBe('skipped');
        expect(queries).toHaveLength(1);
    });
});

describe('mirrorSolanaMarketRow', () => {
    it('copies every shared metric column by name from variant_markets_latest', async () => {
        const { tx, queries } = makeFakeTx(() => [{ address: MINT }]);
        expect(await mirrorSolanaMarketRow(tx, MINT)).toBe(1);
        const text = queries[0]!.text;
        for (const column of V2_MARKET_METRIC_COLUMNS) {
            expect(text).toContain(`vml.${column}`);
            expect(text).toContain(`${column} = EXCLUDED.${column}`);
        }
        expect(text).toContain("SELECT 'solana', vml.mint,");
        expect(text).toContain("'solana_v1' FROM variant_markets_latest vml WHERE vml.mint = $");
        expect(text).toContain('ON CONFLICT (chain, address) DO UPDATE SET');
    });

    it('matches the worker mirror column list (keep in step with cloudrun-assets)', () => {
        expect(V2_MARKET_METRIC_COLUMNS[0]).toBe('source');
        expect(V2_MARKET_METRIC_COLUMNS[V2_MARKET_METRIC_COLUMNS.length - 1]).toBe('overview_last_fetched_at');
        expect(V2_MARKET_METRIC_COLUMNS).toHaveLength(37);
    });
});

describe('deleteSolanaVariantRow / moveSolanaVariantRow', () => {
    it('deletes only the solana_v1 mirror row for (asset, mint), leaving the market row', async () => {
        const { tx, queries } = makeFakeTx(() => [{ address: MINT }]);
        expect(await deleteSolanaVariantRow(tx, { assetId: 'amazon', mint: MINT })).toBe(1);
        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain('DELETE FROM v2_asset_variants');
        expect(queries[0]!.text).toContain("WHERE chain = 'solana' AND address = $ AND asset_id = $ AND origin = 'solana_v1'");
        expect(queries[0]!.params).toEqual([MINT, 'amazon']);
        expect(queries.some(q => q.text.includes('v2_variant_markets_latest'))).toBe(false);
    });

    it('move = delete under the old asset, then mirror under the new one', async () => {
        const { tx, queries } = makeFakeTx(text => (text.startsWith('INSERT INTO v2_asset_variants') ? [{ address: MINT }] : []));
        await moveSolanaVariantRow(tx, { mint: MINT, fromAssetId: 'amazon', toAssetId: 'amazon-xstock', nowMs: NOW });
        expect(queries.map(q => q.text.split(' ').slice(0, 3).join(' '))).toEqual([
            'DELETE FROM v2_asset_variants',
            'INSERT INTO v2_asset_variants',
            'INSERT INTO v2_variant_markets_latest',
        ]);
        expect(queries[0]!.params).toEqual([MINT, 'amazon']);
        expect(queries[1]!.params).toEqual([NOW, NOW, 'amazon-xstock', MINT]);
    });
});

describe('renameV2AssetId', () => {
    it('clears orphans under the new id, then moves variant + rollup rows of every origin', async () => {
        const { tx, queries } = makeFakeTx();
        await renameV2AssetId(tx, { from: 'bitcoin', to: 'btc' });
        expect(queries.map(q => q.text)).toEqual([
            'DELETE FROM v2_asset_variants WHERE asset_id = $',
            'DELETE FROM v2_asset_chain_markets_latest WHERE asset_id = $',
            'UPDATE v2_asset_variants SET asset_id = $, updated_at = now() WHERE asset_id = $',
            'UPDATE v2_asset_chain_markets_latest SET asset_id = $, updated_at = now() WHERE asset_id = $',
        ]);
        expect(queries[0]!.params).toEqual(['btc']);
        expect(queries[2]!.params).toEqual(['btc', 'bitcoin']);
        // No origin filter: derived and admin EVM rows belong to the asset too.
        for (const q of queries) expect(q.text).not.toContain('origin');
    });
});

describe('deleteV2AssetRows / hardDeleteV2', () => {
    it('deleteV2AssetRows removes variants and rollups for the asset, all origins', async () => {
        const { tx, queries } = makeFakeTx(text => (text.startsWith('DELETE FROM v2_asset_variants') ? [{ address: 'a' }, { address: 'b' }] : []));
        expect(await deleteV2AssetRows(tx, 'xai')).toEqual({ variantsDeleted: 2 });
        expect(queries.map(q => q.text)).toEqual([
            'DELETE FROM v2_asset_variants WHERE asset_id = $ RETURNING address',
            'DELETE FROM v2_asset_chain_markets_latest WHERE asset_id = $',
        ]);
    });

    it('hardDeleteV2 also drops mirrored Solana market rows nothing references any more', async () => {
        const { tx, queries } = makeFakeTx(text =>
            text.startsWith('DELETE FROM v2_asset_variants') ? [{ address: MINT }] : text.includes('v2_variant_markets_latest') ? [{ address: MINT }] : [],
        );
        expect(await hardDeleteV2(tx, { assetId: 'amazon', mints: [MINT] })).toEqual({ variantsDeleted: 1, marketsDeleted: 1 });
        const markets = queries.find(q => q.text.includes('DELETE FROM v2_variant_markets_latest'));
        expect(markets).toBeDefined();
        expect(markets!.text).toContain("m.chain = 'solana' AND m.origin = 'solana_v1'");
        expect(markets!.text).toContain('NOT EXISTS ( SELECT 1 FROM v2_asset_variants v');
        expect(markets!.params).toEqual([{ array: [MINT] }]);
    });

    it('hardDeleteV2 skips the market statement when the asset had no mints', async () => {
        const { tx, queries } = makeFakeTx();
        expect(await hardDeleteV2(tx, { assetId: 'polygon', mints: [] })).toEqual({ variantsDeleted: 0, marketsDeleted: 0 });
        expect(queries.some(q => q.text.includes('v2_variant_markets_latest'))).toBe(false);
    });
});
