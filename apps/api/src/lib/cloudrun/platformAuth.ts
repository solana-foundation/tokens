import { Effect } from 'effect';

import { cloudRunMutation, cloudRunQuery } from './client';
import { isCloudRunFrontendNotFound, type CloudRunError } from './errors';

/**
 * Platform API-key auth + usage logging on the authenticated `/v1` hot path
 * (`src/effect/next-route.ts`). Routes to the `cloudrun-usage` service
 * (`apiKeysAuthenticate` / `logApiRequest` / `syncUsageAggregates`), which
 * ports the previous Convex semantics 1:1 against Cloud SQL.
 */

export interface AuthenticateApiKeyResult {
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

/**
 * One immediate replay when Cloud Run's frontend dropped the request with its
 * own 404 (see `isCloudRunFrontendNotFound`). Applied to the per-request usage
 * hops only: each is on the critical path of every keyed request, so one
 * dropped call must not become a 500 (or silently disable rate limiting).
 * Nothing else is retried here — timeouts and 5xx keep today's semantics.
 */
function retryFrontendNotFoundOnce<A>(effect: Effect.Effect<A, CloudRunError>): Effect.Effect<A, CloudRunError> {
    return Effect.retry(effect, { while: isCloudRunFrontendNotFound, times: 1 });
}

export function authenticateApiKey(
    keyHash: string,
): Effect.Effect<AuthenticateApiKeyResult | null, CloudRunError> {
    return retryFrontendNotFoundOnce(
        cloudRunQuery<AuthenticateApiKeyResult | null>('usage', 'apiKeysAuthenticate', {
            keyHash,
        }),
    );
}

export interface LogApiRequestArgs {
    projectId: string;
    apiKeyId: string;
    keyPrefix: string;
    method: string;
    path: string;
    endpoint: string;
    status: number;
    latencyMs: number;
    ts: number;
    errorTag?: string;
}

export function logApiRequest(args: LogApiRequestArgs): Effect.Effect<void, CloudRunError> {
    return cloudRunMutation('usage', 'logApiRequest', { ...args }).pipe(Effect.asVoid);
}

export interface LimitsEnforceArgs {
    apiKeyId: string;
    rateLimit: { requests: number; windowSeconds: number };
    sustainedRateLimit: { requests: number; windowSeconds: number };
    quota: { requestsPerMonth: number };
}

export type LimitsEnforceResult =
    | {
          allowed: true;
          rateLimit: { limit: number; remaining: number; resetMs: number };
          quota: { limit: number; used: number; remaining: number; resetMs: number };
      }
    | {
          allowed: false;
          service: 'rateLimit' | 'sustainedRateLimit' | 'quota';
          retryAfterMs: number;
      };

export function limitsEnforce(args: LimitsEnforceArgs): Effect.Effect<LimitsEnforceResult, CloudRunError> {
    return retryFrontendNotFoundOnce(
        cloudRunMutation<LimitsEnforceResult>('usage', 'limitsEnforce', { ...args }, { timeoutMs: 1500 }),
    );
}

export interface AuthenticateAndEnforceArgs {
    keyHash: string;
    /** apps/api owns the defaults; the server merges them per field like `enforceCloudRunLimits`. */
    defaults: Omit<LimitsEnforceArgs, 'apiKeyId'>;
}

export type AuthenticateAndEnforceResult =
    | { auth: null }
    | { auth: AuthenticateApiKeyResult; limits: LimitsEnforceResult | null; limitsError?: string };

/**
 * `apiKeysAuthenticate` + `limitsEnforce` in one round-trip. Deliberately a
 * mutation (it increments counters; the client never retries it — the only
 * replay is the frontend-404 one, which the service never saw) with the
 * client's default auth timeout: the 1.5 s bound lives server-side on the
 * limits half, so a slow Redis cannot turn auth fail-closed.
 */
export function authenticateAndEnforce(
    args: AuthenticateAndEnforceArgs,
): Effect.Effect<AuthenticateAndEnforceResult, CloudRunError> {
    return retryFrontendNotFoundOnce(
        cloudRunMutation<AuthenticateAndEnforceResult>('usage', 'apiKeysAuthenticateAndEnforce', { ...args }),
    );
}

/**
 * Running totals for a (project, day), or a (project, day, endpoint) when
 * `endpoint` is set. Totals, not deltas: the usage service keeps the larger of
 * the stored and the incoming value, so sending a bucket twice is harmless.
 */
export interface UsageAggregateBucket {
    projectId: string;
    day: string;
    endpoint?: string;
    totalCalls: number;
    assetCalls?: number;
    successCalls: number;
    sumLatencyMs: number;
    latencyHistogram?: number[];
}

export function syncUsageAggregates(buckets: UsageAggregateBucket[]): Effect.Effect<void, CloudRunError> {
    return cloudRunMutation('usage', 'syncUsageAggregates', { buckets }).pipe(Effect.asVoid);
}
