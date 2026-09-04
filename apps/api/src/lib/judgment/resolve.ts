/**
 * Resolve semantics: one answer with confidence — or an explicit refusal.
 *
 * A confident-looking wrong answer to `resolve("USDC")` is the worst possible
 * output, so "I don't know" is a first-class response:
 * - `resolved`            → high confidence single answer
 * - `ambiguous`           → multiple credible candidates; caller disambiguates
 * - `no_confident_match`  → nothing cleared the policy's refusal bar
 */

import type { PolicyDocument } from './policies';
import type { JudgedToken, QueryInterpretation, ResolveStatus } from './types';

export interface ResolveOutcome {
    status: ResolveStatus;
    /** Present when `resolved`. */
    best: (JudgedToken & { confidence: number }) | null;
    /** Present when `ambiguous`: the credible contenders (best first). */
    candidates: JudgedToken[];
}

function confidenceFor(best: JudgedToken, runnerUp: JudgedToken | null, policy: PolicyDocument): number {
    const scoreFactor = best.score.total / 100;
    if (!runnerUp) return Math.round(scoreFactor * 100) / 100;

    const separation = best.score.total - runnerUp.score.total;
    const separationFactor = Math.max(0.5, Math.min(1, 0.5 + separation / (policy.refusal.minSeparation * 4)));
    return Math.round(scoreFactor * separationFactor * 100) / 100;
}

export function resolveFromJudged(
    results: JudgedToken[],
    interpretation: QueryInterpretation,
    policy: PolicyDocument,
): ResolveOutcome {
    // Mint paste is a lookup, not a search: exact mint or refusal, never fuzzy.
    if (interpretation.intent === 'mint') {
        const exact = results.find(result => result.mint === interpretation.normalizedQuery) ?? null;
        if (!exact) return { status: 'no_confident_match', best: null, candidates: [] };
        return { status: 'resolved', best: { ...exact, confidence: 1 }, candidates: [] };
    }

    const [best, ...rest] = results;
    if (!best || best.score.total < policy.refusal.minScore) {
        return { status: 'no_confident_match', best: null, candidates: [] };
    }

    const contenders = rest.filter(
        result =>
            result.score.total >= policy.refusal.minScore &&
            best.score.total - result.score.total < policy.refusal.minSeparation,
    );

    if (contenders.length > 0) {
        return { status: 'ambiguous', best: null, candidates: [best, ...contenders].slice(0, 5) };
    }

    const runnerUp = rest[0] ?? null;
    return {
        status: 'resolved',
        best: { ...best, confidence: confidenceFor(best, runnerUp, policy) },
        candidates: [],
    };
}
