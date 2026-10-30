import { describe, expect, it } from 'bun:test';

import { Effect } from 'effect';

import { __resetCloudRunClientForTesting } from './client';
import { authenticateAndEnforce, authenticateApiKey, limitsEnforce, logApiRequest } from './platformAuth';

const ENV_KEYS = [
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_CLOUDRUN_ADMIN_URL',
    'TOKENS_CLOUDRUN_TIMEOUT_MS',
];

const USAGE_URL = 'https://tokens-usage-stg.example.run.app';

async function withEnvAndFetch<T>(
    overrides: Record<string, string | undefined>,
    fetchImpl: typeof fetch,
    fn: () => Effect.Effect<T, unknown>,
): Promise<T> {
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
    }
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    const savedFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    __resetCloudRunClientForTesting();
    try {
        return await Effect.runPromise(fn());
    } finally {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        globalThis.fetch = savedFetch;
        __resetCloudRunClientForTesting();
    }
}

const CLOUDRUN_ENV = {
    TOKENS_CLOUDRUN_AUTH_TOKEN: 'secret-token',
    TOKENS_CLOUDRUN_ASSETS_URL: 'https://a.example.run.app',
    TOKENS_CLOUDRUN_PRICES_URL: 'https://p.example.run.app',
    TOKENS_CLOUDRUN_USAGE_URL: USAGE_URL,
};

describe('cloudrun/platformAuth.authenticateApiKey', () => {
    it('routes to the usage service', async () => {
        let capturedUrl = '';
        let capturedAuth = '';
        let capturedBody = '';
        const payload = {
            apiKeyId: 'key_1',
            keyPrefix: 'tk_live_abc',
            projectId: 'proj_1',
            ownerClerkUserId: 'user_1',
            scopes: ['assets:read'],
        };
        const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
            capturedUrl = String(input);
            capturedAuth = String((init.headers as Record<string, string>).authorization);
            capturedBody = String(init.body);
            return new Response(JSON.stringify(payload), { status: 200 });
        }) as unknown as typeof fetch;

        const keyHash = 'a'.repeat(64);
        const result = await withEnvAndFetch(CLOUDRUN_ENV, fetchImpl, () => authenticateApiKey(keyHash));

        expect(capturedUrl).toBe(`${USAGE_URL}/query/apiKeysAuthenticate`);
        expect(capturedAuth).toBe('Bearer secret-token');
        expect(JSON.parse(capturedBody)).toEqual({ keyHash });
        expect(result).toEqual(payload);
    });

    it('propagates null for unknown keys', async () => {
        const fetchImpl = (async () => new Response('null', { status: 200 })) as unknown as typeof fetch;
        const result = await withEnvAndFetch(CLOUDRUN_ENV, fetchImpl, () => authenticateApiKey('b'.repeat(64)));
        expect(result).toBeNull();
    });
});

describe('cloudrun/platformAuth.logApiRequest', () => {
    it('posts the mutation to the usage service', async () => {
        let capturedUrl = '';
        let capturedBody = '';
        const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
            capturedUrl = String(input);
            capturedBody = String(init.body);
            return new Response('null', { status: 200 });
        }) as unknown as typeof fetch;

        const args = {
            projectId: 'proj_1',
            apiKeyId: 'key_1',
            keyPrefix: 'tk_live_abc',
            method: 'GET',
            path: '/api/v1/assets/bonk',
            endpoint: '/api/v1/assets/:assetId',
            status: 200,
            latencyMs: 42,
            ts: 1_750_000_000_000,
        };
        await withEnvAndFetch(CLOUDRUN_ENV, fetchImpl, () => logApiRequest(args));

        expect(capturedUrl).toBe(`${USAGE_URL}/mutation/logApiRequest`);
        expect(JSON.parse(capturedBody)).toEqual(args);
    });
});

// -----------------------------------------------------------------------------
// Cloud Run frontend 404s (the request never reached the service)
// -----------------------------------------------------------------------------

const FRONTEND_404_HTML =
    '<html><head><title>404 Page not found</title></head><body><h1>Error: Page not found</h1></body></html>';

const AUTH_PAYLOAD = {
    apiKeyId: 'key_1',
    keyPrefix: 'tk_live_abc',
    projectId: 'proj_1',
    ownerClerkUserId: 'user_1',
    scopes: ['assets:read'],
};

/** Answers from `responses` in order; the last one repeats. */
function scriptedFetch(responses: Array<() => Response>): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
        calls.push(String(input).split('/').pop() ?? '');
        const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
        return next();
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

const frontend404 = () => new Response(FRONTEND_404_HTML, { status: 404, headers: { 'content-type': 'text/html' } });
const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

describe('cloudrun/platformAuth frontend-404 replay', () => {
    it('authenticateApiKey replays once when the Google frontend answered HTML 404', async () => {
        const { fetchImpl, calls } = scriptedFetch([frontend404, () => json(AUTH_PAYLOAD)]);
        const result = await withEnvAndFetch(CLOUDRUN_ENV, fetchImpl, () => authenticateApiKey('a'.repeat(64)));
        expect(result).toEqual(AUTH_PAYLOAD);
        expect(calls).toEqual(['apiKeysAuthenticate', 'apiKeysAuthenticate']);
    });

    it('gives up after one replay and surfaces the 404 as CloudRunHttpError', async () => {
        const { fetchImpl, calls } = scriptedFetch([frontend404]);
        const error = await withEnvAndFetch(CLOUDRUN_ENV, fetchImpl, () =>
            Effect.flip(authenticateApiKey('a'.repeat(64))),
        );
        expect(error._tag).toBe('CloudRunHttpError');
        expect((error as { status?: number }).status).toBe(404);
        expect(calls.length).toBe(2);
    });

    it("does NOT replay the service's own JSON 404 (unknown query)", async () => {
        const { fetchImpl, calls } = scriptedFetch([
            () => json({ error: 'unknown query: apiKeysAuthenticate' }, 404),
            () => json(AUTH_PAYLOAD),
        ]);
        const exit = await withEnvAndFetch(CLOUDRUN_ENV, fetchImpl, () =>
            Effect.exit(authenticateApiKey('a'.repeat(64))),
        );
        expect(exit._tag).toBe('Failure');
        expect(calls).toEqual(['apiKeysAuthenticate']);
    });

    it('replays the merged mutation and limitsEnforce too: the service never saw the dropped call', async () => {
        const merged = scriptedFetch([
            frontend404,
            () => json({ auth: AUTH_PAYLOAD, limits: { allowed: true, rateLimit: {}, quota: {} } }),
        ]);
        const mergedResult = await withEnvAndFetch(CLOUDRUN_ENV, merged.fetchImpl, () =>
            authenticateAndEnforce({
                keyHash: 'a'.repeat(64),
                defaults: {
                    rateLimit: { requests: 1, windowSeconds: 1 },
                    sustainedRateLimit: { requests: 1, windowSeconds: 1 },
                    quota: { requestsPerMonth: 1 },
                },
            }),
        );
        expect(mergedResult.auth).toEqual(AUTH_PAYLOAD);
        expect(merged.calls).toEqual(['apiKeysAuthenticateAndEnforce', 'apiKeysAuthenticateAndEnforce']);

        const limits = scriptedFetch([
            frontend404,
            () =>
                json({
                    allowed: true,
                    rateLimit: { limit: 1, remaining: 0, resetMs: 0 },
                    quota: { limit: 1, used: 1, remaining: 0, resetMs: 0 },
                }),
        ]);
        const limitsResult = await withEnvAndFetch(CLOUDRUN_ENV, limits.fetchImpl, () =>
            limitsEnforce({
                apiKeyId: 'key_1',
                rateLimit: { requests: 1, windowSeconds: 1 },
                sustainedRateLimit: { requests: 1, windowSeconds: 1 },
                quota: { requestsPerMonth: 1 },
            }),
        );
        expect(limitsResult.allowed).toBe(true);
        expect(limits.calls).toEqual(['limitsEnforce', 'limitsEnforce']);
    });

    it('a 5xx is still not replayed by these wrappers', async () => {
        const { fetchImpl, calls } = scriptedFetch([() => new Response('boom', { status: 503 })]);
        const exit = await withEnvAndFetch(CLOUDRUN_ENV, fetchImpl, () =>
            Effect.exit(authenticateApiKey('a'.repeat(64))),
        );
        expect(exit._tag).toBe('Failure');
        expect(calls).toEqual(['apiKeysAuthenticate']);
    });
});
