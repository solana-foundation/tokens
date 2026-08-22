/**
 * Dynamic symbol dominance — list-free protection for symbols the registry
 * doesn't cover.
 *
 * The registry/curated protected-symbol index only guards symbols someone
 * hand-added (USDC works, WIF doesn't). This module derives protection from
 * market data instead, mirroring v1's primary-variant ranking philosophy
 * (eligibility floors + override ratios, see
 * `packages/asset-registry/src/primary-variant-ranking.ts`) one level up:
 * v1 asks "which variant is primary within this asset?"; this asks "which
 * mint is dominant within this symbol?".
 *
 * Computed per query, over the candidate set (provider results are
 * liquidity-sorted, so the true leader of a symbol is present whenever it
 * exists). Prominence is measured by *liquidity*, not volume — wash trading
 * inflates volume cheaply, while liquidity has carry cost.
 *
 * Doctrine preserved: dominance is earned evidence. A contested symbol (two
 * credible claimants) grants no one protection; the static registry index
 * always wins where it has coverage.
 */

import { normalizeClaim } from './claims';
import type { ProtectedSymbolEntry, ProtectedSymbolIndex } from './protected-symbols';
import type { EnrichedCandidate } from './types';

/** A leader must have real standing of its own (same bar the impersonation
 * heuristic uses for "real standing"). */
export const DOMINANCE_MIN_LEADER_LIQUIDITY_USD = 250_000;

/** Leader must out-liquidity the runner-up by at least this factor, else the
 * symbol is contested and nobody is protected. */
export const DOMINANCE_MIN_RATIO = 10;

export interface DominanceEntry {
    normalizedSymbol: string;
    leaderMint: string;
    /** leader liquidity / runner-up liquidity (Infinity when the runner-up has none). */
    ratio: number;
    leaderLiquidityUsd: number;
    runnerUpLiquidityUsd: number;
}

export interface DominanceResult {
    /** Static index merged with dynamically protected symbols. */
    index: ProtectedSymbolIndex;
    /** Leader mint → its dominance evidence (for attestations/reasons). */
    leadersByMint: Map<string, DominanceEntry>;
}

function isEligibleLeader(candidate: EnrichedCandidate): boolean {
    if (candidate.tombstoned) return false;
    return (candidate.liquidityUsd ?? 0) >= DOMINANCE_MIN_LEADER_LIQUIDITY_USD;
}

/**
 * Compute per-symbol dominance over the candidate set and merge it into the
 * static protected-symbol index. Symbols already statically protected are
 * left untouched (registry is authoritative).
 */
export function withDynamicDominance(
    staticIndex: ProtectedSymbolIndex,
    candidates: readonly EnrichedCandidate[],
): DominanceResult {
    const groups = new Map<string, EnrichedCandidate[]>();
    for (const candidate of candidates) {
        const { normalized } = normalizeClaim(candidate.symbol);
        if (!normalized) continue;
        if (staticIndex.has(normalized)) continue; // registry wins
        const group = groups.get(normalized);
        if (group) group.push(candidate);
        else groups.set(normalized, [candidate]);
    }

    const leadersByMint = new Map<string, DominanceEntry>();
    let merged: ProtectedSymbolIndex | null = null;

    for (const [normalizedSymbol, group] of groups) {
        // Protection is only meaningful when a symbol is claimed by more than
        // one mint in this result set.
        if (group.length < 2) continue;

        const sorted = [...group].sort(
            (a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0),
        );
        const leader = sorted[0]!;
        const runnerUp = sorted[1]!;
        if (!isEligibleLeader(leader)) continue;

        const leaderLiquidityUsd = leader.liquidityUsd ?? 0;
        const runnerUpLiquidityUsd = runnerUp.liquidityUsd ?? 0;
        const ratio = runnerUpLiquidityUsd > 0 ? leaderLiquidityUsd / runnerUpLiquidityUsd : Infinity;
        if (ratio < DOMINANCE_MIN_RATIO) continue; // contested — protect no one

        const entry: DominanceEntry = {
            normalizedSymbol,
            leaderMint: leader.mint,
            ratio,
            leaderLiquidityUsd,
            runnerUpLiquidityUsd,
        };
        leadersByMint.set(leader.mint, entry);

        if (!merged) merged = new Map(staticIndex);
        const protectedEntry: ProtectedSymbolEntry = {
            normalizedSymbol,
            mints: new Set([leader.mint]),
            protectedBy: ['dominance:liquidity'],
        };
        merged.set(normalizedSymbol, protectedEntry);
    }

    return { index: merged ?? staticIndex, leadersByMint };
}

/** Human-readable evidence string for the attestation detail. */
export function dominanceDetail(entry: DominanceEntry): string {
    const leader = `$${Math.round(entry.leaderLiquidityUsd).toLocaleString('en-US')}`;
    const ratioText = Number.isFinite(entry.ratio) ? `${Math.floor(entry.ratio)}x` : '>100x';
    return `liquidity ${leader}, ${ratioText} the next '${entry.normalizedSymbol}' claimant`;
}
