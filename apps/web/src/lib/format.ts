export function formatLargeNumber(num: number | null | undefined): string {
    if (num == null || !Number.isFinite(num)) return '—';
    if (num >= 1_000_000_000_000) {
        return `$${(num / 1_000_000_000_000).toFixed(2)}T`;
    }
    if (num >= 1_000_000_000) {
        return `$${(num / 1_000_000_000).toFixed(2)}B`;
    }
    if (num >= 1_000_000) {
        return `$${(num / 1_000_000).toFixed(2)}M`;
    }
    if (num >= 1_000) {
        return `$${(num / 1_000).toFixed(2)}K`;
    }
    return `$${num.toFixed(2)}`;
}

// Plain-decimal rendering for sub-cent prices (e.g. 0.00000573), keeping 3 significant digits
// instead of falling back to scientific notation.
export function formatSmallPriceDecimal(price: number): string {
    const decimals = Math.min(20, Math.max(0, 2 - Math.floor(Math.log10(Math.abs(price)))));
    return price.toFixed(decimals);
}

export function formatPrice(price: number | null | undefined): string {
    if (price == null || Number.isNaN(price)) return '—';
    if (price === 0) return '$0.00';
    if (price < 0.00001) return `$${formatSmallPriceDecimal(price)}`;
    if (price < 0.01) return `$${price.toFixed(6)}`;
    if (price < 1) return `$${price.toFixed(4)}`;
    return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(percent: number): string {
    const formatted = Math.abs(percent).toFixed(2);
    return `${percent >= 0 ? '+' : '-'}${formatted}%`;
}

/**
 * Epoch value → milliseconds. The v2 API stamps `*At` fields in ms but
 * provider `asOf` timestamps arrive in seconds; anything below 1e12 (before
 * 2001 in ms, after 2001 in s) is read as seconds. Null for non-positive input.
 */
export function toEpochMs(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
}
