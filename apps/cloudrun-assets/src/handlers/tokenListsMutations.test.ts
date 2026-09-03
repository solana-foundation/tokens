import { describe, expect, it } from 'bun:test';

import { InvalidArgsError } from './assets';
import {
    DEFAULT_TOKEN_LIST_CAPS,
    SlugConflictError,
    addMembersBatch,
    archiveList,
    createList,
    deleteList,
    isReservedTokenListSlug,
    removeMember,
    updateList,
    upsertMember,
    withOverviewMissCache,
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
    admin_locked_at: null,
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
            upsertMember: async () => true,
            removeMember: async () => true,
            hasActiveVariantForMint: async () => true,
            hasTokenForAddress: async () => false,
            // Batch resolution defaults mirror the single-mint fakes above:
            // every well-formed mint counts as registry-known.
            filterMintsWithActiveVariants: async mints => [...mints],
            filterMintsKnownTokens: async () => [],
            filterMintsExistingMembers: async () => [],
            countMembers: async () => 0,
            upsertMembersBulk: async () => ({ overflowMints: [] }),
            countListsByOwner: async () => 0,
            getSlugHold: async () => null,
            recordSlugHold: async () => {},
            clearSlugHold: async () => {},
            ...repoOverrides,
        },
        fetchTokenOverview: async () => null,
        now: () => FIXED_NOW,
        caps: { ...DEFAULT_TOKEN_LIST_CAPS },
        slugHoldMs: 30 * 24 * 60 * 60 * 1000,
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

describe('admin takedown lock', () => {
    it('blocks every owner mutation while admin_locked_at is set', async () => {
        const deps = makeDeps({ getListBySlug: async () => ({ ...LIST_ROW, admin_locked_at: FIXED_NOW }) });
        const args = { ownerProjectId: 'proj_1', slug: 'ownership-core', mint: USDC_MINT, name: 'x' };
        expect(await updateList(deps, args)).toEqual({ ok: false, error: 'admin_locked' });
        expect(await deleteList(deps, args)).toEqual({ ok: false, error: 'admin_locked' });
        expect(await upsertMember(deps, args)).toEqual({ ok: false, error: 'admin_locked' });
        expect(await removeMember(deps, args)).toEqual({ ok: false, error: 'admin_locked' });
    });
});

describe('slug hold-down', () => {
    const HOLD = { ownerProjectId: 'proj_other', releasedAt: FIXED_NOW - 1000 };

    it('refuses creation of a slug recently freed by another project', async () => {
        const deps = makeDeps({ getSlugHold: async () => HOLD });
        expect(await createList(deps, { ownerProjectId: 'proj_1', slug: 'freed-slug', name: 'X' })).toEqual({
            ok: false,
            error: 'slug_held',
        });
    });

    it('lets the previous owner reclaim, and anyone claim after the window', async () => {
        const mine = makeDeps({ getSlugHold: async () => ({ ...HOLD, ownerProjectId: 'proj_1' }) });
        expect(await createList(mine, { ownerProjectId: 'proj_1', slug: 'freed-slug', name: 'X' })).toMatchObject({
            ok: true,
        });

        const expired = makeDeps({
            getSlugHold: async () => ({ ...HOLD, releasedAt: FIXED_NOW - 31 * 24 * 60 * 60 * 1000 }),
        });
        expect(await createList(expired, { ownerProjectId: 'proj_1', slug: 'freed-slug', name: 'X' })).toMatchObject({
            ok: true,
        });
    });

    it('records a hold on delete (atomically, via the repo) and on rename-away', async () => {
        const holds: unknown[] = [];
        const deps = makeDeps({
            deleteList: async (_listId, hold) =>
                void holds.push(['delete', hold.slug, hold.ownerProjectId, hold.releasedAt]),
            recordSlugHold: async (slug, owner, at) => void holds.push(['rename', slug, owner, at]),
        });
        await deleteList(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core' });
        await updateList(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core', newSlug: 'renamed-core' });
        expect(holds).toEqual([
            ['delete', 'ownership-core', 'proj_1', FIXED_NOW],
            ['rename', 'ownership-core', 'proj_1', FIXED_NOW],
        ]);
    });

    it('blocks renaming onto a slug held for another project', async () => {
        const deps = makeDeps({ getSlugHold: async () => HOLD });
        expect(
            await updateList(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core', newSlug: 'freed-slug' }),
        ).toEqual({ ok: false, error: 'slug_held' });
    });
});

describe('text caps and rank validation', () => {
    it('rejects oversized name/note', async () => {
        await expect(
            createList(makeDeps(), { ownerProjectId: 'p', slug: 'ok-slug', name: 'x'.repeat(81) }),
        ).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(
            upsertMember(makeDeps(), {
                ownerProjectId: 'proj_1',
                slug: 'ownership-core',
                mint: USDC_MINT,
                note: 'n'.repeat(501),
            }),
        ).rejects.toBeInstanceOf(InvalidArgsError);
    });

    it('rejects non-finite and overflowing ranks', async () => {
        for (const rank of [Number.POSITIVE_INFINITY, Number.NaN, 2_147_483_648]) {
            await expect(
                upsertMember(makeDeps(), {
                    ownerProjectId: 'proj_1',
                    slug: 'ownership-core',
                    mint: USDC_MINT,
                    rank,
                }),
            ).rejects.toBeInstanceOf(InvalidArgsError);
        }
    });
});

describe('lists-per-project cap', () => {
    it('refuses creation once the project owns caps.listsPerProject lists', async () => {
        const deps = makeDeps({ countListsByOwner: async () => 100 });
        expect(await createList(deps, { ownerProjectId: 'proj_1', slug: 'one-more', name: 'X' })).toEqual({
            ok: false,
            error: 'project_lists_limit',
        });
        const under = makeDeps({ countListsByOwner: async () => 99 });
        expect(await createList(under, { ownerProjectId: 'proj_1', slug: 'one-more', name: 'X' })).toMatchObject({
            ok: true,
        });
    });
});

describe('withOverviewMissCache', () => {
    it('serves misses from the cache within the TTL and retries after it', async () => {
        let calls = 0;
        let clock = 0;
        const fetch = withOverviewMissCache(
            async () => {
                calls += 1;
                return null;
            },
            { ttlMs: 1000, now: () => clock },
        );
        expect(await fetch('MintA')).toBeNull();
        expect(await fetch('MintA')).toBeNull();
        expect(calls).toBe(1);
        clock = 1001;
        expect(await fetch('MintA')).toBeNull();
        expect(calls).toBe(2);
    });

    it('does not cache hits and evicts FIFO past maxEntries', async () => {
        let calls = 0;
        const fetch = withOverviewMissCache(
            async mint => {
                calls += 1;
                return mint === 'Known' ? ({ symbol: 'K' } as never) : null;
            },
            { maxEntries: 1 },
        );
        await fetch('Known');
        await fetch('Known');
        expect(calls).toBe(2);
        await fetch('MissA');
        await fetch('MissB'); // evicts MissA
        await fetch('MissA'); // refetches
        expect(calls).toBe(5);
    });
});

describe('bulk cap reconciliation', () => {
    it('moves txn-detected overflow mints from added to failed', async () => {
        const deps = makeDeps({
            upsertMembersBulk: async () => ({ overflowMints: [MEME_MINT] }),
        });
        const result = await addMembersBatch(deps, {
            ownerProjectId: 'proj_1',
            slug: 'ownership-core',
            mints: [USDC_MINT, MEME_MINT],
        });
        expect(result).toMatchObject({
            ok: true,
            value: {
                added: [{ mint: USDC_MINT }],
                failed: [{ mint: MEME_MINT, error: 'list_full' }],
            },
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

function uniqueMints(count: number, prefix = 'M'): string[] {
    // Base58 excludes 0, O, I, l — encode the index with safe letters only.
    return Array.from({ length: count }, (_, i) => {
        const tag = String(i)
            .split('')
            .map(digit => 'ABCDEFGHJK'[Number(digit)])
            .join('');
        return `${prefix}${tag}`.padEnd(40, 'z');
    });
}

describe('addMembersBatch', () => {
    it('caps the batch size at caps.batch', async () => {
        const mints = uniqueMints(DEFAULT_TOKEN_LIST_CAPS.batch + 1);
        expect(await addMembersBatch(makeDeps(), { ownerProjectId: 'proj_1', slug: 'ownership-core', mints })).toEqual({
            ok: false,
            error: 'batch_too_large',
        });
    });

    it('partitions per-mint successes and failures via batched resolution', async () => {
        const deps = makeDeps({
            filterMintsWithActiveVariants: async mints => mints.filter(mint => mint === USDC_MINT),
            filterMintsKnownTokens: async () => [],
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
                    { mint: 'garbage', error: 'invalid_mint' },
                    { mint: MEME_MINT, error: 'unknown_mint' },
                ],
            },
        });
    });

    it('writes through the bulk upsert, not the per-mint path', async () => {
        const bulkCalls: number[] = [];
        let singleCalls = 0;
        const deps = makeDeps({
            upsertMembersBulk: async (_listId, rows) => {
                bulkCalls.push(rows.length);
                return { overflowMints: [] };
            },
            upsertMember: async () => {
                singleCalls += 1;
                return true;
            },
        });
        await addMembersBatch(deps, {
            ownerProjectId: 'proj_1',
            slug: 'ownership-core',
            mints: uniqueMints(3),
        });
        expect(bulkCalls).toEqual([3]);
        expect(singleCalls).toBe(0);
    });

    it('spends at most caps.providerLookups on Birdeye and fails the rest as unknown_mint', async () => {
        let lookups = 0;
        const deps = makeDeps(
            {
                // Nothing resolves locally — every mint is a provider candidate.
                filterMintsWithActiveVariants: async () => [],
                filterMintsKnownTokens: async () => [],
            },
            {
                fetchTokenOverview: async () => {
                    lookups += 1;
                    return { symbol: 'X', name: 'X Token', decimals: 6 };
                },
                caps: { ...DEFAULT_TOKEN_LIST_CAPS, providerLookups: 5 },
            },
        );
        const result = await addMembersBatch(deps, {
            ownerProjectId: 'proj_1',
            slug: 'ownership-core',
            mints: uniqueMints(8),
        });
        expect(lookups).toBe(5);
        if (!result.ok) throw new Error('expected ok');
        expect(result.value.added.length).toBe(5);
        expect(result.value.failed.filter(f => f.error === 'unknown_mint').length).toBe(3);
    });

    it('fails net-new mints beyond the members-per-list cap with list_full, updates stay free', async () => {
        const mints = uniqueMints(4);
        const existing = mints[0] as string;
        const deps = makeDeps(
            {
                countMembers: async () => 4999,
                filterMintsExistingMembers: async () => [existing],
            },
            { caps: { ...DEFAULT_TOKEN_LIST_CAPS, membersPerList: 5000 } },
        );
        const result = await addMembersBatch(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core', mints });
        if (!result.ok) throw new Error('expected ok');
        // 1 update (existing) + 1 new fills the last slot; 2 overflow.
        expect(result.value.added.map(m => m.mint)).toEqual([mints[0], mints[1]]);
        expect(result.value.failed).toEqual([
            { mint: mints[2], error: 'list_full' },
            { mint: mints[3], error: 'list_full' },
        ]);
    });
});

describe('upsertMember list_full', () => {
    it('surfaces the repo cap verdict (enforced under the list lock) and passes the cap through', async () => {
        const caps: number[] = [];
        const fullDeps = makeDeps({
            upsertMember: async args => {
                caps.push(args.membersPerListCap);
                return false;
            },
        });
        expect(
            await upsertMember(fullDeps, { ownerProjectId: 'proj_1', slug: 'ownership-core', mint: USDC_MINT }),
        ).toEqual({ ok: false, error: 'list_full' });
        expect(caps).toEqual([5000]);

        const updateDeps = makeDeps({ upsertMember: async () => true });
        expect(
            await upsertMember(updateDeps, { ownerProjectId: 'proj_1', slug: 'ownership-core', mint: USDC_MINT }),
        ).toMatchObject({ ok: true });
    });
});

describe('addMembersBatch members shape', () => {
    it('accepts members with notes and keeps request order', async () => {
        let bulk: unknown = null;
        const deps = makeDeps({
            upsertMembersBulk: async (_listId, rows) => {
                bulk = rows;
                return { overflowMints: [] };
            },
        });
        const result = await addMembersBatch(deps, {
            ownerProjectId: 'proj_1',
            slug: 'ownership-core',
            members: [{ mint: MEME_MINT, note: 'wrapped SOL' }, { mint: USDC_MINT }],
        });
        expect(result).toMatchObject({ ok: true, value: { failed: [] } });
        expect((bulk as Array<{ mint: string; note: string | null }>).map(r => [r.mint, r.note])).toEqual([
            [MEME_MINT, 'wrapped SOL'],
            [USDC_MINT, null],
        ]);
    });

    it('requires one of mints or members and validates member rows', async () => {
        const deps = makeDeps();
        await expect(
            addMembersBatch(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core' }),
        ).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(
            addMembersBatch(deps, { ownerProjectId: 'proj_1', slug: 'ownership-core', members: [{ mint: 1 }] }),
        ).rejects.toBeInstanceOf(InvalidArgsError);
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
