/**
 * `makePostgresHardDeleteRepo` against a recording fake `sql`/`tx`.
 *
 * Regression: the tombstone INSERT bound `JSON.stringify(payload)` into a
 * `::jsonb` parameter. postgres-js serializes json/jsonb-typed parameters with
 * JSON.stringify itself, so the value was encoded twice and Postgres rejected
 * every hard delete that built tombstone rows (i.e. every asset with a name or
 * alias) with "cannot call jsonb_to_recordset on a non-array".
 */

import { describe, expect, it } from 'bun:test';

import type { Sql } from 'postgres';

import { makePostgresHardDeleteRepo } from './hardDelete';

interface RecordedQuery {
    text: string;
    params: unknown[];
}

/** Marker returned by the fake `json()` so tests can tell it apart from a string. */
class JsonParam {
    constructor(readonly value: unknown) {}
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
        begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
    });
    return { sql: fake as unknown as Sql, queries };
}

describe('makePostgresHardDeleteRepo', () => {
    it('binds the tombstone payload through sql.json, not as a pre-stringified string', async () => {
        const { sql, queries } = makeFakeSql(text => {
            if (text.startsWith('SELECT name, symbol, coingecko_id, aliases')) {
                return [{ name: 'xAI', symbol: 'XAI', coingecko_id: null, aliases: ['x.ai'] }];
            }
            if (text.startsWith('SELECT mint FROM asset_variants')) {
                return [{ mint: 'PreC1KtJ1sBPPqaeeqL6Qb15GTLCYVvyYEwxhdfTwfx' }];
            }
            if (text.startsWith('SELECT alias FROM asset_aliases')) return [{ alias: 'xai' }];
            if (text.startsWith('INSERT INTO asset_deletion_tombstones')) return [{ id: 'adt_1' }, { id: 'adt_2' }];
            return [];
        });
        const repo = makePostgresHardDeleteRepo(sql);

        const counters = await repo.hardDeleteAsset({ assetId: 'pre-prec1ktj', nowMs: 1_760_000_000_000 });

        expect(counters).not.toBeNull();
        expect(counters?.tombstonesCreated).toBe(2);

        const insert = queries.find(q => q.text.startsWith('INSERT INTO asset_deletion_tombstones'));
        expect(insert).toBeDefined();
        expect(insert!.text).toContain('jsonb_to_recordset($::jsonb)');
        const payloadParam = insert!.params.find(p => p instanceof JsonParam) as JsonParam | undefined;
        expect(payloadParam).toBeDefined();
        expect(insert!.params.some(p => typeof p === 'string' && p.startsWith('['))).toBe(false);

        const rows = payloadParam!.value as Array<Record<string, string>>;
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(Object.keys(row).sort()).toEqual(['id', 'kind', 'normalized_ref', 'ref']);
        }
        const refs = rows.map(r => r.ref);
        expect(refs).toContain('pre-prec1ktj');
        expect(refs).toContain('PreC1KtJ1sBPPqaeeqL6Qb15GTLCYVvyYEwxhdfTwfx');
    });

    it('returns null without writing anything when the asset does not exist', async () => {
        const { sql, queries } = makeFakeSql(() => []);
        const repo = makePostgresHardDeleteRepo(sql);

        const counters = await repo.hardDeleteAsset({ assetId: 'missing', nowMs: 1 });

        expect(counters).toBeNull();
        expect(queries.filter(q => /^(INSERT|DELETE|UPDATE)/.test(q.text))).toHaveLength(0);
    });
});
