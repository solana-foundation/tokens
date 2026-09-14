/**
 * Pure peg reference and tier rules for the in-house peg guard
 * (crons.pegGuard.ts). No IO, no clock: the caller supplies `now`.
 *
 * Only USD pegs drive automated advisories today. Other fiat pegs are
 * recognised (so the stored row says which currency the coin tracks) but carry
 * a null `pegUsd` until a fiat reference rate exists, and evaluate to
 * `unsupported_peg`.
 */

import type { PegTier } from '@tokens/asset-registry';

export type PegCurrency =
    'USD' | 'EUR' | 'GBP' | 'CHF' | 'SGD' | 'JPY' | 'TRY' | 'BRL' | 'MXN' | 'NGN' | 'ZAR' | 'AUD' | 'MYR' | 'IDR';

export interface PegReference {
    currency: PegCurrency;
    /** USD value of one peg unit; null until a fiat reference exists. */
    pegUsd: number | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Signed deviation thresholds (percent from peg). Only below-peg deviation
 * counts: at or above `watch` is `ok`, then each band runs down to the next.
 */
export const PEG_GUARD_BANDS_PCT = { watch: -0.5, warning: -1, critical: -3 } as const;
/** Non-yield variants this far above peg read as `premium` (the UI's "Above peg"). */
export const PEG_GUARD_PREMIUM_PCT = 2;
/** Below this much DEX liquidity a price is not evidence of anything. */
export const PEG_GUARD_MIN_LIQUIDITY_USD = 100_000;
/** A Birdeye price older than this is not a current observation. */
export const PEG_GUARD_PRICE_STALE_MS = 30 * MINUTE_MS;
/**
 * How recent a Webacy observation must be for Webacy to own the mint. Matches
 * the Webacy reconciler's `staleObservationMs` and the API's PEG_STALE_AFTER_MS
 * so the reconciler and the token page agree on who is speaking.
 */
export const WEBACY_PEG_COVERAGE_MS = 9 * HOUR_MS;

/**
 * Standalone stablecoins (not `usd:*` / `eur:*` variants) keyed by symbol.
 * BUIDL is deliberately absent: it is a fund NAV token, not a peg.
 */
const STANDALONE_PEG_BY_SYMBOL: Record<string, PegCurrency> = {
    tryb: 'TRY',
    brz: 'BRL',
    gyen: 'JPY',
    idrx: 'IDR',
    ngnc: 'NGN',
    mxne: 'MXN',
    tgbp: 'GBP',
    vgbp: 'GBP',
    vchf: 'CHF',
    zarp: 'ZAR',
    xsgd: 'SGD',
    myrc: 'MYR',
    audd: 'AUD',
};

export interface PegVariantInput {
    assetId: string;
    variantId: string;
    symbol: string | null;
    kind: string;
}

/** Peg a curated stablecoin variant tracks; null when unknown (BUIDL, strangers). */
export function pegForStablecoinVariant(variant: PegVariantInput): PegReference | null {
    const variantId = variant.variantId.trim().toLowerCase();
    const assetId = variant.assetId.trim().toLowerCase();
    if (variantId === 'usd' || variantId.startsWith('usd:') || assetId === 'usd') {
        return { currency: 'USD', pegUsd: 1 };
    }
    if (variantId === 'eur' || variantId.startsWith('eur:') || assetId === 'eur') {
        return { currency: 'EUR', pegUsd: null };
    }
    const symbol = (variant.symbol ?? '').trim().toLowerCase();
    if (!symbol) return null;
    const currency = STANDALONE_PEG_BY_SYMBOL[symbol];
    return currency ? { currency, pegUsd: null } : null;
}

/** Signed percent from peg; negative means below. */
export function pegDeviationPct(priceUsd: number, pegUsd: number): number {
    return (priceUsd / pegUsd - 1) * 100;
}

/**
 * Tier from signed deviation. Yield-bearing variants trade above 1.00 by
 * design, so for them anything at or above peg clamps to `ok` (never
 * `premium`, which the UI renders as "Above peg").
 */
export function pegTierFromDeviation(deviationPct: number, opts: { yield: boolean }): PegTier {
    if (deviationPct >= PEG_GUARD_BANDS_PCT.watch) {
        if (!opts.yield && deviationPct >= PEG_GUARD_PREMIUM_PCT) return 'premium';
        return 'ok';
    }
    if (deviationPct > PEG_GUARD_BANDS_PCT.warning) return 'watch';
    if (deviationPct > PEG_GUARD_BANDS_PCT.critical) return 'warning';
    return 'critical';
}

export type PegObservationIssue = 'unsupported_peg' | 'no_price' | 'stale_price' | 'thin_liquidity';

export type PegEvaluation =
    | { ok: true; tier: PegTier; deviationPct: number }
    | { ok: false; issue: PegObservationIssue; deviationPct: number | null };

export interface EvaluatePegObservationInput {
    peg: PegReference | null;
    priceUsd: number | null;
    /** Provider timestamp of the price (unix ms); null when unknown. */
    priceUpdatedAt: number | null;
    liquidityUsd: number | null;
    now: number;
    isYield: boolean;
    priceStaleMs: number;
    minLiquidityUsd: number;
}

/**
 * Checks run in a fixed order (unsupported_peg, no_price, stale_price,
 * thin_liquidity) so the stored `error_message` is deterministic. The
 * deviation is still computed for stale and thin observations so the UI can
 * show it alongside `ok: false`.
 */
export function evaluatePegObservation(input: EvaluatePegObservationInput): PegEvaluation {
    const pegUsd = input.peg?.pegUsd ?? null;
    if (pegUsd === null || !Number.isFinite(pegUsd) || pegUsd <= 0) {
        return { ok: false, issue: 'unsupported_peg', deviationPct: null };
    }
    const price = input.priceUsd;
    if (price === null || !Number.isFinite(price) || price <= 0) {
        return { ok: false, issue: 'no_price', deviationPct: null };
    }
    const deviationPct = pegDeviationPct(price, pegUsd);
    if (input.priceUpdatedAt === null || input.now - input.priceUpdatedAt > input.priceStaleMs) {
        return { ok: false, issue: 'stale_price', deviationPct };
    }
    // Unknown liquidity is treated as thin: without depth a price is not evidence.
    if (
        input.liquidityUsd === null ||
        !Number.isFinite(input.liquidityUsd) ||
        input.liquidityUsd < input.minLiquidityUsd
    ) {
        return { ok: false, issue: 'thin_liquidity', deviationPct };
    }
    return { ok: true, tier: pegTierFromDeviation(deviationPct, { yield: input.isYield }), deviationPct };
}

export interface WebacyCoverageRow {
    ok: boolean;
    tier: PegTier | null;
    /** Unix ms of the last successful Webacy fetch. */
    lastOkAt: number | null;
}

/**
 * Webacy owns a mint while its latest row is a successful observation with a
 * tier and its last success is within `coverageMs`. A failed poll keeps the
 * old `lastOkAt`, so an outage hands the mint to the peg guard after 9h.
 */
export function webacyCoversMint(
    row: WebacyCoverageRow | null | undefined,
    now: number,
    coverageMs: number = WEBACY_PEG_COVERAGE_MS,
): boolean {
    if (!row || !row.ok || row.tier === null || row.lastOkAt === null) return false;
    return now - row.lastOkAt <= coverageMs;
}
