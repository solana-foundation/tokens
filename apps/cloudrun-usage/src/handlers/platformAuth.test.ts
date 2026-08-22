import { describe, expect, it } from 'bun:test';

import {
    authenticateApiKey,
    DEFAULT_LEGACY_SCOPES,
    LAST_USED_DEDUP_MS,
    logApiRequest,
    type ApiKeyByHashRow,
    type ApiKeyByIdRow,
    type ApiRequestEventInsert,
    type PlatformAuthRepo,
    type ProjectRow,
} from './platformAuth';
import { InvalidArgsError } from './errors';

const KEY_HASH = 'a'.repeat(64);

interface FakeState {
    keyByHash?: ApiKeyByHashRow | null;
    personalProjectId?: string | null;
    projects?: Record<string, ProjectRow>;
    keyById?: ApiKeyByIdRow | null;
    isMember?: boolean;
}

function makeRepo(state: FakeState) {
    const inserted: ApiRequestEventInsert[] = [];
    const bumps: Array<{ apiKeyId: string; ts: number }> = [];
    const repo: PlatformAuthRepo = {
        findApiKeyByHash: async () => state.keyByHash ?? null,
        findPersonalProjectId: async () => state.personalProjectId ?? null,
        getProject: async id => state.projects?.[id] ?? null,
        getApiKeyById: async () => state.keyById ?? null,
        hasProjectMembership: async () => state.isMember ?? false,
        insertApiRequestEvent: async event => {
            inserted.push(event);
        },
        bumpApiKeyLastUsedAt: async (apiKeyId, ts) => {
            bumps.push({ apiKeyId, ts });
        },
    };
    return { repo, inserted, bumps };
}

const ACTIVE_KEY: ApiKeyByHashRow = {
    id: 'key_1',
    keyPrefix: 'tk_live_abc',
    projectId: 'proj_1',
    ownerClerkUserId: 'user_1',
    scopes: ['assets:read'],
    revokedAt: null,
};

describe('authenticateApiKey', () => {
    it('returns the auth context for an active key with an explicit project', async () => {
        const { repo } = makeRepo({
            keyByHash: ACTIVE_KEY,
            projects: { proj_1: { limits: { quota: { requestsPerMonth: 10 } } } },
        });
        const result = await authenticateApiKey(repo, { keyHash: KEY_HASH });
        expect(result).toEqual({
            apiKeyId: 'key_1',
            keyPrefix: 'tk_live_abc',
            projectId: 'proj_1',
            ownerClerkUserId: 'user_1',
            scopes: ['assets:read'],
            limits: { quota: { requestsPerMonth: 10 } },
        });
    });

    it('normalizes the hash (trim + lowercase) before lookup', async () => {
        let seenHash = '';
        const { repo } = makeRepo({ keyByHash: ACTIVE_KEY, projects: { proj_1: { limits: null } } });
        repo.findApiKeyByHash = async hash => {
            seenHash = hash;
            return ACTIVE_KEY;
        };
        await authenticateApiKey(repo, { keyHash: `  ${KEY_HASH.toUpperCase()}  ` });
        expect(seenHash).toBe(KEY_HASH);
    });

    it('returns null for a malformed hash without hitting the repo', async () => {
        const { repo } = makeRepo({ keyByHash: ACTIVE_KEY });
        repo.findApiKeyByHash = async () => {
            throw new Error('should not be called');
        };
        expect(await authenticateApiKey(repo, { keyHash: 'not-a-hash' })).toBeNull();
    });

    it('returns null for unknown or revoked keys', async () => {
        const missing = makeRepo({ keyByHash: null });
        expect(await authenticateApiKey(missing.repo, { keyHash: KEY_HASH })).toBeNull();

        const revoked = makeRepo({ keyByHash: { ...ACTIVE_KEY, revokedAt: 123 } });
        expect(await authenticateApiKey(revoked.repo, { keyHash: KEY_HASH })).toBeNull();
    });

    it('falls back to the personal project for legacy keys without projectId', async () => {
        const { repo } = makeRepo({
            keyByHash: { ...ACTIVE_KEY, projectId: null },
            personalProjectId: 'proj_personal',
            projects: { proj_personal: { limits: null } },
        });
        const result = await authenticateApiKey(repo, { keyHash: KEY_HASH });
        expect(result?.projectId).toBe('proj_personal');
        expect(result && 'limits' in result).toBe(false);
    });

    it('returns null when no project can be resolved or the project row is missing', async () => {
        const noPersonal = makeRepo({ keyByHash: { ...ACTIVE_KEY, projectId: null }, personalProjectId: null });
        expect(await authenticateApiKey(noPersonal.repo, { keyHash: KEY_HASH })).toBeNull();

        const noProject = makeRepo({ keyByHash: ACTIVE_KEY, projects: {} });
        expect(await authenticateApiKey(noProject.repo, { keyHash: KEY_HASH })).toBeNull();
    });

    it('applies default legacy scopes when scopes are null or empty', async () => {
        for (const scopes of [null, [], ['  ', 42]]) {
            const { repo } = makeRepo({
                keyByHash: { ...ACTIVE_KEY, scopes },
                projects: { proj_1: { limits: null } },
            });
            const result = await authenticateApiKey(repo, { keyHash: KEY_HASH });
            expect(result?.scopes).toEqual(DEFAULT_LEGACY_SCOPES);
        }
    });

    it('grants execution:read by default (keys with materialized scopes rely on the 0014 backfill)', () => {
        expect(DEFAULT_LEGACY_SCOPES).toContain('execution:read');
    });

    it('dedupes and trims scopes', async () => {
        const { repo } = makeRepo({
            keyByHash: { ...ACTIVE_KEY, scopes: [' assets:read ', 'assets:read', 'assets:ohlcv:read'] },
            projects: { proj_1: { limits: null } },
        });
        const result = await authenticateApiKey(repo, { keyHash: KEY_HASH });
        expect(result?.scopes).toEqual(['assets:read', 'assets:ohlcv:read']);
    });

    it('throws InvalidArgsError for a non-string keyHash', async () => {
        const { repo } = makeRepo({});
        await expect(authenticateApiKey(repo, { keyHash: 42 })).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(authenticateApiKey(repo, 'nope')).rejects.toBeInstanceOf(InvalidArgsError);
    });
});

const LOG_ARGS = {
    projectId: 'proj_1',
    apiKeyId: 'key_1',
    keyPrefix: 'tk_live_abc',
    method: 'GET',
    path: '/api/v1/assets/bonk',
    endpoint: '/api/v1/assets/:assetId',
    status: 200,
    latencyMs: 12.7,
    ts: 1_750_000_000_000,
};

const KEY_BY_ID: ApiKeyByIdRow = {
    projectId: 'proj_1',
    ownerClerkUserId: 'user_1',
    revokedAt: null,
    lastUsedAt: null,
};

describe('logApiRequest', () => {
    it('inserts the event with clamped latency and bumps last_used_at', async () => {
        const { repo, inserted, bumps } = makeRepo({ keyById: KEY_BY_ID });
        expect(await logApiRequest(repo, LOG_ARGS)).toBeNull();
        expect(inserted).toEqual([
            {
                projectId: 'proj_1',
                apiKeyId: 'key_1',
                keyPrefix: 'tk_live_abc',
                method: 'GET',
                path: '/api/v1/assets/bonk',
                endpoint: '/api/v1/assets/:assetId',
                status: 200,
                latencyMs: 12,
                ts: LOG_ARGS.ts,
            },
        ]);
        expect(bumps).toEqual([{ apiKeyId: 'key_1', ts: LOG_ARGS.ts }]);
    });

    it('includes errorTag when present and clamps negative latency to 0', async () => {
        const { repo, inserted } = makeRepo({ keyById: KEY_BY_ID });
        await logApiRequest(repo, { ...LOG_ARGS, latencyMs: -5, errorTag: 'UpstreamTimeout' });
        expect(inserted[0]?.latencyMs).toBe(0);
        expect(inserted[0]?.errorTag).toBe('UpstreamTimeout');
    });

    it('skips the last_used_at bump inside the dedup window', async () => {
        const { repo, inserted, bumps } = makeRepo({
            keyById: { ...KEY_BY_ID, lastUsedAt: LOG_ARGS.ts - LAST_USED_DEDUP_MS + 1 },
        });
        await logApiRequest(repo, LOG_ARGS);
        expect(inserted).toHaveLength(1);
        expect(bumps).toHaveLength(0);
    });

    it('no-ops for missing or revoked keys', async () => {
        for (const keyById of [null, { ...KEY_BY_ID, revokedAt: 5 }]) {
            const { repo, inserted, bumps } = makeRepo({ keyById });
            expect(await logApiRequest(repo, LOG_ARGS)).toBeNull();
            expect(inserted).toHaveLength(0);
            expect(bumps).toHaveLength(0);
        }
    });

    it('no-ops when the key belongs to a different project', async () => {
        const { repo, inserted } = makeRepo({ keyById: { ...KEY_BY_ID, projectId: 'proj_other' } });
        expect(await logApiRequest(repo, LOG_ARGS)).toBeNull();
        expect(inserted).toHaveLength(0);
    });

    it('requires membership for legacy keys without projectId', async () => {
        const denied = makeRepo({ keyById: { ...KEY_BY_ID, projectId: null }, isMember: false });
        expect(await logApiRequest(denied.repo, LOG_ARGS)).toBeNull();
        expect(denied.inserted).toHaveLength(0);

        const allowed = makeRepo({ keyById: { ...KEY_BY_ID, projectId: null }, isMember: true });
        await logApiRequest(allowed.repo, LOG_ARGS);
        expect(allowed.inserted).toHaveLength(1);
        expect(allowed.inserted[0]?.projectId).toBe('proj_1');
    });

    it('throws InvalidArgsError on malformed args', async () => {
        const { repo } = makeRepo({ keyById: KEY_BY_ID });
        await expect(logApiRequest(repo, { ...LOG_ARGS, status: 'ok' })).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(logApiRequest(repo, { ...LOG_ARGS, projectId: 7 })).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(logApiRequest(repo, { ...LOG_ARGS, errorTag: 9 })).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(logApiRequest(repo, undefined)).rejects.toBeInstanceOf(InvalidArgsError);
    });
});
