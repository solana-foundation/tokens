import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

mock.module('server-only', () => ({}));

const { __resetCloudRunClientForTesting, CloudRunQueryMemo } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
const { BadRequestError, NotFoundError } = await import('@tokens/effect');
const { signPlaygroundProxyAuthPayload } = await import('./playground-proxy-auth');
const { route } = await import('./next-route');

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'TOKENS_REDIS_TARGET',
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_PLAYGROUND_PROXY_SECRET',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let logs: string[] = [];
const originalLog = console.log;

beforeEach(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    // Cloud Run env present (auth service reachable through the faked fetch);
    // Redis env deliberately ABSENT so the limits path exercises fail-open.
    process.env.TOKENS_CLOUDRUN_AUTH_TOKEN = 'tok';
    process.env.TOKENS_CLOUDRUN_ASSETS_URL = 'https://assets.example.run.app';
    process.env.TOKENS_CLOUDRUN_PRICES_URL = 'https://prices.example.run.app';
    process.env.TOKENS_CLOUDRUN_USAGE_URL = 'https://usage.example.run.app';
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    logs = [];
    console.log = (...args: unknown[]) => {
        logs.push(String(args[0]));
    };
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.log = originalLog;
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    resetEnvForTests();
    __resetCloudRunClientForTesting();
});

function fakeAuthFetch(authResult: unknown): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/query/apiKeysAuthenticate')) {
            return new Response(JSON.stringify(authResult), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
}

async function playgroundHeader(scopes: string[]): Promise<string> {
    const now = Date.now();
    return signPlaygroundProxyAuthPayload({
        apiKeyId: 'k',
        keyPrefix: 'tk_test',
        projectId: 'p',
        ownerClerkUserId: 'u',
        scopes,
        iat: now,
        exp: now + 60_000,
    });
}

const okHandler = route(() => Effect.succeed({ hello: 'world' }), {
    platform: { requiredScopes: ['assets:read'] },
});

function request(headers: Record<string, string> = {}): Request {
    return new Request('https://api.example.test/api/v1/assets/thing', { headers });
}

type Envelope = { error: { _tag: string; message: string } };

describe('route() auth/limits matrices', () => {
    it('401 with the envelope when no credentials are presented', async () => {
        const res = await okHandler(request(), {} as never);
        expect(res.status).toBe(401);
        const body = (await res.json()) as Envelope;
        expect(body.error._tag).toBe('UnauthorizedError');
        expect(body.error.message).toBe('Missing API key');
        expect(res.headers.get('x-request-id')).not.toBeNull();
    });

    it('401 when the API key does not authenticate', async () => {
        fakeAuthFetch(null);
        const res = await okHandler(request({ 'x-api-key': 'tk_bogus' }), {} as never);
        expect(res.status).toBe(401);
        const body = (await res.json()) as Envelope;
        expect(body.error._tag).toBe('UnauthorizedError');
        expect(body.error.message).toBe('Invalid API key');
    });

    it('403 when the key lacks a required scope', async () => {
        const header = await playgroundHeader(['tokens:read']);
        const res = await okHandler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(403);
        const body = (await res.json()) as Envelope;
        expect(body.error._tag).toBe('ForbiddenError');
    });

    it('200 fail-open when Redis is unconfigured, logging rate_limit_degraded', async () => {
        const header = await playgroundHeader(['assets:read']);
        const res = await okHandler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ hello: 'world' });
        const degraded = logs.filter(line => line.includes('rate_limit_degraded'));
        expect(degraded.length).toBe(1);
    });

    it('maps handler BadRequestError to a 400 envelope', async () => {
        const handler = route(() => Effect.fail(new BadRequestError({ message: 'bad limit' })), {
            platform: { requiredScopes: ['assets:read'] },
        });
        const header = await playgroundHeader(['assets:read']);
        const res = await handler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(400);
        const body = (await res.json()) as Envelope;
        expect(body.error._tag).toBe('BadRequestError');
        expect(body.error.message).toBe('bad limit');
    });

    it('maps handler NotFoundError to a 404 envelope', async () => {
        const handler = route(() => Effect.fail(new NotFoundError({ message: 'nope' })), {
            platform: { requiredScopes: ['assets:read'] },
        });
        const header = await playgroundHeader(['assets:read']);
        const res = await handler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(404);
    });

    it('maps unknown failures to a 500 envelope', async () => {
        const handler = route(() => Effect.fail(new Error('kaboom')), {
            platform: { requiredScopes: ['assets:read'] },
        });
        const header = await playgroundHeader(['assets:read']);
        const res = await handler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(500);
    });
});

describe('route() request-scoped query memo', () => {
    it('provides a fresh memo store per request — nothing leaks between requests', async () => {
        const seen: Array<number | null> = [];
        const handler = route(() =>
            Effect.gen(function* () {
                const store = yield* Effect.service(CloudRunQueryMemo);
                if (!store) {
                    seen.push(null);
                    return { ok: false };
                }
                // Whatever a previous request put must not be visible here.
                seen.push(store.take('k') ? 1 : 0);
                store.put('k', 'v');
                return { ok: true, size: store.size };
            }),
        );
        const first = await handler(request(), {} as never);
        const second = await handler(request(), {} as never);
        expect(await first.json()).toEqual({ ok: true, size: 1 });
        expect(await second.json()).toEqual({ ok: true, size: 1 });
        expect(seen).toEqual([0, 0]);
    });
});
