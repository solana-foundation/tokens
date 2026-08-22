import { describe, expect, it } from 'bun:test';

import { InvalidArgsError } from './assets';
import {
    MEMBER_BATCH_CAP,
    SlugConflictError,
    addMembersBatch,
    archiveList,
    createList,
    deleteList,
    isReservedTokenListSlug,
    removeMember,
    updateList,
    upsertMember,
    type TokenListMutationRow,
    type TokenListsMutationsDeps,
    type TokenListsMutationsRepo,
} from './tokenListsMutations';

const FIXED_NOW = 1_780_000_000_000;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEME_MINT = 'So11111111111111111111111111111111111111112';

const LIST_ROW: TokenListMutationRow = {
    id: 'tl_1',
    slug: 'ownership-core',
    owner_project_id: 'proj_1',
    name: 'Ownership Core',
    status: 'published',
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
};

function makeDeps(
    repoOverrides: Partial<TokenListsMutationsRepo> = {},
    depsOverrides: Partial<Omit<TokenListsMutationsDeps, 'repo'>> = {},
): TokenListsMutationsDeps {
    return {
        repo: {
            getListBySlug: async () => LIST_ROW,
            insertList: async args => ({
                ...LIST_ROW,
                slug: args.slug,
                owner_project_id: args.ownerProjectId,
                name: args.name,
                status: args.status,
            }),
            updateList: async (_listId, patch) => ({ ...LIST_ROW, ...patch }),
            deleteList: async () => {},
            upsertMember: async () => {},
            removeMember: async () => true,
            hasActiveVariantForMint: async () => true,
            hasTokenForAddress: async () => false,
            ...repoOverrides,
        },
        fetchTokenOverview: async () => null,
        now: () => FIXED_NOW,
        ...depsOverrides,
    };
}

describe('isReservedTokenListSlug', () => {
    it('reserves curated ids, their aliases, and route segments', () => {
        for (const slug of ['majors', 'stables', 'xstocks', 'all', 'lists', 'tokens', 'search-tokens', 'check-slug']) {
            expect(isReservedTokenListSlug(slug)).toBe(true);
        }
        expect(isReservedTokenListSlug('ownership-core')).toBe(false);
    });
});

describe('createList', () => {
    it('creates with defaults and lowercases the slug', async () => {
        const result = await createList(makeDeps(), {
            ownerProjectId: 'proj_1',
            slug: 'Ownership-Core',
            name: 'Ownership Core',
        });
        expect(result).toMatchObject({ ok: true, value: { slug: 'ownership-core', status: 'published' } });
    });

    it('rejects malformed and reserved slugs', async () => {
        expect(await createList(makeDeps(), { ownerProjectId: 'p', slug: '-bad', name: 'x' })).toEqual({
            ok: false,
            error: 'invalid_slug',
        });
        expect(await createList(makeDeps(), { ownerProjectId: 'p', slug: 'majors', name: 'x' })).toEqual({
            ok: false,
            error: 'reserved_slug',
        });
    });

    it('maps unique-index violations to slug_conflict', async () => {
        const deps = makeDeps({
            insertList: async () => {
                throw new SlugConflictError('ownership-core');
            },
        });
        expect(await createList(deps, { ownerProjectId: 'p', slug: 'ownership-core', name: 'x' })).toEqual({
            ok: false,
            error: 'slug_conflict',
        });
    });

    it('rejects invalid status via InvalidArgsError', async () => {
        await expect(
            createList(makeDeps(), { ownerProjectId: 'p', slug: 'ok-slug', name: 'x', status: 'live' }),
        ).rejects.toBeInstanceOf(InvalidArgsError);
    });
});

describe('ownership enforcement', () => {
    it('rejects a non-owner on every list-scoped mutation', async () => {
        const deps = makeDeps();
        const args = {
            ownerProjectId: 'intruder',
            slug: 'ownership-core',
            mint: USDC_MINT,
            mints: [USDC_MINT],
            name: 'x',
        };
        expect(await updateList(deps, args)).toEqual({ ok: false, error: 'forbidden' });
        expect(await archiveList(deps, args)).toEqual({ ok: false, error: 'forbidden' });
        expect(await deleteList(deps, args)).toEqual({ ok: false, error: 'forbidden' });
        expect(await upsertMember(deps, args)).toEqual({ ok: false, error: 'forbidden' });
        expect(await removeMember(deps, args)).toEqual({ ok: false, error: 'forbidden' });
        expect(await addMembersBatch(deps, args)).toEqual({ ok: false, error: 'forbidden' });
    });

    it('reports not_found for unknown lists', async () => {
        const deps = makeDeps({ getListBySlug: async () => null });
        expect(await archiveList(deps, { ownerProjectId: 'p', slug: 'nope' })).toEqual({
            ok: false,
            error: 'not_found',
        });
    });
});

describe('updateList slug rename', () => {
    it('renames via newSlug, lowercasing the target', async () => {
        const result = await updateList(makeDeps(), {
            ownerProjectId: 'proj_1',
            slug: 'ownership-core',
            newSlug: 'Ownership-Majors',
        });
        expect(result).toMatchObject({ ok: true, value: { slug: 'ownership-majors' } });
    });

    it('rejects malformed and reserved targets', async () => {
        const base = { ownerProjectId: 'proj_1', slug: 'ownership-core' };
        expect(await updateList(makeDeps(), { ...base, newSlug: '-nope' })).toEqual({
            ok: false,
            error: 'invalid_slug',
        });
        expect(await updateList(makeDeps(), { ...base, newSlug: 'stables' })).toEqual({
            ok: false,
            error: 'reserved_slug',
        });
    });

    it('maps a colliding rename to slug_conflict', async () => {
        const deps = makeDeps({
            updateList: async () => {
                throw new SlugConflictError('taken-slug');
            },
        });
        expect(
            await updateList(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core', newSlug: 'taken-slug' }),
        ).toEqual({ ok: false, error: 'slug_conflict' });
    });

    it('does not send a self-rename to the unique index', async () => {
        let patched: unknown = null;
        const deps = makeDeps({
            updateList: async (_listId, patch) => {
                patched = patch;
                return { ...LIST_ROW, ...patch };
            },
        });
        await updateList(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core', newSlug: 'ownership-core' });
        expect(patched).toEqual({});
    });
});

describe('deleteList', () => {
    it('hard-deletes the owned list and returns its final shape', async () => {
        const deleted: string[] = [];
        const deps = makeDeps({ deleteList: async listId => void deleted.push(listId) });
        const result = await deleteList(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core' });
        expect(deleted).toEqual(['tl_1']);
        expect(result).toMatchObject({ ok: true, value: { slug: 'ownership-core' } });
    });

    it('reports not_found for unknown lists', async () => {
        const deps = makeDeps({ getListBySlug: async () => null });
        expect(await deleteList(deps, { ownerProjectId: 'p', slug: 'nope' })).toEqual({
            ok: false,
            error: 'not_found',
        });
    });
});

describe('upsertMember mint resolution', () => {
    it('registry-known mint → verified, no snapshot', async () => {
        const result = await upsertMember(makeDeps(), {
            ownerProjectId: 'proj_1',
            slug: 'ownership-core',
            mint: USDC_MINT,
        });
        expect(result).toEqual({ ok: true, value: { mint: USDC_MINT, verified: true, snapshot: null } });
    });

    it('tokens-table mint → unverified, no snapshot', async () => {
        const deps = makeDeps({
            hasActiveVariantForMint: async () => false,
            hasTokenForAddress: async () => true,
        });
        const result = await upsertMember(deps, {
            ownerProjectId: 'proj_1',
            slug: 'ownership-core',
            mint: MEME_MINT,
        });
        expect(result).toEqual({ ok: true, value: { mint: MEME_MINT, verified: false, snapshot: null } });
    });

    it('Birdeye-only mint → unverified with snapshot', async () => {
        const deps = makeDeps(
            { hasActiveVariantForMint: async () => false, hasTokenForAddress: async () => false },
            {
                fetchTokenOverview: async () => ({
                    symbol: 'MEME',
                    name: 'Meme Token',
                    logoURI: 'https://img.example/meme.png',
                    decimals: 9,
                }),
            },
        );
        const result = await upsertMember(deps, {
            ownerProjectId: 'proj_1',
            slug: 'ownership-core',
            mint: MEME_MINT,
        });
        expect(result).toEqual({
            ok: true,
            value: {
                mint: MEME_MINT,
                verified: false,
                snapshot: { symbol: 'MEME', name: 'Meme Token', logoUri: 'https://img.example/meme.png', decimals: 9 },
            },
        });
    });

    it('mint unknown everywhere → unknown_mint; malformed → invalid_mint', async () => {
        const deps = makeDeps({
            hasActiveVariantForMint: async () => false,
            hasTokenForAddress: async () => false,
        });
        expect(await upsertMember(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core', mint: MEME_MINT })).toEqual(
            { ok: false, error: 'unknown_mint' },
        );
        expect(
            await upsertMember(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core', mint: 'not-a-mint!' }),
        ).toEqual({ ok: false, error: 'invalid_mint' });
    });
});

describe('addMembersBatch', () => {
    it('caps the batch size', async () => {
        const mints = Array.from({ length: MEMBER_BATCH_CAP + 1 }, (_, i) =>
            `M${String(i).padStart(3, 'x')}`.padEnd(40, 'z'),
        );
        expect(await addMembersBatch(makeDeps(), { ownerProjectId: 'proj_1', slug: 'ownership-core', mints })).toEqual({
            ok: false,
            error: 'batch_too_large',
        });
    });

    it('partitions per-mint successes and failures', async () => {
        const deps = makeDeps({
            hasActiveVariantForMint: async mint => mint === USDC_MINT,
            hasTokenForAddress: async () => false,
        });
        const result = await addMembersBatch(deps, {
            ownerProjectId: 'proj_1',
            slug: 'ownership-core',
            mints: [USDC_MINT, MEME_MINT, 'garbage'],
        });
        expect(result).toEqual({
            ok: true,
            value: {
                added: [{ mint: USDC_MINT, verified: true, snapshot: null }],
                failed: [
                    { mint: MEME_MINT, error: 'unknown_mint' },
                    { mint: 'garbage', error: 'invalid_mint' },
                ],
            },
        });
    });
});

describe('removeMember', () => {
    it('reports not_found when the mint was not a member', async () => {
        const deps = makeDeps({ removeMember: async () => false });
        expect(await removeMember(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core', mint: USDC_MINT })).toEqual(
            { ok: false, error: 'not_found' },
        );
    });
});
