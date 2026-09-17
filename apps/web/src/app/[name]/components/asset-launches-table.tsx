'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { IconTriangleFill } from 'symbols-react';

import { cn } from '@tokens/ui/cn';
import { AssetAdvisoryBadge } from '@/components/asset-advisory-badge';
import { normalizeAdvisory, type AssetAdvisory } from '@/lib/asset-advisory';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { trackEvent } from '@/lib/posthog-client';
import { formatCompactAddress, formatUsd } from '@/app/token/[address]/lib/format';

export interface AssetLaunchEntry {
    mint: string;
    symbol: string | null;
    name: string | null;
    logoURI: string | null;
    quoteMint: string;
    quoteSymbol: string | null;
    launchpad: string;
    price: number | null;
    marketCap: number | null;
    fdv: number | null;
    liquidity: number | null;
    volume24hUSD: number | null;
    priceChange24hPercent: number | null;
    launchedAt: number | null;
    graduatedAt: number | null;
    externalUrl: string;
    advisory: AssetAdvisory | null;
}

export interface AssetLaunchesResponse {
    assetId: string;
    total: number;
    limit: number;
    launches: AssetLaunchEntry[];
    lastUpdatedAt: number | null;
}

const COLLAPSED_ROWS = 10;

function normalizeOptionalText(value: string | null | undefined): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed || trimmed === '???' || trimmed === '—' || trimmed.toLowerCase() === 'unknown') return '';
    return trimmed;
}

function formatPrice(value: number | null): string {
    if (value == null || !Number.isFinite(value)) return '—';
    if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    if (value >= 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toPrecision(3)}`;
}

function LaunchLogo({ logoURI, label }: { logoURI: string | null; label: string }) {
    const [hasError, setHasError] = React.useState(false);
    const src = normalizeLogoSrc(logoURI ?? undefined);
    const initials = (label || '??').slice(0, 2).toUpperCase();

    if (!src || hasError) {
        return (
            <div className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-gray-1400">
                <span className="text-[10px] font-bold text-white">{initials}</span>
            </div>
        );
    }

    return (
        <Image
            src={src}
            alt={label}
            width={26}
            height={26}
            className="size-[26px] shrink-0 rounded-full bg-gray-50 object-cover"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setHasError(true)}
        />
    );
}

function PercentChange({ value }: { value: number | null }) {
    if (value == null || !Number.isFinite(value)) return <span className="text-text-extra-low">—</span>;
    const isPositive = value >= 0;
    return (
        <span
            className={cn(
                'inline-flex items-center justify-end gap-1 text-[14px] font-medium tabular-nums',
                isPositive ? 'text-green-800' : 'text-red-800',
            )}
        >
            <IconTriangleFill className={cn('size-2 shrink-0 fill-current', !isPositive && 'rotate-180')} aria-hidden />
            {`${Math.abs(value).toFixed(2)}%`}
        </span>
    );
}

export function AssetLaunchesTable({
    assetId,
    quoteSymbol,
    initial,
}: {
    assetId: string;
    quoteSymbol: string;
    initial: AssetLaunchesResponse;
}) {
    const [expanded, setExpanded] = React.useState(false);
    const launches = initial.launches ?? [];
    const rows = expanded ? launches : launches.slice(0, COLLAPSED_ROWS);
    const hasMore = launches.length > COLLAPSED_ROWS;

    if (launches.length === 0) return null;

    return (
        <div className="rounded-[28px] bg-border-light/30 p-2 sm:p-3">
            <div className="overflow-hidden rounded-[22px] border border-border-medium bg-white">
                <div className="grid grid-cols-[minmax(0,1fr)_88px_88px] border-b border-border-extra-light bg-gray-50/50 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-text-low sm:grid-cols-[minmax(0,1fr)_96px_96px_104px_104px]">
                    <span>Token</span>
                    <span className="text-right">Price</span>
                    <span className="text-right">24h</span>
                    <span className="hidden text-right sm:block">Mkt cap</span>
                    <span className="hidden text-right sm:block">Vol 24h</span>
                </div>
                <ul className="divide-y divide-border-extra-light">
                    {rows.map(launch => {
                        const symbol = normalizeOptionalText(launch.symbol) || formatCompactAddress(launch.mint);
                        const name = normalizeOptionalText(launch.name);
                        const advisory = normalizeAdvisory(launch.advisory);
                        return (
                            <li key={launch.mint}>
                                <Link
                                    href={`/token/${encodeURIComponent(launch.mint)}`}
                                    prefetch={false}
                                    onClick={() =>
                                        trackEvent('asset_launch_click', {
                                            asset_id: assetId,
                                            quote_symbol: quoteSymbol,
                                            mint: launch.mint,
                                            symbol,
                                            launchpad: launch.launchpad,
                                        })
                                    }
                                    className="grid grid-cols-[minmax(0,1fr)_88px_88px] items-center gap-3 px-4 py-3 transition-colors hover:bg-gray-50/70 sm:grid-cols-[minmax(0,1fr)_96px_96px_104px_104px]"
                                >
                                    <span className="flex min-w-0 items-center gap-3">
                                        <LaunchLogo logoURI={launch.logoURI} label={symbol} />
                                        <span className="min-w-0">
                                            <span className="flex items-center gap-2">
                                                <span className="truncate text-[15px] font-semibold text-text-extra-high">
                                                    {symbol}
                                                </span>
                                                {advisory ? (
                                                    <AssetAdvisoryBadge
                                                        advisory={advisory}
                                                        size="sm"
                                                        showLabel={false}
                                                    />
                                                ) : null}
                                            </span>
                                            {name && name !== symbol ? (
                                                <span className="block truncate text-[13px] text-text-low">{name}</span>
                                            ) : null}
                                        </span>
                                    </span>
                                    <span className="text-right text-[14px] tabular-nums text-text-high">
                                        {formatPrice(launch.price)}
                                    </span>
                                    <span className="text-right">
                                        <PercentChange value={launch.priceChange24hPercent} />
                                    </span>
                                    <span className="hidden text-right text-[14px] tabular-nums text-text-high sm:block">
                                        {formatUsd(launch.marketCap)}
                                    </span>
                                    <span className="hidden text-right text-[14px] tabular-nums text-text-high sm:block">
                                        {formatUsd(launch.volume24hUSD)}
                                    </span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
                {hasMore ? (
                    <button
                        type="button"
                        onClick={() => setExpanded(v => !v)}
                        className="w-full border-t border-border-extra-light px-4 py-3 text-center text-[13px] font-medium text-text-medium transition-colors hover:bg-gray-50/70 hover:text-text-high"
                    >
                        {expanded ? 'Show fewer' : `View all ${launches.length}`}
                    </button>
                ) : null}
            </div>
        </div>
    );
}
