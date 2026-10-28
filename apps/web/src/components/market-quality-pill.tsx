'use client';

import { Badge } from '@tokens/ui/badge';
import { cn } from '@tokens/ui/cn';

import type { V2Market } from '@/lib/api-v2-types';
import { marketQualityVerdict } from '@/lib/market-quality-label';

export type MarketQualityPillSize = 'sm' | 'md';
export type MarketQualityPillAppearance = 'light' | 'dark';

interface MarketQualityPillProps {
    market: Pick<V2Market, 'quality'> | null | undefined;
    size?: MarketQualityPillSize;
    appearance?: MarketQualityPillAppearance;
    className?: string;
}

/**
 * Marks a variant whose market row the API's quality guard left out of the
 * asset totals (see `market.quality`). Renders nothing for an included row so
 * call sites can pass `variant.market` straight through.
 */
export function MarketQualityPill({ market, size = 'md', appearance = 'light', className }: MarketQualityPillProps) {
    if (!market || market.quality.included) return null;
    const verdict = marketQualityVerdict(market.quality.reasons);
    if (!verdict) return null;
    const isDark = appearance === 'dark';
    const toneClassName = isDark
        ? 'border-white/15 bg-white/10 text-white/70'
        : 'border-border-light bg-gray-50 text-text-low';
    const sizeClassName = size === 'sm' ? 'px-1.5 py-0 text-[10px] leading-4' : 'px-2 py-0.5 text-[11px] leading-5';
    return (
        <Badge
            variant="outline"
            role="img"
            aria-label={`${verdict.label}: ${verdict.detail}`}
            title={verdict.detail}
            className={cn(
                'inline-flex shrink-0 items-center font-medium tracking-normal',
                toneClassName,
                sizeClassName,
                className,
            )}
        >
            {verdict.label}
        </Badge>
    );
}
