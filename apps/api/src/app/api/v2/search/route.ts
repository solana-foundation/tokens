import { Effect } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { enforceProviderBudget } from '@/effect/provider-budget';

import { POLICY_VERSION } from '@/lib/judgment/policies';
import { SCORING_VERSION } from '@/lib/judgment/types';
import { parseJudgedSearchParams, policyEnvelope, runJudgedSearch, withVerified } from '../_judged-search';

/**
 * GET /api/v2/search — public risk-aware token search. Candidates come from
 * the live provider, the token index and the canonical registry; a policy
 * preset (`strict` | `default` | `degen`) plus per-gate overrides decides
 * what is suppressed vs. ranked. Suppressed rows are returned with the gate
 * that fired unless `includeSuppressed=false`.
 *
 * Tombstone / `blocked` / `compromised` gates are not overridable.
 */
export const GET = route(
    (request: Request, ctx: { platformAuth: PlatformAuthContext }) =>
        Effect.gen(function* () {
            // Unique-q searches bypass the 30s response cache; the per-key
            // window budget bounds sustained provider spend.
            yield* enforceProviderBudget(ctx.platformAuth, 'search');
            const url = new URL(request.url);
            const params = yield* parseJudgedSearchParams(url, {
                defaultPolicy: 'default',
                allowIncludeSuppressed: true,
            });

            const { interpretation, candidates, sources, results, suppressed, latencyMs } = yield* runJudgedSearch({
                q: params.q,
                policy: params.policy,
                limit: params.limit,
            });

            return {
                query: params.q,
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
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 30 } },
);
