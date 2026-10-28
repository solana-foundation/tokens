import type { V2Market, V2MarketQualityReason } from './api-v2-types';

/**
 * How a variant card explains a market row the API's quality guard left out
 * of the asset's sums. The reasons are ranked: a dead pool is the whole story,
 * a wrong price is the next most useful thing to say, staleness last.
 */
export type MarketQualityVerdict = { label: string; detail: string };

const RANK: V2MarketQualityReason[] = ['inactive', 'dust', 'price_outlier', 'stale'];

export function marketQualityVerdict(reasons: readonly V2MarketQualityReason[]): MarketQualityVerdict | null {
    const reason = RANK.find(candidate => reasons.includes(candidate));
    if (!reason) return null;
    switch (reason) {
        case 'inactive':
            return {
                label: 'No active market',
                detail: 'No trade in the last 7 days; this pool is left out of the asset totals.',
            };
        case 'dust':
            return {
                label: 'No active market',
                detail: 'Under $1k of liquidity and 24h volume; this pool is left out of the asset totals.',
            };
        case 'price_outlier':
            return {
                label: 'Price off reference',
                detail: 'This pool prices the token far from the reference; it is left out of the asset totals.',
            };
        case 'stale':
            return {
                label: 'Stale data',
                detail: 'The provider has not refreshed this row recently; it is left out of the asset totals.',
            };
    }
}

/** True when the row is in the asset's sums (or has no market at all, which says nothing). */
export function isMarketIncluded(market: Pick<V2Market, 'quality'> | null | undefined): boolean {
    return market?.quality?.included !== false;
}

/** Sort key: rows in the totals first, then the excluded ones; ties keep the caller's order. */
export function compareMarketInclusion(
    a: { market?: Pick<V2Market, 'quality'> | null },
    b: { market?: Pick<V2Market, 'quality'> | null },
): number {
    return Number(!isMarketIncluded(a.market)) - Number(!isMarketIncluded(b.market));
}
