import { describe, expect, it } from 'bun:test';

import { listAdvisories, type AssetAdvisoriesRepo, type AssetAdvisoryRow } from './assetAdvisoriesReads';

function repoWith(rows: AssetAdvisoryRow[]): AssetAdvisoriesRepo {
    return { listAll: async () => rows };
}

describe('listAdvisories', () => {
    it('returns revision 0 and no advisories when the table is empty', async () => {
        expect(await listAdvisories(repoWith([]))).toEqual({ revision: 0, advisories: [] });
    });

    it('maps rows to the contract shape with since = set_at', async () => {
        const result = await listAdvisories(
            repoWith([
                {
                    mint: 'SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L',
                    status: 'compromised',
                    reason: 'Treasury exploited',
                    url: 'https://example.com/post',
                    set_at: 1000,
                    updated_at: 2000,
                },
                { mint: 'MintB', status: 'caution', reason: 'Watch', url: null, set_at: 500, updated_at: 500 },
            ]),
        );
        expect(result).toEqual({
            revision: 2000,
            advisories: [
                {
                    mint: 'SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L',
                    status: 'compromised',
                    reason: 'Treasury exploited',
                    url: 'https://example.com/post',
                    since: 1000,
                    source: 'admin',
                },
                { mint: 'MintB', status: 'caution', reason: 'Watch', url: null, since: 500, source: 'admin' },
            ],
        });
    });

    it('carries a known source through and defaults unknown or missing sources to admin', async () => {
        const result = await listAdvisories(
            repoWith([
                { mint: 'A', status: 'caution', reason: 'r', url: null, set_at: 1, updated_at: 1, source: 'webacy_depeg' },
                { mint: 'B', status: 'caution', reason: 'r', url: null, set_at: 1, updated_at: 1, source: 'bogus' },
                { mint: 'C', status: 'caution', reason: 'r', url: null, set_at: 1, updated_at: 1 },
            ]),
        );
        expect(result.advisories.map(a => a.source)).toEqual(['webacy_depeg', 'admin', 'admin']);
    });

    it('coerces bigint and string epoch columns to numbers', async () => {
        const result = await listAdvisories(
            repoWith([
                { mint: 'A', status: 'blocked', reason: 'r', url: null, set_at: '1700000000000', updated_at: '1700000000500' },
                { mint: 'B', status: 'caution', reason: 'r', url: null, set_at: 1700000001000n, updated_at: 1700000002000n },
            ]),
        );
        expect(result.revision).toBe(1700000002000);
        expect(result.advisories.map(a => a.since)).toEqual([1700000000000, 1700000001000]);
        for (const a of result.advisories) expect(typeof a.since).toBe('number');
        expect(typeof result.revision).toBe('number');
    });

    it('skips rows with an unknown status and excludes them from the revision', async () => {
        const result = await listAdvisories(
            repoWith([
                { mint: 'A', status: 'caution', reason: 'r', url: null, set_at: 10, updated_at: 10 },
                { mint: 'B', status: 'quarantined', reason: 'r', url: null, set_at: 99, updated_at: 99 },
            ]),
        );
        expect(result.revision).toBe(10);
        expect(result.advisories.map(a => a.mint)).toEqual(['A']);
    });

    it('revision is the max updated_at, independent of row order', async () => {
        const result = await listAdvisories(
            repoWith([
                { mint: 'A', status: 'caution', reason: 'r', url: null, set_at: 1, updated_at: 300 },
                { mint: 'B', status: 'caution', reason: 'r', url: null, set_at: 1, updated_at: 100 },
                { mint: 'C', status: 'caution', reason: 'r', url: null, set_at: 1, updated_at: 200 },
            ]),
        );
        expect(result.revision).toBe(300);
    });
});
