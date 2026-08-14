export function formatLargeNumber(num: number | null | undefined): string {
    if (num == null || !Number.isFinite(num)) return '—';
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

export function formatPrice(price: number | null | undefined): string {
    if (price == null || Number.isNaN(price)) return '—';
    if (price === 0) return '$0.00';
    if (price < 0.00001) return `$${price.toExponential(2)}`;
    if (price < 0.01) return `$${price.toFixed(6)}`;
    if (price < 1) return `$${price.toFixed(4)}`;
    return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(percent: number): string {
    const formatted = Math.abs(percent).toFixed(2);
    return `${percent >= 0 ? '+' : '-'}${formatted}%`;
}
