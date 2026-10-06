import { formatLargeNumber, formatPercent } from '@/lib/format';
import type { LayoutTile } from './treemap';
import type { HeatmapAsset, HeatmapPeriod } from './types';

/** `formatLargeNumber` stops at billions; stock market caps run into trillions. */
export function formatUsdCompact(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(2)}T`;
    return formatLargeNumber(value);
}

export function formatChange(change: number | null | undefined): string {
    return typeof change === 'number' && Number.isFinite(change) ? formatPercent(change) : 'No data';
}

/** A tile's 24h Solana volume; "no volume" rather than a misleading $0.00. */
export function formatVolume(value: number | null | undefined): string {
    return typeof value === 'number' && value > 0 ? formatUsdCompact(value) : 'No volume';
}

export function tileChange(tile: LayoutTile, period: HeatmapPeriod): number | null {
    if (tile.kind === 'asset') return period === '1h' ? tile.asset.change1h : tile.asset.change24h;
    if (tile.kind === 'variant') return period === '1h' ? tile.variant.change1h : tile.variant.change24h;
    return null;
}

/** Name of the figure behind an asset's "market cap": the underlying asset's, or what is on Solana. */
export function marketCapLabel(asset: HeatmapAsset): string {
    return asset.marketCapSource === 'underlying' ? 'Market cap' : 'On-Solana value';
}

export function tileAriaLabel(tile: LayoutTile, period: HeatmapPeriod): string {
    if (tile.kind === 'more') return `${tile.count} more assets too small to draw here. Show this category.`;

    const change = `${formatChange(tileChange(tile, period))} ${period}`;
    const volume = `24h volume ${formatVolume(tile.value)}`;
    if (tile.kind === 'variant') {
        return `${tile.variant.name} (${tile.variant.symbol}), ${change}, ${volume}.${tile.variant.hasTokenPage ? ' Open token page.' : ''}`;
    }

    const action = tile.asset.variants.length > 1 ? `Show ${tile.asset.variants.length} variants.` : 'Open asset page.';
    return `${tile.asset.name} (${tile.asset.symbol}), ${change}, ${volume}. ${action}`;
}
