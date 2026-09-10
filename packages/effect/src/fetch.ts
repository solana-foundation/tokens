import { Duration, Effect, Schedule, type Schema } from 'effect';
import { mergeSignals } from './abort';
import { FetchFailedError, JsonParseError, RateLimitedError, UpstreamDataError, UpstreamHttpError } from './api-errors';
import { CurrentRequestId, emitEvent } from './observability';
import { decodeUpstreamOrFail, decodeUpstreamOrWarn } from './schema';

type NextFetchInit = RequestInit & { next?: { revalidate?: number } };

export interface FetchJsonArgs {
    url: string;
    service: string;
    init?: NextFetchInit;
    signal?: AbortSignal;
    /**
     * Optional response schema. In 'warn' mode (the default, right for
     * third-party APIs) mismatches log an `upstream_decode_failed` event and
     * pass the raw payload through; in 'fail' mode they fail with a tagged
     * `UpstreamDataError`.
     */
    schema?: Schema.ConstraintDecoder<unknown>;
    decodeMode?: 'fail' | 'warn';
    /** Per-attempt timeout. A timed-out attempt fails as FetchFailedError (retryable). */
    timeout?: Duration.Input;
}

export type FetchJsonError = RateLimitedError | UpstreamHttpError | FetchFailedError | JsonParseError | UpstreamDataError;

export interface FetchHttpRecovery<T> {
    value: T;
    outcome: string;
}

function parseRetryAfterMs(value: string | null): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    // `retry-after` can be seconds (recommended) or an HTTP date.
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

    const dateMs = Date.parse(trimmed);
    if (Number.isFinite(dateMs)) {
        const delta = dateMs - Date.now();
        return delta > 0 ? delta : 0;
    }

    return undefined;
}

function isRetryableFetchError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    if (!('_tag' in error)) return false;

    const tag = (error as { _tag?: unknown })._tag;
    if (tag === 'RateLimitedError') return true;
    if (tag === 'FetchFailedError') return true;

    if (tag === 'UpstreamHttpError') {
        const status = (error as { status?: unknown }).status;
        return typeof status === 'number' && status >= 500;
    }

    return false;
}

export function fetchJson<T = unknown>(args: FetchJsonArgs): Effect.Effect<T, FetchJsonError> {
    const attempt = Effect.tryPromise({
        try: (signal: AbortSignal) => {
            const merged = mergeSignals(signal, args.signal);
            return Promise.resolve()
                .then(() => fetch(args.url, { ...args.init, signal: merged.signal }))
                .finally(merged.cleanup);
        },
        catch: error =>
            new FetchFailedError({
                service: args.service,
                message: `Failed to fetch ${args.service}`,
                cause: error instanceof Error ? error.message : String(error),
            }),
    }).pipe(
        Effect.flatMap(res => {
            type BodyError = RateLimitedError | UpstreamHttpError | JsonParseError | UpstreamDataError;

            if (res.status === 429) {
                return Effect.fail(
                    new RateLimitedError({
                        service: args.service,
                        message: `${args.service} rate limited`,
                        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
                    }),
                ) as Effect.Effect<T, BodyError, never>;
            }

            if (!res.ok) {
                const bodyEffect = Effect.tryPromise({
                    try: () => res.text(),
                    catch: error =>
                        new FetchFailedError({
                            service: args.service,
                            message: `Failed to read ${args.service} response body`,
                            cause: error instanceof Error ? error.message : String(error),
                        }),
                }).pipe(Effect.catch(() => Effect.succeed('')));

                return bodyEffect.pipe(
                    Effect.flatMap(body =>
                        Effect.fail(
                            new UpstreamHttpError({
                                service: args.service,
                                status: res.status,
                                statusText: res.statusText,
                                body: body.length > 0 ? body : undefined,
                                message: `${args.service} request failed`,
                            }),
                        ),
                    ),
                ) as Effect.Effect<T, BodyError, never>;
            }

            return Effect.tryPromise({
                try: () => res.json() as Promise<T>,
                catch: error =>
                    new JsonParseError({
                        message: `Failed to parse JSON from ${args.service}`,
                        cause: error instanceof Error ? error.message : String(error),
                    }),
            }).pipe(
                Effect.flatMap(payload => {
                    if (!args.schema) return Effect.succeed(payload);
                    const decode =
                        args.decodeMode === 'fail'
                            ? decodeUpstreamOrFail(args.schema, args.service)
                            : decodeUpstreamOrWarn(args.schema, args.service);
                    return decode(payload) as Effect.Effect<T, UpstreamDataError, never>;
                }),
            );
        }),
    );

    if (args.timeout === undefined) return attempt;
    return attempt.pipe(
        Effect.timeout(args.timeout),
        Effect.catchTag('TimeoutError', () =>
            Effect.fail(
                new FetchFailedError({
                    service: args.service,
                    message: `${args.service} request timed out`,
                    cause: 'timeout',
                }),
            ),
        ),
    );
}

export function fetchJsonWithRetry<T = unknown>(
    args: FetchJsonArgs & {
        maxRetries?: number;
        baseDelay?: Duration.Input;
        recoverHttpError?: (error: UpstreamHttpError) => FetchHttpRecovery<T> | null;
    },
): Effect.Effect<T, FetchJsonError> {
    const maxRetries = Math.max(0, args.maxRetries ?? 3);
    const baseDelay = args.baseDelay ?? '200 millis';

    // performance.now(): this is a duration measurement, and Next 16 treats
    // Date.now() during prerendering as an unstable value (blocking-route error
    // when a cacheable route hits this before any dynamic data access).
    const started = performance.now();
    const endpoint = extractEndpoint(args.url);

    const request = Effect.retry(fetchJson<T>(args), {
        while: isRetryableFetchError,
        times: maxRetries,
        schedule: Schedule.exponential(baseDelay),
    }).pipe(
        Effect.map(value => ({ value, recovered: false as const })),
        Effect.catchTag('UpstreamHttpError', error => {
            const recovery = args.recoverHttpError?.(error) ?? null;
            if (!recovery) return Effect.fail(error);

            return Effect.succeed({
                value: recovery.value,
                recovered: true as const,
                status: error.status,
                outcome: recovery.outcome,
            });
        }),
    );

    return request.pipe(
        Effect.tap(result =>
            Effect.service(CurrentRequestId).pipe(
                Effect.map(requestId =>
                    emitExternalCall({
                        provider: args.service,
                        endpoint,
                        status: result.recovered ? result.status : null,
                        duration_ms: Math.round(performance.now() - started),
                        ok: true,
                        ...(result.recovered ? { recovered: true, outcome: result.outcome } : {}),
                        ...(requestId ? { request_id: requestId } : {}),
                    }),
                ),
            ),
        ),
        Effect.tapError(err =>
            Effect.service(CurrentRequestId).pipe(
                Effect.map(requestId =>
                    emitExternalCall({
                        provider: args.service,
                        endpoint,
                        status: extractStatus(err),
                        duration_ms: Math.round(performance.now() - started),
                        ok: false,
                        error_tag: extractErrorTag(err),
                        ...(requestId ? { request_id: requestId } : {}),
                    }),
                ),
            ),
        ),
        Effect.map(result => result.value),
        Effect.withSpan(`external.${args.service}`),
    );
}

function extractEndpoint(url: string): string {
    try {
        return new URL(url).pathname.replace(/\/+$/, '') || '/';
    } catch {
        return url.slice(0, 100);
    }
}

function extractStatus(err: unknown): number | null {
    if (!err || typeof err !== 'object') return null;
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
}

function extractErrorTag(err: unknown): string {
    if (!err || typeof err !== 'object') return 'unknown';
    const tag = (err as { _tag?: unknown })._tag;
    return typeof tag === 'string' ? tag : 'unknown';
}

interface ExternalCallEvent {
    provider: string;
    endpoint: string;
    status: number | null;
    duration_ms: number;
    ok: boolean;
    error_tag?: string;
    recovered?: boolean;
    outcome?: string;
    request_id?: string;
}

function emitExternalCall(fields: ExternalCallEvent): void {
    emitEvent({ event: 'external_call', ...fields });
}
