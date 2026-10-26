import { Effect } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { enforceProviderBudget } from '@/effect/provider-budget';
import { emitEvent, readJsonBody } from '@tokens/effect';

import { enrichCandidatesDetailed, type CandidateSourcesStatus } from '@/lib/judgment/candidates';
import { classifyQuery } from '@/lib/judgment/intent';
import type { LiveOutcome } from '@/lib/judgment/live-enrichment';
import { POLICY_VERSION } from '@/lib/judgment/policies';
import { SCORING_VERSION, type QueryInterpretation } from '@/lib/judgment/types';
import {
    judgeEnriched,
    paramsFromBody,
    parseJudgedParams,
    policyEnvelope,
    rejectNonScalarParams,
    withVerified,
} from '../_judged-search';
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
 * Any mint gets the same read-out. Mints we hold a stored snapshot for are
 * judged on it; mints we do not are looked up live at the provider (market
 * overview + holder/authority facts), cached per mint, under one soft
 * deadline for the whole request. Only requests that need at least one live
 * lookup draw from the per-key `judge` provider budget; a fully covered or
 * fully cached request costs no budget. Every result says where its inputs
 * came from (`dataSources`), and `sources.live` reports the tier's outcome.
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
            yield* rejectNonScalarParams(body);
            const params = yield* parseJudgedParams(paramsFromBody(body), {
                defaultPolicy: 'default',
                allowIncludeSuppressed: true,
                requireQuery: false,
            });
            const interpretation = params.q ? classifyQuery(params.q) : NO_QUERY;

            const enrichStart = Date.now();
            const enriched = yield* enrichCandidatesDetailed(raws, {
                live: { budget: enforceProviderBudget(ctx.platformAuth, 'judge') },
            });
            const candidates = enriched.candidates;
            const enrichMs = Date.now() - enrichStart;

            const { results, suppressed } = yield* judgeEnriched(
                candidates,
                interpretation,
                params.policy,
                params.limit,
            );

            const sources: CandidateSourcesStatus & { caller: 'ok'; live: LiveOutcome } = {
                caller: 'ok',
                provider: enriched.live === 'ok' ? 'ok' : enriched.live === 'degraded' ? 'degraded' : 'disabled',
                db: 'ok',
                registry: 'ok',
                cache: 'bypass',
                live: enriched.live,
            };
            const latencyMs = Date.now() - startedAt;
            emitEvent({
                event: 'judged_search',
                route: 'judge',
                intent: params.q ? interpretation.intent : 'none',
                cache: 'bypass',
                provider: sources.provider,
                provider_outcome: enriched.live,
                live_lookups: enriched.liveLookups,
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
