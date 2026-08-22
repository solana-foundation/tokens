/**
 * The composed judgment pipeline: enriched candidates in → judged results +
 * suppressed list out. Pure (no I/O): the routes feed it candidates, the
 * golden-set tests feed it fixtures.
 */

import { buildAttestations, normalizeClaim, tokenAgeDays } from './claims';
import { dominanceDetail, withDynamicDominance, type DominanceEntry } from './dominance';
import { evaluateGates, hasMarketData } from './gates';
import type { CollisionVerdict, ProtectedSymbolIndex } from './protected-symbols';
import { checkSymbolCollision } from './protected-symbols';
import type { PolicyDocument } from './policies';
import { classifyMatch, computeComponents, computeTotalScore } from './score';
import type {
    EnrichedCandidate,
    JudgedToken,
    QueryInterpretation,
    ReasonCode,
    SuppressedToken,
    WarningCode,
} from './types';

const STALE_DATA_THRESHOLD_MS = 30 * 60_000;

function buildReasons(
    candidate: EnrichedCandidate,
    interpretation: QueryInterpretation,
    nowMs: number,
    dominance?: DominanceEntry | null,
): ReasonCode[] {
    const reasons: ReasonCode[] = [];

    switch (classifyMatch(candidate, interpretation)) {
        case 'mint':
            reasons.push('mint_match');
            break;
        case 'exact_symbol':
            reasons.push('exact_symbol_match');
            break;
        case 'exact_name':
            reasons.push('exact_name_match');
            break;
        case 'symbol_prefix':
            reasons.push('symbol_prefix_match');
            break;
        case 'name_contains':
            reasons.push('name_match');
            break;
        case 'weak':
            break;
    }

    if (candidate.registry) {
        if (candidate.registry.curatedListIds.length > 0) reasons.push('curated_list_member');
        reasons.push('registry_variant');
    }
    if (dominance) reasons.push('market_leader');
    if ((candidate.liquidityUsd ?? 0) >= 1_000_000) reasons.push('deep_liquidity');
    if ((candidate.volume24hUsd ?? 0) >= 250_000) reasons.push('high_activity');

    const ageDays = tokenAgeDays(candidate, nowMs);
    if (ageDays !== null && ageDays >= 90) reasons.push('established_token');

    if ((candidate.fillQuality?.executionScore ?? 0) >= 70) reasons.push('strong_execution_quality');

    return reasons;
}

function buildWarnings(
    candidate: EnrichedCandidate,
    collision: CollisionVerdict,
    nowMs: number,
): WarningCode[] {
    const warnings: WarningCode[] = [];

    if (!hasMarketData(candidate)) {
        warnings.push('no_market_data');
    } else if ((candidate.liquidityUsd ?? 0) < 10_000) {
        warnings.push('low_liquidity');
    }

    if (collision.kind === 'impersonation') warnings.push('possible_impersonation');
    if (collision.kind === 'collision') warnings.push('symbol_collision');

    const symbolClaim = normalizeClaim(candidate.symbol);
    const nameClaim = normalizeClaim(candidate.name);
    if (symbolClaim.hadSuspiciousCharacters || nameClaim.hadSuspiciousCharacters) {
        warnings.push('suspicious_characters');
    }

    const ageDays = tokenAgeDays(candidate, nowMs);
    if (ageDays !== null && ageDays < 7) warnings.push('new_token');

    if (candidate.dataAsOf !== null && nowMs - candidate.dataAsOf > STALE_DATA_THRESHOLD_MS) {
        warnings.push('stale_data');
    }

    if ((candidate.fillQuality?.botVolumeRatio ?? 0) > 0.6) warnings.push('high_bot_volume');
    if ((candidate.top10HoldersPercent ?? 0) > 50 && !candidate.registry) warnings.push('concentrated_holders');
    if (!candidate.registry) warnings.push('unverified');

    if (
        candidate.risk?.marketScore !== null &&
        candidate.risk?.marketScore !== undefined &&
        candidate.risk.marketScore < 40
    ) {
        warnings.push('weak_market_score');
    }

    return warnings;
}

function buildBadges(candidate: EnrichedCandidate): string[] {
    const badges: string[] = [];
    if (candidate.registry) {
        for (const listId of candidate.registry.curatedListIds) badges.push(`curated:${listId}`);
        if (candidate.registry.trustTier) badges.push(candidate.registry.trustTier);
    }
    if (candidate.risk?.grade) badges.push(`grade:${candidate.risk.grade}`);
    return badges;
}

export function judgeCandidate(
    candidate: EnrichedCandidate,
    interpretation: QueryInterpretation,
    policy: PolicyDocument,
    index: ProtectedSymbolIndex,
    nowMs: number,
    dominance?: DominanceEntry | null,
): { judged: JudgedToken; suppressedBy: ReturnType<typeof evaluateGates> } {
    const collision = checkSymbolCollision(candidate, index, nowMs);
    const suppressedBy = evaluateGates(candidate, policy, collision, nowMs);
    const attestations = buildAttestations(candidate, nowMs, {
        marketDominanceDetail: dominance ? dominanceDetail(dominance) : undefined,
    });
    const components = computeComponents(candidate, interpretation, nowMs, attestations);
    const total = computeTotalScore(components, policy, interpretation, collision);

    const judged: JudgedToken = {
        mint: candidate.mint,
        claims: {
            symbol: candidate.symbol,
            name: candidate.name,
            attestations,
        },
        market: {
            price: candidate.price,
            liquidityUsd: candidate.liquidityUsd,
            volume24hUsd: candidate.volume24hUsd,
            marketCapUsd: candidate.marketCapUsd,
            priceChange24hPercent: candidate.priceChange24hPercent,
            holderCount: candidate.holderCount,
            decimals: candidate.decimals,
            logoURI: candidate.logoURI,
            dataAsOf: candidate.dataAsOf,
        },
        score: { total, components },
        reasons: buildReasons(candidate, interpretation, nowMs, dominance),
        warnings: buildWarnings(candidate, collision, nowMs),
        badges: buildBadges(candidate),
    };

    return { judged, suppressedBy };
}

export interface JudgmentOutput {
    results: JudgedToken[];
    suppressed: SuppressedToken[];
}

export function judgeCandidates(
    candidates: EnrichedCandidate[],
    interpretation: QueryInterpretation,
    policy: PolicyDocument,
    index: ProtectedSymbolIndex,
    opts: { nowMs: number; limit: number },
): JudgmentOutput {
    const results: JudgedToken[] = [];
    const suppressed: SuppressedToken[] = [];

    // Dynamic protection: symbols the registry doesn't cover are protected by
    // their market-dominant claimant (if one exists) for this result set.
    const { index: effectiveIndex, leadersByMint } = withDynamicDominance(index, candidates);

    for (const candidate of candidates) {
        const { judged, suppressedBy } = judgeCandidate(
            candidate,
            interpretation,
            policy,
            effectiveIndex,
            opts.nowMs,
            leadersByMint.get(candidate.mint) ?? null,
        );

        if (suppressedBy.length > 0) {
            suppressed.push({
                mint: candidate.mint,
                symbol: candidate.symbol,
                name: candidate.name,
                liquidityUsd: candidate.liquidityUsd,
                suppressedBy,
                warnings: judged.warnings,
            });
            continue;
        }

        results.push(judged);
    }

    results.sort((a, b) => b.score.total - a.score.total);

    return {
        results: results.slice(0, opts.limit),
        suppressed,
    };
}
