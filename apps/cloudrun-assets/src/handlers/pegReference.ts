/**
 * Pure peg reference and tier rules for the in-house peg guard
 * (crons.pegGuard.ts). No IO, no clock: the caller supplies `now`.
 *
 * Three reference kinds: a fixed 1.00 for USD stables, a CoinGecko-implied
 * fiat rate for EUR/GBP/... pegs, and a ratcheting high-water price for
 * yield-bearing USD variants that accrue above 1.00 by design.
 */

import type { PegReferenceKind, PegTier } from '@tokens/asset-registry';

export type PegCurrency =
    'USD' | 'EUR' | 'GBP' | 'CHF' | 'SGD' | 'JPY' | 'TRY' | 'BRL' | 'MXN' | 'NGN' | 'ZAR' | 'AUD' | 'MYR' | 'IDR';

export const PEG_FX_CURRENCIES: readonly PegCurrency[] = [
    'EUR', 'GBP', 'CHF', 'SGD', 'JPY', 'TRY', 'BRL', 'MXN', 'NGN', 'ZAR', 'AUD', 'MYR', 'IDR',
];

export interface PegReference {
    currency: PegCurrency;
    /**
     * USD value of one peg unit. 1 for `fixed`; null for `fx` and
     * `high_water` until the job resolves it (see `resolvePegUsd`).
     */
    pegUsd: number | null;
    /** How `pegUsd` is derived. */
    reference: PegReferenceKind;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Signed deviation thresholds (percent from peg). Only below-peg deviation
 * counts: at or above `watch` is `ok`, then each band runs down to the next.
 */
export const PEG_GUARD_BANDS_PCT = { watch: -0.5, warning: -1, critical: -3 } as const;
/**
 * Yield-bearing variants are measured against their own high-water price,
 * which is noisier than a hard peg, so the bands are wider. Steven picked
 * 5% as the critical threshold (2026-09-14).
 */
export const PEG_GUARD_YIELD_BANDS_PCT = { watch: -1, warning: -2, critical: -5 } as const;
/** A high-water reference may rise at most this much per elapsed day (yield never accrues faster). */
export const PEG_GUARD_REFERENCE_MAX_DAILY_RISE_PCT = 0.1;
/** A fiat rate older than this is not used to judge a peg. */
export const PEG_GUARD_FX_STALE_MS = 6 * 60 * 60_000;
/** Non-yield variants this far above peg read as `premium` (the UI's "Above peg"). */
export const PEG_GUARD_PREMIUM_PCT = 2;
/** Below this much DEX liquidity a price is not evidence of anything. */
export const PEG_GUARD_MIN_LIQUIDITY_USD = 100_000;
/** A Birdeye price older than this is not a current observation. */
/**
 * Birdeye's `updateUnixTime` is the last trade, not a heartbeat. A quiet
 * stablecoin (USDS, USDY, syrupUSDC trade less than hourly on Solana) has
 * not moved, so its last price is still evidence; only a market silent for
 * most of a day is treated as unknown. Verified 2026-09-14: 30 minutes
 * dropped three multi-million-dollar pools as "stale".
 */
export const PEG_GUARD_PRICE_STALE_MS = 6 * HOUR_MS;
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
        // Yield-bearing USD variants accrue above 1.00 by design; a fixed
        // reference would never see them fall. They track their own high.
        if (variant.kind === 'yield') return { currency: 'USD', pegUsd: null, reference: 'high_water' };
        return { currency: 'USD', pegUsd: 1, reference: 'fixed' };
    }
    if (variantId === 'eur' || variantId.startsWith('eur:') || assetId === 'eur') {
        return { currency: 'EUR', pegUsd: null, reference: 'fx' };
    }
    const symbol = (variant.symbol ?? '').trim().toLowerCase();
    if (!symbol) return null;
    const currency = STANDALONE_PEG_BY_SYMBOL[symbol];
    return currency ? { currency, pegUsd: null, reference: 'fx' } : null;
}

/* ------------------------------------------------------------------------- *
 * Reference resolution (fx rates, high-water marks)
 * ------------------------------------------------------------------------- */

export interface FxRate {
    usdPerUnit: number;
    /** Unix ms of the last successful fetch of this rate. */
    lastOkAt: number;
}

export interface HighWaterReference {
    referenceUsd: number;
    /** Unix ms when the reference last moved. */
    referenceUpdatedAt: number;
}

/**
 * Ratcheting reference for yield-bearing variants. Seeds at max(1.00, price)
 * on the first observation with enough liquidity; afterwards it only rises,
 * only on liquid observations, and by at most `maxDailyRisePct` per elapsed
 * day, so a thin-market wick cannot inflate it. It never falls.
 */
export function advanceHighWaterReference(input: {
    prev: HighWaterReference | null;
    priceUsd: number | null;
    liquidityOk: boolean;
    now: number;
    maxDailyRisePct?: number;
    floorUsd?: number;
}): HighWaterReference | null {
    const { prev, priceUsd, liquidityOk, now } = input;
    const floor = input.floorUsd ?? 1;
    if (!liquidityOk || priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return prev;
    if (!prev) return { referenceUsd: Math.max(floor, priceUsd), referenceUpdatedAt: now };
    if (priceUsd <= prev.referenceUsd) return prev;
    const dailyRise = (input.maxDailyRisePct ?? PEG_GUARD_REFERENCE_MAX_DAILY_RISE_PCT) / 100;
    const elapsedDays = Math.max(0, now - prev.referenceUpdatedAt) / (24 * HOUR_MS);
    const cap = prev.referenceUsd * (1 + dailyRise * elapsedDays);
    const next = Math.min(priceUsd, cap);
    if (next <= prev.referenceUsd) return prev;
    return { referenceUsd: next, referenceUpdatedAt: now };
}

export type PegResolutionIssue = 'unsupported_peg' | 'no_fx_rate' | 'stale_fx' | 'no_reference';

/** The USD value a mint's price is judged against this run, or why there is none. */
export function resolvePegUsd(input: {
    peg: PegReference | null;
    fxRates: ReadonlyMap<string, FxRate>;
    reference: HighWaterReference | null;
    now: number;
    fxStaleMs?: number;
}): { pegUsd: number } | { issue: PegResolutionIssue } {
    const { peg } = input;
    if (!peg) return { issue: 'unsupported_peg' };
    if (peg.reference === 'fixed') {
        return peg.pegUsd !== null && peg.pegUsd > 0 ? { pegUsd: peg.pegUsd } : { issue: 'unsupported_peg' };
    }
    if (peg.reference === 'high_water') {
        return input.reference ? { pegUsd: input.reference.referenceUsd } : { issue: 'no_reference' };
    }
    const rate = input.fxRates.get(peg.currency);
    if (!rate || !Number.isFinite(rate.usdPerUnit) || rate.usdPerUnit <= 0) return { issue: 'no_fx_rate' };
    if (input.now - rate.lastOkAt > (input.fxStaleMs ?? PEG_GUARD_FX_STALE_MS)) return { issue: 'stale_fx' };
    return { pegUsd: rate.usdPerUnit };
}

/** Max relative disagreement between the two implied rates before a currency is dropped. */
const FX_CROSS_CHECK_TOLERANCE = 0.01;

export interface ImpliedFxRate {
    currency: PegCurrency;
    usdPerUnit: number;
    source: 'coingecko_usd_coin' | 'coingecko_tether';
    /** Unix ms from CoinGecko's `last_updated_at`, when present. */
    providerUpdatedAt: number | null;
}

/**
 * CoinGecko `simple/price` for `usd-coin` and `tether` quoted in USD plus each
 * fiat currency. usd_per_unit(ccy) = price_usd / price_ccy. The primary coin
 * is usd-coin; tether cross-checks it and a currency whose two implied rates
 * disagree by more than 1% is dropped for the run. Tether stands in alone
 * when usd-coin lacks the quote.
 */
export function impliedUsdPerUnit(payload: unknown, currencies: readonly PegCurrency[]): ImpliedFxRate[] {
    const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const coin = (id: string): Record<string, unknown> | null => {
        const c = rec[id];
        return c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
    };
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    const implied = (c: Record<string, unknown> | null, ccy: string): number | null => {
        if (!c) return null;
        const usd = num(c.usd);
        const quote = num(c[ccy.toLowerCase()]);
        return usd !== null && quote !== null ? usd / quote : null;
    };
    const primary = coin('usd-coin');
    const secondary = coin('tether');
    const out: ImpliedFxRate[] = [];
    for (const currency of currencies) {
        const a = implied(primary, currency);
        const b = implied(secondary, currency);
        if (a !== null && b !== null) {
            if (Math.abs(a - b) / a > FX_CROSS_CHECK_TOLERANCE) continue;
        }
        const chosen = a ?? b;
        if (chosen === null) continue;
        const src = a !== null ? primary : secondary;
        const ts = src ? num(src.last_updated_at) : null;
        out.push({
            currency,
            usdPerUnit: chosen,
            source: a !== null ? 'coingecko_usd_coin' : 'coingecko_tether',
            providerUpdatedAt: ts !== null ? (ts < 1e12 ? ts * 1000 : ts) : null,
        });
    }
    return out;
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
export function pegTierFromDeviation(deviationPct: number, opts: { reference: PegReferenceKind }): PegTier {
    const highWater = opts.reference === 'high_water';
    const bands = highWater ? PEG_GUARD_YIELD_BANDS_PCT : PEG_GUARD_BANDS_PCT;
    if (deviationPct >= bands.watch) {
        if (!highWater && deviationPct >= PEG_GUARD_PREMIUM_PCT) return 'premium';
        return 'ok';
    }
    if (deviationPct > bands.warning) return 'watch';
    if (deviationPct > bands.critical) return 'warning';
    return 'critical';
}

export type PegObservationIssue = PegResolutionIssue | 'no_price' | 'stale_price' | 'thin_liquidity';

export type PegEvaluation =
    | { ok: true; tier: PegTier; deviationPct: number }
    | { ok: false; issue: PegObservationIssue; deviationPct: number | null };

export interface EvaluatePegObservationInput {
    /** Resolved reference for this run (see `resolvePegUsd`), or the reason there is none. */
    resolved: { pegUsd: number; reference: PegReferenceKind } | { issue: PegResolutionIssue };
    priceUsd: number | null;
    /** Provider timestamp of the price (unix ms); null when unknown. */
    priceUpdatedAt: number | null;
    liquidityUsd: number | null;
    now: number;
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
    if ('issue' in input.resolved) return { ok: false, issue: input.resolved.issue, deviationPct: null };
    const { pegUsd, reference } = input.resolved;
    if (!Number.isFinite(pegUsd) || pegUsd <= 0) return { ok: false, issue: 'unsupported_peg', deviationPct: null };
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
    return { ok: true, tier: pegTierFromDeviation(deviationPct, { reference }), deviationPct };
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
