'use client';

import Link from 'next/link';
import { Fragment, memo } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { SegmentedControl } from '@solana/design-system/segmented-control';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@tokens/ui/breadcrumb';

import { HEATMAP_PERIODS, type HeatmapPeriod } from '../lib/types';

export interface HeatmapCrumb {
    key: string;
    label: string;
    /** A page elsewhere on the site (Explore). */
    href?: string;
    /** A view of the heat map. Neither href nor onSelect: the current (last) crumb. */
    onSelect?: () => void;
}

const CRUMB_CLASS =
    'rounded-sm font-medium transition-colors hover:text-text-extra-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high/30';

interface HeatmapToolbarProps {
    crumbs: HeatmapCrumb[];
    /** Asset page for the asset being viewed, when drilled into one. */
    assetHref?: string;
    period: HeatmapPeriod;
    onPeriodChange: (period: HeatmapPeriod) => void;
}

const PERIOD_ITEMS = HEATMAP_PERIODS.map(value => ({ value, label: value }));
const LINK_CLASS =
    'inline-flex items-center gap-1 whitespace-nowrap text-[13px] font-medium text-text-low transition-colors hover:text-text-extra-high';

/**
 * Memoised: the segmented control measures its layout on every render (for its sliding pill), and
 * re-rendering it on each zoom would force a synchronous layout of the freshly mounted tiles.
 */
const PeriodSwitch = memo(function PeriodSwitch({
    period,
    onPeriodChange,
}: {
    period: HeatmapPeriod;
    onPeriodChange: (period: HeatmapPeriod) => void;
}) {
    return (
        <div className="flex items-center gap-2 text-[13px] text-text-low">
            <span aria-hidden="true" className="shrink-0 whitespace-nowrap">
                Change
            </span>
            <SegmentedControl
                aria-label="Price change period"
                items={PERIOD_ITEMS}
                value={period}
                onValueChange={value => onPeriodChange(value as HeatmapPeriod)}
            />
        </div>
    );
});

export function HeatmapToolbar({ crumbs, assetHref, period, onPeriodChange }: HeatmapToolbarProps) {
    return (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1">
                <Breadcrumb>
                    <BreadcrumbList className="text-[15px] text-text-low">
                        {crumbs.map((crumb, index) => (
                            <Fragment key={crumb.key}>
                                {index > 0 ? <BreadcrumbSeparator /> : null}
                                <BreadcrumbItem>
                                    {crumb.href ? (
                                        <Link href={crumb.href} className={CRUMB_CLASS}>
                                            {crumb.label}
                                        </Link>
                                    ) : crumb.onSelect ? (
                                        <button type="button" className={CRUMB_CLASS} onClick={crumb.onSelect}>
                                            {crumb.label}
                                        </button>
                                    ) : (
                                        <BreadcrumbPage className="font-semibold text-text-extra-high">
                                            {crumb.label}
                                        </BreadcrumbPage>
                                    )}
                                </BreadcrumbItem>
                            </Fragment>
                        ))}
                    </BreadcrumbList>
                </Breadcrumb>
                {assetHref ? (
                    <Link href={assetHref} className={LINK_CLASS}>
                        Open asset page
                        <ArrowUpRight aria-hidden="true" className="size-3.5" />
                    </Link>
                ) : null}
            </div>

            <PeriodSwitch period={period} onPeriodChange={onPeriodChange} />
        </div>
    );
}
