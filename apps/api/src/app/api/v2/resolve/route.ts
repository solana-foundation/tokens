import { Effect } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { enforceProviderBudget } from '@/effect/provider-budget';

import { POLICY_VERSION } from '@/lib/judgment/policies';
import { resolveFromJudged } from '@/lib/judgment/resolve';
import { SCORING_VERSION } from '@/lib/judgment/types';
import { parseJudgedSearchParams, policyEnvelope, runJudgedSearch, withVerified } from '../_judged-search';

/** Enough headroom for the refusal bar to see the runner-up(s). */
const RESOLVE_CANDIDATE_LIMIT = 10;

/**
 * GET /api/v2/resolve — one answer with confidence, or an explicit refusal.
 * Always HTTP 200: `status` is `resolved` (single `best` + `confidence`),
 * `ambiguous` (credible `candidates`, best first) or `no_confident_match`.
 * A confident-looking wrong answer to resolve("USDC") is the worst possible
 * output, so refusal is a first-class response, not an error.
 * Accepts the same `policy` + gate overrides as `GET /v2/search`.
 */
export const GET = route(
    (request: Request, ctx: { platformAuth: PlatformAuthContext }) =>
        Effect.gen(function* () {
            yield* enforceProviderBudget(ctx.platformAuth, 'search');
            const url = new URL(request.url);
            const params = yield* parseJudgedSearchParams(url, { defaultPolicy: 'default' });

            const { interpretation, candidates, sources, results, latencyMs } = yield* runJudgedSearch({
                q: params.q,
                policy: params.policy,
                limit: RESOLVE_CANDIDATE_LIMIT,
            });

            const outcome = resolveFromJudged(results, interpretation, params.policy);
            const best = outcome.best ? withVerified([outcome.best], candidates)[0]! : null;

            return {
                query: params.q,
                interpretation,
                policy: policyEnvelope(params),
                policyVersion: POLICY_VERSION,
                scoringVersion: SCORING_VERSION,
                sources,
                latencyMs,
                status: outcome.status,
                best,
                candidates: withVerified(outcome.candidates, candidates),
            };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 30 } },
);
