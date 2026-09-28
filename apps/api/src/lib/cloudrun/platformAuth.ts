import { Effect } from 'effect';

import { cloudRunMutation, cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

/**
 * Platform API-key auth + usage logging on the authenticated `/v1` hot path
 * (`src/effect/next-route.ts`). Routes to the `cloudrun-usage` service
 * (`apiKeysAuthenticate` / `logApiRequest` / `ingestUsageAggregates`), which
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

/** A drained usage bucket: per-project daily, or per-endpoint when `endpoint` is set. */
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

export function ingestUsageAggregates(buckets: UsageAggregateBucket[]): Effect.Effect<void, CloudRunError> {
    return cloudRunMutation('usage', 'ingestUsageAggregates', { buckets }).pipe(Effect.asVoid);
}
