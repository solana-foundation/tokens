'use client';

import type { ComponentProps } from 'react';

import type { CompactPegHealth, PegHealth } from '@tokens/asset-registry';
import { Badge } from '@tokens/ui/badge';
import { cn } from '@tokens/ui/cn';

import { PEG_TIER_COPY, pegDeviationText, pegStatusTitle, type HealthTone } from '@/lib/stablecoin-health';

export type PegStatusPillSize = 'sm' | 'md';
/** `dark` targets the tooltip-styled VARIANTS hover card; `light` is the default white surface. */
export type PegStatusPillAppearance = 'light' | 'dark';

interface PegStatusPillProps {
    pegHealth: CompactPegHealth | PegHealth | null | undefined;
    size?: PegStatusPillSize;
    appearance?: PegStatusPillAppearance;
    /** Append the signed deviation after the label (skipped when the tier is `ok`). */
    showDeviation?: boolean;
    className?: string;
}

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>['variant']>;

const BADGE_VARIANT_BY_TONE: Record<HealthTone, BadgeVariant> = {
    success: 'success',
    neutral: 'secondary',
    warning: 'warning',
    destructive: 'destructive',
    info: 'secondary',
};

/**
 * The `@tokens/ui` tone variants are tuned for dark surfaces (`warning` is
 * `text-yellow-400`), so colors are overridden per appearance here using the
 * same amber/rose/emerald/gray families as the advisory badge and risk rows.
 * `info` (above peg) shares the neutral treatment: it is not a health signal.
 */
function toneClassName(tone: HealthTone, isDark: boolean): string {
    switch (tone) {
        case 'success':
            return isDark
                ? 'border-emerald-300/30 bg-emerald-400/15 text-emerald-200 hover:bg-emerald-400/25'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100';
        case 'warning':
            return isDark
                ? 'border-amber-300/30 bg-amber-400/15 text-amber-200 hover:bg-amber-400/25'
                : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100';
        case 'destructive':
            return isDark
                ? 'border-rose-300/30 bg-rose-400/15 text-rose-200 hover:bg-rose-400/25'
                : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100';
        case 'neutral':
        case 'info':
            return isDark
                ? 'border-white/15 bg-white/10 text-gray-200 hover:bg-white/15'
                : 'border-border-light bg-gray-50 text-text-medium hover:bg-gray-100';
    }
}

/**
 * Single shared peg-status chip for stablecoin variants. Renders nothing for
 * `null` so call sites can pass `variant.pegHealth` straight through without
 * a guard. Stale observations keep their tone but drop to reduced opacity and
 * say so in the accessible title.
 */
export function PegStatusPill({
    pegHealth,
    size = 'md',
    appearance = 'light',
    showDeviation = false,
    className,
}: PegStatusPillProps) {
    if (!pegHealth) return null;

    const copy = PEG_TIER_COPY[pegHealth.tier];
    const isDark = appearance === 'dark';
    const title = pegStatusTitle(pegHealth);
    const deviation =
        showDeviation && pegHealth.tier !== 'ok' && pegHealth.deviationPct !== null
            ? pegDeviationText(pegHealth)
            : null;

    const sizeClassName =
        size === 'sm' ? 'gap-1 px-1.5 py-0 text-[10px] leading-4' : 'gap-1.5 px-2 py-0.5 text-[11px] leading-5';
    const dotClassName = size === 'sm' ? 'size-1.5' : 'size-2';

    return (
        <Badge
            variant={BADGE_VARIANT_BY_TONE[copy.tone]}
            role="img"
            aria-label={title}
            title={title}
            className={cn(
                'inline-flex shrink-0 items-center font-medium tracking-normal',
                toneClassName(copy.tone, isDark),
                sizeClassName,
                pegHealth.stale && 'opacity-70',
                className,
            )}
        >
            <span className={cn(dotClassName, 'shrink-0 rounded-full bg-current')} aria-hidden />
            <span>{copy.label}</span>
            {deviation ? <span className="tabular-nums opacity-80">{deviation}</span> : null}
        </Badge>
    );
}
