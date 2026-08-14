import { clamp, computeMarketScore } from '@tokens/token-risk-helpers';

export { clamp, computeMarketScore };
export type {
    MarketGrade,
    MarketScoreComponentResult,
    MarketScoreInput,
    MarketScoreResult,
    RiskStatus,
} from '@tokens/token-risk-helpers';

// ---------------------------------------------------------------------------
// Formatting Helpers for Display
// ---------------------------------------------------------------------------

export function formatLiquidityRatio(liquidityUsd: number | null, marketCapUsd: number | null): string {
    if (liquidityUsd == null || marketCapUsd == null || marketCapUsd <= 0) return '—';
    const ratio = (liquidityUsd / marketCapUsd) * 100;
    return `${ratio.toFixed(2)}%`;
}

export function formatVolumeToLiquidityRatio(volumeUsd: number | null, liquidityUsd: number | null): string {
    if (volumeUsd == null || liquidityUsd == null || liquidityUsd <= 0) return '—';
    const ratio = volumeUsd / liquidityUsd;
    return `${ratio.toFixed(2)}x`;
}

export function formatUsdCompact(value: number | null): string {
    if (value == null) return '—';
    if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
    return `$${value.toFixed(2)}`;
}

export function formatInteger(value: number): string {
    return Math.round(value).toLocaleString('en-US');
}
