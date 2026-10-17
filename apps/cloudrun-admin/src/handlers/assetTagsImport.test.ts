import { describe, expect, it } from 'bun:test';

import { ASSET_TAGS_INITIAL } from '../data/asset-tags-initial';
import { IdentityRequiredError, InvalidArgsError, UnauthorizedError } from './errors';
import {
    applyAssetTagsImport,
    planAssetTagsImport,
    previewAssetTagsImport,
    type AssetTagsImportDeps,
    type AssetTagsImportRepo,
    type AssetTagsImportRow,
    type ResolvedAssetTags,
} from './assetTagsImport';

const ADMIN = { clerkUserId: 'admin_1' };
const ADMIN_IDS: ReadonlySet<string> = new Set(['admin_1']);
const NOW = 1_760_000_000_000;

function makeRepo(
    assets: Record<string, ResolvedAssetTags>,
    options: { renames?: Record<string, string>; untagged?: string[] } = {},
): { repo: AssetTagsImportRepo; applied: Array<{ rows: AssetTagsImportRow[]; nowMs: number; mode: string }> } {
    const applied: Array<{ rows: AssetTagsImportRow[]; nowMs: number; mode: string }> = [];
    const repo: AssetTagsImportRepo = {
        async resolveAssets(ids) {
            const out = new Map<string, ResolvedAssetTags>();
            for (const id of ids) {
                const current = options.renames?.[id] ?? id;
                const asset = assets[current];
                if (asset) out.set(id, asset);
            }
            return out;
        },
        async applyTags(rows, nowMs, mode) {
            applied.push({ rows: [...rows], nowMs, mode });
            return rows.length;
        },
        async listUntaggedStockAssetIds() {
            return options.untagged ?? [];
        },
    };
    return { repo, applied };
}

function deps(repo: AssetTagsImportRepo): AssetTagsImportDeps {
    return { repo, adminAllowlist: { clerkUserIds: ADMIN_IDS, emails: new Set() }, now: () => NOW };
}

const ROWS: AssetTagsImportRow[] = [
    { assetId: 'tesla', region: 'north_america', industry: 'automotive' },
    { assetId: 'asml', region: 'europe', industry: 'semiconductors' },
    { assetId: 'sk-hynix', region: 'asia', industry: 'semiconductors' },
    { assetId: 'ghost', region: 'asia', industry: 'defense' },
];

describe('planAssetTagsImport', () => {
    it('fill_empty writes untagged assets, skips tagged ones, reports unmatched and unchanged', async () => {
        const { repo } = makeRepo({
            tesla: { assetId: 'tesla', region: null, industry: null },
            asml: { assetId: 'asml', region: 'europe', industry: 'hardware' }, // hand-edited → left alone
            'sk-hynix': { assetId: 'sk-hynix', region: 'asia', industry: 'semiconductors' }, // identical
        });
        const plan = await planAssetTagsImport(repo, ROWS, 'fill_empty');
        expect(plan.toApply).toEqual([{ assetId: 'tesla', region: 'north_america', industry: 'automotive' }]);
        expect(plan.skippedAlreadyTagged).toEqual(['asml']);
        expect(plan.unchanged).toEqual(['sk-hynix']);
        expect(plan.unmatched).toEqual(['ghost']);
    });

    it('overwrite rewrites differing tags but still skips identical rows', async () => {
        const { repo } = makeRepo({
            tesla: { assetId: 'tesla', region: null, industry: null },
            asml: { assetId: 'asml', region: 'europe', industry: 'hardware' },
            'sk-hynix': { assetId: 'sk-hynix', region: 'asia', industry: 'semiconductors' },
        });
        const plan = await planAssetTagsImport(repo, ROWS, 'overwrite');
        expect(plan.toApply.map(row => row.assetId)).toEqual(['tesla', 'asml']);
        expect(plan.skippedAlreadyTagged).toEqual([]);
        expect(plan.unchanged).toEqual(['sk-hynix']);
    });

    it('follows admin renames and targets the current id once', async () => {
        const { repo } = makeRepo(
            { 'tesla-inc': { assetId: 'tesla-inc', region: null, industry: null } },
            { renames: { tesla: 'tesla-inc' } },
        );
        const plan = await planAssetTagsImport(
            repo,
            [
                { assetId: 'tesla', region: 'north_america', industry: 'automotive' },
                { assetId: 'tesla-inc', region: 'north_america', industry: 'automotive' },
            ],
            'fill_empty',
        );
        expect(plan.toApply).toEqual([{ assetId: 'tesla-inc', region: 'north_america', industry: 'automotive' }]);
        expect(plan.renamed).toEqual([{ requested: 'tesla', assetId: 'tesla-inc' }]);
    });
});

describe('previewAssetTagsImport / applyAssetTagsImport', () => {
    it('reject missing identity and non-admin callers', async () => {
        const { repo } = makeRepo({});
        await expect(previewAssetTagsImport(deps(repo), {}, null)).rejects.toBeInstanceOf(IdentityRequiredError);
        await expect(applyAssetTagsImport(deps(repo), {}, { clerkUserId: 'nope' })).rejects.toBeInstanceOf(
            UnauthorizedError,
        );
    });

    it('defaults to the bundled dataset and reports untagged stocks after the plan', async () => {
        const { repo } = makeRepo(
            { tesla: { assetId: 'tesla', region: null, industry: null } },
            { untagged: ['tesla', 'stock-abcdefgh'] },
        );
        const preview = await previewAssetTagsImport(deps(repo), {}, ADMIN);
        expect(preview.requested).toBe(Object.keys(ASSET_TAGS_INITIAL).length);
        expect(preview.toApply).toEqual([{ assetId: 'tesla', region: 'north_america', industry: 'automotive' }]);
        expect(preview.untaggedStocks).toEqual(['stock-abcdefgh']);
        expect(preview.unmatched.length).toBe(preview.requested - 1);
    });

    it('validates pasted rows and mode', async () => {
        const { repo } = makeRepo({});
        const d = deps(repo);
        await expect(previewAssetTagsImport(d, { rows: [] }, ADMIN)).rejects.toThrow(/rows must not be empty/);
        await expect(
            previewAssetTagsImport(d, { rows: [{ assetId: 'x', region: 'mars', industry: 'defense' }] }, ADMIN),
        ).rejects.toThrow(/rows\[0\]\.region/);
        await expect(
            previewAssetTagsImport(d, { rows: [{ assetId: 'x', region: 'asia', industry: 'Defense' }] }, ADMIN),
        ).rejects.toThrow(/rows\[0\]\.industry/);
        await expect(
            previewAssetTagsImport(
                d,
                {
                    rows: [
                        { assetId: 'x', region: 'asia', industry: 'defense' },
                        { assetId: 'X', region: 'asia', industry: 'defense' },
                    ],
                },
                ADMIN,
            ),
        ).rejects.toThrow(/duplicates/);
        await expect(previewAssetTagsImport(d, { mode: 'nuke' }, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
    });

    it('apply writes only the planned rows with the deps clock and returns the count', async () => {
        const { repo, applied } = makeRepo({
            tesla: { assetId: 'tesla', region: null, industry: null },
            asml: { assetId: 'asml', region: 'europe', industry: 'hardware' },
        });
        const result = await applyAssetTagsImport(deps(repo), { rows: ROWS.slice(0, 2) }, ADMIN);
        expect(result.applied).toBe(1);
        expect(applied).toEqual([
            {
                rows: [{ assetId: 'tesla', region: 'north_america', industry: 'automotive' }],
                nowMs: NOW,
                mode: 'fill_empty',
            },
        ]);
        expect(result.skippedAlreadyTagged).toEqual(['asml']);
    });

    it('apply reports the repo count, which can be lower than the plan when a row was tagged mid-run', async () => {
        const { repo } = makeRepo({
            tesla: { assetId: 'tesla', region: null, industry: null },
            asml: { assetId: 'asml', region: null, industry: null },
        });
        repo.applyTags = async rows => rows.length - 1; // one row lost the fill_empty race
        const result = await applyAssetTagsImport(deps(repo), { rows: ROWS.slice(0, 2) }, ADMIN);
        expect(result.toApply.length).toBe(2);
        expect(result.applied).toBe(1);
    });

    it('apply skips the write entirely when nothing is planned', async () => {
        const { repo, applied } = makeRepo({ asml: { assetId: 'asml', region: 'europe', industry: 'semiconductors' } });
        const result = await applyAssetTagsImport(deps(repo), { rows: [ROWS[1]!] }, ADMIN);
        expect(result.applied).toBe(0);
        expect(applied).toEqual([]);
    });
});
