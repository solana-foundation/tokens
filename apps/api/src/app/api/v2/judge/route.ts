import { Effect } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { emitEvent, readJsonBody } from '@tokens/effect';

import { enrichCandidates, type CandidateSourcesStatus } from '@/lib/judgment/candidates';
import { classifyQuery } from '@/lib/judgment/intent';
import { POLICY_VERSION } from '@/lib/judgment/policies';
import { SCORING_VERSION, type QueryInterpretation } from '@/lib/judgment/types';
import { judgeEnriched, paramsFromBody, parseJudgedParams, policyEnvelope, withVerified } from '../_judged-search';
import { parseJudgeBody } from './_judge-body';

/** No query: nothing can match, so ranking is credibility alone. */
const NO_QUERY: QueryInterpretation = { intent: 'name', normalizedQuery: '', hadSuspiciousCharacters: false };

/**
 * POST /api/v2/judge — bring your own candidates. The caller supplies up to
 * 40 mints (optionally with the symbol/name/market fields their own search
 * returned) and gets the same judged response as `GET /v2/search`: hard
 * gates under a policy, weighted score, reasons/warnings/badges, and the
 * suppressed rows with the gate that fired.
 *
 * What it does NOT do: call the live provider. There is no provider lookup,
 * so no provider budget is charged — only the standard rate limit applies —
 * and latency is enrichment (our own snapshots) plus the pure pipeline.
 * Mints we know nothing about are judged on the caller's claims alone and
 * come back `unverified` / `no_market_data`, which is the honest answer.
 *
 * `q` is optional and only sharpens match scoring (exact_symbol_match …);
 * `policy`, the gate overrides, `limit` and `includeSuppressed` are the same
 * flags as the GET routes, read from the body.
 */
export const POST = route(
    (request: Request, ctx: { platformAuth: PlatformAuthContext }) =>
        Effect.gen(function* () {
            const startedAt = Date.now();
            const json = yield* readJsonBody(request);
            const { body, raws } = yield* parseJudgeBody(json);
            const params = yield* parseJudgedParams(paramsFromBody(body), {
                defaultPolicy: 'default',
                allowIncludeSuppressed: true,
                requireQuery: false,
            });
            const interpretation = params.q ? classifyQuery(params.q) : NO_QUERY;

            const enrichStart = Date.now();
            const candidates = yield* enrichCandidates(raws);
            const enrichMs = Date.now() - enrichStart;

            const { results, suppressed } = yield* judgeEnriched(
                candidates,
                interpretation,
                params.policy,
                params.limit,
            );

            const sources: CandidateSourcesStatus & { caller: 'ok' } = {
                caller: 'ok',
                provider: 'disabled',
                db: 'ok',
                registry: 'ok',
                cache: 'bypass',
            };
            const latencyMs = Date.now() - startedAt;
            emitEvent({
                event: 'judged_search',
                route: 'judge',
                intent: params.q ? interpretation.intent : 'none',
                cache: 'bypass',
                provider: 'disabled',
                provider_outcome: 'disabled',
                db: 'ok',
                candidates: candidates.length,
                results: results.length,
                suppressed: suppressed.length,
                collect_ms: 0,
                enrich_ms: enrichMs,
                duration_ms: latencyMs,
                key_prefix: ctx.platformAuth.keyPrefix,
            });

            return {
                query: params.q || null,
                interpretation,
                policy: policyEnvelope(params),
                policyVersion: POLICY_VERSION,
                scoringVersion: SCORING_VERSION,
                sources,
                latencyMs,
                results: withVerified(results, candidates),
                ...(params.includeSuppressed ? { suppressed } : {}),
            };
        }),
    { platform: { requiredScopes: ['assets:read'] } },
);
