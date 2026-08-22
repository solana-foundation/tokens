/**
 * Policies: named bundles of hard gates + score weights + refusal behavior.
 *
 * Internally a policy is a declarative document — presets are just named
 * instances of it. This keeps policies versionable/diffable and leaves the
 * door open for customer-defined policies without an API redesign.
 */

import type { ScoreComponents } from './types';

export const POLICY_VERSION = 'v2-policy-2026-07-05.1' as const;

export const POLICY_IDS = ['strict', 'default', 'degen'] as const;
export type PolicyId = (typeof POLICY_IDS)[number];

export interface PolicyDocument {
    id: PolicyId;
    /** Hard gates — candidates failing these are suppressed, not ranked low. */
    gates: {
        /** Suppress below this liquidity (USD). `null` disables the gate. */
        minLiquidityUsd: number | null;
        /** Suppress candidates with no market data at all. */
        requireMarketData: boolean;
        /** Suppress likely impersonators (vs. warn on them). */
        suppressImpersonation: boolean;
        /** Suppress below this market score when a score exists. `null` disables. */
        minMarketScore: number | null;
        /** Suppress tokens younger than this (days). `null` disables. */
        minAgeDays: number | null;
    };
    /** Relative component weights (normalized at scoring time). */
    weights: ScoreComponents;
    /** Refusal bar for `/resolve`. */
    refusal: {
        /** Best candidate must score at least this to resolve. */
        minScore: number;
        /** Best must beat runner-up by at least this margin, else `ambiguous`. */
        minSeparation: number;
    };
}

export const POLICIES: Record<PolicyId, PolicyDocument> = {
    strict: {
        id: 'strict',
        gates: {
            minLiquidityUsd: 10_000,
            requireMarketData: true,
            suppressImpersonation: true,
            minMarketScore: null,
            minAgeDays: 1,
        },
        weights: {
            matchQuality: 30,
            claimCredibility: 30,
            liquidity: 15,
            activity: 10,
            risk: 10,
            freshness: 5,
        },
        refusal: { minScore: 65, minSeparation: 12 },
    },
    default: {
        id: 'default',
        gates: {
            minLiquidityUsd: 1_000,
            requireMarketData: false,
            suppressImpersonation: true,
            minMarketScore: null,
            minAgeDays: null,
        },
        weights: {
            matchQuality: 35,
            claimCredibility: 20,
            liquidity: 15,
            activity: 15,
            risk: 10,
            freshness: 5,
        },
        refusal: { minScore: 55, minSeparation: 10 },
    },
    degen: {
        id: 'degen',
        gates: {
            minLiquidityUsd: null,
            requireMarketData: false,
            suppressImpersonation: false,
            minMarketScore: null,
            minAgeDays: null,
        },
        weights: {
            matchQuality: 40,
            claimCredibility: 10,
            liquidity: 10,
            activity: 25,
            risk: 5,
            freshness: 10,
        },
        refusal: { minScore: 45, minSeparation: 8 },
    },
};

export function parsePolicyId(raw: string | null): PolicyId | null {
    if (raw === null || raw.trim() === '') return 'default';
    const trimmed = raw.trim().toLowerCase();
    return (POLICY_IDS as readonly string[]).includes(trimmed) ? (trimmed as PolicyId) : null;
}
