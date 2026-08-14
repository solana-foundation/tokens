export function formatNumber(num: number | undefined | null): string {
    if (num == null) return '—';
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
    return num.toFixed(2);
}

export function formatUsd(value: number | undefined | null): string {
    if (value == null || Number.isNaN(value)) return '—';
    return `$${formatNumber(value)}`;
}

export function formatCount(value: number | undefined | null): string {
    if (value == null || Number.isNaN(value)) return '—';
    return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function formatPercent(value: number | undefined | null): string {
    if (value == null || Number.isNaN(value)) return '—';
    const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
    return `${prefix}${Math.abs(value).toFixed(2)}%`;
}

export function formatCompactAddress(address: string | undefined | null): string {
    if (!address) return '—';
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
