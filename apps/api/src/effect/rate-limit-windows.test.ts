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
