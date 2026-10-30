'use client';

import { IconExclamationmarkTriangleFill } from 'symbols-react';

import { Badge } from '@tokens/ui/badge';
import { cn } from '@tokens/ui/cn';

import { advisoryLabel, advisoryReasonText, advisoryTone, type AssetAdvisory } from '@/lib/asset-advisory';

export type AssetAdvisoryBadgeSize = 'sm' | 'md';
/** `dark` targets the tooltip-styled VARIANTS hover card; `light` is the default white surface. */
export type AssetAdvisoryBadgeAppearance = 'light' | 'dark';

interface AssetAdvisoryBadgeProps {
    advisory: AssetAdvisory | null | undefined;
    size?: AssetAdvisoryBadgeSize;
    appearance?: AssetAdvisoryBadgeAppearance;
    showLabel?: boolean;
    className?: string;
}

/**
 * Single shared advisory chip. Renders nothing for `null` so call sites can
 * pass `token.advisory` straight through without a guard.
 *
 * The `@tokens/ui` `warning` variant is `text-yellow-400`, which is unreadable
 * on white, so tone colors are overridden per appearance here.
 */
export function AssetAdvisoryBadge({
    advisory,
    size = 'md',
    appearance = 'light',
    showLabel = true,
    className,
}: AssetAdvisoryBadgeProps) {
    if (!advisory) return null;

    const tone = advisoryTone(advisory.status);
    const label = advisoryLabel(advisory.status);
    const isDark = appearance === 'dark';

    const toneClassName =
        tone === 'warning'
            ? isDark
                ? 'border-amber-300/30 bg-amber-400/15 text-amber-200 hover:bg-amber-400/25'
                : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
            : isDark
              ? 'border-rose-300/30 bg-rose-400/15 text-rose-200 hover:bg-rose-400/25'
              : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100';

    const sizeClassName =
        size === 'sm' ? 'gap-1 px-1.5 py-0 text-[10px] leading-4' : 'gap-1 px-2 py-0.5 text-[11px] leading-5';
    const iconClassName = size === 'sm' ? 'size-2.5' : 'size-3';

    return (
        <Badge
            variant={tone}
            role="img"
            aria-label={`${label} advisory: ${advisoryReasonText(advisory)}`}
            title={advisoryReasonText(advisory)}
            className={cn(
                'inline-flex shrink-0 items-center font-medium tracking-normal',
                toneClassName,
                sizeClassName,
                !showLabel && (size === 'sm' ? 'px-1' : 'px-1.5'),
                className,
            )}
        >
            <IconExclamationmarkTriangleFill className={cn(iconClassName, 'shrink-0 fill-current')} aria-hidden />
            {showLabel ? <span>{label}</span> : null}
        </Badge>
    );
}
