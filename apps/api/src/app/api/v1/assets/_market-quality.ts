/**
 * Which per-variant market rows may enter an asset's sums and averages.
 *
 * Every chain's rows are summed into `chainStats` / `aggregate` and the
 * liquidity-weighted price pool, and v1's `aggregateTokenStats` does the same
 * for Solana. Without a guard a single row can own the headline: a dead
 * xStock pool on which Birdeye still reports a weeks-old last-trade price with
 * a non-trivial `liquidity` figure (CrowdStrike $8,826 against a $238 stock),
 * a $15,192 Tesla row with $11 of liquidity adding $739M of market cap, or an
 * rwa.xyz row 114 days old. Three checks, in order:
 *
 * 1. `stale`: the row's last successful provider write is older than the
 *    chain family's threshold (touches do not move it).
 * 2. `dust`: both liquidity and 24h volume are under the floor. Dust is
 *    relative: when no row at all would survive, the non-stale dust rows are
 *    kept, so a one-pool asset still has a price.
 * 3. `price_outlier`: the price is more than `MAX_PRICE_DEVIATION` from the
 *    anchor, which is the reference price (CoinGecko / stock) when the caller
 *    has one in the token's units, else the liquidity-weighted median of the
 *    surviving rows (needs at least two priced survivors; a lone row passes).
 *
 * Excluded rows leave every sum and average, market cap and supply included.
 * They stay in the response with `market.quality.included = false` so a
 * reader can see why. Primary-variant ranking is deliberately untouched.
 */
import { CHAINS, type ChainKind } from '@tokens/asset-registry/chains';

export type MarketQualityReason = 'stale' | 'dust' | 'price_outlier';

export interface MarketQuality {
    included: boolean;
    reasons: MarketQualityReason[];
}

export const INCLUDED_MARKET_QUALITY: Readonly<MarketQuality> = Object.freeze({ included: true, reasons: [] });

const HOUR_MS = 60 * 60 * 1000;
/** Solana rows refresh on a trade-aware rotation (≤ 1h for non-curated mints); EVM rows every 15 min, empty ones hourly. */
export const STALE_AFTER_MS: Readonly<Record<'svm' | 'evm', number>> = { svm: 2 * HOUR_MS, evm: 3 * HOUR_MS };
export const DUST_MIN_LIQUIDITY_USD = 1_000;
export const DUST_MIN_VOLUME24H_USD = 1_000;
export const MAX_PRICE_DEVIATION = 0.25;

export interface MarketQualityInput {
    /** Map key in the result (`<chain>:<address>` for v2, the mint for v1). */
    key: string;
    chain: ChainKind;
    price: number | null | undefined;
    liquidity: number | null | undefined;
    volume24hUSD: number | null | undefined;
    /** ms epoch of the last successful provider write; null = unknown (never stale). */
    lastFetchedAt: number | null | undefined;
}

export interface MarketQualityReference {
    /** Reference price in the token's units, or null to anchor on the rows themselves. */
    priceUsd: number | null | undefined;
}

function finite(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Smallest value whose cumulative weight reaches half the total (ties resolve to the lower value). */
export function weightedMedian(points: ReadonlyArray<{ value: number; weight: number }>): number | null {
    const sorted = points.filter(p => Number.isFinite(p.value) && p.weight > 0).sort((a, b) => a.value - b.value);
    if (sorted.length === 0) return null;
    const total = sorted.reduce((sum, p) => sum + p.weight, 0);
    let cumulative = 0;
    for (const point of sorted) {
        cumulative += point.weight;
        if (cumulative >= total / 2) return point.value;
    }
    return sorted[sorted.length - 1]!.value;
}

export function assessMarkets(
    rows: ReadonlyArray<MarketQualityInput>,
    reference: MarketQualityReference | null,
    nowMs: number,
): Map<string, MarketQuality> {
    const out = new Map<string, MarketQuality>();
    const reasonsByKey = new Map<string, MarketQualityReason[]>();

    // Pass 1: stale and dust, per row.
    let survivors: MarketQualityInput[] = [];
    const dustOnly: MarketQualityInput[] = [];
    for (const row of rows) {
        const reasons: MarketQualityReason[] = [];
        const fetchedAt = finite(row.lastFetchedAt);
        const family = CHAINS[row.chain]?.family ?? 'evm';
        if (fetchedAt !== null && nowMs - fetchedAt > STALE_AFTER_MS[family]) reasons.push('stale');
        const liquidity = finite(row.liquidity) ?? 0;
        const volume = finite(row.volume24hUSD) ?? 0;
        if (liquidity < DUST_MIN_LIQUIDITY_USD && volume < DUST_MIN_VOLUME24H_USD) reasons.push('dust');
        reasonsByKey.set(row.key, reasons);
        if (reasons.length === 0) survivors.push(row);
        else if (reasons.length === 1 && reasons[0] === 'dust') dustOnly.push(row);
    }
    // Dust is relative: with nothing else to stand on, thin pools are the market.
    if (survivors.length === 0 && dustOnly.length > 0) {
        for (const row of dustOnly) reasonsByKey.set(row.key, []);
        survivors = dustOnly;
    }

    // Pass 2: price outliers against the reference, else against the survivors' weighted median.
    const referencePrice = finite(reference?.priceUsd);
    const priced = survivors.filter(row => (finite(row.price) ?? 0) > 0);
    let anchor: number | null = referencePrice !== null && referencePrice > 0 ? referencePrice : null;
    if (anchor === null && priced.length >= 2) {
        anchor = weightedMedian(
            priced.map(row => {
                const liquidity = finite(row.liquidity) ?? 0;
                const volume = finite(row.volume24hUSD) ?? 0;
                return { value: finite(row.price)!, weight: liquidity > 0 ? liquidity : volume > 0 ? volume : 1 };
            }),
        );
    }
    if (anchor !== null && anchor > 0) {
        for (const row of priced) {
            const price = finite(row.price)!;
            if (Math.abs(price - anchor) / anchor > MAX_PRICE_DEVIATION) reasonsByKey.get(row.key)!.push('price_outlier');
        }
    }

    for (const row of rows) {
        const reasons = reasonsByKey.get(row.key) ?? [];
        out.set(row.key, { included: reasons.length === 0, reasons });
    }
    return out;
}

/** Counts of excluded rows by reason, for `chainStats` / `aggregate`. */
export interface ExcludedByQuality {
    stale: number;
    dust: number;
    priceOutlier: number;
}

export function emptyExcludedByQuality(): ExcludedByQuality {
    return { stale: 0, dust: 0, priceOutlier: 0 };
}

export function countExcludedReasons(target: ExcludedByQuality, quality: MarketQuality): void {
    for (const reason of quality.reasons) {
        if (reason === 'stale') target.stale += 1;
        else if (reason === 'dust') target.dust += 1;
        else target.priceOutlier += 1;
    }
}
