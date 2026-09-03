import 'server-only';

import { Cause, Effect } from 'effect';
import { NextResponse } from 'next/server';

import { runAfterResponse } from './after-response';

import { authenticateApiKey, logApiRequest } from '@/lib/cloudrun';
import { loadEnv } from '@/lib/env';
import { getRedisClient, type RedisClient } from '@/lib/redis';
import { slidingWindowLimit } from './sliding-window-rate-limit';
import { verifyPlaygroundProxyAuthHeader } from './playground-proxy-auth';
import {
    logApiError,
    logHttpRequest,
    logRateLimitDegraded,
    logUsageAggregationDegraded,
    normalizeEndpointPath,
} from '@/lib/http-metrics';
import {
    ForbiddenError,
    httpStatusForError,
    MissingEnvError,
    RateLimitedError,
    toApiErrorInfo,
    toErrorEnvelope,
    UnauthorizedError,
    CurrentRequestId,
} from '@tokens/effect';

export type RouteHandlerEffect<T> = Effect.Effect<T, unknown, never>;

export interface PlatformAuthContext {
    apiKeyId: string;
    keyPrefix: string;
    projectId: string;
    ownerClerkUserId: string;
    scopes: string[];
    limits?: {
        rateLimit?: { requests: number; windowSeconds: number };
        sustainedRateLimit?: { requests: number; windowSeconds: number };
        quota?: { requestsPerMonth: number };
    };
}

import { buildCacheControl, type CachePolicy } from './cache-control';

export { buildCacheControl, type CachePolicy } from './cache-control';

export interface RouteOptions {
    platform?: {
        requiredScopes?: string[];
    };
    /** Cache policy for 2xx responses. Absent → `no-store` (current default). Errors are always `no-store`. */
    cache?: CachePolicy;
}

type StripPlatformAuth<Ctx> = Ctx extends { platformAuth: unknown } ? Omit<Ctx, 'platformAuth'> : Ctx;

const LATENCY_BOUNDS_MS: ReadonlyArray<number> = [
    25, 50, 75, 100, 150, 200, 300, 400, 600, 1_000, 2_000, 5_000, 10_000,
];

/**
 * Resolve the active Redis client. Routes through `getRedisClient()` so the
 * `TOKENS_REDIS_TARGET=memorystore` flag (PR #189) flips us between Upstash
 * and Memorystore without touching callsites. Defaults to Upstash.
 */
export function getRedisClientEffect(): Effect.Effect<RedisClient, MissingEnvError, never> {
    return Effect.gen(function* () {
        const upstash = loadEnv().upstash;
        const target = (process.env.TOKENS_REDIS_TARGET ?? '').trim().toLowerCase();
        if (target !== 'memorystore' && !upstash) {
            return yield* Effect.fail(
                new MissingEnvError({
                    name: 'UPSTASH_REDIS_REST_URL',
                    message: 'Upstash Redis is not configured',
                }),
            );
        }

        return yield* Effect.try({
            try: () => getRedisClient(),
            catch: err =>
                new MissingEnvError({
                    name: target === 'memorystore' ? 'REDIS_HOST' : 'UPSTASH_REDIS_REST_URL',
                    message: err instanceof Error ? err.message : String(err),
                }),
        });
    });
}

function getMonthKeyUtc(now: Date): string {
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

function msUntilNextMonthUtc(now: Date): number {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const nextMonthStart = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
    return Math.max(0, nextMonthStart.getTime() - now.getTime());
}

function secondsUntilNextMonthUtc(now: Date): number {
    return Math.max(1, Math.ceil(msUntilNextMonthUtc(now) / 1000));
}

async function sha256Hex(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function hasAllScopes(scopes: string[], required: string[]): boolean {
    if (required.length === 0) return true;
    const set = new Set(scopes);
    for (const scope of required) if (!set.has(scope)) return false;
    return true;
}

function isPlatformAuthContext(value: unknown): value is PlatformAuthContext {
    if (!value || typeof value !== 'object') return false;
    const auth = value as Partial<PlatformAuthContext>;
    return (
        typeof auth.apiKeyId === 'string' &&
        typeof auth.keyPrefix === 'string' &&
        typeof auth.projectId === 'string' &&
        typeof auth.ownerClerkUserId === 'string' &&
        Array.isArray(auth.scopes) &&
        auth.scopes.every(scope => typeof scope === 'string')
    );
}

function getCachedPlatformAuth(keyHash: string): Effect.Effect<PlatformAuthContext | null, unknown> {
    return Effect.gen(function* () {
        const ttl = loadEnv().authCacheTtlSeconds;
        if (ttl <= 0) return null;

        const redis = yield* getRedisClientEffect();
        const cached = yield* Effect.tryPromise(() =>
            redis.get<string | PlatformAuthContext>(`api-auth:v1:${keyHash}`),
        );
        const value = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return isPlatformAuthContext(value) ? value : null;
    });
}

function cachePlatformAuth(keyHash: string, auth: PlatformAuthContext): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
        const ttl = loadEnv().authCacheTtlSeconds;
        if (ttl <= 0) return;

        const redis = yield* getRedisClientEffect();
        yield* Effect.tryPromise(() => redis.set(`api-auth:v1:${keyHash}`, JSON.stringify(auth), { ex: ttl }));
    });
}

function requirePlatformAuth(request: Request) {
    return Effect.gen(function* () {
        const rawKey = request.headers.get('x-api-key')?.trim() ?? '';

        if (rawKey) {
            const keyHash = yield* Effect.tryPromise(() => sha256Hex(rawKey));
            const cachedAuth = yield* getCachedPlatformAuth(keyHash).pipe(Effect.catch(() => Effect.succeed(null)));
            if (cachedAuth) return cachedAuth;

            const auth = yield* authenticateApiKey(keyHash);
            if (!auth) {
                return yield* Effect.fail(new UnauthorizedError({ message: 'Invalid API key' }));
            }

            const authContext = {
                apiKeyId: auth.apiKeyId,
                keyPrefix: auth.keyPrefix,
                projectId: auth.projectId,
                ownerClerkUserId: auth.ownerClerkUserId,
                scopes: auth.scopes,
                ...(auth.limits ? { limits: auth.limits } : {}),
            } satisfies PlatformAuthContext;

            yield* cachePlatformAuth(keyHash, authContext).pipe(Effect.catch(() => Effect.succeed(undefined)));

            return authContext;
        }

        const playgroundAuth = yield* Effect.tryPromise(() =>
            verifyPlaygroundProxyAuthHeader(request.headers.get('x-tokens-playground-auth')),
        );
        if (!playgroundAuth) {
            return yield* Effect.fail(new UnauthorizedError({ message: 'Missing API key' }));
        }
        return {
            apiKeyId: playgroundAuth.apiKeyId,
            keyPrefix: playgroundAuth.keyPrefix,
            projectId: playgroundAuth.projectId,
            ownerClerkUserId: playgroundAuth.ownerClerkUserId,
            scopes: playgroundAuth.scopes,
            ...(playgroundAuth.limits ? { limits: playgroundAuth.limits } : {}),
        } satisfies PlatformAuthContext;
    });
}

function enforceUpstashLimits(auth: PlatformAuthContext, redisOverride?: RedisClient) {
    return Effect.gen(function* () {
        const redis = redisOverride ?? (yield* getRedisClientEffect());

        const env = loadEnv();
        const rateLimitCfg = auth.limits?.rateLimit ?? env.defaultRateLimit;
        const sustainedCfg = auth.limits?.sustainedRateLimit ?? env.defaultSustainedRateLimit;

        const quotaCfg = auth.limits?.quota ?? env.defaultQuota;
        const now = new Date();
        const period = getMonthKeyUtc(now);
        const quotaKey = `quota:${auth.apiKeyId}:${period}`;

        // Run the sliding-window check and the quota accounting concurrently:
        // 1 round-trip of wall-clock instead of 3 sequential REST calls.
        // The quota INCR+EXPIRE share a single pipelined request; EXPIRE NX sets
        // the TTL only when none exists (fixes the `used === 1` TOCTOU).
        // Trade-off: rate-limited (429) requests still increment the quota.
        const [rate, sustained, [used]] = yield* Effect.all(
            [
                slidingWindowLimit({
                    redis,
                    identifier: `key:${auth.apiKeyId}`,
                    tokens: rateLimitCfg.requests,
                    windowSeconds: rateLimitCfg.windowSeconds,
                    // A hung Redis must not hold the request hostage; TimeoutError
                    // falls into the caller's fail-open catch (only RateLimitedError blocks).
                }).pipe(Effect.timeout('1 second')),
                slidingWindowLimit({
                    redis,
                    identifier: `key:${auth.apiKeyId}:sustained`,
                    tokens: sustainedCfg.requests,
                    windowSeconds: sustainedCfg.windowSeconds,
                }).pipe(Effect.timeout('1 second')),
                Effect.tryPromise(() =>
                    redis
                        .pipeline()
                        .incr(quotaKey)
                        .expire(quotaKey, secondsUntilNextMonthUtc(now), 'NX')
                        .exec<[number, 0 | 1]>(),
                ),
            ],
            { concurrency: 'unbounded' },
        );

        if (!rate.success) {
            const retryAfterMs = Math.max(0, rate.reset - Date.now());
            return yield* Effect.fail(
                new RateLimitedError({
                    service: 'rateLimit',
                    message: 'Rate limited',
                    retryAfterMs,
                }),
            );
        }

        if (!sustained.success) {
            const retryAfterMs = Math.max(0, sustained.reset - Date.now());
            return yield* Effect.fail(
                new RateLimitedError({
                    service: 'sustainedRateLimit',
                    message: 'Rate limited (sustained)',
                    retryAfterMs,
                }),
            );
        }

        if (used > quotaCfg.requestsPerMonth) {
            return yield* Effect.fail(
                new RateLimitedError({
                    service: 'quota',
                    message: 'Monthly quota exceeded',
                    retryAfterMs: msUntilNextMonthUtc(now),
                }),
            );
        }

        return {
            rateLimit: {
                limit: rate.limit,
                remaining: rate.remaining,
                resetMs: rate.reset,
            },
            quota: {
                limit: quotaCfg.requestsPerMonth,
                used,
                remaining: Math.max(0, quotaCfg.requestsPerMonth - used),
                resetMs: Date.now() + msUntilNextMonthUtc(now),
            },
        };
    });
}

function getRequestId(request: Request): string {
    const existing = request.headers.get('x-request-id')?.trim();
    if (existing) return existing;
    try {
        return crypto.randomUUID();
    } catch {
        return String(Date.now());
    }
}

function dateKeyUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function isAssetEndpoint(endpoint: string): boolean {
    return endpoint.startsWith('/api/v1/assets');
}

function binLatencyMs(latencyMs: number): number {
    const v = Number.isFinite(latencyMs) ? Math.max(0, Math.floor(latencyMs)) : 0;

    for (let i = 0; i < LATENCY_BOUNDS_MS.length; i++) {
        const bound = LATENCY_BOUNDS_MS[i] ?? 0;
        if (v <= bound) return i;
    }

    return LATENCY_BOUNDS_MS.length;
}

function statusClassField(status: number): 'status2xx' | 'status3xx' | 'status4xx' | 'status5xx' {
    if (status >= 200 && status < 300) return 'status2xx';
    if (status >= 300 && status < 400) return 'status3xx';
    if (status >= 400 && status < 500) return 'status4xx';
    return 'status5xx';
}

async function tryLogRequest(params: {
    platformAuth: PlatformAuthContext;
    method: string;
    path: string;
    status: number;
    latencyMs: number;
    ts: number;
    errorTag?: string;
}): Promise<void> {
    try {
        await Effect.runPromise(
            logApiRequest({
                projectId: params.platformAuth.projectId,
                apiKeyId: params.platformAuth.apiKeyId,
                keyPrefix: params.platformAuth.keyPrefix,
                method: params.method,
                path: params.path,
                endpoint: normalizeEndpointPath(params.path),
                status: params.status,
                latencyMs: params.latencyMs,
                ts: params.ts,
                ...(params.errorTag ? { errorTag: params.errorTag } : {}),
            }),
        );
    } catch {
        // Best-effort logging; never fail the API request due to analytics.
    }
}

function recordUsageAggregate(params: {
    requestId: string;
    platformAuth: PlatformAuthContext;
    method: string;
    path: string;
    status: number;
    latencyMs: number;
    ts: number;
}): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
        const env = loadEnv();
        const redis = yield* getRedisClientEffect();
        const endpoint = normalizeEndpointPath(params.path);
        const day = dateKeyUtc(params.ts);
        const endpointHash = yield* Effect.tryPromise(() => sha256Hex(endpoint));
        const ttl = env.usageAggregationTtlSeconds;
        const dayKey = `usage:v1:day:${day}:${params.platformAuth.projectId}`;
        const endpointKey = `usage:v1:endpoint:${day}:${params.platformAuth.projectId}:${endpointHash}`;
        const endpointNameKey = `usage:v1:endpoint-name:${endpointHash}`;
        const assetCallDelta = isAssetEndpoint(endpoint) ? 1 : 0;
        const successDelta = params.status < 400 ? 1 : 0;
        const latencyMs = Math.max(0, Math.floor(params.latencyMs));
        const statusField = statusClassField(params.status);
        const histogramField = `hist:${binLatencyMs(latencyMs)}`;

        yield* Effect.tryPromise(() =>
            redis
                .pipeline()
                .hincrby(dayKey, 'totalCalls', 1)
                .hincrby(dayKey, 'assetCalls', assetCallDelta)
                .hincrby(dayKey, 'successCalls', successDelta)
                .hincrby(dayKey, 'sumLatencyMs', latencyMs)
                .hincrby(dayKey, statusField, 1)
                .expire(dayKey, ttl)
                .hincrby(endpointKey, 'calls', 1)
                .hincrby(endpointKey, 'successCalls', successDelta)
                .hincrby(endpointKey, 'sumLatencyMs', latencyMs)
                .hincrby(endpointKey, statusField, 1)
                .hincrby(endpointKey, histogramField, 1)
                .expire(endpointKey, ttl)
                .set(endpointNameKey, endpoint, { ex: ttl })
                .exec(),
        );
    });
}

async function recordApiRequestUsage(params: {
    requestId: string;
    platformAuth: PlatformAuthContext;
    method: string;
    path: string;
    status: number;
    latencyMs: number;
    ts: number;
    errorTag?: string;
}): Promise<void> {
    const env = loadEnv();
    const shouldSampleRaw = env.usageRawSampleRate > 0 && Math.random() < env.usageRawSampleRate;

    if (env.usageLogMode === 'aggregated') {
        try {
            await Effect.runPromise(recordUsageAggregate(params));
        } catch (error) {
            logUsageAggregationDegraded({
                requestId: params.requestId,
                apiKeyId: params.platformAuth.apiKeyId,
                projectId: params.platformAuth.projectId,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    if (env.usageLogMode === 'raw' || shouldSampleRaw) {
        await tryLogRequest(params);
    }
}

function scheduleUsageRecording(params: {
    requestId: string;
    platformAuth: PlatformAuthContext | null;
    method: string;
    path: string | null;
    status: number;
    latencyMs: number;
    ts: number;
    errorTag?: string;
}): void {
    if (!params.platformAuth || !params.path) return;
    runAfterResponse(
        Effect.tryPromise(() =>
            recordApiRequestUsage({
                requestId: params.requestId,
                platformAuth: params.platformAuth as PlatformAuthContext,
                method: params.method,
                path: params.path as string,
                status: params.status,
                latencyMs: params.latencyMs,
                ts: params.ts,
                ...(params.errorTag ? { errorTag: params.errorTag } : {}),
            }),
        ).pipe(Effect.catch(() => Effect.void)),
    );
}

/**
 * Wrap an Effect-based handler into a Next.js route handler with:
 * - standardized JSON success responses
 * - standardized JSON error envelope + status codes
 * - optional platform API-key auth + scope enforcement
 * - structured logging (latency, endpoint, auth context)
 * - abort propagation via `request.signal`
 */
export function route<T, Ctx = unknown>(
    handler: (request: Request, ctx: Ctx) => RouteHandlerEffect<T>,
    options: RouteOptions = {},
): (request: Request, ctx: StripPlatformAuth<Ctx>) => Promise<Response> {
    return async function handle(request: Request, ctx: StripPlatformAuth<Ctx>): Promise<Response> {
        const requestId = getRequestId(request);
        const startedAt = Date.now();

        let platformAuth: PlatformAuthContext | null = null;
        let limitMeta: { rateLimit: unknown; quota: unknown } | null = null;

        const requiredScopes = options.platform?.requiredScopes ?? [];

        const effect = options.platform
            ? requirePlatformAuth(request).pipe(
                  Effect.tap(auth =>
                      Effect.sync(() => {
                          platformAuth = auth;
                      }),
                  ),
                  Effect.flatMap(auth =>
                      enforceUpstashLimits(auth).pipe(
                          Effect.tap(meta =>
                              Effect.sync(() => {
                                  limitMeta = meta as unknown as { rateLimit: unknown; quota: unknown };
                              }),
                          ),
                          // Fail open: only RateLimitedError (a real 429) blocks the request.
                          // Any other failure (Redis down, missing env, timeout) is logged as a
                          // degradation metric and the request proceeds without limit metadata.
                          Effect.catch(error =>
                              error instanceof RateLimitedError
                                  ? Effect.fail(error)
                                  : Effect.sync(() => {
                                        logRateLimitDegraded({
                                            requestId,
                                            apiKeyId: auth.apiKeyId,
                                            projectId: auth.projectId,
                                            reason: error instanceof Error ? error.message : String(error),
                                        });
                                    }),
                          ),
                          Effect.as(auth),
                      ),
                  ),
                  Effect.flatMap(auth =>
                      hasAllScopes(auth.scopes, requiredScopes)
                          ? Effect.succeed(auth)
                          : Effect.fail(
                                new ForbiddenError({
                                    message: 'Insufficient scope',
                                    details: { required: requiredScopes, granted: auth.scopes },
                                }),
                            ),
                  ),
                  Effect.flatMap(auth => handler(request, { ...(ctx as object), platformAuth: auth } as Ctx)),
              )
            : handler(request, ctx as Ctx);

        const exit = await Effect.runPromiseExit(effect.pipe(Effect.provideService(CurrentRequestId, requestId)), {
            signal: request.signal,
        });

        const latencyMs = Date.now() - startedAt;
        const url = (() => {
            try {
                return new URL(request.url);
            } catch {
                return null;
            }
        })();

        if (exit._tag === 'Success') {
            const res = NextResponse.json(exit.value, {
                headers: { 'Cache-Control': buildCacheControl(options.cache), 'x-request-id': requestId },
            });

            const auth = platformAuth as PlatformAuthContext | null;
            const meta = limitMeta as { rateLimit: unknown; quota: unknown } | null;

            logHttpRequest({
                requestId,
                method: request.method,
                path: url?.pathname ?? null,
                status: 200,
                durationMs: latencyMs,
                source: 'route',
                ...(auth
                    ? {
                          authType: 'api_key' as const,
                          apiKeyId: auth.apiKeyId,
                          keyPrefix: auth.keyPrefix,
                          projectId: auth.projectId,
                          scopes: auth.scopes,
                      }
                    : { authType: 'public' as const }),
                ...(meta ? { rateLimit: meta.rateLimit, quota: meta.quota } : {}),
            });

            scheduleUsageRecording({
                requestId,
                platformAuth,
                method: request.method,
                path: url?.pathname ?? null,
                status: 200,
                latencyMs,
                ts: startedAt,
            });

            return res;
        }

        const failures = exit.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error);
        const firstFailure = failures[0];

        if (firstFailure !== undefined) {
            const status = httpStatusForError(firstFailure);
            const info = toApiErrorInfo(firstFailure);

            const auth = platformAuth as PlatformAuthContext | null;
            const meta = limitMeta as { rateLimit: unknown; quota: unknown } | null;

            logHttpRequest({
                requestId,
                method: request.method,
                path: url?.pathname ?? null,
                status,
                durationMs: latencyMs,
                source: 'route',
                authType: auth ? 'api_key' : 'public',
                authFailure: status === 401 || status === 403,
                ...(auth
                    ? {
                          apiKeyId: auth.apiKeyId,
                          keyPrefix: auth.keyPrefix,
                          projectId: auth.projectId,
                          scopes: auth.scopes,
                      }
                    : {}),
                ...(meta ? { rateLimit: meta.rateLimit, quota: meta.quota } : {}),
            });

            logApiError({
                requestId,
                method: request.method,
                path: url?.pathname ?? null,
                status,
                durationMs: latencyMs,
                errorType: info._tag,
                errorMessage: info.message,
                source: 'route',
                authType: auth ? 'api_key' : 'public',
                authFailure: status === 401 || status === 403,
                ...(auth
                    ? {
                          apiKeyId: auth.apiKeyId,
                          keyPrefix: auth.keyPrefix,
                          projectId: auth.projectId,
                          scopes: auth.scopes,
                      }
                    : {}),
                ...(meta ? { rateLimit: meta.rateLimit, quota: meta.quota } : {}),
            });

            scheduleUsageRecording({
                requestId,
                platformAuth,
                method: request.method,
                path: url?.pathname ?? null,
                status,
                latencyMs,
                ts: startedAt,
                errorTag: info._tag,
            });

            return NextResponse.json(toErrorEnvelope(firstFailure), {
                status,
                headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId },
            });
        }

        // Unexpected defect / interruption - log for server visibility, but keep response safe.
        const prettyCause = Cause.pretty(exit.cause);
        console.error(prettyCause);

        const auth = platformAuth as PlatformAuthContext | null;
        const meta = limitMeta as { rateLimit: unknown; quota: unknown } | null;

        logHttpRequest({
            requestId,
            method: request.method,
            path: url?.pathname ?? null,
            status: 500,
            durationMs: latencyMs,
            source: 'route',
            authType: auth ? 'api_key' : 'public',
            ...(auth
                ? {
                      apiKeyId: auth.apiKeyId,
                      keyPrefix: auth.keyPrefix,
                      projectId: auth.projectId,
                      scopes: auth.scopes,
                  }
                : {}),
            ...(meta ? { rateLimit: meta.rateLimit, quota: meta.quota } : {}),
        });

        logApiError({
            requestId,
            method: request.method,
            path: url?.pathname ?? null,
            status: 500,
            durationMs: latencyMs,
            errorType: 'InternalServerError',
            errorMessage: prettyCause.split('\n', 1)[0] || 'unknown defect',
            errorStack: prettyCause,
            source: 'route',
            authType: auth ? 'api_key' : 'public',
            ...(auth
                ? {
                      apiKeyId: auth.apiKeyId,
                      keyPrefix: auth.keyPrefix,
                      projectId: auth.projectId,
                      scopes: auth.scopes,
                  }
                : {}),
            ...(meta ? { rateLimit: meta.rateLimit, quota: meta.quota } : {}),
        });

        scheduleUsageRecording({
            requestId,
            platformAuth,
            method: request.method,
            path: url?.pathname ?? null,
            status: 500,
            latencyMs,
            ts: startedAt,
            errorTag: 'InternalServerError',
        });

        return NextResponse.json(toErrorEnvelope({ _tag: 'InternalServerError', message: 'Internal server error' }), {
            status: 500,
            headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId },
        });
    };
}

/** @internal test-only exports for the auth/limits hot-path matrices. */
export const __internals = {
    requirePlatformAuth,
    enforceUpstashLimits,
    getCachedPlatformAuth,
    cachePlatformAuth,
};
