import { Effect } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { enforceProviderBudget } from '@/effect/provider-budget';
import { tapErrorAndDefault } from '@tokens/effect';
import { tokenListsGetSlugsByMints } from '@/lib/cloudrun';

import { POLICY_VERSION } from '@/lib/judgment/policies';
import { SCORING_VERSION } from '@/lib/judgment/types';
import { parseJudgedSearchParams, runJudgedSearch, withVerified } from '../../_judged-search';

/**
 * GET /api/v2/lists/search-tokens — curator-assist search for list owners
 * deciding which mint to add. Not a public ranking: it defaults to the strict
 * policy and ALWAYS returns the suppressed set with reasons — a curator must
 * see what was filtered and why. Accepts the same per-gate overrides as
 * `GET /v2/search` (see `_judged-search.ts`).
 * Each result carries `verified` (registry variant exists) and `inLists`
 * (curated + community lists already containing the mint — prior art).
 */
export const GET = route(
    (request: Request, ctx: { platformAuth: PlatformAuthContext }) =>
        Effect.gen(function* () {
            // Unique-q searches bypass the 30s response cache; the per-key
            // window budget bounds sustained provider spend.
            yield* enforceProviderBudget(ctx.platformAuth, 'search');
            const url = new URL(request.url);
            // Curators default to the strict policy; ?policy=default|degen widens the net.
            const params = yield* parseJudgedSearchParams(url, { defaultPolicy: 'strict' });

            const { interpretation, candidates, sources, results, suppressed, latencyMs } = yield* runJudgedSearch({
                q: params.q,
                policy: params.policy,
                limit: params.limit,
            });

            // Prior art for the curator: which lists (curated ∪ published
            // community) already contain each candidate. Fail-open — membership
            // annotations must never break the search.
            const candidateByMint = new Map(candidates.map(c => [c.mint, c] as const));
            const resultMints = results.map(r => r.mint);
            const communityLists =
                resultMints.length > 0
                    ? yield* tokenListsGetSlugsByMints({ mints: resultMints }).pipe(
                          tapErrorAndDefault('v2.lists.searchTokens.inLists', []),
                      )
                    : [];
            const communityByMint = new Map(communityLists.map(entry => [entry.mint, entry.slugs] as const));

            const annotated = withVerified(results, candidates).map(result => {
                const candidate = candidateByMint.get(result.mint) ?? null;
                const inLists = [...(candidate?.curatedListIds ?? []), ...(communityByMint.get(result.mint) ?? [])];
                return { ...result, inLists };
            });

            return {
                query: params.q,
                interpretation,
                policy: params.policyId,
                policyVersion: POLICY_VERSION,
                scoringVersion: SCORING_VERSION,
                sources,
                latencyMs,
                results: annotated,
                suppressed,
            };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 30 } },
);
