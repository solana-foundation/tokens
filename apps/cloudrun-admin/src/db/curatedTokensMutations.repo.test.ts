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

function jsonParams(query: RecordedQuery | undefined): unknown[] {
    return (query?.params ?? []).filter(p => p instanceof JsonParam).map(p => (p as JsonParam).value);
}

const NOW = 1_760_000_000_000;

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
            expect(await repo.updateVariant({ mint: 'm', tags: ['PreStocks', 'curated:stocks'], nowMs: NOW })).toBe(
                'updated',
            );
            const update = queries.find(q => q.text.startsWith('UPDATE asset_variants SET'));
            expect(jsonParams(update)).toEqual([['PreStocks', 'curated:stocks']]);
            expect(update!.params.some(p => typeof p === 'string' && p.startsWith('['))).toBe(false);
        }
        {
            const { sql, queries } = makeFakeSql(text => (text.includes('FOR UPDATE') ? [current] : []));
            const repo = makePostgresAdminMutationsRepo(sql);
            expect(await repo.updateVariant({ mint: 'm', label: 'PreStocks', nowMs: NOW })).toBe('updated');
            const update = queries.find(q => q.text.startsWith('UPDATE asset_variants SET'));
            expect(jsonParams(update)).toEqual([['category:crypto']]);
        }
    });
});
