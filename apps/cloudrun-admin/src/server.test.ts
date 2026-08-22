import { describe, expect, it } from 'bun:test';

import type { AdminRepo, CategorySummary, CuratedCategorySlug } from './handlers/curatedTokens';
import type { AdminMutationsRepo } from './handlers/curatedTokensMutations';
import type { AdminReadsRepo } from './handlers/curatedTokensReads';
import type { HardDeleteRepo } from './handlers/hardDelete';
import { createApp, decodeIdentityHeader, IDENTITY_HEADER, type ServerDeps } from './server';

const ADMIN_ID = 'admin_1';

function identityHeader(clerkUserId: string): string {
    return Buffer.from(JSON.stringify({ clerkUserId }), 'utf8').toString('base64');
}

function makeCategoriesRepo(summaries: CategorySummary[]): AdminRepo {
    return {
        listCategorySummaries: async (slugs: readonly CuratedCategorySlug[]) =>
            summaries.filter(s => slugs.includes(s.id)),
    };
}

function makeReadsRepo(): AdminReadsRepo {
    return {
        listAssets: async () => [],
        listAllVariantsWithMarkets: async () => [],
        listVariantsWithMarketsByAssetIds: async () => [],
        listCustomAliases: async () => [],
        listCustomAliasesByAssetId: async () => [],
        listCollectionMembers: async () => [],
        getAssetByAssetId: async () => null,
        getVariantByMint: async () => null,
        getMarketByMint: async () => null,
        searchAssets: async () => [],
    };
}

function makeMutationsRepo(): AdminMutationsRepo {
    return {
        createCanonicalAsset: async () => 'created',
        updateCanonicalAsset: async () => 'updated',
        deleteCanonicalAsset: async () => 'deleted',
        createVariant: async () => ({ status: 'created' }),
        updateVariant: async () => 'updated',
        deleteVariant: async () => 'deleted',
        deactivateVariant: async () => 'updated',
        moveVariantToCanonical: async () => ({ status: 'moved', fromAssetId: 'old' }),
        removeFromCategory: async () => true,
    };
}

function makeHardDeleteRepo(): HardDeleteRepo {
    return { hardDeleteAsset: async () => null };
}

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
    return {
        repo: makeCategoriesRepo([]),
        reads: makeReadsRepo(),
        mutations: makeMutationsRepo(),
        hardDelete: makeHardDeleteRepo(),
        tokenListsAdmin: { listAll: async () => [], archiveBySlug: async () => false },
        adminAllowlist: { clerkUserIds: new Set([ADMIN_ID]), emails: new Set<string>() },
        authToken: 'tok',
        ...overrides,
    };
}

async function call(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
    return app.fetch(new Request(`http://test${path}`, init));
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        authorization: 'Bearer tok',
        'content-type': 'application/json',
        [IDENTITY_HEADER]: identityHeader(ADMIN_ID),
        ...extra,
    };
}

describe('decodeIdentityHeader', () => {
    it('decodes a base64 JSON identity and trims fields', () => {
        const raw = Buffer.from(JSON.stringify({ clerkUserId: ' user_1 ', email: 'a@b.co' })).toString('base64');
        expect(decodeIdentityHeader(raw)).toEqual({ clerkUserId: 'user_1', email: 'a@b.co' });
    });

    it('returns null for missing/garbage headers', () => {
        expect(decodeIdentityHeader(undefined)).toBeNull();
        expect(decodeIdentityHeader('not-base64-json')).toBeNull();
        expect(decodeIdentityHeader(Buffer.from('{}').toString('base64'))).toBeNull();
    });
});

describe('createApp', () => {
    it('GET /health returns 200 without auth', async () => {
        const app = createApp(makeDeps());
        const res = await call(app, '/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('rejects missing/wrong bearer with 401 on both dispatchers', async () => {
        const app = createApp(makeDeps());
        for (const path of ['/query/listCategories', '/mutation/removeFromCategory']) {
            const noAuth = await call(app, path, { method: 'POST', body: '{}' });
            expect(noAuth.status).toBe(401);
            const wrongAuth = await call(app, path, {
                method: 'POST',
                headers: { authorization: 'Bearer nope' },
                body: '{}',
            });
            expect(wrongAuth.status).toBe(401);
        }
    });

    it('returns 401 identity_required when no identity header is forwarded', async () => {
        const app = createApp(makeDeps());
        const res = await call(app, '/query/listCategories', {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: '{}',
        });
        expect(res.status).toBe(401);
        expect(((await res.json()) as { error: string }).error).toBe('identity_required');
    });

    it('returns 403 unauthorized for a non-admin identity', async () => {
        const app = createApp(makeDeps());
        const res = await call(app, '/query/listCategories', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                [IDENTITY_HEADER]: identityHeader('user_9'),
            },
            body: '{}',
        });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
    });

    it('enforces admin identity on every registered query and mutation', async () => {
        const app = createApp(makeDeps());
        const endpoints = [
            '/query/listCategories',
            '/query/listCanonicalAssets',
            '/query/listVariantsByAssetIds',
            '/query/getCanonicalEditor',
            '/query/getVariantEditor',
            '/query/searchCanonicalAssets',
            '/query/previewMint',
            '/mutation/createCanonicalAsset',
            '/mutation/updateCanonicalAsset',
            '/mutation/deleteCanonicalAsset',
            '/mutation/createVariant',
            '/mutation/updateVariant',
            '/mutation/deleteVariant',
            '/mutation/deactivateVariant',
            '/mutation/moveVariantToCanonical',
            '/mutation/removeFromCategory',
            '/mutation/hardDeleteAsset',
        ];
        for (const path of endpoints) {
            const noIdentity = await call(app, path, {
                method: 'POST',
                headers: { authorization: 'Bearer tok' },
                body: '{}',
            });
            expect(noIdentity.status).toBe(401);
            const nonAdmin = await call(app, path, {
                method: 'POST',
                headers: { authorization: 'Bearer tok', [IDENTITY_HEADER]: identityHeader('user_9') },
                body: '{}',
            });
            expect(nonAdmin.status).toBe(403);
        }
    });

    it('POST /query/listCategories returns one summary per slug for an admin caller', async () => {
        const app = createApp(
            makeDeps({
                repo: makeCategoriesRepo([
                    { id: 'majors', name: 'Top Majors', count: 7, lastAddedAssetId: 'jup' },
                    { id: 'stocks', name: '', count: 0, lastAddedAssetId: null },
                ]),
            }),
        );
        const res = await call(app, '/query/listCategories', {
            method: 'POST',
            headers: adminHeaders(),
            body: '{}',
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([
            { id: 'majors', name: 'Top Majors', count: 7, lastAddedAssetId: 'jup' },
            { id: 'currencies', name: 'Currencies', count: 0, lastAddedAssetId: null },
            { id: 'rwas', name: 'RWAs', count: 0, lastAddedAssetId: null },
            { id: 'etfs', name: 'ETFs', count: 0, lastAddedAssetId: null },
            { id: 'metals', name: 'Metals', count: 0, lastAddedAssetId: null },
            { id: 'stocks', name: 'Stocks', count: 0, lastAddedAssetId: null },
        ]);
    });

    it('dispatches admin mutations and maps Convex-parity errors to 400', async () => {
        const app = createApp(makeDeps());
        const ok = await call(app, '/mutation/removeFromCategory', {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify({ slug: 'majors', assetId: 'bitcoin' }),
        });
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ removed: true });

        // hardDeleteAsset repo returns null → InvalidArgsError('Asset not found') → 400.
        const missing = await call(app, '/mutation/hardDeleteAsset', {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify({ assetId: 'ghost' }),
        });
        expect(missing.status).toBe(400);
        expect(await missing.json()).toEqual({ error: 'invalid_args', message: 'Asset not found' });
    });

    it('returns 400 invalid_args for non-object args', async () => {
        const app = createApp(makeDeps());
        for (const body of ['"oops"', '42', '[1,2,3]']) {
            const res = await call(app, '/query/listCategories', {
                method: 'POST',
                headers: adminHeaders(),
                body,
            });
            expect(res.status).toBe(400);
            expect(((await res.json()) as { error: string }).error).toBe('invalid_args');
        }
    });

    it('returns 400 invalid_json on a malformed body', async () => {
        const app = createApp(makeDeps());
        const res = await call(app, '/query/listCategories', {
            method: 'POST',
            headers: adminHeaders(),
            body: '{not-json',
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('invalid_json');
    });

    it('accepts an empty body and defaults args to {}', async () => {
        const app = createApp(makeDeps());
        const res = await call(app, '/query/listCategories', {
            method: 'POST',
            headers: adminHeaders(),
        });
        expect(res.status).toBe(200);
    });

    it('returns 404 for unknown and prototype-named handlers', async () => {
        const app = createApp(makeDeps());
        for (const name of ['doesNotExist', 'constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
            const res = await call(app, `/query/${name}`, {
                method: 'POST',
                headers: adminHeaders(),
                body: '{}',
            });
            expect(res.status).toBe(404);
        }
    });

    it('hides handler-thrown DB error details behind handler_error', async () => {
        const failingRepo: AdminRepo = {
            listCategorySummaries: async () => {
                throw new Error('relation "asset_collection_members" does not exist on host db-internal');
            },
        };
        const app = createApp(makeDeps({ repo: failingRepo }));
        const res = await call(app, '/query/listCategories', {
            method: 'POST',
            headers: adminHeaders(),
            body: '{}',
        });
        expect(res.status).toBe(500);
        const payload = (await res.json()) as { error: string; message?: string };
        expect(payload.error).toBe('handler_error');
        expect(payload.message).toBeUndefined();
    });
});
