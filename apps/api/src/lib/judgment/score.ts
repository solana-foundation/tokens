/**
 * Component scoring. Gates decide *whether* a candidate is shown; scores
 * decide *where* it ranks. Components are 0–100 and blended with policy
 * weights, modulated by query intent, then adjusted for collision verdicts.
 */

import { computeMarketScore } from '@/lib/token-risk-helpers';

import { claimCredibilityScore, buildAttestations, normalizeClaim } from './claims';
import type { CollisionVerdict } from './protected-symbols';
import type { PolicyDocument } from './policies';
import type { Attestation, EnrichedCandidate, QueryInterpretation, ScoreComponents } from './types';

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function logScale(value: number | null, floor: number, ceiling: number): number {
    if (value === null || !Number.isFinite(value) || value <= floor) return 0;
    if (value >= ceiling) return 100;
    return Math.round(100 * clamp01(Math.log10(value / floor) / Math.log10(ceiling / floor)));
}

export type MatchKind =
    | 'mint'
    | 'exact_symbol'
    | 'exact_name'
    | 'symbol_prefix'
    | 'name_contains'
    | 'weak';

export function classifyMatch(candidate: EnrichedCandidate, interpretation: QueryInterpretation): MatchKind {
    if (interpretation.intent === 'mint') {
        return candidate.mint === interpretation.normalizedQuery ? 'mint' : 'weak';
    }

    const query = interpretation.normalizedQuery;
    const symbol = normalizeClaim(candidate.symbol).normalized;
    const name = normalizeClaim(candidate.name).normalized;
    const registrySymbol = normalizeClaim(candidate.registry?.symbol).normalized;

    if (symbol === query || registrySymbol === query) return 'exact_symbol';
    if (name === query) return 'exact_name';
    if (symbol.startsWith(query) && query.length >= 2) return 'symbol_prefix';
    if (name.includes(query) && query.length >= 3) return 'name_contains';
    return 'weak';
}

const MATCH_SCORES: Record<QueryInterpretation['intent'], Record<MatchKind, number>> = {
    mint: { mint: 100, exact_symbol: 0, exact_name: 0, symbol_prefix: 0, name_contains: 0, weak: 0 },
    // Ticker queries are identity questions: an exact symbol is the claim
    // itself; an exact full-name match is strong corroboration; a symbol
    // *prefix* (JupUSD for 'JUP') is a family resemblance, not identity — it
    // must not let heavy curation outrank the exact-match leader.
    ticker: { mint: 100, exact_symbol: 100, exact_name: 75, symbol_prefix: 55, name_contains: 45, weak: 20 },
    name: { mint: 100, exact_symbol: 80, exact_name: 100, symbol_prefix: 55, name_contains: 70, weak: 20 },
};

function riskComponent(candidate: EnrichedCandidate): number {
    if (candidate.risk?.marketScore !== null && candidate.risk?.marketScore !== undefined) {
        return Math.max(0, Math.min(100, candidate.risk.marketScore));
    }

    const computed = computeMarketScore({
        liquidityUsd: candidate.liquidityUsd,
        marketCapUsd: candidate.marketCapUsd,
        holderCount: candidate.holderCount,
        top10HoldersPercent: candidate.top10HoldersPercent,
        volume24hUsd: candidate.volume24hUsd,
        volume7dUsd: null,
        tokenMintTime: candidate.tokenMintTime,
        tokenAddress: candidate.mint,
    });

    // Unknown is neutral, not bad: candidates outside the risk-refresh rotation
    // shouldn't be punished for missing data (gates handle the dangerous cases).
    if (computed.hasInsufficientData) return 50;
    return computed.score;
}

function freshnessComponent(candidate: EnrichedCandidate, nowMs: number): number {
    if (candidate.dataAsOf === null) return 30;
    const ageMinutes = Math.max(0, (nowMs - candidate.dataAsOf) / 60_000);
    if (ageMinutes <= 5) return 100;
    if (ageMinutes >= 24 * 60) return 0;
    return Math.round(100 * (1 - ageMinutes / (24 * 60)));
}

export function computeComponents(
    candidate: EnrichedCandidate,
    interpretation: QueryInterpretation,
    nowMs: number,
    /** Prebuilt attestations (with pipeline-only extras like market_dominance);
     * falls back to rebuilding from the candidate alone. */
    attestationsOverride?: Attestation[],
): ScoreComponents {
    const match = classifyMatch(candidate, interpretation);
    const attestations = attestationsOverride ?? buildAttestations(candidate, nowMs);

    const volumeScore = logScale(candidate.volume24hUsd, 100, 50_000_000);
    const executionScore = candidate.fillQuality?.executionScore ?? null;
    const activity =
        executionScore !== null ? Math.round(0.7 * volumeScore + 0.3 * executionScore) : volumeScore;

    return {
        matchQuality: MATCH_SCORES[interpretation.intent][match],
        claimCredibility: claimCredibilityScore(attestations),
        liquidity: logScale(candidate.liquidityUsd, 100, 10_000_000),
        activity,
        risk: riskComponent(candidate),
        freshness: freshnessComponent(candidate, nowMs),
    };
}

/** Intent shifts emphasis: ticker queries are identity questions, name queries are recall questions. */
function intentAdjustedWeights(policy: PolicyDocument, interpretation: QueryInterpretation): ScoreComponents {
    const weights = { ...policy.weights };
    if (interpretation.intent === 'ticker') {
        weights.matchQuality *= 1.4;
        weights.claimCredibility *= 1.4;
    }
    return weights;
}

const COLLISION_PENALTY: Record<CollisionVerdict['kind'], number> = {
    none: 1,
    protected_holder: 1,
    collision: 0.85,
    impersonation: 0.3,
};

export function computeTotalScore(
    components: ScoreComponents,
    policy: PolicyDocument,
    interpretation: QueryInterpretation,
    collision: CollisionVerdict,
): number {
    const weights = intentAdjustedWeights(policy, interpretation);
    const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);
    if (totalWeight <= 0) return 0;

    let weighted = 0;
    for (const key of Object.keys(weights) as Array<keyof ScoreComponents>) {
        weighted += components[key] * weights[key];
    }

    const base = weighted / totalWeight;
    return Math.round(base * COLLISION_PENALTY[collision.kind]);
}
