import { afterEach, beforeEach, describe, expect, it, mock, spyOn, type Mock } from 'bun:test';
import { Effect, Result } from 'effect';

mock.module('server-only', () => ({}));

const { apiAppJson, fetchApiAppJsonOrNull, fetchApiAppResult } = await import('./api-app');

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['API_BASE_URL', 'TOKENS_API_ORIGIN', 'TOKENS_PLATFORM_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function setFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
    globalThis.fetch = impl as typeof fetch;
}

let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.API_BASE_URL = 'https://api.example.test';
    process.env.TOKENS_PLATFORM_API_KEY = 'test-platform-key';
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    errorSpy.mockRestore();
});

async function failureOf<T>(effect: Effect.Effect<T, unknown>): Promise<unknown> {
    const result = await Effect.runPromise(Effect.result(effect));
    if (Result.isSuccess(result)) throw new Error('expected failure');
    return result.failure;
}

describe('apiAppJson', () => {
    it('returns parsed JSON and sends the platform key', async () => {
        let sawUrl = '';
        let sawKey: string | null = null;
        setFetch(async (url, init) => {
            sawUrl = String(url);
            sawKey = new Headers(init?.headers).get('x-api-key');
            return jsonResponse({ assets: [1, 2] });
        });
        const result = await Effect.runPromise(apiAppJson<{ assets: number[] }>({ path: '/api/v1/assets/curated' }));
        expect(result).toEqual({ assets: [1, 2] });
        expect(sawUrl).toBe('https://api.example.test/api/v1/assets/curated');
        expect(sawKey).toBe('test-platform-key');
    });

    it('preserves the API error envelope as ApiResponseError', async () => {
        setFetch(async () =>
            jsonResponse({ error: { _tag: 'NotFoundError', message: 'missing', details: { id: 'x' } } }, 404),
        );
        const error = (await failureOf(apiAppJson({ path: '/api/v1/assets/nope' }))) as {
            _tag: string;
            status: number;
            error: { _tag: string; details?: unknown };
        };
        expect(error._tag).toBe('ApiResponseError');
        expect(error.status).toBe(404);
        expect(error.error._tag).toBe('NotFoundError');
        expect(error.error.details).toEqual({ id: 'x' });
    });

    it('synthesizes an HttpError envelope for non-envelope failures', async () => {
        setFetch(async () => new Response('upstream exploded', { status: 502, headers: { 'content-type': 'text/plain' } }));
        const error = (await failureOf(apiAppJson({ path: '/x' }))) as {
            _tag: string;
            status: number;
            error: { _tag: string };
        };
        expect(error._tag).toBe('ApiResponseError');
        expect(error.status).toBe(502);
        expect(error.error._tag).toBe('HttpError');
    });

    it('fails with JsonParseError for non-JSON 200s', async () => {
        setFetch(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
        const error = (await failureOf(apiAppJson({ path: '/x' }))) as { _tag: string };
        expect(error._tag).toBe('JsonParseError');
    });

    it('fails with FetchFailedError on network failure', async () => {
        setFetch(async () => {
            throw new Error('ECONNREFUSED');
        });
        const error = (await failureOf(apiAppJson({ path: '/x' }))) as { _tag: string; cause?: string };
        expect(error._tag).toBe('FetchFailedError');
        expect(error.cause).toBe('ECONNREFUSED');
    });

    it('fails with a retryable FetchFailedError when the API hangs', async () => {
        setFetch(
            (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                }),
        );
        const error = (await failureOf(apiAppJson({ path: '/x', timeout: '20 millis' }))) as {
            _tag: string;
            cause?: string;
        };
        expect(error._tag).toBe('FetchFailedError');
        expect(error.cause).toBe('timeout');
    });

    it('retries a timed-out attempt when retryTimes is set', async () => {
        let calls = 0;
        setFetch((_url, init) => {
            calls++;
            if (calls === 1) {
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                });
            }
            return Promise.resolve(jsonResponse({ ok: true }));
        });
        const result = await Effect.runPromise(apiAppJson({ path: '/x', timeout: '20 millis', retryTimes: 1 }));
        expect(result).toEqual({ ok: true });
        expect(calls).toBe(2);
    });

    it('fails with MissingEnvError when the platform key is unset', async () => {
        delete process.env.TOKENS_PLATFORM_API_KEY;
        const error = (await failureOf(apiAppJson({ path: '/x' }))) as { _tag: string; name: string };
        expect(error._tag).toBe('MissingEnvError');
        expect(error.name).toBe('TOKENS_PLATFORM_API_KEY');
    });

    it('retries 5xx when retryTimes is set, never 4xx', async () => {
        let calls = 0;
        setFetch(async () => {
            calls++;
            if (calls === 1) return jsonResponse({ error: { _tag: 'InternalServerError', message: 'x' } }, 500);
            return jsonResponse({ ok: true });
        });
        const result = await Effect.runPromise(apiAppJson({ path: '/x', retryTimes: 1 }));
        expect(result).toEqual({ ok: true });
        expect(calls).toBe(2);

        calls = 0;
        setFetch(async () => {
            calls++;
            return jsonResponse({ error: { _tag: 'BadRequestError', message: 'x' } }, 400);
        });
        const error = (await failureOf(apiAppJson({ path: '/x', retryTimes: 3 }))) as { status: number };
        expect(error.status).toBe(400);
        expect(calls).toBe(1);
    });
});

describe('fetchApiAppJsonOrNull', () => {
    it('returns the payload on success without logging', async () => {
        setFetch(async () => jsonResponse({ ok: true }));
        expect(await fetchApiAppJsonOrNull('/x')).toEqual({ ok: true });
        expect(errorSpy.mock.calls.length).toBe(0);
    });

    it('returns null and logs a structured event on server failure', async () => {
        setFetch(async () => jsonResponse({ error: { _tag: 'InternalServerError', message: 'boom' } }, 500));
        expect(await fetchApiAppJsonOrNull('/x')).toBeNull();
        expect(errorSpy.mock.calls.length).toBe(1);
        const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
        expect(logged.event).toBe('api_app_fetch_failed');
        expect(logged.tag).toBe('ApiResponseError');
        expect(logged.status).toBe(500);
    });

    it('returns null silently on 404 (expected no-data)', async () => {
        setFetch(async () => jsonResponse({ error: { _tag: 'NotFoundError', message: 'nope' } }, 404));
        expect(await fetchApiAppJsonOrNull('/x')).toBeNull();
        expect(errorSpy.mock.calls.length).toBe(0);
    });

    it('never throws, even for missing env', async () => {
        delete process.env.TOKENS_PLATFORM_API_KEY;
        expect(await fetchApiAppJsonOrNull('/x')).toBeNull();
        expect(errorSpy.mock.calls.length).toBe(1);
    });
});

describe('fetchApiAppResult', () => {
    it('carries the typed failure', async () => {
        setFetch(async () => jsonResponse({ error: { _tag: 'RateLimitedError', message: 'slow down' } }, 429));
        const result = await fetchApiAppResult('/x');
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ApiResponseError');
        }
    });
});
