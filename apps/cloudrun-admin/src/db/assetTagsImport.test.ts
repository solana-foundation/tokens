import { describe, expect, it } from 'bun:test';

import type { Sql } from 'postgres';

import { makePostgresAssetTagsImportRepo } from './assetTagsImport';

interface RecordedQuery {
    text: string;
    params: unknown[];
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
        array: (value: unknown) => ({ array: value }),
        begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
    });
    return { sql: fake as unknown as Sql, queries };
}

const NOW = 1_760_000_000_000;

describe('makePostgresAssetTagsImportRepo', () => {
    it('resolveAssets prefers a direct match over a rename alias and keys by the requested spelling', async () => {
        const { sql } = makeFakeSql(text =>
            text.startsWith('SELECT lower(a.asset_id)')
                ? [
                      { requested: 'tesla', asset_id: 'tesla', region: null, industry: null, direct: true },
                      {
                          requested: 'tesla',
                          asset_id: 'tesla-legacy',
                          region: 'asia',
                          industry: 'defense',
                          direct: false,
                      },
                      { requested: 'old-asml', asset_id: 'asml', region: 'europe', industry: null, direct: false },
                  ]
                : [],
        );
        const repo = makePostgresAssetTagsImportRepo(sql);
        const resolved = await repo.resolveAssets(['Tesla', 'old-asml', 'ghost']);
        expect(resolved.get('Tesla')).toEqual({ assetId: 'tesla', region: null, industry: null });
        expect(resolved.get('old-asml')).toEqual({ assetId: 'asml', region: 'europe', industry: null });
        expect(resolved.has('ghost')).toBe(false);
    });

    it('applyTags updates each row with admin_edited_at inside one transaction and returns the count', async () => {
        const { sql, queries } = makeFakeSql(text => (text.startsWith('UPDATE assets SET') ? [{}] : []));
        const repo = makePostgresAssetTagsImportRepo(sql);
        const updated = await repo.applyTags(
            [
                { assetId: 'tesla', region: 'north_america', industry: 'automotive' },
                { assetId: 'asml', region: 'europe', industry: 'semiconductors' },
            ],
            NOW,
        );
        expect(updated).toBe(2);
        const updates = queries.filter(q => q.text.startsWith('UPDATE assets SET'));
        expect(updates.length).toBe(2);
        expect(updates[0]!.text).toContain('admin_edited_at = $');
        expect(updates[0]!.params).toEqual(['north_america', 'automotive', new Date(NOW), NOW, 'tesla']);
    });

    it('applyTags is a no-op for an empty plan', async () => {
        const { sql, queries } = makeFakeSql();
        const repo = makePostgresAssetTagsImportRepo(sql);
        expect(await repo.applyTags([], NOW)).toBe(0);
        expect(queries).toEqual([]);
    });
});
