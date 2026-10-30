/**
 * `apiKeysAuthenticateAndEnforce`: the two per-request hot-path calls from
 * apps/api (`apiKeysAuthenticate` + `limitsEnforce`) in one round-trip.
 *
 * Semantics are the composition of the two existing handlers, unchanged:
 * - auth is `authenticateApiKey` verbatim; `null` means "invalid key".
 * - limits are `limitsEnforce` verbatim, with the per-field merge that
 *   apps/api performs today (`auth.limits?.X ?? defaults.X`, where
 *   `auth.limits` is the raw project jsonb). apps/api keeps owning the
 *   defaults, so the rate-limit / quota metadata it logs is identical.
 * - the limits half NEVER throws: a Redis error, a malformed project limit,
 *   a missing REDIS_HOST, or a timeout becomes `limits: null` with a reason,
 *   so apps/api can keep failing open on limits while failing closed on auth.
 *   Only invalid *defaults* (an apps/api misconfiguration) are a 400.
 */

import { InvalidArgsError } from './errors';
import { decodeQuota, decodeWindow, limitsEnforce, type LimitsEnforceResult } from './limits';
import { authenticateApiKey, type ApiKeyAuthContext, type PlatformAuthRepo } from './platformAuth';
import type { LimitsRedis } from '../redis';

export interface AuthenticateAndEnforceDeps {
    platformAuth: PlatformAuthRepo;
    limitsRedis?: LimitsRedis;
    /** Bound on the limits half; auth is not bounded here (the caller's timeout applies). */
    limitsTimeoutMs?: number;
    now?: () => number;
}

export type AuthenticateAndEnforceResult =
    { auth: null } | { auth: ApiKeyAuthContext; limits: LimitsEnforceResult | null; limitsError?: string };

const DEFAULT_LIMITS_TIMEOUT_MS = 1_500;

function requireObject(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null) throw new InvalidArgsError('args must be an object');
    return args as Record<string, unknown>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`limitsEnforce timed out after ${ms}ms`)), ms);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export async function apiKeysAuthenticateAndEnforce(
    deps: AuthenticateAndEnforceDeps,
    rawArgs: unknown,
): Promise<AuthenticateAndEnforceResult> {
    const a = requireObject(rawArgs);
    if (typeof a.keyHash !== 'string') throw new InvalidArgsError('keyHash must be a string');
    const defaultsRaw = requireObject(a.defaults);
    const defaults = {
        rateLimit: decodeWindow(defaultsRaw.rateLimit, 'defaults.rateLimit'),
        sustainedRateLimit: decodeWindow(defaultsRaw.sustainedRateLimit, 'defaults.sustainedRateLimit'),
        quota: decodeQuota(defaultsRaw.quota),
    };

    const auth = await authenticateApiKey(deps.platformAuth, { keyHash: a.keyHash });
    if (!auth) return { auth: null };

    const redis = deps.limitsRedis;
    if (!redis) return { auth, limits: null, limitsError: 'limitsEnforce: REDIS_HOST not configured' };

    // Per-field merge, exactly as apps/api does it: a field present on the
    // project wins, otherwise the apps/api default.
    const projectLimits = (auth.limits ?? {}) as Record<string, unknown>;
    const limitsArgs = {
        apiKeyId: auth.apiKeyId,
        rateLimit: projectLimits.rateLimit ?? defaults.rateLimit,
        sustainedRateLimit: projectLimits.sustainedRateLimit ?? defaults.sustainedRateLimit,
        quota: projectLimits.quota ?? defaults.quota,
    };

    try {
        const limits = await withTimeout(
            limitsEnforce({ redis, ...(deps.now ? { now: deps.now } : {}) }, limitsArgs),
            deps.limitsTimeoutMs ?? DEFAULT_LIMITS_TIMEOUT_MS,
        );
        return { auth, limits };
    } catch (error) {
        return { auth, limits: null, limitsError: error instanceof Error ? error.message : String(error) };
    }
}
