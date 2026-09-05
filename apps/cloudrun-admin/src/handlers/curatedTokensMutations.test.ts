import { describe, expect, it } from 'bun:test';

import {
    ALIAS_PRIORITIES,
    createCanonicalAsset,
    createVariant,
    deactivateVariant,
    deleteCanonicalAsset,
    deleteVariant,
    moveVariantToCanonical,
    removeFromCategory,
    updateCanonicalAsset,
    updateCollectionMeta,
    updateVariant,
    type AdminMutationsDeps,
    type AdminMutationsRepo,
    type CreateVariantOutcome,
    type MoveVariantOutcome,
} from './curatedTokensMutations';
import { IdentityRequiredError, InvalidArgsError, UnauthorizedError } from './errors';

const ADMIN = { clerkUserId: 'admin_1' };
const ADMIN_IDS: ReadonlySet<string> = new Set(['admin_1']);
const NOW = 1_750_000_000_000;
const MINT = 'So11111111111111111111111111111111111111112';

interface RepoState {
    createAsset?: 'created' | 'exists';
    updateAsset?: 'updated' | 'not_found';
    deleteAsset?: 'deleted' | 'not_found' | 'has_variants';
    createVariant?: CreateVariantOutcome;
    updateVariant?: 'updated' | 'not_found' | 'variant_id_collision';
    deleteVariant?: 'deleted' | 'not_found';
    deactivateVariant?: 'updated' | 'not_found';
    moveVariant?: MoveVariantOutcome;
    removeFromCategory?: boolean;
}

function makeDeps(state: RepoState = {}): { deps: AdminMutationsDeps; calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = {};
    const track = (name: string, args: unknown) => {
        (calls[name] ??= []).push(args);
    };
    const repo: AdminMutationsRepo = {
        createCanonicalAsset: async args => {
            track('createCanonicalAsset', args);
            return state.createAsset ?? 'created';
        },
        updateCanonicalAsset: async args => {
            track('updateCanonicalAsset', args);
            return state.updateAsset ?? 'updated';
        },
        deleteCanonicalAsset: async args => {
            track('deleteCanonicalAsset', args);
            return state.deleteAsset ?? 'deleted';
        },
        createVariant: async args => {
            track('createVariant', args);
            return state.createVariant ?? { status: 'created' };
        },
        updateVariant: async args => {
            track('updateVariant', args);
            return state.updateVariant ?? 'updated';
        },
        deleteVariant: async args => {
            track('deleteVariant', args);
            return state.deleteVariant ?? 'deleted';
        },
        deactivateVariant: async args => {
            track('deactivateVariant', args);
            return state.deactivateVariant ?? 'updated';
        },
        moveVariantToCanonical: async args => {
            track('moveVariantToCanonical', args);
            return state.moveVariant ?? { status: 'moved', fromAssetId: 'old-asset' };
        },
        removeFromCategory: async args => {
            track('removeFromCategory', args);
            return state.removeFromCategory ?? true;
        },
        updateCollectionMeta: async args => {
            track('updateCollectionMeta', args);
        },
    };
    return { deps: { repo, adminAllowlist: { clerkUserIds: ADMIN_IDS, emails: new Set<string>() }, now: () => NOW }, calls };
}

describe('authz (mutations)', () => {
    const handlers: Array<[string, (deps: AdminMutationsDeps, args: unknown, identity: { clerkUserId: string } | null) => Promise<unknown>, unknown]> = [
        ['createCanonicalAsset', createCanonicalAsset, { assetId: 'a', category: 'crypto' }],
        ['updateCanonicalAsset', updateCanonicalAsset, { assetId: 'a' }],
        ['deleteCanonicalAsset', deleteCanonicalAsset, { assetId: 'a' }],
        ['createVariant', createVariant, { assetId: 'a', mint: MINT, variantId: 'v', kind: 'native', trustTier: 'tier1', tags: [] }],
        ['updateVariant', updateVariant, { mint: MINT }],
        ['deleteVariant', deleteVariant, { mint: MINT }],
        ['deactivateVariant', deactivateVariant, { mint: MINT }],
        ['moveVariantToCanonical', moveVariantToCanonical, { mint: MINT, assetId: 'a' }],
        ['removeFromCategory', removeFromCategory, { slug: 'majors', assetId: 'a' }],
        ['updateCollectionMeta', updateCollectionMeta, { slug: 'majors', title: 'Crypto' }],
    ];

    for (const [name, handler, args] of handlers) {
        it(`${name} rejects missing identity and non-admin callers`, async () => {
            const { deps, calls } = makeDeps();
            await expect(handler(deps, args, null)).rejects.toBeInstanceOf(IdentityRequiredError);
            await expect(handler(deps, args, { clerkUserId: 'user_9' })).rejects.toBeInstanceOf(UnauthorizedError);
            expect(Object.keys(calls)).toEqual([]);
        });
    }
});

describe('alias priorities', () => {
    it('mirror the Convex replaceAliasesForKind call sites', () => {
        expect(ALIAS_PRIORITIES).toEqual({ name: 900, symbol: 800, coingeckoId: 700, custom: 500 });
    });
});

describe('createCanonicalAsset', () => {
    it('normalizes text fields and dedupes aliases before writing', async () => {
        const { deps, calls } = makeDeps();
        const result = await createCanonicalAsset(
            deps,
            {
                assetId: ' bitcoin ',
                category: 'crypto',
                name: ' Bitcoin ',
                symbol: '',
                coingeckoId: null,
                imageUrl: ' https://img/x.png ',
                aliases: [' BTC ', 'BTC', '', 'digital gold'],
                collections: ['majors'],
            },
            ADMIN,
        );
        expect(result).toEqual({ assetId: 'bitcoin', created: true });
        expect(calls.createCanonicalAsset?.[0]).toEqual({
            assetId: 'bitcoin',
            category: 'crypto',
            name: 'Bitcoin',
            symbol: null,
            coingeckoId: null,
            description: null,
            imageUrl: 'https://img/x.png',
            aliases: ['BTC', 'digital gold'],
            collections: ['majors'],
            nowMs: NOW,
        });
    });

    it('maps repo outcomes to the Convex error messages', async () => {
        const { deps } = makeDeps({ createAsset: 'exists' });
        await expect(
            createCanonicalAsset(deps, { assetId: 'bitcoin', category: 'crypto' }, ADMIN),
        ).rejects.toThrow('Canonical asset already exists');
        await expect(createCanonicalAsset(deps, { assetId: ' ', category: 'crypto' }, ADMIN)).rejects.toThrow(
            'assetId is required',
        );
        await expect(
            createCanonicalAsset(deps, { assetId: 'x', category: 'nope' }, ADMIN),
        ).rejects.toBeInstanceOf(InvalidArgsError);
    });
});

describe('updateCanonicalAsset', () => {
    it('passes tri-state fields: omitted keys stay omitted, blank strings clear', async () => {
        const { deps, calls } = makeDeps();
        await updateCanonicalAsset(deps, { assetId: 'bitcoin', name: '  ', symbol: ' BTC ' }, ADMIN);
        const args = calls.updateCanonicalAsset?.[0] as Record<string, unknown>;
        expect(args.name).toBeNull(); // provided-but-blank clears
        expect(args.symbol).toBe('BTC');
        expect('coingeckoId' in args).toBe(false); // omitted stays omitted
        expect('description' in args).toBe(false);
        expect('aliases' in args).toBe(false);
        expect('collections' in args).toBe(false);
        expect(args.clearImage).toBe(false);
    });

    it('forwards clearImage, collections and deduped aliases', async () => {
        const { deps, calls } = makeDeps();
        await updateCanonicalAsset(
            deps,
            { assetId: 'bitcoin', clearImage: true, aliases: ['a', 'a', ' b '], collections: ['stocks', 'metals'] },
            ADMIN,
        );
        const args = calls.updateCanonicalAsset?.[0] as Record<string, unknown>;
        expect(args.clearImage).toBe(true);
        expect(args.aliases).toEqual(['a', 'b']);
        expect(args.collections).toEqual(['stocks', 'metals']);
    });

    it('maps not_found to the Convex message', async () => {
        const { deps } = makeDeps({ updateAsset: 'not_found' });
        await expect(updateCanonicalAsset(deps, { assetId: 'ghost' }, ADMIN)).rejects.toThrow(
            'Canonical asset not found',
        );
    });
});

describe('deleteCanonicalAsset', () => {
    it('maps outcomes to the Convex error messages', async () => {
        const notFound = makeDeps({ deleteAsset: 'not_found' });
        await expect(deleteCanonicalAsset(notFound.deps, { assetId: 'ghost' }, ADMIN)).rejects.toThrow(
            'Canonical asset not found',
        );
        const hasVariants = makeDeps({ deleteAsset: 'has_variants' });
        await expect(deleteCanonicalAsset(hasVariants.deps, { assetId: 'bitcoin' }, ADMIN)).rejects.toThrow(
            'Cannot delete a canonical asset while variants still exist',
        );
        const ok = makeDeps();
        expect(await deleteCanonicalAsset(ok.deps, { assetId: 'bitcoin' }, ADMIN)).toEqual({
            assetId: 'bitcoin',
            deleted: true,
        });
    });
});

describe('createVariant', () => {
    const BASE = { assetId: 'bitcoin', mint: MINT, variantId: 'bitcoin:wbtc', kind: 'wrapped', trustTier: 'tier2', tags: [' a ', 'a', 'b'] };

    it('validates the mint address and required ids with Convex messages', async () => {
        const { deps } = makeDeps();
        await expect(createVariant(deps, { ...BASE, mint: 'nope' }, ADMIN)).rejects.toThrow(
            'Not a valid Solana mint address',
        );
        await expect(createVariant(deps, { ...BASE, assetId: ' ' }, ADMIN)).rejects.toThrow('assetId is required');
        await expect(createVariant(deps, { ...BASE, variantId: ' ' }, ADMIN)).rejects.toThrow('variantId is required');
    });

    it('dedupes tags, defaults isActive, and only forwards provided market fields', async () => {
        const { deps, calls } = makeDeps();
        const result = await createVariant(deps, { ...BASE, marketSymbol: ' WBTC ' }, ADMIN);
        expect(result).toEqual({ assetId: 'bitcoin', mint: MINT, created: true });
        expect(calls.createVariant?.[0]).toEqual({
            assetId: 'bitcoin',
            mint: MINT,
            variantId: 'bitcoin:wbtc',
            kind: 'wrapped',
            trustTier: 'tier2',
            tags: ['a', 'b'],
            label: null,
            issuer: null,
            issuerUrl: null,
            stockVariantTier: null,
            isActive: true,
            marketSymbol: 'WBTC',
            nowMs: NOW,
        });
    });

    it('maps collision outcomes to the Convex messages', async () => {
        const mintExists = makeDeps({ createVariant: { status: 'mint_exists', ownerAssetId: 'ethereum' } });
        await expect(createVariant(mintExists.deps, BASE, ADMIN)).rejects.toThrow(
            'Mint already belongs to ethereum',
        );
        const variantExists = makeDeps({ createVariant: { status: 'variant_id_exists' } });
        await expect(createVariant(variantExists.deps, BASE, ADMIN)).rejects.toThrow(
            'variantId already exists for this canonical asset',
        );
        const noAsset = makeDeps({ createVariant: { status: 'asset_not_found' } });
        await expect(createVariant(noAsset.deps, BASE, ADMIN)).rejects.toThrow('Canonical asset not found');
    });
});

describe('updateVariant', () => {
    it('rejects a blank variantId with the Convex message', async () => {
        const { deps } = makeDeps();
        await expect(updateVariant(deps, { mint: MINT, variantId: '  ' }, ADMIN)).rejects.toThrow(
            'variantId is required',
        );
        await expect(updateVariant(deps, { mint: '  ' }, ADMIN)).rejects.toThrow('mint is required');
    });

    it('maps not_found / collision to the Convex messages', async () => {
        const notFound = makeDeps({ updateVariant: 'not_found' });
        await expect(updateVariant(notFound.deps, { mint: MINT }, ADMIN)).rejects.toThrow('Variant not found');
        const collision = makeDeps({ updateVariant: 'variant_id_collision' });
        await expect(updateVariant(collision.deps, { mint: MINT, variantId: 'dup' }, ADMIN)).rejects.toThrow(
            'variantId already exists for this canonical asset',
        );
    });

    it('forwards tri-state fields (null clears, omitted untouched)', async () => {
        const { deps, calls } = makeDeps();
        await updateVariant(deps, { mint: MINT, label: null, marketLogoURI: '', stockVariantTier: null, tags: ['x', 'x'] }, ADMIN);
        const args = calls.updateVariant?.[0] as Record<string, unknown>;
        expect(args.label).toBeNull();
        expect(args.marketLogoURI).toBeNull();
        expect(args.stockVariantTier).toBeNull();
        expect(args.tags).toEqual(['x']);
        expect('issuer' in args).toBe(false);
        expect('marketSymbol' in args).toBe(false);
        expect('isActive' in args).toBe(false);
    });
});

describe('deleteVariant / deactivateVariant', () => {
    it('deleteVariant maps not_found and returns Convex shape', async () => {
        const notFound = makeDeps({ deleteVariant: 'not_found' });
        await expect(deleteVariant(notFound.deps, { mint: MINT }, ADMIN)).rejects.toThrow('Variant not found');
        const ok = makeDeps();
        expect(await deleteVariant(ok.deps, { mint: ` ${MINT} ` }, ADMIN)).toEqual({ mint: MINT, deleted: true });
    });

    it('deactivateVariant defaults isActive to false', async () => {
        const { deps, calls } = makeDeps();
        expect(await deactivateVariant(deps, { mint: MINT }, ADMIN)).toEqual({
            mint: MINT,
            isActive: false,
            updated: true,
        });
        expect(calls.deactivateVariant?.[0]).toEqual({ mint: MINT, isActive: false, nowMs: NOW });
        expect(await deactivateVariant(deps, { mint: MINT, isActive: true }, ADMIN)).toEqual({
            mint: MINT,
            isActive: true,
            updated: true,
        });
    });
});

describe('moveVariantToCanonical', () => {
    it('maps outcomes to Convex messages and shapes', async () => {
        const moved = makeDeps({ moveVariant: { status: 'moved', fromAssetId: 'ethereum' } });
        expect(await moveVariantToCanonical(moved.deps, { mint: MINT, assetId: 'bitcoin' }, ADMIN)).toEqual({
            mint: MINT,
            fromAssetId: 'ethereum',
            toAssetId: 'bitcoin',
            moved: true,
        });

        const noop = makeDeps({ moveVariant: { status: 'noop', fromAssetId: 'bitcoin' } });
        expect(await moveVariantToCanonical(noop.deps, { mint: MINT, assetId: 'bitcoin' }, ADMIN)).toEqual({
            mint: MINT,
            fromAssetId: 'bitcoin',
            toAssetId: 'bitcoin',
            moved: false,
        });

        const noVariant = makeDeps({ moveVariant: { status: 'variant_not_found' } });
        await expect(moveVariantToCanonical(noVariant.deps, { mint: MINT, assetId: 'x' }, ADMIN)).rejects.toThrow(
            'Variant not found',
        );
        const noAsset = makeDeps({ moveVariant: { status: 'asset_not_found' } });
        await expect(moveVariantToCanonical(noAsset.deps, { mint: MINT, assetId: 'x' }, ADMIN)).rejects.toThrow(
            'Destination canonical asset not found',
        );
        const collision = makeDeps({ moveVariant: { status: 'variant_id_collision' } });
        await expect(moveVariantToCanonical(collision.deps, { mint: MINT, assetId: 'x' }, ADMIN)).rejects.toThrow(
            'Destination canonical already has this variantId',
        );
    });
});

describe('removeFromCategory', () => {
    it('returns removed:false for a blank assetId without hitting the repo', async () => {
        const { deps, calls } = makeDeps();
        expect(await removeFromCategory(deps, { slug: 'majors', assetId: '  ' }, ADMIN)).toEqual({ removed: false });
        expect(calls.removeFromCategory).toBeUndefined();
    });

    it('rejects unknown slugs', async () => {
        const { deps } = makeDeps();
        await expect(removeFromCategory(deps, { slug: 'lsts', assetId: 'x' }, ADMIN)).rejects.toBeInstanceOf(
            InvalidArgsError,
        );
    });

    it('forwards the delete result', async () => {
        const removedDeps = makeDeps({ removeFromCategory: true });
        expect(await removeFromCategory(removedDeps.deps, { slug: 'stocks', assetId: ' tsla ' }, ADMIN)).toEqual({
            removed: true,
        });
        expect(removedDeps.calls.removeFromCategory?.[0]).toEqual({ slug: 'stocks', assetId: 'tsla' });
        const missing = makeDeps({ removeFromCategory: false });
        expect(await removeFromCategory(missing.deps, { slug: 'stocks', assetId: 'tsla' }, ADMIN)).toEqual({
            removed: false,
        });
    });
});

describe('updateCollectionMeta', () => {
    it('updates the title only, leaving description untouched', async () => {
        const { deps, calls } = makeDeps();
        expect(await updateCollectionMeta(deps, { slug: 'majors', title: '  Blue Chips  ' }, ADMIN)).toEqual({
            slug: 'majors',
            updated: true,
        });
        expect(calls.updateCollectionMeta?.[0]).toEqual({ slug: 'majors', title: 'Blue Chips', nowMs: NOW });
    });

    it('updates the description only, leaving title untouched', async () => {
        const { deps, calls } = makeDeps();
        await updateCollectionMeta(deps, { slug: 'stocks', description: ' Tokenized equities. ' }, ADMIN);
        expect(calls.updateCollectionMeta?.[0]).toEqual({
            slug: 'stocks',
            description: 'Tokenized equities.',
            nowMs: NOW,
        });
    });

    it('clears the description when passed an empty string', async () => {
        const { deps, calls } = makeDeps();
        await updateCollectionMeta(deps, { slug: 'metals', description: '   ' }, ADMIN);
        expect(calls.updateCollectionMeta?.[0]).toEqual({ slug: 'metals', description: null, nowMs: NOW });
    });

    it('accepts lsts: membership is Sanctum-driven but the title is editable text', async () => {
        const { deps, calls } = makeDeps();
        await updateCollectionMeta(deps, { slug: 'lsts', title: 'Staking' }, ADMIN);
        expect(calls.updateCollectionMeta?.[0]).toEqual({ slug: 'lsts', title: 'Staking', nowMs: NOW });
    });

    it('rejects unknown slugs, empty titles, and over-long values without hitting the repo', async () => {
        const { deps, calls } = makeDeps();
        await expect(updateCollectionMeta(deps, { slug: 'nope', title: 'x' }, ADMIN)).rejects.toBeInstanceOf(
            InvalidArgsError,
        );
        await expect(updateCollectionMeta(deps, { slug: 'majors', title: '   ' }, ADMIN)).rejects.toBeInstanceOf(
            InvalidArgsError,
        );
        await expect(
            updateCollectionMeta(deps, { slug: 'majors', title: 'x'.repeat(81) }, ADMIN),
        ).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(
            updateCollectionMeta(deps, { slug: 'majors', description: 'x'.repeat(301) }, ADMIN),
        ).rejects.toBeInstanceOf(InvalidArgsError);
        expect(calls.updateCollectionMeta).toBeUndefined();
    });

    it('requires at least one editable field', async () => {
        const { deps, calls } = makeDeps();
        await expect(updateCollectionMeta(deps, { slug: 'majors' }, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
        expect(calls.updateCollectionMeta).toBeUndefined();
    });
});
