import { describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

mock.module('server-only', () => ({}));

const { __internals } = await import('./next-route');
import type { RedisClient } from '@/lib/redis';

function makeStub(state: { burstRemaining: number; sustainedRemaining: number }) {
    const evalCalls: Array<{ keys: string[]; args: Array<string | number> }> = [];
    const windowResult = (keys: string[], args: Array<string | number>): [number, number] => {
        evalCalls.push({ keys, args });
        const isSustained = keys[0]?.includes(':sustained:');
        return [isSustained ? state.sustainedRemaining : state.burstRemaining, Number(args[0])];
    };
    const pipeline = () => {
        const p = {
            incr: () => p,
            expire: () => p,
            hincrby: () => p,
            set: () => p,
            exec: async () => [1, 1] as [number, 0 | 1],
        };
        return p;
    };
    const redis = {
        get: async () => null,
        set: async () => 'OK' as const,
        pipeline,
        eval: async (_s: string, keys: string[], args: Array<string | number>) => windowResult(keys, args),
        evalsha: async (_s: string, keys: string[], args: Array<string | number>) => windowResult(keys, args),
        scriptLoad: async () => 'sha',
    } as unknown as RedisClient;
    return { redis, evalCalls };
}

const AUTH = {
    apiKeyId: 'key_1',
    keyPrefix: 'tok_test',
    projectId: 'proj_1',
    ownerClerkUserId: 'user_1',
    scopes: ['assets:read'],
};

describe('enforceUpstashLimits burst + sustained windows', () => {
    it('checks both windows and passes when both allow', async () => {
        const { redis, evalCalls } = makeStub({ burstRemaining: 10, sustainedRemaining: 10 });
        const meta = await Effect.runPromise(__internals.enforceUpstashLimits(AUTH, redis));
        expect(meta.rateLimit.limit).toBe(400);
        const identifiers = evalCalls.map(c => c.keys[0] ?? '');
        expect(identifiers.some(k => k.includes('key:key_1:') && !k.includes(':sustained:'))).toBe(true);
        expect(identifiers.some(k => k.includes('key:key_1:sustained:'))).toBe(true);
    });

    it('fails with service=rateLimit when the burst window rejects', async () => {
        const { redis } = makeStub({ burstRemaining: -1, sustainedRemaining: 10 });
        const err = (await Effect.runPromise(Effect.flip(__internals.enforceUpstashLimits(AUTH, redis)))) as {
            _tag: string;
            service?: string;
        };
        expect(err._tag).toBe('RateLimitedError');
        expect(err.service).toBe('rateLimit');
    });

    it('fails with service=sustainedRateLimit when only the long window rejects', async () => {
        const { redis } = makeStub({ burstRemaining: 10, sustainedRemaining: -1 });
        const err = (await Effect.runPromise(Effect.flip(__internals.enforceUpstashLimits(AUTH, redis)))) as {
            _tag: string;
            service?: string;
        };
        expect(err._tag).toBe('RateLimitedError');
        expect(err.service).toBe('sustainedRateLimit');
    });

    it('honors per-project overrides for both windows', async () => {
        const { redis, evalCalls } = makeStub({ burstRemaining: 10, sustainedRemaining: 10 });
        await Effect.runPromise(
            __internals.enforceUpstashLimits(
                {
                    ...AUTH,
                    limits: {
                        rateLimit: { requests: 500, windowSeconds: 10 },
                        sustainedRateLimit: { requests: 3000, windowSeconds: 60 },
                    },
                },
                redis,
            ),
        );
        const burst = evalCalls.find(c => !c.keys[0]?.includes(':sustained:'));
        const sustained = evalCalls.find(c => c.keys[0]?.includes(':sustained:'));
        expect(burst?.args[0]).toBe(500);
        expect(sustained?.args[0]).toBe(3000);
    });
});

describe('enforceCloudRunLimits (Memorystore-backed usage RPC)', () => {
    const okResult = {
        allowed: true as const,
        rateLimit: { limit: 400, remaining: 399, resetMs: 1_790_000_000_000 },
        quota: { limit: 1_000_000_000, used: 5, remaining: 999_999_995, resetMs: 1_790_500_000_000 },
    };

    it('returns the meta shape unchanged when allowed', async () => {
        const calls: unknown[] = [];
        const meta = await Effect.runPromise(
            __internals.enforceCloudRunLimits(AUTH, args => {
                calls.push(args);
                return Effect.succeed(okResult);
            }),
        );
        expect(meta).toEqual({ rateLimit: okResult.rateLimit, quota: okResult.quota });
        expect(calls.length).toBe(1);
        const args = calls[0] as { apiKeyId: string; rateLimit: unknown; sustainedRateLimit: unknown; quota: unknown };
        expect(args.apiKeyId).toBe('key_1');
        expect(args.rateLimit).toEqual({ requests: 400, windowSeconds: 10 });
        expect(args.sustainedRateLimit).toBeDefined();
        expect(args.quota).toBeDefined();
    });

    it('maps allowed=false onto RateLimitedError with the blocking service', async () => {
        for (const service of ['rateLimit', 'sustainedRateLimit', 'quota'] as const) {
            const err = (await Effect.runPromise(
                Effect.flip(
                    __internals.enforceCloudRunLimits(AUTH, () =>
                        Effect.succeed({ allowed: false as const, service, retryAfterMs: 1234 }),
                    ),
                ),
            )) as { _tag: string; service?: string; retryAfterMs?: number };
            expect(err._tag).toBe('RateLimitedError');
            expect(err.service).toBe(service);
            expect(err.retryAfterMs).toBe(1234);
        }
    });
});

describe('enforceLimits backend switch', () => {
    it('defaults to the Upstash limiter when TOKENS_LIMITS_BACKEND is unset', async () => {
        delete process.env.TOKENS_LIMITS_BACKEND;
        const err = (await Effect.runPromise(Effect.flip(__internals.enforceLimits(AUTH)))) as { _tag: string };
        expect(err._tag).toBe('MissingEnvError');
    });

    it('routes to the usage RPC when TOKENS_LIMITS_BACKEND=usage', async () => {
        process.env.TOKENS_LIMITS_BACKEND = 'usage';
        try {
            let called = 0;
            const meta = await Effect.runPromise(
                __internals.enforceLimits(AUTH, () => {
                    called += 1;
                    return Effect.succeed({
                        allowed: true as const,
                        rateLimit: { limit: 1, remaining: 1, resetMs: 1 },
                        quota: { limit: 1, used: 1, remaining: 0, resetMs: 1 },
                    });
                }),
            );
            expect(called).toBe(1);
            expect(meta.rateLimit.limit).toBe(1);
        } finally {
            delete process.env.TOKENS_LIMITS_BACKEND;
        }
    });
});
