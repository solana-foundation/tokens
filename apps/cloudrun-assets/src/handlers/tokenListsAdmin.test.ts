import { describe, expect, it } from 'bun:test';

import { IdentityRequiredError, InvalidArgsError, UnauthorizedError } from './assets';
import { adminCreateTokenList, adminImportTokenListMembers, type TokenListsAdminDeps } from './tokenListsAdmin';
import {
    DEFAULT_TOKEN_LIST_CAPS,
    UnknownProjectError,
    type TokenListMutationRow,
    type TokenListsMutationsRepo,
} from './tokenListsMutations';

const FIXED_NOW = 1_780_000_000_000;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const ADMIN = { clerkUserId: 'user_admin' };
const MORTAL = { clerkUserId: 'user_mortal' };

const LIST_ROW: TokenListMutationRow = {
    id: 'tl_1',
    slug: 'ownership-core',
    owner_project_id: 'proj_partner',
    name: 'Ownership Core',
    status: 'published',
    admin_locked_at: null,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
};

function makeDeps(repoOverrides: Partial<TokenListsMutationsRepo> = {}): TokenListsAdminDeps {
    return {
        adminAllowlist: { clerkUserIds: new Set(['user_admin']), emails: new Set<string>() },
        lists: {
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
                filterMintsWithActiveVariants: async mints => [...mints],
                filterMintsKnownTokens: async () => [],
                filterMintsExistingMembers: async () => [],
                countMembers: async () => 0,
                upsertMembersBulk: async () => ({ overflowMints: [] }),
                getSlugHold: async () => null,
                recordSlugHold: async () => {},
                clearSlugHold: async () => {},
                countListsByOwner: async () => 0,
                ...repoOverrides,
            },
            fetchTokenOverview: async () => null,
            now: () => FIXED_NOW,
            caps: { ...DEFAULT_TOKEN_LIST_CAPS },
            slugHoldMs: 30 * 24 * 60 * 60 * 1000,
        },
    };
}

describe('admin gating', () => {
    it('requires an identity and an allowlisted caller on both mutations', async () => {
        const deps = makeDeps();
        const create = { ownerProjectId: 'proj_x', slug: 'x-core', name: 'X' };
        const imp = { slug: 'ownership-core', members: [{ mint: USDC_MINT }] };
        await expect(adminCreateTokenList(deps, create, null)).rejects.toBeInstanceOf(IdentityRequiredError);
        await expect(adminCreateTokenList(deps, create, MORTAL)).rejects.toBeInstanceOf(UnauthorizedError);
        await expect(adminImportTokenListMembers(deps, imp, null)).rejects.toBeInstanceOf(IdentityRequiredError);
        await expect(adminImportTokenListMembers(deps, imp, MORTAL)).rejects.toBeInstanceOf(UnauthorizedError);
    });
});

describe('adminCreateTokenList', () => {
    it('creates under the given owner project, not the caller', async () => {
        const result = await adminCreateTokenList(
            makeDeps(),
            { ownerProjectId: 'proj_partner', slug: 'Partner-Core', name: 'Partner Core' },
            ADMIN,
        );
        expect(result).toMatchObject({
            ok: true,
            value: { slug: 'partner-core', ownerProjectId: 'proj_partner', status: 'published' },
        });
    });

    it('maps a missing project (FK failure) to unknown_project', async () => {
        const deps = makeDeps({
            insertList: async () => {
                throw new UnknownProjectError('proj_nope');
            },
        });
        expect(
            await adminCreateTokenList(deps, { ownerProjectId: 'proj_nope', slug: 'x-core', name: 'X' }, ADMIN),
        ).toEqual({ ok: false, error: 'unknown_project' });
    });

    it('rejects a missing name before touching the repo', async () => {
        await expect(
            adminCreateTokenList(makeDeps(), { ownerProjectId: 'p', slug: 'x-core' }, ADMIN),
        ).rejects.toBeInstanceOf(InvalidArgsError);
    });
});

describe('adminImportTokenListMembers', () => {
    it('imports in CSV order with notes, ignoring list ownership', async () => {
        let bulk: unknown = null;
        const deps = makeDeps({
            upsertMembersBulk: async (_listId, rows) => {
                bulk = rows;
                return { overflowMints: [] };
            },
        });
        const result = await adminImportTokenListMembers(
            deps,
            {
                slug: 'Ownership-Core',
                members: [
                    { mint: WSOL_MINT, note: 'wrapped SOL' },
                    { mint: USDC_MINT },
                    { mint: WSOL_MINT, note: 'duplicate row — first note wins' },
                ],
            },
            ADMIN,
        );
        expect(result).toMatchObject({
            ok: true,
            value: { slug: 'ownership-core', received: 2, failed: [] },
        });
        expect(bulk).toEqual([
            { mint: WSOL_MINT, note: 'wrapped SOL', addedAt: FIXED_NOW, snapshot: null },
            { mint: USDC_MINT, note: null, addedAt: FIXED_NOW, snapshot: null },
        ]);
    });

    it('partitions malformed mints into failed without sinking the batch', async () => {
        const result = await adminImportTokenListMembers(
            makeDeps(),
            { slug: 'ownership-core', members: [{ mint: 'not-a-mint' }, { mint: USDC_MINT }] },
            ADMIN,
        );
        expect(result).toMatchObject({
            ok: true,
            value: {
                received: 2,
                added: [{ mint: USDC_MINT, verified: true }],
                failed: [{ mint: 'not-a-mint', error: 'invalid_mint' }],
            },
        });
    });

    it('reports not_found for an unknown slug and batch_too_large over the cap', async () => {
        const missing = makeDeps({ getListBySlug: async () => null });
        expect(
            await adminImportTokenListMembers(missing, { slug: 'nope', members: [{ mint: USDC_MINT }] }, ADMIN),
        ).toEqual({ ok: false, error: 'not_found' });

        const deps = makeDeps();
        deps.lists.caps.batch = 1;
        expect(
            await adminImportTokenListMembers(
                deps,
                { slug: 'ownership-core', members: [{ mint: USDC_MINT }, { mint: WSOL_MINT }] },
                ADMIN,
            ),
        ).toEqual({ ok: false, error: 'batch_too_large' });
    });

    it('validates the members shape', async () => {
        const deps = makeDeps();
        await expect(
            adminImportTokenListMembers(deps, { slug: 'ownership-core', members: 'nope' }, ADMIN),
        ).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(
            adminImportTokenListMembers(deps, { slug: 'ownership-core', members: [{ mint: 5 }] }, ADMIN),
        ).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(
            adminImportTokenListMembers(
                deps,
                { slug: 'ownership-core', members: [{ mint: USDC_MINT, note: 7 }] },
                ADMIN,
            ),
        ).rejects.toBeInstanceOf(InvalidArgsError);
    });
});
