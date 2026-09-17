'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@tokens/ui/avatar';
import { Button } from '@tokens/ui/button';
import { Badge } from '@solana/design-system/badge';

import type { LaunchpadTokenMarket } from '@/lib/admin-types';
import { formatUsdCompact } from '@/lib/launch-labels';

/** Small shared pieces for the Launches page and its dialogs (same look as Curation's add-variant dialog). */

export function SummaryField({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 rounded-md border border-border-extra-light bg-white px-3 py-2">
            <div className="text-[11px] font-inter-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {label}
            </div>
            <div className="mt-1 truncate text-sm font-inter-medium text-foreground">{value}</div>
        </div>
    );
}

export function CopyButton({ value }: { value: string }) {
    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void navigator.clipboard.writeText(value)}
        >
            Copy
        </Button>
    );
}

export function TokenAvatar({
    imageUrl,
    label,
    className = 'h-8 w-8',
}: {
    imageUrl: string | null | undefined;
    label: string;
    className?: string;
}) {
    return (
        <Avatar className={className}>
            {imageUrl ? <AvatarImage src={imageUrl} alt={label} /> : null}
            <AvatarFallback className="text-[10px]">{label.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
    );
}

export function formatPrice(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—';
    if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    if (value >= 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toPrecision(3)}`;
}

export function MarketSummary({ market }: { market: LaunchpadTokenMarket }) {
    const fields = [
        ['Price', formatPrice(market.priceUsd)],
        ['Market cap', formatUsdCompact(market.marketCapUsd)],
        ['FDV', formatUsdCompact(market.fdvUsd)],
        ['Liquidity', formatUsdCompact(market.liquidityUsd)],
        ['Volume 24h', formatUsdCompact(market.volume24hUsd)],
        [
            '24h change',
            market.priceChange24h === null
                ? '—'
                : `${market.priceChange24h >= 0 ? '+' : ''}${market.priceChange24h.toFixed(2)}%`,
        ],
    ] as const;
    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {fields.map(([label, value]) => (
                <SummaryField key={label} label={label} value={value} />
            ))}
        </div>
    );
}

/** Badges describing where a coin stands: approved / live / pending / below threshold. */
export function LaunchStateBadges({
    approved,
    synced,
    isActive,
    meetsThreshold,
    status,
}: {
    approved: boolean;
    synced: boolean;
    isActive: boolean;
    meetsThreshold?: boolean;
    status?: string | null;
}) {
    return (
        <>
            {approved ? <Badge variant="success">approved</Badge> : null}
            {synced && isActive ? (
                <Badge variant={approved ? 'success' : 'default'}>{approved ? 'live' : 'synced'}</Badge>
            ) : synced ? (
                <Badge variant="warning">pending identity</Badge>
            ) : (
                <Badge variant="default">not synced</Badge>
            )}
            {meetsThreshold === false ? <Badge variant="warning">below threshold</Badge> : null}
            {status && status !== 'graduated' ? <Badge variant="danger">{status}</Badge> : null}
        </>
    );
}
