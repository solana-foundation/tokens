'use client';

import { useEffect, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { IconCheckmark, IconExclamationmarkTriangleFill, IconInfoCircleFill, IconXmark } from 'symbols-react';

import type { PegHealth, StructuralHealth, StructuralHealthCategory } from '@tokens/asset-registry';
import { cn } from '@tokens/ui/cn';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@tokens/ui/tooltip';

import { PegStatusPill } from '@/components/peg-status-pill';
import { TrackedAnchor } from '@/components/tracked-link';
import { trackEvent } from '@/lib/posthog-client';
import {
    PEG_TIER_COPY,
    STABLECOIN_HEALTH_VIEWED_EVENT,
    WEBACY_ATTRIBUTION_URL,
    WEBACY_PROVIDER_LABEL,
    formatHealthUpdatedAt,
    pegDeviationText,
    pegPriceText,
    stablecoinHealthEventProps,
    structuralCategoryTooltip,
    structuralGradeTone,
    structuralStatusTone,
    type HealthTone,
} from '@/lib/stablecoin-health';

interface StablecoinHealthPanelProps {
    pegHealth: PegHealth | null;
    structuralHealth: StructuralHealth | null;
    /** Mint the panel describes, attached to the attribution click event. */
    mint?: string | null;
    className?: string;
}

const CARD_CLASS_NAME = 'rounded-[18px] border border-border-light bg-white p-6';

/**
 * Two-card stablecoin block rendered above the market-score risk cards for
 * stablecoin variants: live peg status (Webacy depeg monitor, ~20 min cadence)
 * and the structural health grade (Webacy v3, daily). Webacy's 0-100 scores
 * are higher-is-riskier and are deliberately not rendered so they cannot be
 * misread next to the higher-is-better Market Score gauge.
 */
export function StablecoinHealthPanel({ pegHealth, structuralHealth, mint, className }: StablecoinHealthPanelProps) {
    const pegTier = pegHealth?.tier ?? null;
    const structuralGrade = structuralHealth?.grade ?? null;

    useEffect(() => {
        if (!pegTier && !structuralGrade) return;
        trackEvent(
            STABLECOIN_HEALTH_VIEWED_EVENT,
            stablecoinHealthEventProps(
                pegTier ? { tier: pegTier } : null,
                structuralGrade ? { grade: structuralGrade } : null,
            ),
        );
    }, [pegTier, structuralGrade]);

    if (!pegHealth && !structuralHealth) return null;

    return (
        <TooltipProvider delayDuration={200}>
            <div className={cn('grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6', className)}>
                <PegStatusCard pegHealth={pegHealth} mint={mint} />
                <StructuralHealthCard structuralHealth={structuralHealth} mint={mint} />
            </div>
        </TooltipProvider>
    );
}

// ---------------------------------------------------------------------------
// Peg status card
// ---------------------------------------------------------------------------

function PegStatusCard({ pegHealth, mint }: { pegHealth: PegHealth | null; mint?: string | null }) {
    if (!pegHealth) {
        return (
            <UnavailableCard
                heading="Peg status"
                subtitle="Live depeg monitor by Webacy"
                message="Peg monitor not available for this token."
            />
        );
    }

    const copy = PEG_TIER_COPY[pegHealth.tier];
    const priceText = pegPriceText(pegHealth);
    const deviationText = pegDeviationText(pegHealth);

    return (
        <section className={CARD_CLASS_NAME} aria-labelledby="stablecoin-peg-status-heading">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <h4 id="stablecoin-peg-status-heading" className="text-title-sm text-text-extra-high">
                        Peg status
                    </h4>
                    <p className="mt-1 text-body-sm text-text-low">Live depeg monitor by Webacy</p>
                </div>
                <PegStatusPill pegHealth={pegHealth} size="md" showDeviation className="mt-0.5" />
            </div>

            <div className="mt-6">
                {priceText ? (
                    <p className="text-[28px] font-medium leading-none tabular-nums text-text-extra-high">
                        {priceText}
                    </p>
                ) : null}
                <p className={cn('text-body-lg font-medium tabular-nums text-text-extra-high', priceText && 'mt-2')}>
                    {deviationText}
                </p>
                <p className="mt-2 text-body-md text-text-low text-pretty">{copy.description}</p>
            </div>

            {pegHealth.stale ? (
                <StaleNotice>Peg data is stale. The monitor has not reported a fresh observation recently.</StaleNotice>
            ) : null}

            <AttributionFooter updatedAt={pegHealth.updatedAt} surface="peg_status" mint={mint} />
        </section>
    );
}

// ---------------------------------------------------------------------------
// Structural health card
// ---------------------------------------------------------------------------

function StructuralHealthCard({
    structuralHealth,
    mint,
}: {
    structuralHealth: StructuralHealth | null;
    mint?: string | null;
}) {
    if (!structuralHealth) {
        return (
            <UnavailableCard
                heading="Structural health"
                subtitle="Graded daily by Webacy"
                message="Structural health grade not available for this token."
            />
        );
    }

    const tone = structuralGradeTone(structuralHealth.grade);

    return (
        <section className={CARD_CLASS_NAME} aria-labelledby="stablecoin-structural-health-heading">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <h4 id="stablecoin-structural-health-heading" className="text-title-sm text-text-extra-high">
                        Structural health
                    </h4>
                    <p className="mt-1 text-body-sm text-text-low">Structural health · graded daily by Webacy</p>
                </div>
                <div
                    className={cn(
                        'flex h-14 min-w-14 shrink-0 items-center justify-center rounded-2xl border px-3 text-[28px] font-medium leading-none tabular-nums',
                        gradeToneClassName(tone),
                    )}
                    role="img"
                    aria-label={`Structural health grade ${structuralHealth.grade}`}
                >
                    {structuralHealth.grade}
                </div>
            </div>

            {structuralHealth.categories.length > 0 ? (
                <div className="mt-6 divide-y divide-border-light">
                    {structuralHealth.categories.map(category => (
                        <StatusRow key={category.key} category={category} />
                    ))}
                </div>
            ) : (
                <p className="mt-6 text-body-md text-text-low">Category breakdown not available.</p>
            )}

            {structuralHealth.stale ? (
                <StaleNotice>Structural grade is stale. The last daily refresh did not complete.</StaleNotice>
            ) : null}

            <AttributionFooter updatedAt={structuralHealth.updatedAt} surface="structural_health" mint={mint} />
        </section>
    );
}

/**
 * Sibling of `ScoreRow` in `token-risk-display.tsx` (which is not exported):
 * same row layout and icon language, but keyed on the structural category
 * status instead of a market-score component. No numeric value is shown.
 */
function StatusRow({ category }: { category: StructuralHealthCategory }) {
    const tone = structuralStatusTone(category.status);
    const Icon =
        tone === 'success'
            ? IconCheckmark
            : tone === 'destructive'
              ? IconXmark
              : tone === 'warning'
                ? IconExclamationmarkTriangleFill
                : IconInfoCircleFill;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div className="flex cursor-default items-center justify-between gap-6 py-3.5 first:pt-0 last:pb-0">
                    <div className="text-body-md font-medium text-text-extra-high">{category.label}</div>
                    <div
                        className={cn(
                            'flex size-7 items-center justify-center rounded-lg border border-border-light bg-gray-50',
                            tone === 'destructive' && 'border-red-200 bg-red-50 text-red-700',
                            tone === 'success' && 'border-green-200 bg-green-50 text-green-700',
                            tone === 'warning' && 'border-amber-200 bg-amber-50 text-amber-700',
                            tone === 'neutral' && 'text-text-medium',
                        )}
                        aria-label={structuralCategoryTooltip(category)}
                    >
                        <Icon
                            className={cn(
                                'h-3.5 w-3.5',
                                tone === 'destructive' && 'fill-rose-600',
                                tone === 'success' && 'fill-emerald-600',
                                tone === 'warning' && 'fill-amber-600',
                                tone === 'neutral' && 'fill-text-medium',
                            )}
                        />
                    </div>
                </div>
            </TooltipTrigger>
            <TooltipContent
                side="right"
                sideOffset={8}
                className="bg-[var(--tooltip-bg)] text-[var(--tooltip-text)] max-w-[280px]"
            >
                <p className="text-pretty">{structuralCategoryTooltip(category)}</p>
            </TooltipContent>
        </Tooltip>
    );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function gradeToneClassName(tone: HealthTone): string {
    switch (tone) {
        case 'success':
            return 'border-emerald-200 bg-emerald-50 text-emerald-700';
        case 'warning':
            return 'border-amber-200 bg-amber-50 text-amber-700';
        case 'destructive':
            return 'border-rose-200 bg-rose-50 text-rose-700';
        case 'neutral':
        case 'info':
            return 'border-border-light bg-gray-50 text-text-extra-high';
    }
}

function UnavailableCard({ heading, subtitle, message }: { heading: string; subtitle: string; message: string }) {
    return (
        <section className={cn(CARD_CLASS_NAME, 'bg-gray-50/50')}>
            <h4 className="text-title-sm text-text-extra-high">{heading}</h4>
            <p className="mt-1 text-body-sm text-text-low">{subtitle}</p>
            <p className="mt-6 text-body-md text-text-extra-low text-pretty">{message}</p>
        </section>
    );
}

function StaleNotice({ children }: { children: ReactNode }) {
    return (
        <p className="mt-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-900">
            <IconExclamationmarkTriangleFill className="mt-0.5 h-3 w-3 shrink-0 fill-amber-600" aria-hidden />
            <span>{children}</span>
        </p>
    );
}

function AttributionFooter({
    updatedAt,
    surface,
    mint,
}: {
    updatedAt: number;
    surface: 'peg_status' | 'structural_health';
    mint?: string | null;
}) {
    const updated = formatHealthUpdatedAt(updatedAt);

    return (
        <p className="mt-5 flex flex-wrap items-center gap-x-1 text-[12px] text-text-extra-low">
            {updated ? <span>Updated {updated} ·</span> : null}
            <span>Data by</span>
            <TrackedAnchor
                href={WEBACY_ATTRIBUTION_URL}
                target="_blank"
                rel="noopener noreferrer"
                trackingEvent="external_link_clicked"
                trackingProperties={{
                    link_type: 'data_provider',
                    link_url: WEBACY_ATTRIBUTION_URL,
                    provider: 'webacy',
                    source: `stablecoin_health_${surface}`,
                    ...(mint ? { token_address: mint } : {}),
                }}
                className="inline-flex items-center gap-0.5 font-medium text-text-medium transition-colors hover:text-text-extra-high"
            >
                {WEBACY_PROVIDER_LABEL}
                <ArrowUpRight className="size-3" aria-hidden />
            </TrackedAnchor>
        </p>
    );
}
