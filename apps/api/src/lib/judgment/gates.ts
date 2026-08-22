/**
 * Gate evaluation. Gates are policy-dependent hard filters — a gated token is
 * *out* (reported in `suppressed[]` with reason codes), it does not rank low.
 */

import { tokenAgeDays } from './claims';
import type { CollisionVerdict } from './protected-symbols';
import type { PolicyDocument } from './policies';
import type { EnrichedCandidate, SuppressionCode } from './types';

export function hasMarketData(candidate: EnrichedCandidate): boolean {
    return (
        (candidate.price !== null && candidate.price > 0) ||
        (candidate.liquidityUsd !== null && candidate.liquidityUsd > 0) ||
        (candidate.volume24hUsd !== null && candidate.volume24hUsd > 0)
    );
}

export function evaluateGates(
    candidate: EnrichedCandidate,
    policy: PolicyDocument,
    collision: CollisionVerdict,
    nowMs: number,
): SuppressionCode[] {
    const suppressions: SuppressionCode[] = [];

    // Tombstones are editorial deletions — suppressed under every policy.
    if (candidate.tombstoned) suppressions.push('gate_tombstoned');

    if (policy.gates.requireMarketData && !hasMarketData(candidate)) {
        suppressions.push('gate_no_market_data');
    }

    // Registry-attested assets bypass the liquidity gate: it exists to filter
    // scams/unknowns, not to hide verified assets that settle off-AMM. RFQ /
    // primary-issuance assets (e.g. Ondo Global Markets tokenized stocks,
    // treasury funds) legitimately show near-zero DEX liquidity — their
    // identity is attested, so thin tradability is a *warning*
    // (`low_liquidity`), not a suppression.
    if (
        policy.gates.minLiquidityUsd !== null &&
        (candidate.liquidityUsd ?? 0) < policy.gates.minLiquidityUsd &&
        !candidate.registry
    ) {
        suppressions.push('gate_min_liquidity');
    }

    if (policy.gates.suppressImpersonation && collision.kind === 'impersonation') {
        suppressions.push('gate_impersonation');
    }

    if (
        policy.gates.minMarketScore !== null &&
        candidate.risk?.marketScore !== null &&
        candidate.risk?.marketScore !== undefined &&
        candidate.risk.marketScore < policy.gates.minMarketScore
    ) {
        suppressions.push('gate_min_market_score');
    }

    if (policy.gates.minAgeDays !== null) {
        const ageDays = tokenAgeDays(candidate, nowMs);
        // Unknown age is not "new" — only gate when the mint time is known.
        if (ageDays !== null && ageDays < policy.gates.minAgeDays) {
            suppressions.push('gate_new_token');
        }
    }

    return suppressions;
}
