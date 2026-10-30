import { Effect } from 'effect';

import { cloudRunMutation, cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

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

export function authenticateApiKey(
    keyHash: string,
): Effect.Effect<AuthenticateApiKeyResult | null, CloudRunError> {
    return cloudRunQuery<AuthenticateApiKeyResult | null>('usage', 'apiKeysAuthenticate', {
        keyHash,
    });
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
    return cloudRunMutation<LimitsEnforceResult>('usage', 'limitsEnforce', { ...args }, { timeoutMs: 1500 });
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
 * mutation (it increments counters; never retried) with the client's default
 * auth timeout: the 1.5 s bound lives server-side on the limits half, so a
 * slow Redis cannot turn auth fail-closed.
 */
export function authenticateAndEnforce(
    args: AuthenticateAndEnforceArgs,
): Effect.Effect<AuthenticateAndEnforceResult, CloudRunError> {
    return cloudRunMutation<AuthenticateAndEnforceResult>('usage', 'apiKeysAuthenticateAndEnforce', { ...args });
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
