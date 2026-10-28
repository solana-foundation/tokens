/**
 * Which per-variant market rows may enter an asset's sums and averages.
 *
 * Every chain's rows are summed into `chainStats` / `aggregate` and the
 * liquidity-weighted price pool, and v1's `aggregateTokenStats` does the same
 * for Solana. Without a guard a single row can own the headline: a dead
 * xStock pool on which Birdeye still reports a weeks-old last-trade price with
 * a non-trivial `liquidity` figure (CrowdStrike $8,826 against a $238 stock),
 * a $15,192 Tesla row with $11 of liquidity adding $739M of market cap, or an
 * rwa.xyz row 114 days old, a $2.4B "liquidity" figure on an Arbitrum pool
 * nobody has traded since August. Four checks, in order:
 *
 * 1. `stale`: the row's last successful provider write is older than the
 *    chain family's threshold (touches do not move it).
 * 2. `inactive`: the pool's last trade is older than `INACTIVE_AFTER_MS`.
 *    Whatever liquidity the provider still reports, nobody can be filled
 *    against it at that price; rows without a last-trade time are not judged.
 * 3. `dust`: both liquidity and 24h volume are under the floor. Dust is
 *    relative: when no row at all would survive, the dust-only rows are
 *    kept, so a one-pool asset still has a price.
 * 4. `price_outlier`: the price is more than `MAX_PRICE_DEVIATION` from the
 *    anchor, which is the reference price (CoinGecko / stock) when the caller
 *    has one in the token's units, else the liquidity-weighted median of the
 *    surviving rows (needs at least two priced survivors; a lone row passes).
 *    Rows flagged `priceChecked: false` (derivative-class variants: an LST at
 *    1.3 SOL, an ETF share) are not priced in the asset's units, so they
 *    neither take this check nor anchor the median; stale and dust still apply.
 *
 * Excluded rows leave every market sum and average (liquidity, volume, trades,
 * price). Their issued supply is an on-chain fact independent of the pool and
 * is kept by the chain-stats builder (valued at the reference price when the
 * row's own price is the problem). They stay in the response with
 * `market.quality.included = false` so a reader can see why. Primary-variant
 * ranking is deliberately untouched.
 */
import { CHAINS, type ChainKind } from '@tokens/asset-registry/chains';

export type MarketQualityReason = 'stale' | 'inactive' | 'dust' | 'price_outlier';

export interface MarketQuality {
    included: boolean;
    reasons: MarketQualityReason[];
}

export const INCLUDED_MARKET_QUALITY: Readonly<MarketQuality> = Object.freeze({ included: true, reasons: [] });

const HOUR_MS = 60 * 60 * 1000;
/** Solana rows refresh on a trade-aware rotation (≤ 1h for non-curated mints); EVM rows every 15 min, empty ones hourly. */
export const STALE_AFTER_MS: Readonly<Record<'svm' | 'evm', number>> = { svm: 2 * HOUR_MS, evm: 3 * HOUR_MS };
/** A pool whose last trade is older than this has no market, whatever liquidity the provider reports. */
export const INACTIVE_AFTER_MS = 7 * 24 * HOUR_MS;
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
    /** ms epoch of the pool's last trade; null = unknown (never inactive). */
    lastTradeAt?: number | null | undefined;
    /** False for a row not priced in the asset's units (a derivative); it skips the outlier pass. Default true. */
    priceChecked?: boolean;
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

    // Pass 1: stale, inactive and dust, per row.
    let survivors: MarketQualityInput[] = [];
    const dustOnly: MarketQualityInput[] = [];
    for (const row of rows) {
        const reasons: MarketQualityReason[] = [];
        const fetchedAt = finite(row.lastFetchedAt);
        const family = CHAINS[row.chain]?.family ?? 'evm';
        if (fetchedAt !== null && nowMs - fetchedAt > STALE_AFTER_MS[family]) reasons.push('stale');
        const lastTradeAt = finite(row.lastTradeAt);
        if (lastTradeAt !== null && nowMs - lastTradeAt > INACTIVE_AFTER_MS) reasons.push('inactive');
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
    const priced = survivors.filter(row => row.priceChecked !== false && (finite(row.price) ?? 0) > 0);
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

/** True when the guard rejected at least one row (callers then keep guarded sums over unguarded rollups). */
export function hasExcludedMarkets(quality: ReadonlyMap<string, MarketQuality>): boolean {
    for (const verdict of quality.values()) if (!verdict.included) return true;
    return false;
}

/** Counts of excluded rows by reason, for `chainStats` / `aggregate`. */
export interface ExcludedByQuality {
    stale: number;
    inactive: number;
    dust: number;
    priceOutlier: number;
}

export function emptyExcludedByQuality(): ExcludedByQuality {
    return { stale: 0, inactive: 0, dust: 0, priceOutlier: 0 };
}

export function countExcludedReasons(target: ExcludedByQuality, quality: MarketQuality): void {
    for (const reason of quality.reasons) {
        if (reason === 'stale') target.stale += 1;
        else if (reason === 'inactive') target.inactive += 1;
        else if (reason === 'dust') target.dust += 1;
        else target.priceOutlier += 1;
    }
}
