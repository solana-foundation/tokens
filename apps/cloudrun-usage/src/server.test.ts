import { describe, expect, it } from 'bun:test';
import { IDENTITY_TOKEN_TTL_MS, signIdentityToken } from '@tokens/cloudrun-shutdown/identity';

import type { IdentityRepo } from './handlers/clerkIdentity';
import type { DashboardRepo } from './handlers/dashboard';
import type { PlatformAuthRepo } from './handlers/platformAuth';
import type { UsageDashboardRepo } from './handlers/usageDashboard';
import type { UsageIngestRepo } from './handlers/usageIngest';
import { createApp, decodeIdentityHeader } from './server';

const noopPlatformAuth: PlatformAuthRepo = {
    findApiKeyByHash: async () => null,
    findPersonalProjectId: async () => null,
    getProject: async () => null,
    getApiKeyById: async () => null,
    hasProjectMembership: async () => false,
    insertApiRequestEvent: async () => {},
    bumpApiKeyLastUsedAt: async () => {},
};

const noopUsageIngest: UsageIngestRepo = {
    applyIngestBuckets: async () => {},
    applySyncBuckets: async () => {},
};

export const noopIdentity: IdentityRepo = {
    getUserPrimaryEmail: async () => null,
    listClerkUserIdsByEmail: async () => [],
    getIdentityScoreInputs: async () => ({ memberships: 0, keys: 0, activeKeys: 0 }),
};

const noopDashboard: DashboardRepo = {
    getUserByClerkId: async () => null,
    upsertUser: async () => 'usr_test',
    getMembership: async () => null,
    countMemberships: async () => 0,
    listProjectsForMember: async () => [],
    getProjectDoc: async () => null,
    findProjectIdByCreatorAndName: async () => null,
    findPersonalProjectId: async () => null,
    createProjectWithOwner: async () => 'prj_test',
    ensureMembership: async () => {},
    updateProject: async () => {},
    setProjectRateLimit: async () => null,
    deleteProjectCascade: async () => {},
    listProjectsDigest: async () => [],
    listProjectApiKeys: async () => [],
    getApiKeyById: async () => null,
    getApiKeyByHash: async () => null,
    revokeApiKey: async () => {},
    insertApiKeyRevokingActive: async () => 'key_test',
    listEncryptedApiKeys: async () => [],
    updateApiKeyEncryption: async () => {},
};

const noopUsageDashboard: UsageDashboardRepo = {
    hasProjectMembership: async () => false,
    getProjectLimits: async () => ({ exists: false, limits: null }),
    getRollupCursor: async () => null,
    getDailyRollups: async () => [],
    getEndpointDailyRollups: async () => [],
    getEventsAfterTs: async () => [],
    countActiveKeysUsedSince: async () => 0,
};

async function call(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
    return app.fetch(new Request(`http://test${path}`, init));
}

/** Legacy unsigned header (only accepted while `acceptUnsignedIdentity` is on). */
export function identityHeader(identity: { clerkUserId: string; projectId?: string; email?: string }): string {
    return Buffer.from(JSON.stringify(identity), 'utf8').toString('base64');
}

const SIGNING_SECRET = 'sig-secret';

/** Signed header bound to the RPC and body the test is about to send. */
export function signedIdentityHeader(
    identity: { clerkUserId: string; projectId?: string; email?: string },
    kind: 'query' | 'mutation',
    fn: string,
    body: string,
    opts: { secret?: string; nowMs?: number } = {},
): Promise<string> {
    return signIdentityToken(identity, { kind, fn, body }, opts.secret ?? SIGNING_SECRET, opts.nowMs);
}

function makeApp(
    overrides: {
        platformAuth?: PlatformAuthRepo;
        usageIngest?: UsageIngestRepo;
        dashboard?: DashboardRepo;
        usageDashboard?: UsageDashboardRepo;
        identity?: IdentityRepo;
        apiKeyEncryptionSecret?: string;
        authToken?: string;
        /** Defaults to SIGNING_SECRET; pass null to simulate an unconfigured verifier. */
        identitySigningSecret?: string | null;
        identitySigningSecretPrevious?: string;
        acceptUnsignedIdentity?: boolean;
    } = {},
) {
    const signingSecret = overrides.identitySigningSecret === undefined ? SIGNING_SECRET : overrides.identitySigningSecret;
    return createApp({
        platformAuth: overrides.platformAuth ?? noopPlatformAuth,
        usageIngest: overrides.usageIngest ?? noopUsageIngest,
        dashboard: overrides.dashboard ?? noopDashboard,
        usageDashboard: overrides.usageDashboard ?? noopUsageDashboard,
        identity: overrides.identity ?? noopIdentity,
        ...(overrides.apiKeyEncryptionSecret ? { apiKeyEncryptionSecret: overrides.apiKeyEncryptionSecret } : {}),
        authToken: overrides.authToken ?? 'tok',
        ...(signingSecret ? { identitySigningSecret: signingSecret } : {}),
        ...(overrides.identitySigningSecretPrevious
            ? { identitySigningSecretPrevious: overrides.identitySigningSecretPrevious }
            : {}),
        ...(overrides.acceptUnsignedIdentity ? { acceptUnsignedIdentity: true } : {}),
    });
}

describe('decodeIdentityHeader', () => {
    it('decodes a base64 identity payload', () => {
        const raw = Buffer.from(
            JSON.stringify({ clerkUserId: 'user_1', projectId: 'proj_1', email: 'a@b.co' }),
            'utf8',
        ).toString('base64');
        expect(decodeIdentityHeader(raw)).toEqual({
            clerkUserId: 'user_1',
            projectId: 'proj_1',
            email: 'a@b.co',
        });
    });

    it('returns null for missing, malformed, or identity-less payloads', () => {
        expect(decodeIdentityHeader(undefined)).toBeNull();
        expect(decodeIdentityHeader('!!!not-base64-json')).toBeNull();
        const noUser = Buffer.from(JSON.stringify({ projectId: 'p' }), 'utf8').toString('base64');
        expect(decodeIdentityHeader(noUser)).toBeNull();
    });
});

describe('createApp', () => {
    it('GET /health returns 200', async () => {
        const res = await call(makeApp(), '/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('POST /query/ping returns the echoed args with valid bearer', async () => {
        const res = await call(makeApp(), '/query/ping', {
            method: 'POST',
            headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
            body: JSON.stringify({ hello: 'world' }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, echo: { hello: 'world' } });
    });

    it('POST /query and /mutation reject missing/wrong bearer with 401', async () => {
        const app = makeApp();
        for (const path of ['/query/ping', '/mutation/logApiRequest']) {
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

    it('POST /query/<unknown> and /mutation/<unknown> return 404', async () => {
        const app = makeApp();
        const q = await call(app, '/query/doesNotExist', {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: '{}',
        });
        expect(q.status).toBe(404);
        const m = await call(app, '/mutation/doesNotExist', {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: '{}',
        });
        expect(m.status).toBe(404);
    });

    it('POST /query/<prototype-method> returns 404', async () => {
        const app = makeApp();
        for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
            const res = await call(app, `/query/${name}`, {
                method: 'POST',
                headers: { authorization: 'Bearer tok' },
                body: '{}',
            });
            expect(res.status).toBe(404);
        }
    });

    it('POST /query/apiKeysAuthenticate resolves an active key', async () => {
        const platformAuth: PlatformAuthRepo = {
            ...noopPlatformAuth,
            findApiKeyByHash: async () => ({
                id: 'key_1',
                keyPrefix: 'tk_live_abc',
                projectId: 'proj_1',
                ownerClerkUserId: 'user_1',
                scopes: ['assets:read'],
                revokedAt: null,
            }),
            getProject: async () => ({ limits: null }),
        };
        const res = await call(makeApp({ platformAuth }), '/query/apiKeysAuthenticate', {
            method: 'POST',
            headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
            body: JSON.stringify({ keyHash: 'a'.repeat(64) }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            apiKeyId: 'key_1',
            keyPrefix: 'tk_live_abc',
            projectId: 'proj_1',
            ownerClerkUserId: 'user_1',
            scopes: ['assets:read'],
        });
    });

    it('POST /query/apiKeysAuthenticate returns null for unknown keys', async () => {
        const res = await call(makeApp(), '/query/apiKeysAuthenticate', {
            method: 'POST',
            headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
            body: JSON.stringify({ keyHash: 'a'.repeat(64) }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });

    it('POST /mutation/logApiRequest inserts an event with valid bearer', async () => {
        const events: unknown[] = [];
        const platformAuth: PlatformAuthRepo = {
            ...noopPlatformAuth,
            getApiKeyById: async () => ({
                projectId: 'proj_1',
                ownerClerkUserId: 'user_1',
                revokedAt: null,
                lastUsedAt: null,
            }),
            insertApiRequestEvent: async event => {
                events.push(event);
            },
        };
        const res = await call(makeApp({ platformAuth }), '/mutation/logApiRequest', {
            method: 'POST',
            headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
            body: JSON.stringify({
                projectId: 'proj_1',
                apiKeyId: 'key_1',
                keyPrefix: 'tk_live_abc',
                method: 'GET',
                path: '/api/v1/assets/bonk',
                endpoint: '/api/v1/assets/:assetId',
                status: 200,
                latencyMs: 42,
                ts: 1_750_000_000_000,
            }),
        });
        expect(res.status).toBe(200);
        expect(events).toHaveLength(1);
    });

    it('POST /mutation/logApiRequest with malformed args returns 400', async () => {
        const res = await call(makeApp(), '/mutation/logApiRequest', {
            method: 'POST',
            headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
            body: JSON.stringify({ projectId: 'proj_1' }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('invalid_args');
    });

    it('POST /mutation/ingestUsageAggregates applies buckets', async () => {
        const applied: unknown[] = [];
        const usageIngest: UsageIngestRepo = {
            ...noopUsageIngest,
            applyIngestBuckets: async args => {
                applied.push(args);
            },
        };
        const res = await call(makeApp({ usageIngest }), '/mutation/ingestUsageAggregates', {
            method: 'POST',
            headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
            body: JSON.stringify({
                buckets: [
                    {
                        projectId: 'proj_1',
                        day: '2026-07-01',
                        totalCalls: 10,
                        assetCalls: 4,
                        successCalls: 9,
                        sumLatencyMs: 1234,
                    },
                    {
                        projectId: 'proj_1',
                        day: '2026-07-01',
                        endpoint: '/api/v1/assets/:assetId',
                        totalCalls: 6,
                        assetCalls: 0,
                        successCalls: 6,
                        sumLatencyMs: 500,
                        latencyHistogram: [1, 2, 3],
                    },
                ],
            }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ingested: 2, dailyBuckets: 1, endpointBuckets: 1 });
        expect(applied).toHaveLength(1);
    });

    it('identity-scoped queries return 401 identity_required without the header', async () => {
        const res = await call(makeApp(), '/query/usersGetMe', {
            method: 'POST',
            headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
            body: '{}',
        });
        expect(res.status).toBe(401);
        expect(((await res.json()) as { error: string }).error).toBe('identity_required');
    });

    it('identity-scoped mutations map UnauthorizedError to 403', async () => {
        // usersUpdateProject with an identity that has no membership → 403.
        const body = JSON.stringify({ projectId: 'proj_1', name: 'New name' });
        const res = await call(makeApp(), '/mutation/usersUpdateProject', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
                'x-tokens-identity': await signedIdentityHeader(
                    { clerkUserId: 'user_1' },
                    'mutation',
                    'usersUpdateProject',
                    body,
                ),
            },
            body,
        });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
    });

    it('POST /query/usersGetMe returns the user row for the identity caller', async () => {
        const dashboard: DashboardRepo = {
            ...noopDashboard,
            getUserByClerkId: async clerkUserId => ({
                _id: 'usr_1',
                _creationTime: 1,
                clerkUserId,
                primaryEmail: 'a@b.co',
                createdAt: 1,
                updatedAt: 2,
            }),
        };
        const res = await call(makeApp({ dashboard }), '/query/usersGetMe', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
                'x-tokens-identity': await signedIdentityHeader({ clerkUserId: 'user_1' }, 'query', 'usersGetMe', '{}'),
            },
            body: '{}',
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { clerkUserId: string }).clerkUserId).toBe('user_1');
    });

    describe('x-tokens-identity verification', () => {
        const userRow = {
            _id: 'usr_1',
            _creationTime: 1,
            clerkUserId: 'user_1',
            primaryEmail: 'a@b.co',
            createdAt: 1,
            updatedAt: 2,
        };
        const dashboard: DashboardRepo = { ...noopDashboard, getUserByClerkId: async () => userRow };

        async function getMe(app: ReturnType<typeof createApp>, header: string, body = '{}') {
            return call(app, '/query/usersGetMe', {
                method: 'POST',
                headers: { authorization: 'Bearer tok', 'content-type': 'application/json', 'x-tokens-identity': header },
                body,
            });
        }

        async function expectIdentityInvalid(res: Response, reason: string) {
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ error: 'identity_invalid', reason });
        }

        it('rejects a token signed for a different function', async () => {
            const header = await signedIdentityHeader({ clerkUserId: 'user_1' }, 'query', 'usersGetProjectById', '{}');
            await expectIdentityInvalid(await getMe(makeApp({ dashboard }), header), 'binding_mismatch');
        });

        it('rejects a token whose body hash does not match the sent body', async () => {
            const header = await signedIdentityHeader({ clerkUserId: 'user_1' }, 'query', 'usersGetMe', '{"a":1}');
            await expectIdentityInvalid(await getMe(makeApp({ dashboard }), header, '{"a":2}'), 'binding_mismatch');
        });

        it('rejects an expired token', async () => {
            const header = await signedIdentityHeader({ clerkUserId: 'user_1' }, 'query', 'usersGetMe', '{}', {
                nowMs: Date.now() - IDENTITY_TOKEN_TTL_MS - 1_000,
            });
            await expectIdentityInvalid(await getMe(makeApp({ dashboard }), header), 'expired');
        });

        it('rejects a token signed with the wrong secret', async () => {
            const header = await signedIdentityHeader({ clerkUserId: 'user_1' }, 'query', 'usersGetMe', '{}', {
                secret: 'not-the-secret',
            });
            await expectIdentityInvalid(await getMe(makeApp({ dashboard }), header), 'bad_signature');
        });

        it('accepts a token signed with the previous secret during a rotation', async () => {
            const header = await signedIdentityHeader({ clerkUserId: 'user_1' }, 'query', 'usersGetMe', '{}', {
                secret: 'old-secret',
            });
            await expectIdentityInvalid(await getMe(makeApp({ dashboard }), header), 'bad_signature');
            const res = await getMe(makeApp({ dashboard, identitySigningSecretPrevious: 'old-secret' }), header);
            expect(res.status).toBe(200);
        });

        it('rejects a signed token when no signing secret is configured', async () => {
            const header = await signedIdentityHeader({ clerkUserId: 'user_1' }, 'query', 'usersGetMe', '{}');
            await expectIdentityInvalid(
                await getMe(makeApp({ dashboard, identitySigningSecret: null }), header),
                'signing_not_configured',
            );
        });

        it('rejects a legacy unsigned header unless acceptUnsignedIdentity is on', async () => {
            const header = identityHeader({ clerkUserId: 'user_1' });
            await expectIdentityInvalid(await getMe(makeApp({ dashboard }), header), 'unsigned');

            const res = await getMe(makeApp({ dashboard, acceptUnsignedIdentity: true }), header);
            expect(res.status).toBe(200);
            expect(((await res.json()) as { clerkUserId: string }).clerkUserId).toBe('user_1');
        });

        it('rejects a malformed legacy header even when acceptUnsignedIdentity is on', async () => {
            const res = await getMe(makeApp({ dashboard, acceptUnsignedIdentity: true }), '!!!not-base64-json');
            await expectIdentityInvalid(res, 'malformed');
        });

        it('fails closed: an invalid header on a non-identity RPC is still 401', async () => {
            const res = await call(makeApp(), '/query/ping', {
                method: 'POST',
                headers: {
                    authorization: 'Bearer tok',
                    'content-type': 'application/json',
                    'x-tokens-identity': 'garbage.signature',
                },
                body: '{}',
            });
            await expectIdentityInvalid(res, 'malformed');
        });

        it('still checks the bearer before the identity header', async () => {
            const header = await signedIdentityHeader({ clerkUserId: 'user_1' }, 'query', 'usersGetMe', '{}');
            const res = await call(makeApp({ dashboard }), '/query/usersGetMe', {
                method: 'POST',
                headers: { authorization: 'Bearer wrong', 'content-type': 'application/json', 'x-tokens-identity': header },
                body: '{}',
            });
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ error: 'unauthorized' });
        });
    });

    it('POST /mutation/syncUsageAggregates routes to the replay-safe write', async () => {
        const added: unknown[] = [];
        const synced: unknown[] = [];
        const usageIngest: UsageIngestRepo = {
            applyIngestBuckets: async args => {
                added.push(args);
            },
            applySyncBuckets: async args => {
                synced.push(args);
            },
        };
        const res = await call(makeApp({ usageIngest }), '/mutation/syncUsageAggregates', {
            method: 'POST',
            headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
            body: JSON.stringify({
                buckets: [
                    { projectId: 'p', day: '2026-07-01', totalCalls: 3, assetCalls: 1, successCalls: 3, sumLatencyMs: 9 },
                ],
            }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ingested: 1, dailyBuckets: 1, endpointBuckets: 0 });
        expect(synced).toHaveLength(1);
        expect(added).toHaveLength(0);
    });

    it('POST /mutation hides handler-thrown errors as 500', async () => {
        const usageIngest: UsageIngestRepo = {
            ...noopUsageIngest,
            applyIngestBuckets: async () => {
                throw new Error('connection refused on db-internal');
            },
        };
        const res = await call(makeApp({ usageIngest }), '/mutation/ingestUsageAggregates', {
            method: 'POST',
            headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
            body: JSON.stringify({
                buckets: [
                    { projectId: 'p', day: '2026-07-01', totalCalls: 1, assetCalls: 0, successCalls: 1, sumLatencyMs: 5 },
                ],
            }),
        });
        expect(res.status).toBe(500);
        const payload = (await res.json()) as { error: string; message?: string };
        expect(payload.error).toBe('handler_error');
        expect(payload.message).toBeUndefined();
    });
});
