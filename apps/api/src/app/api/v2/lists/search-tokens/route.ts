import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError, decodeLimit, tapErrorAndDefault } from '@tokens/effect';
import { tokenListsGetSlugsByMints } from '@/lib/cloudrun';

import { gatherCandidates } from '@/lib/judgment/candidates';
import { classifyQuery } from '@/lib/judgment/intent';
import { judgeCandidates } from '@/lib/judgment/pipeline';
import { parsePolicyId, POLICIES, POLICY_IDS, POLICY_VERSION } from '@/lib/judgment/policies';
import { getProtectedSymbolIndex } from '@/lib/judgment/protected-symbols';
import { SCORING_VERSION } from '@/lib/judgment/types';

/**
 * GET /api/v2/lists/search-tokens — curator-assist search for list owners
 * deciding which mint to add. Not a public ranking: it is gated behind
 * `lists:write`, defaults to the strict policy, and ALWAYS returns the
 * suppressed set with reasons — a curator must see what was filtered and why.
 * Each result carries `verified` (registry variant exists) and `inLists`
 * (curated + community lists already containing the mint — prior art).
 */
export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const q = (url.searchParams.get('q') ?? '').trim();
            if (!q) {
                return yield* Effect.fail(new BadRequestError({ message: 'Missing required query param: q' }));
            }
            if (q.length > 100) {
                return yield* Effect.fail(new BadRequestError({ message: 'Query too long (max 100 characters)' }));
            }

            // Curators default to the strict policy; ?policy=default|degen widens the net.
            const rawPolicy = url.searchParams.get('policy');
            const policyId = rawPolicy === null || rawPolicy.trim() === '' ? 'strict' : parsePolicyId(rawPolicy);
            if (!policyId) {
                return yield* Effect.fail(
                    new BadRequestError({
                        message: `Invalid policy: ${url.searchParams.get('policy')}`,
                        details: { policies: POLICY_IDS },
                    }),
                );
            }

            const limit = yield* decodeLimit(url.searchParams.get('limit'), { defaultValue: '10', max: 50 });

            const startedAt = Date.now();
            const interpretation = classifyQuery(q);
            const policy = POLICIES[policyId];

            const { candidates, sources } = yield* gatherCandidates(q, interpretation);
            const { results, suppressed } = judgeCandidates(candidates, interpretation, policy, getProtectedSymbolIndex(), {
                nowMs: Date.now(),
                limit,
            });

            // Prior art for the curator: which lists (curated ∪ published
            // community) already contain each candidate. Fail-open — membership
            // annotations must never break the search.
            const registryByMint = new Map(candidates.map(c => [c.mint, c.registry] as const));
            const resultMints = results.map(r => r.mint);
            const communityLists =
                resultMints.length > 0
                    ? yield* tokenListsGetSlugsByMints({ mints: resultMints }).pipe(
                          tapErrorAndDefault('v2.lists.searchTokens.inLists', []),
                      )
                    : [];
            const communityByMint = new Map(communityLists.map(entry => [entry.mint, entry.slugs] as const));

            const annotated = results.map(result => {
                const registry = registryByMint.get(result.mint) ?? null;
                const inLists = [
                    ...(registry?.curatedListIds ?? []),
                    ...(communityByMint.get(result.mint) ?? []),
                ];
                return { ...result, verified: registry !== null, inLists };
            });

            return {
                query: q,
                interpretation,
                policy: policyId,
                policyVersion: POLICY_VERSION,
                scoringVersion: SCORING_VERSION,
                sources,
                latencyMs: Date.now() - startedAt,
                results: annotated,
                suppressed,
            };
        }),
    { platform: { requiredScopes: ['lists:write'] }, cache: { maxAge: 30 } },
);
