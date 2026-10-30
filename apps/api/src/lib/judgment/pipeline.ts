/**
 * The composed judgment pipeline: enriched candidates in → judged results +
 * suppressed list out. Pure (no I/O): the routes feed it candidates, the
 * golden-set tests feed it fixtures.
 */

import { bandFor, isCategoryBand } from './bands';
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
const NO_RECENT_TRADES_MS = 24 * 60 * 60_000;
const THIN_FLOAT_MAX_RATIO = 0.1;
const LOW_LP_LOCKED_MAX_PERCENT = 50;
const DEV_HOLDING_MAX_PERCENT = 10;
const SNIPER_BUNDLE_MAX_PERCENT = 20;
const TOXIC_MARKOUT_BPS = 50;

/** Registry/curated assets keep authorities legitimately (stablecoin issuers, tokenized stocks). */
function authorityExempt(candidate: EnrichedCandidate): boolean {
    return candidate.registry !== null || candidate.curatedListIds.length > 0;
}

function buildReasons(
    candidate: EnrichedCandidate,
    interpretation: QueryInterpretation,
    nowMs: number,
    dominance?: DominanceEntry | null,
): ReasonCode[] {
    const reasons: ReasonCode[] = [];
    const band = bandFor(candidate);

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

    if (candidate.curatedListIds.length > 0) reasons.push('curated_list_member');
    if (candidate.registry) {
        reasons.push('registry_variant');
    }
    if (dominance) reasons.push('market_leader');
    if ((candidate.liquidityUsd ?? 0) >= band.deepLiquidityUsd) reasons.push('deep_liquidity');
    if ((candidate.volume24hUsd ?? 0) >= band.sustainedVolumeUsd) reasons.push('high_activity');

    const ageDays = tokenAgeDays(candidate, nowMs);
    if (ageDays !== null && ageDays >= 90) reasons.push('established_token');

    // Execution quality: a strong score, corroborated by several flow
    // sources when that count is known (one venue can fake a score).
    const executionScore = candidate.fillQuality?.executionScore ?? 0;
    const flowSources = candidate.fillQuality?.flowSourceCount;
    if (executionScore >= 70 && (flowSources === undefined || flowSources === null || flowSources >= 3)) {
        reasons.push('strong_execution_quality');
    }

    if ((candidate.uniqueWallet24h ?? 0) >= 1_000) reasons.push('active_wallets');
    if ((candidate.security?.lpLockedPercent ?? 0) >= 80) reasons.push('locked_liquidity');

    return reasons;
}

function buildWarnings(candidate: EnrichedCandidate, collision: CollisionVerdict, nowMs: number): WarningCode[] {
    const warnings: WarningCode[] = [];
    const band = bandFor(candidate);

    if (!hasMarketData(candidate)) {
        warnings.push('no_market_data');
    } else if ((candidate.liquidityUsd ?? 0) < band.lowLiquidityUsd) {
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

    // Informational advisory: the token stays rankable, the caller sees why
    // it is flagged. (compromised/blocked are gates, not warnings.)
    if (candidate.advisory?.status === 'caution') warnings.push('advisory_caution');

    // Authority / launch hygiene. Unknown (`null`) never warns.
    const security = candidate.security;
    if (security && !authorityExempt(candidate)) {
        if (security.mintable === true) warnings.push('mint_authority_active');
        if (security.freezable === true) warnings.push('freeze_authority_active');
        if (security.mutableMetadata === true) warnings.push('mutable_metadata');
    }
    if (security?.transferTax === true) warnings.push('transfer_tax');
    if (
        security?.lpLockedPercent !== null &&
        security?.lpLockedPercent !== undefined &&
        security.lpLockedPercent < LOW_LP_LOCKED_MAX_PERCENT &&
        !candidate.registry
    ) {
        warnings.push('low_lp_locked');
    }
    if ((security?.devHoldingPercent ?? 0) > DEV_HOLDING_MAX_PERCENT && !candidate.registry) {
        warnings.push('dev_holding_high');
    }
    if (
        (security?.sniperHoldingPercent ?? 0) + (security?.bundlerHoldingPercent ?? 0) > SNIPER_BUNDLE_MAX_PERCENT &&
        !candidate.registry
    ) {
        warnings.push('sniper_bundle_heavy');
    }

    // Supply and trade recency from the market row.
    if (
        candidate.circulatingSupply !== null &&
        candidate.totalSupply !== null &&
        candidate.totalSupply > 0 &&
        candidate.circulatingSupply / candidate.totalSupply < THIN_FLOAT_MAX_RATIO
    ) {
        warnings.push('thin_float');
    }
    if (candidate.lastTradeAt !== null && nowMs - candidate.lastTradeAt > NO_RECENT_TRADES_MS) {
        warnings.push('no_recent_trades');
    }
    if ((candidate.fillQuality?.markoutBps ?? 0) > TOXIC_MARKOUT_BPS) warnings.push('toxic_flow');

    return warnings;
}

function buildBadges(candidate: EnrichedCandidate): string[] {
    const badges: string[] = [];
    for (const listId of candidate.curatedListIds) badges.push(`curated:${listId}`);
    if (candidate.registry) {
        if (candidate.registry.trustTier) badges.push(candidate.registry.trustTier);
    }
    if (candidate.risk?.grade) badges.push(`grade:${candidate.risk.grade}`);
    if (candidate.advisory) badges.push(`advisory:${candidate.advisory.status}`);
    const band = bandFor(candidate);
    if (isCategoryBand(band)) badges.push(`band:${band.id}`);
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
        dataSources: candidate.dataSources,
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
