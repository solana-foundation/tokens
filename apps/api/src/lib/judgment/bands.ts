/**
 * Category-aware thresholds ("bands") for registry-attested assets.
 *
 * The pipeline's absolute USD constants describe AMM memecoin markets. The
 * curated catalog is thin by design for tokenized equities, ETFs and RWAs
 * (RFQ / primary issuance: median liquidity ~24K) and huge for stablecoins,
 * so one scale misjudges both. A band swaps the constants for a registry
 * asset's category; the long tail (no registry attestation) keeps the
 * default band on purpose — an unknown token with 24K liquidity *is* thin.
 *
 * Measured from the live catalog on 2026-10-24 (per-category liquidity /
 * volume percentiles); see docs/v2-search-plan-2026-10-24.md.
 */

import type { EnrichedCandidate } from './types';

export interface Band {
    /** Category label echoed as the `band:<id>` badge. */
    id: string;
    /** `low_liquidity` warning below this. */
    lowLiquidityUsd: number;
    /** `deep_liquidity` attestation/reason at or above this. */
    deepLiquidityUsd: number;
    /** `sustained_activity` attestation / `high_activity` reason at or above this 24h volume. */
    sustainedVolumeUsd: number;
    /** Impersonation "shallow" bar and dynamic-dominance leader minimum. */
    standingLiquidityUsd: number;
}

export const DEFAULT_BAND: Band = {
    id: 'default',
    lowLiquidityUsd: 10_000,
    deepLiquidityUsd: 1_000_000,
    sustainedVolumeUsd: 250_000,
    standingLiquidityUsd: 250_000,
};

const OFF_AMM: Omit<Band, 'id'> = {
    lowLiquidityUsd: 2_000,
    deepLiquidityUsd: 250_000,
    sustainedVolumeUsd: 10_000,
    standingLiquidityUsd: 100_000,
};

export const BANDS: Record<string, Band> = {
    equity: { id: 'equity', ...OFF_AMM },
    etf: { id: 'etf', ...OFF_AMM },
    rwa: { id: 'rwa', ...OFF_AMM },
    stablecoin: {
        id: 'stablecoin',
        lowLiquidityUsd: 50_000,
        deepLiquidityUsd: 5_000_000,
        sustainedVolumeUsd: 1_000_000,
        standingLiquidityUsd: 250_000,
    },
    crypto: { ...DEFAULT_BAND, id: 'crypto' },
    commodity: { ...DEFAULT_BAND, id: 'commodity' },
};

/**
 * The band a candidate is judged under. Only registry-attested candidates
 * get a category band; everything else is the default scale.
 */
export function bandFor(candidate: Pick<EnrichedCandidate, 'registry' | 'category'>): Band {
    if (!candidate.registry) return DEFAULT_BAND;
    const category = candidate.category?.trim().toLowerCase();
    return (category && BANDS[category]) || DEFAULT_BAND;
}

/** Whether the candidate's band differs from the default scale (worth a badge). */
export function isCategoryBand(band: Band): boolean {
    return band.id !== DEFAULT_BAND.id;
}
