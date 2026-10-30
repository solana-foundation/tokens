/**
 * Shared request parsing + pipeline runner for the judged-search family:
 * `GET /v2/search`, `GET /v2/resolve`, and the curator-facing
 * `GET /v2/lists/search-tokens`. One parser means one documented flag set —
 * a preset `policy` plus per-gate overrides — across all three.
 */

import { Effect } from 'effect';

import { BadRequestError, decodeLimit, emitEvent } from '@tokens/effect';

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
    /**
     * `false` lets `q` be absent (judge: the caller brings candidates, the
     * query only sharpens match scoring). Default `true`.
     */
    requireQuery?: boolean;
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

/** Reads one raw request parameter: a query-string value, or a JSON body field stringified. */
export type ParamGetter = (key: string) => string | null;

export function paramsFromUrl(url: URL): ParamGetter {
    return key => url.searchParams.get(key);
}

/** Every flag the judged-search parser reads; a body may carry them as scalars. */
export const JUDGED_PARAM_KEYS = [
    'q',
    'policy',
    'minLiquidityUsd',
    'minAgeDays',
    'minMarketScore',
    'requireMarketData',
    'suppressImpersonation',
    'verifiedOnly',
    'suppressUnsafeAuthorities',
    'limit',
    'includeSuppressed',
] as const;

/**
 * A body flag that is an object or array is malformed, not absent: silently
 * ignoring `verifiedOnly: [true]` would widen the result set the caller
 * asked to narrow. Rejected before parsing with the key named.
 */
export function rejectNonScalarParams(body: Record<string, unknown>): Effect.Effect<void, BadRequestError> {
    for (const key of JUDGED_PARAM_KEYS) {
        const value = body[key];
        if (value === undefined || value === null) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') continue;
        return badRequest(`Invalid ${key}: expected a string, number or boolean`, {
            code: 'invalid_param',
            param: key,
        });
    }
    return Effect.void;
}

/**
 * Body fields as parameters: numbers and booleans are stringified so the same
 * validators (and the same error messages) apply to `?minLiquidityUsd=1000`
 * and `{ "minLiquidityUsd": 1000 }`. Call `rejectNonScalarParams` first;
 * anything else here is treated as absent.
 */
export function paramsFromBody(body: Record<string, unknown>): ParamGetter {
    return key => {
        const value = body[key];
        if (value === undefined || value === null) return null;
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return null;
    };
}

const NONE_VALUES = new Set(['none', 'null', 'off']);
const TRUE_VALUES = new Set(['true', '1', 'yes']);
const FALSE_VALUES = new Set(['false', '0', 'no']);

function rawParam(get: ParamGetter, key: string): string | undefined {
    const value = get(key);
    if (value === null) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

function badRequest(message: string, details?: Record<string, unknown>) {
    return Effect.fail(new BadRequestError({ message, ...(details ? { details } : {}) }));
}

function parseBooleanParam(get: ParamGetter, key: string): Effect.Effect<boolean | undefined, BadRequestError> {
    const raw = rawParam(get, key);
    if (raw === undefined) return Effect.succeed(undefined);
    const lower = raw.toLowerCase();
    if (TRUE_VALUES.has(lower)) return Effect.succeed(true);
    if (FALSE_VALUES.has(lower)) return Effect.succeed(false);
    return badRequest(`Invalid ${key}: expected true or false`);
}

function parseGateNumberParam(
    get: ParamGetter,
    key: string,
    rules: { integer: boolean; min: number; max?: number },
): Effect.Effect<number | null | undefined, BadRequestError> {
    const raw = rawParam(get, key);
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
    return parseJudgedParams(paramsFromUrl(url), options);
}

/** Same flag set over any parameter source (query string or JSON body). */
export function parseJudgedParams(
    get: ParamGetter,
    options: ParseOptions,
): Effect.Effect<JudgedSearchParams, BadRequestError> {
    return Effect.gen(function* () {
        const q = (get('q') ?? '').trim();
        if (!q && options.requireQuery !== false) {
            return yield* badRequest('Missing required query param: q');
        }
        if (q.length > MAX_QUERY_LENGTH) {
            return yield* badRequest(`Query too long (max ${MAX_QUERY_LENGTH} characters)`);
        }

        const rawPolicy = get('policy');
        const policyId =
            rawPolicy === null || rawPolicy.trim() === '' ? options.defaultPolicy : parsePolicyId(rawPolicy);
        if (!policyId) {
            return yield* badRequest(`Invalid policy: ${rawPolicy}`, { policies: POLICY_IDS });
        }

        const overrides: GateOverrides = {};
        const minLiquidityUsd = yield* parseGateNumberParam(get, 'minLiquidityUsd', { integer: false, min: 0 });
        if (minLiquidityUsd !== undefined) overrides.minLiquidityUsd = minLiquidityUsd;
        const minAgeDays = yield* parseGateNumberParam(get, 'minAgeDays', { integer: true, min: 0 });
        if (minAgeDays !== undefined) overrides.minAgeDays = minAgeDays;
        const minMarketScore = yield* parseGateNumberParam(get, 'minMarketScore', { integer: true, min: 0, max: 100 });
        if (minMarketScore !== undefined) overrides.minMarketScore = minMarketScore;
        const requireMarketData = yield* parseBooleanParam(get, 'requireMarketData');
        if (requireMarketData !== undefined) overrides.requireMarketData = requireMarketData;
        const suppressImpersonation = yield* parseBooleanParam(get, 'suppressImpersonation');
        if (suppressImpersonation !== undefined) overrides.suppressImpersonation = suppressImpersonation;
        const verifiedOnly = yield* parseBooleanParam(get, 'verifiedOnly');
        if (verifiedOnly !== undefined) overrides.requireRegistry = verifiedOnly;
        const suppressUnsafeAuthorities = yield* parseBooleanParam(get, 'suppressUnsafeAuthorities');
        if (suppressUnsafeAuthorities !== undefined) overrides.suppressUnsafeAuthorities = suppressUnsafeAuthorities;

        const limit = yield* decodeLimit(get('limit'), {
            defaultValue: DEFAULT_SEARCH_LIMIT,
            max: MAX_SEARCH_LIMIT,
        });

        const includeSuppressed = options.allowIncludeSuppressed
            ? ((yield* parseBooleanParam(get, 'includeSuppressed')) ?? true)
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

export type JudgedRoute = 'search' | 'resolve' | 'lists.search-tokens' | 'judge';

/**
 * intent → candidates (cached collect + live enrich) → protected index →
 * pure judgment. `budget` is the route's provider-budget charge; it runs only
 * when the raw candidate set is not served from cache, which is what makes
 * "repeat queries are free" true.
 *
 * Emits one `judged_search` event per call so cache hit rate, provider
 * degradation and the collect/enrich split are a single Loki query.
 */
export function runJudgedSearch(params: {
    route: JudgedRoute;
    q: string;
    policy: PolicyDocument;
    limit: number;
    budget?: Effect.Effect<void, unknown>;
}): Effect.Effect<JudgedSearchOutput, unknown> {
    return Effect.gen(function* () {
        const startedAt = Date.now();
        const interpretation = classifyQuery(params.q);
        const { candidates, sources, providerOutcome, timing } = yield* gatherCandidates(params.q, interpretation, {
            budget: params.budget,
        });
        const { results, suppressed } = yield* judgeEnriched(candidates, interpretation, params.policy, params.limit);
        const latencyMs = Date.now() - startedAt;
        emitEvent({
            event: 'judged_search',
            route: params.route,
            intent: interpretation.intent,
            cache: sources.cache,
            provider: sources.provider,
            provider_outcome: providerOutcome,
            db: sources.db,
            candidates: candidates.length,
            results: results.length,
            suppressed: suppressed.length,
            collect_ms: timing.collectMs,
            enrich_ms: timing.enrichMs,
            duration_ms: latencyMs,
        });
        return { interpretation, candidates, sources, results, suppressed, latencyMs };
    });
}

/** Protected index → pure judgment. Shared by the gathered routes and `POST /v2/judge`. */
export function judgeEnriched(
    candidates: EnrichedCandidate[],
    interpretation: QueryInterpretation,
    policy: PolicyDocument,
    limit: number,
): Effect.Effect<{ results: JudgedToken[]; suppressed: SuppressedToken[] }, never> {
    return getProtectedSymbolIndex().pipe(
        Effect.map(protectedIndex =>
            judgeCandidates(candidates, interpretation, policy, protectedIndex, { nowMs: Date.now(), limit }),
        ),
    );
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
