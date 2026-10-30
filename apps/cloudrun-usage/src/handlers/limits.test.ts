import { describe, expect, it } from 'bun:test';

import { InvalidArgsError } from './errors';
import { decodeLimitsEnforceArgs, limitsEnforce, SLIDING_WINDOW_LIMIT_SCRIPT } from './limits';
import type { LimitsRedis } from '../redis';

function makeFakeRedis(overrides: Partial<LimitsRedis> = {}): {
    redis: LimitsRedis;
    store: Map<string, number>;
    quotaTtls: Map<string, number>;
} {
    const store = new Map<string, number>();
    const quotaTtls = new Map<string, number>();

    function runScript(keys: string[], args: Array<string | number>): [number, number] {
        const [currentKey, previousKey] = keys as [string, string, string];
        const tokens = Number(args[0]);
        const now = Number(args[1]);
        const windowMs = Number(args[2]);
        const incrementBy = Number(args[3]);

        const current = store.get(currentKey) ?? 0;
        const previousRaw = store.get(previousKey) ?? 0;
        const pctInCurrent = (now % windowMs) / windowMs;
        const previous = Math.floor((1 - pctInCurrent) * previousRaw);

        if (incrementBy > 0 && previous + current >= tokens) return [-1, tokens];
        const newValue = current + incrementBy;
        store.set(currentKey, newValue);
        return [tokens - (newValue + previous), tokens];
    }

    const redis: LimitsRedis = {
        async evalsha<T>(sha: string, keys: string[], args: Array<string | number>): Promise<T> {
            expect(sha).toBe(SLIDING_WINDOW_LIMIT_SCRIPT.sha1);
            return runScript(keys, args) as T;
        },
        async eval<T>(_script: string, keys: string[], args: Array<string | number>): Promise<T> {
            return runScript(keys, args) as T;
        },
        async quotaIncr(key: string, ttlSeconds: number): Promise<number> {
            const used = (store.get(key) ?? 0) + 1;
            store.set(key, used);
            if (!quotaTtls.has(key)) quotaTtls.set(key, ttlSeconds);
            return used;
        },
        ...overrides,
    };
    return { redis, store, quotaTtls };
}

const ARGS = {
    apiKeyId: 'kh7test',
    rateLimit: { requests: 3, windowSeconds: 10 },
    sustainedRateLimit: { requests: 100, windowSeconds: 300 },
    quota: { requestsPerMonth: 5 },
};

const NOW = Date.UTC(2026, 8, 29, 12, 0, 5);

describe('limitsEnforce', () => {
    it('allows under all limits and reports remaining/reset', async () => {
        const { redis, quotaTtls } = makeFakeRedis();
        const res = await limitsEnforce({ redis, now: () => NOW }, ARGS);
        expect(res.allowed).toBe(true);
        if (!res.allowed) throw new Error('unreachable');
        expect(res.rateLimit.limit).toBe(3);
        expect(res.rateLimit.remaining).toBe(2);
        expect(res.rateLimit.resetMs).toBeGreaterThan(NOW);
        expect(res.quota).toEqual({
            limit: 5,
            used: 1,
            remaining: 4,
            resetMs: NOW + (res.quota.resetMs - NOW),
        });
        const ttl = [...quotaTtls.values()][0]!;
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(31 * 24 * 60 * 60);
    });

    it('blocks with service=rateLimit when the burst window is exhausted', async () => {
        const { redis } = makeFakeRedis();
        const deps = { redis, now: () => NOW };
        for (let i = 0; i < 3; i += 1) {
            const res = await limitsEnforce(deps, ARGS);
            expect(res.allowed).toBe(true);
        }
        const res = await limitsEnforce(deps, ARGS);
        expect(res).toEqual({
            allowed: false,
            service: 'rateLimit',
            retryAfterMs: expect.any(Number),
        });
    });

    it('blocks with service=sustainedRateLimit when the long window is exhausted', async () => {
        const { redis } = makeFakeRedis();
        const deps = { redis, now: () => NOW };
        const args = { ...ARGS, rateLimit: { requests: 1000, windowSeconds: 10 }, sustainedRateLimit: { requests: 2, windowSeconds: 300 } };
        await limitsEnforce(deps, args);
        await limitsEnforce(deps, args);
        const res = await limitsEnforce(deps, args);
        expect(res.allowed).toBe(false);
        if (res.allowed) throw new Error('unreachable');
        expect(res.service).toBe('sustainedRateLimit');
    });

    it('blocks with service=quota when the monthly counter passes the cap', async () => {
        const { redis } = makeFakeRedis();
        const deps = { redis, now: () => NOW };
        const args = { ...ARGS, rateLimit: { requests: 1000, windowSeconds: 10 }, quota: { requestsPerMonth: 2 } };
        await limitsEnforce(deps, args);
        await limitsEnforce(deps, args);
        const res = await limitsEnforce(deps, args);
        expect(res.allowed).toBe(false);
        if (res.allowed) throw new Error('unreachable');
        expect(res.service).toBe('quota');
        expect(res.retryAfterMs).toBeGreaterThan(0);
    });

    it('falls back to EVAL on NOSCRIPT', async () => {
        const base = makeFakeRedis();
        let evalCalls = 0;
        const { redis } = makeFakeRedis({
            evalsha: async () => {
                throw new Error('NOSCRIPT No matching script');
            },
            eval: async <T,>(script: string, keys: string[], args: Array<string | number>): Promise<T> => {
                evalCalls += 1;
                return base.redis.eval<T>(script, keys, args);
            },
        });
        const res = await limitsEnforce({ redis, now: () => NOW }, ARGS);
        expect(res.allowed).toBe(true);
        expect(evalCalls).toBe(2);
    });

    it('propagates redis failures (caller fails open)', async () => {
        const { redis } = makeFakeRedis({
            quotaIncr: async () => {
                throw new Error('connection refused');
            },
        });
        await expect(limitsEnforce({ redis, now: () => NOW }, ARGS)).rejects.toThrow('connection refused');
    });
});

describe('decodeLimitsEnforceArgs', () => {
    it('rejects malformed args', () => {
        expect(() => decodeLimitsEnforceArgs({})).toThrow(InvalidArgsError);
        expect(() => decodeLimitsEnforceArgs({ ...ARGS, apiKeyId: 'bad key!' })).toThrow(InvalidArgsError);
        expect(() => decodeLimitsEnforceArgs({ ...ARGS, rateLimit: { requests: 0, windowSeconds: 10 } })).toThrow(
            InvalidArgsError,
        );
        expect(() => decodeLimitsEnforceArgs({ ...ARGS, quota: { requestsPerMonth: -1 } })).toThrow(InvalidArgsError);
    });

    it('floors numeric config', () => {
        const args = decodeLimitsEnforceArgs({ ...ARGS, rateLimit: { requests: 3.9, windowSeconds: 10.2 } });
        expect(args.rateLimit).toEqual({ requests: 3, windowSeconds: 10 });
    });
});
