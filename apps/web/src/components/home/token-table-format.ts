import { formatSmallPriceDecimal } from '@/lib/format';
import type { Token, TrendingWindow } from '@/lib/types';

/** Formatters and lookups shared by the home table, its cells and its phone list. */

export const INLINE_CHART_FALLBACK_DAYS = 7;

export const TRENDING_WINDOW_LABELS: Record<TrendingWindow, string> = {
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '6h': '6h',
    '24h': '24h',
};

export function formatPrice(price: number | null | undefined): string {
    if (price == null || isNaN(price)) return '$0.00';
    if (price === 0) return '$0.00';
    if (price < 0.00001) return `$${formatSmallPriceDecimal(price)}`;
    if (price < 0.01) return `$${price.toFixed(6)}`;
    if (price < 1) return `$${price.toFixed(4)}`;
    return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatVolume(volume: number | null | undefined): string {
    if (volume == null || isNaN(volume)) return '$0.00';
    if (volume >= 1_000_000_000) return `$${(volume / 1_000_000_000).toFixed(2)}B`;
    if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(2)}M`;
    if (volume >= 1_000) return `$${(volume / 1_000).toFixed(2)}K`;
    return `$${volume.toFixed(2)}`;
}

export function formatOptionalVolume(volume: number | null | undefined): string {
    if (volume == null || isNaN(volume)) return '—';
    return formatVolume(volume);
}

export function formatInteger(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return Math.round(value).toLocaleString();
}

export function getVolumeForWindow(token: Token, window: TrendingWindow): number | undefined {
    switch (window) {
        case '5m':
            return token.volume5mUSD;
        case '15m':
            return token.volume15mUSD;
        case '1h':
            return token.volume1hUSD;
        case '6h':
            return token.volume6hUSD;
        case '24h':
            return token.volume24hUSD;
    }
}

export function getTradeForWindow(token: Token, window: TrendingWindow): number | undefined {
    switch (window) {
        case '5m':
            return token.trade5m;
        case '15m':
            return token.trade15m;
        case '1h':
            return token.trade1h;
        case '6h':
            return token.trade6h;
        case '24h':
            return token.trade24h;
    }
}
