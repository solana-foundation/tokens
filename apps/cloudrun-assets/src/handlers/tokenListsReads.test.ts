import { describe, expect, it } from 'bun:test';

import { InvalidArgsError } from './assets';
import {
    getBySlug,
    getMembers,
    getSlugsByMints,
    listPublished,
    type TokenListMemberRow,
    type TokenListRow,
    type TokenListSummaryRow,
    type TokenListsReadsRepo,
} from './tokenListsReads';

const SUMMARY_ROW: TokenListSummaryRow = {
    slug: 'ownership-core',
    name: 'Ownership Core',
    owner_project_id: 'proj_1',
    member_count: 3,
    updated_at: 1_780_000_000_000,
};

const LIST_ROW: TokenListRow = {
    id: 'tl_1',
    slug: 'ownership-core',
    owner_project_id: 'proj_1',
    name: 'Ownership Core',
    status: 'published',
    member_count: 3,
    created_at: 1_779_000_000_000,
    updated_at: 1_780_000_000_000,
};

const MEMBER_ROW: TokenListMemberRow = {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    rank: 0,
    note: null,
    added_at: 1_780_000_000_000,
    symbol: null,
    name: null,
    logo_uri: null,
    decimals: null,
    verified: true,
};

function makeRepo(overrides: Partial<TokenListsReadsRepo> = {}): TokenListsReadsRepo {
    return {
        listPublished: async () => [SUMMARY_ROW],
        getBySlug: async () => LIST_ROW,
        listMembersBySlug: async () => [MEMBER_ROW],
        listSlugsByMints: async () => [],
        ...overrides,
    };
}

describe('tokenListsReads.listPublished', () => {
    it('maps rows to camelCase summaries', async () => {
        const result = await listPublished(makeRepo(), {});
        expect(result).toEqual([
            {
                slug: 'ownership-core',
                name: 'Ownership Core',
                ownerProjectId: 'proj_1',
                tokenCount: 3,
                updatedAt: 1_780_000_000_000,
            },
        ]);
    });

    it('clamps limit and floors offset', async () => {
        const calls: Array<{ limit: number; offset: number }> = [];
        const repo = makeRepo({
            listPublished: async (limit, offset) => {
                calls.push({ limit, offset });
                return [];
            },
        });
        await listPublished(repo, { limit: 10_000, offset: -5 });
        expect(calls).toEqual([{ limit: 500, offset: 0 }]);
    });

    it('rejects non-numeric limit', async () => {
        await expect(listPublished(makeRepo(), { limit: 'lots' })).rejects.toBeInstanceOf(
            InvalidArgsError,
        );
    });
});

describe('tokenListsReads.getBySlug', () => {
    it('returns detail with status and createdAt', async () => {
        const result = await getBySlug(makeRepo(), { slug: 'ownership-core' });
        expect(result).toMatchObject({
            slug: 'ownership-core',
            status: 'published',
            createdAt: 1_779_000_000_000,
            tokenCount: 3,
        });
    });

    it('returns null for blank slug without hitting the repo', async () => {
        const repo = makeRepo({
            getBySlug: async () => {
                throw new Error('should not be called');
            },
        });
        expect(await getBySlug(repo, { slug: '   ' })).toBeNull();
    });

    it('rejects missing slug', async () => {
        await expect(getBySlug(makeRepo(), {})).rejects.toBeInstanceOf(InvalidArgsError);
    });
});

describe('tokenListsReads.getSlugsByMints', () => {
    it('groups slugs per mint', async () => {
        const repo = makeRepo({
            listSlugsByMints: async () => [
                { mint: 'MintA', slug: 'ownership-core' },
                { mint: 'MintA', slug: 'defi-picks' },
                { mint: 'MintB', slug: 'ownership-core' },
            ],
        });
        const result = await getSlugsByMints(repo, { mints: ['MintA', 'MintB', 'MintC'] });
        expect(result).toEqual([
            { mint: 'MintA', slugs: ['ownership-core', 'defi-picks'] },
            { mint: 'MintB', slugs: ['ownership-core'] },
        ]);
    });
});

describe('tokenListsReads.getMembers', () => {
    it('maps snapshot columns and verified flag', async () => {
        const repo = makeRepo({
            listMembersBySlug: async () => [
                {
                    ...MEMBER_ROW,
                    mint: 'SoMeMemeMint11111111111111111111111111111111',
                    symbol: 'MEME',
                    name: 'Meme Token',
                    logo_uri: 'https://img.example/meme.png',
                    decimals: 9,
                    verified: false,
                },
            ],
        });
        const result = await getMembers(repo, { slug: 'ownership-core' });
        expect(result).toEqual([
            {
                mint: 'SoMeMemeMint11111111111111111111111111111111',
                rank: 0,
                note: null,
                addedAt: 1_780_000_000_000,
                symbol: 'MEME',
                name: 'Meme Token',
                logoUri: 'https://img.example/meme.png',
                decimals: 9,
                verified: false,
            },
        ]);
    });

    it('returns empty for blank slug', async () => {
        expect(await getMembers(makeRepo(), { slug: '' })).toEqual([]);
    });
});
