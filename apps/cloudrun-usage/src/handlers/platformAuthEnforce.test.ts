import { describe, expect, it } from 'bun:test';

import { InvalidArgsError } from './errors';
import { apiKeysAuthenticateAndEnforce } from './platformAuthEnforce';
import type { PlatformAuthRepo } from './platformAuth';
import { SLIDING_WINDOW_LIMIT_SCRIPT } from './limits';
import type { LimitsRedis } from '../redis';

const KEY_HASH = 'a'.repeat(64);
const NOW = Date.UTC(2026, 8, 29, 12, 0, 5);

const DEFAULTS = {
    rateLimit: { requests: 400, windowSeconds: 10 },
    sustainedRateLimit: { requests: 1_000, windowSeconds: 60 },
    quota: { requestsPerMonth: 1_000_000_000 },
};

function makeRepo(projectLimits: unknown = null, revoked = false): PlatformAuthRepo {
    return {
        findApiKeyByHash: async hash =>
            hash === KEY_HASH
                ? {
                      id: 'kh7test',
                      keyPrefix: 'tk_test',
                      projectId: 'prj_1',
                      ownerClerkUserId: 'user_1',
                      scopes: ['assets:read'],
                      revokedAt: revoked ? NOW : null,
                  }
                : null,
        findPersonalProjectId: async () => null,
        getProject: async () => ({ limits: projectLimits }),
        getApiKeyById: async () => null,
        hasProjectMembership: async () => false,
        insertApiRequestEvent: async () => {},
        bumpApiKeyLastUsedAt: async () => {},
    };
}

/** Records the window configs the Lua script was invoked with. */
function makeFakeRedis(overrides: Partial<LimitsRedis> = {}): {
    redis: LimitsRedis;
    windows: Array<{ key: string; tokens: number }>;
    quotaCalls: number;
} {
    const store = new Map<string, number>();
    const windows: Array<{ key: string; tokens: number }> = [];
    let quotaCalls = 0;
    const run = (keys: string[], args: Array<string | number>): [number, number] => {
        const key = keys[0] ?? '';
        const tokens = Number(args[0]);
        windows.push({ key, tokens });
        const current = (store.get(key) ?? 0) + 1;
        store.set(key, current);
        return current > tokens ? [-1, tokens] : [tokens - current, tokens];
    };
    const redis: LimitsRedis = {
        async evalsha<T>(sha: string, keys: string[], args: Array<string | number>): Promise<T> {
            expect(sha).toBe(SLIDING_WINDOW_LIMIT_SCRIPT.sha1);
            return run(keys, args) as T;
        },
        async eval<T>(_script: string, keys: string[], args: Array<string | number>): Promise<T> {
            return run(keys, args) as T;
        },
        async quotaIncr(key: string): Promise<number> {
            quotaCalls += 1;
            const used = (store.get(key) ?? 0) + 1;
            store.set(key, used);
            return used;
        },
        ...overrides,
    };
    return {
        redis,
        windows,
        get quotaCalls() {
            return quotaCalls;
        },
    };
}

const args = (overrides: Record<string, unknown> = {}) => ({ keyHash: KEY_HASH, defaults: DEFAULTS, ...overrides });

describe('apiKeysAuthenticateAndEnforce', () => {
    it('rejects missing keyHash or invalid defaults (an apps/api misconfiguration)', async () => {
        const { redis } = makeFakeRedis();
        const deps = { platformAuth: makeRepo(), limitsRedis: redis };
        await expect(apiKeysAuthenticateAndEnforce(deps, { defaults: DEFAULTS })).rejects.toBeInstanceOf(
            InvalidArgsError,
        );
        await expect(
            apiKeysAuthenticateAndEnforce(deps, args({ defaults: { ...DEFAULTS, quota: { requestsPerMonth: 0 } } })),
        ).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(
            apiKeysAuthenticateAndEnforce(deps, args({ defaults: { quota: DEFAULTS.quota } })),
        ).rejects.toBeInstanceOf(InvalidArgsError);
    });

    it('unknown or revoked key → { auth: null } without touching Redis', async () => {
        const fake = makeFakeRedis();
        expect(
            await apiKeysAuthenticateAndEnforce(
                { platformAuth: makeRepo(), limitsRedis: fake.redis },
                args({ keyHash: 'b'.repeat(64) }),
            ),
        ).toEqual({ auth: null });
        expect(
            await apiKeysAuthenticateAndEnforce(
                { platformAuth: makeRepo(null, true), limitsRedis: fake.redis },
                args(),
            ),
        ).toEqual({ auth: null });
        expect(fake.windows).toEqual([]);
        expect(fake.quotaCalls).toBe(0);
    });

    it('uses the apps/api defaults when the project has no limits, and returns the auth context unchanged', async () => {
        const fake = makeFakeRedis();
        const out = await apiKeysAuthenticateAndEnforce(
            { platformAuth: makeRepo(), limitsRedis: fake.redis, now: () => NOW },
            args(),
        );
        expect(out.auth).toEqual({
            apiKeyId: 'kh7test',
            keyPrefix: 'tk_test',
            projectId: 'prj_1',
            ownerClerkUserId: 'user_1',
            scopes: ['assets:read'],
        });
        if (!out.auth) throw new Error('unreachable');
        expect(out.limits?.allowed).toBe(true);
        expect(fake.windows.map(w => w.tokens)).toEqual([400, 1_000]);
        if (out.limits?.allowed) {
            expect(out.limits.rateLimit.limit).toBe(400);
            expect(out.limits.quota.limit).toBe(1_000_000_000);
        }
    });

    it('merges project limits per field, exactly like enforceCloudRunLimits', async () => {
        const fake = makeFakeRedis();
        const repo = makeRepo({ quota: { requestsPerMonth: 5 }, rateLimit: { requests: 7, windowSeconds: 10 } });
        const out = await apiKeysAuthenticateAndEnforce(
            { platformAuth: repo, limitsRedis: fake.redis, now: () => NOW },
            args(),
        );
        if (!out.auth || !out.limits?.allowed) throw new Error('expected allowed');
        expect(out.auth.limits).toEqual({
            quota: { requestsPerMonth: 5 },
            rateLimit: { requests: 7, windowSeconds: 10 },
        });
        expect(fake.windows.map(w => w.tokens)).toEqual([7, 1_000]);
        expect(out.limits.quota.limit).toBe(5);
    });

    it('over the limit → allowed:false with the blocking service, auth still returned', async () => {
        const fake = makeFakeRedis();
        const repo = makeRepo({ rateLimit: { requests: 1, windowSeconds: 10 } });
        const deps = { platformAuth: repo, limitsRedis: fake.redis, now: () => NOW };
        await apiKeysAuthenticateAndEnforce(deps, args());
        const out = await apiKeysAuthenticateAndEnforce(deps, args());
        if (!out.auth) throw new Error('expected auth');
        expect(out.limits).toEqual({ allowed: false, service: 'rateLimit', retryAfterMs: expect.any(Number) });
    });

    it('malformed project limits → auth returned, limits null with a reason (never thrown)', async () => {
        const fake = makeFakeRedis();
        const repo = makeRepo({ rateLimit: 'not-a-window' });
        const out = await apiKeysAuthenticateAndEnforce({ platformAuth: repo, limitsRedis: fake.redis }, args());
        if (!out.auth) throw new Error('expected auth');
        expect(out.limits).toBeNull();
        expect(out.limitsError).toContain('rateLimit');
    });

    it('no Redis configured → auth returned, limits null', async () => {
        const out = await apiKeysAuthenticateAndEnforce({ platformAuth: makeRepo() }, args());
        if (!out.auth) throw new Error('expected auth');
        expect(out.limits).toBeNull();
        expect(out.limitsError).toContain('REDIS_HOST');
    });

    it('a Redis error → auth returned, limits null', async () => {
        const { redis } = makeFakeRedis({
            evalsha: async () => {
                throw new Error('ECONNRESET');
            },
        });
        const out = await apiKeysAuthenticateAndEnforce({ platformAuth: makeRepo(), limitsRedis: redis }, args());
        if (!out.auth) throw new Error('expected auth');
        expect(out.limits).toBeNull();
        expect(out.limitsError).toBe('ECONNRESET');
    });

    it('a slow Redis → auth returned, limits null after the bound', async () => {
        const { redis } = makeFakeRedis({ evalsha: () => new Promise(() => undefined) });
        const out = await apiKeysAuthenticateAndEnforce(
            { platformAuth: makeRepo(), limitsRedis: redis, limitsTimeoutMs: 20 },
            args(),
        );
        if (!out.auth) throw new Error('expected auth');
        expect(out.limits).toBeNull();
        expect(out.limitsError).toContain('timed out');
    });
});
