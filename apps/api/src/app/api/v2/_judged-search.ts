/**
 * Shared request parsing + pipeline runner for the judged-search family:
 * `GET /v2/search`, `GET /v2/resolve`, and the curator-facing
 * `GET /v2/lists/search-tokens`. One parser means one documented flag set —
 * a preset `policy` plus per-gate overrides — across all three.
 */

import { Effect } from 'effect';

import { BadRequestError, decodeLimit } from '@tokens/effect';

import { gatherCandidates, type CandidateSourcesStatus } from '@/lib/judgment/candidates';
import { classifyQuery } from '@/lib/judgment/intent';
import { judgeCandidates } from '@/lib/judgment/pipeline';
import {
    applyGateOverrides,
    parsePolicyId,
    POLICIES,
    POLICY_IDS,
    type GateOverrideKey,
    type GateOverrides,
    type PolicyDocument,
    type PolicyId,
} from '@/lib/judgment/policies';
import { getProtectedSymbolIndex } from '@/lib/judgment/protected-symbols';
import type { EnrichedCandidate, JudgedToken, QueryInterpretation, SuppressedToken } from '@/lib/judgment/types';

export const MAX_QUERY_LENGTH = 100;
export const DEFAULT_SEARCH_LIMIT = '10';
export const MAX_SEARCH_LIMIT = 50;

export interface JudgedSearchParams {
    q: string;
    policyId: PolicyId;
    /** Preset with request overrides applied. */
    policy: PolicyDocument;
    /** Gate keys the request actually overrode (echoed in responses). */
    overrides: GateOverrideKey[];
    limit: number;
    includeSuppressed: boolean;
}

export interface ParseOptions {
    /** Preset used when `policy` is absent. */
    defaultPolicy: PolicyId;
    /** Parse `includeSuppressed` (default `true` when honoured; ignored otherwise). */
    allowIncludeSuppressed?: boolean;
}

/** Public shape of the effective policy: preset id, effective gates, and what was tuned. */
export interface PolicyEnvelope {
    id: PolicyId;
    gates: PolicyDocument['gates'];
    overrides: GateOverrideKey[];
}

export function policyEnvelope(params: Pick<JudgedSearchParams, 'policyId' | 'policy' | 'overrides'>): PolicyEnvelope {
    return { id: params.policyId, gates: params.policy.gates, overrides: params.overrides };
}

const NONE_VALUES = new Set(['none', 'null', 'off']);
const TRUE_VALUES = new Set(['true', '1', 'yes']);
const FALSE_VALUES = new Set(['false', '0', 'no']);

function rawParam(url: URL, key: string): string | undefined {
    const value = url.searchParams.get(key);
    if (value === null) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

function badRequest(message: string, details?: Record<string, unknown>) {
    return Effect.fail(new BadRequestError({ message, ...(details ? { details } : {}) }));
}

function parseBooleanParam(url: URL, key: string): Effect.Effect<boolean | undefined, BadRequestError> {
    const raw = rawParam(url, key);
    if (raw === undefined) return Effect.succeed(undefined);
    const lower = raw.toLowerCase();
    if (TRUE_VALUES.has(lower)) return Effect.succeed(true);
    if (FALSE_VALUES.has(lower)) return Effect.succeed(false);
    return badRequest(`Invalid ${key}: expected true or false`);
}

function parseGateNumberParam(
    url: URL,
    key: string,
    rules: { integer: boolean; min: number; max?: number },
): Effect.Effect<number | null | undefined, BadRequestError> {
    const raw = rawParam(url, key);
    if (raw === undefined) return Effect.succeed(undefined);
    if (NONE_VALUES.has(raw.toLowerCase())) return Effect.succeed(null);
    const value = Number(raw);
    const bounds = rules.max === undefined ? `>= ${rules.min}` : `between ${rules.min} and ${rules.max}`;
    const kind = rules.integer ? 'an integer' : 'a number';
    if (!Number.isFinite(value) || (rules.integer && !Number.isInteger(value))) {
        return badRequest(`Invalid ${key}: expected ${kind} ${bounds}, or "none" to disable the gate`);
    }
    if (value < rules.min || (rules.max !== undefined && value > rules.max)) {
        return badRequest(`Invalid ${key}: expected ${kind} ${bounds}, or "none" to disable the gate`);
    }
    return Effect.succeed(value);
}

export function parseJudgedSearchParams(
    url: URL,
    options: ParseOptions,
): Effect.Effect<JudgedSearchParams, BadRequestError> {
    return Effect.gen(function* () {
        const q = (url.searchParams.get('q') ?? '').trim();
        if (!q) {
            return yield* badRequest('Missing required query param: q');
        }
        if (q.length > MAX_QUERY_LENGTH) {
            return yield* badRequest(`Query too long (max ${MAX_QUERY_LENGTH} characters)`);
        }

        const rawPolicy = url.searchParams.get('policy');
        const policyId =
            rawPolicy === null || rawPolicy.trim() === '' ? options.defaultPolicy : parsePolicyId(rawPolicy);
        if (!policyId) {
            return yield* badRequest(`Invalid policy: ${rawPolicy}`, { policies: POLICY_IDS });
        }

        const overrides: GateOverrides = {};
        const minLiquidityUsd = yield* parseGateNumberParam(url, 'minLiquidityUsd', { integer: false, min: 0 });
        if (minLiquidityUsd !== undefined) overrides.minLiquidityUsd = minLiquidityUsd;
        const minAgeDays = yield* parseGateNumberParam(url, 'minAgeDays', { integer: true, min: 0 });
        if (minAgeDays !== undefined) overrides.minAgeDays = minAgeDays;
        const minMarketScore = yield* parseGateNumberParam(url, 'minMarketScore', { integer: true, min: 0, max: 100 });
        if (minMarketScore !== undefined) overrides.minMarketScore = minMarketScore;
        const requireMarketData = yield* parseBooleanParam(url, 'requireMarketData');
        if (requireMarketData !== undefined) overrides.requireMarketData = requireMarketData;
        const suppressImpersonation = yield* parseBooleanParam(url, 'suppressImpersonation');
        if (suppressImpersonation !== undefined) overrides.suppressImpersonation = suppressImpersonation;
        const verifiedOnly = yield* parseBooleanParam(url, 'verifiedOnly');
        if (verifiedOnly !== undefined) overrides.requireRegistry = verifiedOnly;

        const limit = yield* decodeLimit(url.searchParams.get('limit'), {
            defaultValue: DEFAULT_SEARCH_LIMIT,
            max: MAX_SEARCH_LIMIT,
        });

        const includeSuppressed = options.allowIncludeSuppressed
            ? ((yield* parseBooleanParam(url, 'includeSuppressed')) ?? true)
            : true;

        const applied = applyGateOverrides(POLICIES[policyId], overrides);

        return {
            q,
            policyId,
            policy: applied.policy,
            overrides: applied.overrides,
            limit,
            includeSuppressed,
        };
    });
}

export interface JudgedSearchOutput {
    interpretation: QueryInterpretation;
    candidates: EnrichedCandidate[];
    sources: CandidateSourcesStatus;
    results: JudgedToken[];
    suppressed: SuppressedToken[];
    latencyMs: number;
}

/** intent → candidates (I/O) → protected index → pure judgment. */
export function runJudgedSearch(params: {
    q: string;
    policy: PolicyDocument;
    limit: number;
}): Effect.Effect<JudgedSearchOutput, unknown> {
    return Effect.gen(function* () {
        const startedAt = Date.now();
        const interpretation = classifyQuery(params.q);
        const { candidates, sources } = yield* gatherCandidates(params.q, interpretation);
        const protectedIndex = yield* Effect.promise(() => getProtectedSymbolIndex());
        const { results, suppressed } = judgeCandidates(candidates, interpretation, params.policy, protectedIndex, {
            nowMs: Date.now(),
            limit: params.limit,
        });
        return { interpretation, candidates, sources, results, suppressed, latencyMs: Date.now() - startedAt };
    });
}

export type VerifiedJudgedToken = JudgedToken & { verified: boolean };

/** `verified` = a canonical-registry variant exists for the mint. */
export function withVerified<T extends JudgedToken>(
    results: readonly T[],
    candidates: readonly EnrichedCandidate[],
): Array<T & { verified: boolean }> {
    const candidateByMint = new Map(candidates.map(candidate => [candidate.mint, candidate] as const));
    return results.map(result => ({ ...result, verified: candidateByMint.get(result.mint)?.registry != null }));
}
