import 'server-only';

import { Cause, Duration, Effect, Result, Schedule } from 'effect';
import {
    ApiResponseError,
    FetchFailedError,
    JsonParseError,
    MissingEnvError,
} from '@tokens/effect';
import { decodeApiResponse } from '@/effect/api-response';

type NextFetchInit = RequestInit & { next?: { revalidate?: number } };
const LOCAL_API_ORIGIN = 'http://localhost:3002';

export type ApiAppFailure =
    | ApiResponseError
    | FetchFailedError
    | JsonParseError
    | MissingEnvError
    | Cause.TimeoutError;

export interface ApiAppJsonArgs {
    /** API path, e.g. '/api/v1/assets/curated?list=majors'. */
    path: string;
    init?: NextFetchInit;
    /** Per-call timeout. Defaults to 10 seconds so a hung API can't hang the page render. */
    timeout?: Duration.Input;
    /**
     * Retries after the first attempt. Defaults to 0. Only network failures
     * and 5xx responses are retried — 4xx is caller/data-dependent.
     */
    retryTimes?: number;
}

function getApiOrigin(): string | MissingEnvError {
    const raw = process.env.API_BASE_URL?.trim() ?? process.env.TOKENS_API_ORIGIN?.trim() ?? '';
    if (raw) return raw.replace(/\/$/, '');
    if (process.env.NODE_ENV !== 'production') return LOCAL_API_ORIGIN;

    return new MissingEnvError({
        message: 'API_BASE_URL or TOKENS_API_ORIGIN must be set in production',
        name: 'API_BASE_URL',
    });
}

function getPlatformServiceKey(): string | MissingEnvError {
    const key = process.env.TOKENS_PLATFORM_API_KEY?.trim();
    if (!key) {
        return new MissingEnvError({
            message: 'TOKENS_PLATFORM_API_KEY is not set (required for server-to-server API calls)',
            name: 'TOKENS_PLATFORM_API_KEY',
        });
    }
    return key;
}

function joinUrl(origin: string, path: string): string {
    const base = origin.endsWith('/') ? origin : `${origin}/`;
    const normalized = path.startsWith('/') ? path.slice(1) : path;
    return `${base}${normalized}`;
}

function isRetryableApiAppFailure(error: ApiAppFailure): boolean {
    if (error._tag === 'FetchFailedError') return true;
    if (error._tag === 'ApiResponseError') return error.status >= 500;
    return false;
}

/** Server-to-server call to the tokens API, with the error envelope preserved. */
export function apiAppJson<T = unknown>(args: ApiAppJsonArgs): Effect.Effect<T, ApiAppFailure> {
    return Effect.suspend((): Effect.Effect<T, ApiAppFailure> => {
        const origin = getApiOrigin();
        if (origin instanceof MissingEnvError) return Effect.fail(origin);
        const platformKey = getPlatformServiceKey();
        if (platformKey instanceof MissingEnvError) return Effect.fail(platformKey);

        const url = joinUrl(origin, args.path);
        const headers = new Headers(args.init?.headers);
        headers.set('accept', 'application/json');
        headers.set('x-api-key', platformKey);

        const attempt = Effect.tryPromise({
            try: (signal: AbortSignal) => fetch(url, { ...args.init, headers, signal }),
            catch: error =>
                new FetchFailedError({
                    service: 'api',
                    message: `Failed to fetch API ${args.path}`,
                    cause: error instanceof Error ? error.message : String(error),
                }),
        }).pipe(
            Effect.flatMap(res => decodeApiResponse<T>(res)),
            Effect.timeout(args.timeout ?? '10 seconds'),
        );

        const retryTimes = Math.max(0, args.retryTimes ?? 0);
        if (retryTimes === 0) return attempt;
        return Effect.retry(attempt, {
            while: isRetryableApiAppFailure,
            times: retryTimes,
            schedule: Schedule.exponential('200 millis').pipe(Schedule.jittered),
        });
    });
}

function logApiAppFailure(path: string, error: ApiAppFailure): void {
    console.error(
        JSON.stringify({
            event: 'api_app_fetch_failed',
            path,
            tag: error._tag,
            ...(error._tag === 'ApiResponseError' ? { status: error.status, errorTag: error.error._tag } : {}),
            message: error.message,
            ...('cause' in error && error.cause ? { cause: String(error.cause) } : {}),
        }),
    );
}

/**
 * Fetch JSON from the API, returning `null` on any failure (the historical
 * contract — callers branch with `data?.x ?? fallback` / `notFound()`).
 * Failures are logged as structured `api_app_fetch_failed` events, EXCEPT
 * 404s, which are expected no-data (e.g. resolve misses feeding notFound()).
 */
export async function fetchApiAppJsonOrNull<T>(path: string, init?: NextFetchInit): Promise<T | null> {
    const result = await Effect.runPromise(Effect.result(apiAppJson<T>({ path, ...(init ? { init } : {}) })));
    if (Result.isSuccess(result)) return result.success;
    const error = result.failure;
    if (!(error._tag === 'ApiResponseError' && error.status === 404)) {
        logApiAppFailure(path, error);
    }
    return null;
}

/**
 * Fetch JSON from the API, preserving the typed failure for callers that need
 * to distinguish failure from no-data. Adopt opportunistically.
 */
export async function fetchApiAppResult<T>(
    path: string,
    init?: NextFetchInit,
): Promise<Result.Result<T, ApiAppFailure>> {
    return Effect.runPromise(Effect.result(apiAppJson<T>({ path, ...(init ? { init } : {}) })));
}

/**
 * Raw-Response passthrough for callers that need status/headers/body verbatim
 * (assets-api docs pages). Throws on missing env, like it always did.
 */
export async function fetchApiApp(path: string, init?: NextFetchInit): Promise<Response> {
    const origin = getApiOrigin();
    if (origin instanceof MissingEnvError) throw new Error(origin.message);
    const platformKey = getPlatformServiceKey();
    if (platformKey instanceof MissingEnvError) throw new Error(platformKey.message);

    const url = joinUrl(origin, path);
    const headers = new Headers(init?.headers);
    headers.set('accept', 'application/json');
    headers.set('x-api-key', platformKey);

    return await fetch(url, {
        ...init,
        headers,
    });
}
