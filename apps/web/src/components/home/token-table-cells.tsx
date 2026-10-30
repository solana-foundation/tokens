'use client';

import * as React from 'react';
import Image from 'next/image';
import { IconTriangleFill } from 'symbols-react';

import { cn } from '@tokens/ui/cn';
import { AnimatedPrice } from '@/components/animated-price';
import { useInlineLatestClose } from '@/hooks/queries/use-inline-latest-close';
import { getTokenLogoURLWithSecondarySymbol } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { applyLiveChangePercent } from '@/lib/realtime-prices/live-change';
import { getLiveSpotPrice, isFreshLiveSpot, useFreshLiveSpotPrice } from '@/lib/realtime-prices/live-spot-store';
import { buildLiveQuoteKey } from '@/lib/realtime-prices/pyth-feed-batch';
import type { Token } from '@/lib/types';
import { INLINE_CHART_FALLBACK_DAYS, formatPrice } from './token-table-format';

/** Cell renderers shared by the home table and its phone list; formatters live in token-table-format.ts. */

const LIVE_PRICE_STALE_MS = 10_000;

/** The row's live Pyth price when the table hook is streaming it and the tick is fresh; else null. */
function useLiveRowPrice(token: Token): number | null {
    return useFreshLiveSpotPrice(buildLiveQuoteKey(token), LIVE_PRICE_STALE_MS);
}

/** Same value `TokenTablePriceCell` displays right now, for sorting: live when fresh, else the snapshot. */
export function rowPriceForSort(token: Token): number | null {
    const liveSpot = getLiveSpotPrice(buildLiveQuoteKey(token));
    if (isFreshLiveSpot(liveSpot, LIVE_PRICE_STALE_MS)) return liveSpot!.priceUsd;
    return typeof token.price === 'number' && Number.isFinite(token.price) ? token.price : null;
}

/** Same value `LivePercentChangeCell` displays right now, for sorting. */
export function rowChangeForSort(token: Token, field: LiveChangeField): number | null {
    const liveSpot = getLiveSpotPrice(buildLiveQuoteKey(token));
    const livePrice = isFreshLiveSpot(liveSpot, LIVE_PRICE_STALE_MS) ? liveSpot!.priceUsd : null;
    return applyLiveChangePercent(token.price, token[field], livePrice);
}

export function TokenTablePriceCell({ token, className }: { token: Token; className?: string }) {
    const shouldUseCanonicalAssetChart = token.canonicalMarketSource === 'clickhouse_stock';
    const latestClose = useInlineLatestClose({
        assetId: token.assetId,
        address: token.address,
        useCanonicalAssetChart: shouldUseCanonicalAssetChart,
        fallbackDays: INLINE_CHART_FALLBACK_DAYS,
    });
    const snapshotPrice =
        token.coingeckoId || shouldUseCanonicalAssetChart ? token.price : (latestClose ?? token.price);
    // Live Pyth price when the table hook is streaming this row (see useLiveTablePrices);
    // a tick older than the stale window falls back to the snapshot.
    const livePrice = useLiveRowPrice(token);
    const displayPrice = livePrice ?? snapshotPrice;

    return (
        <span
            className={cn('block w-full text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums', className)}
            data-live={livePrice !== null ? 'true' : undefined}
        >
            {/* Same rolling digits as the chart header; static until the row is live. */}
            <AnimatedPrice value={formatPrice(displayPrice)} enabled={livePrice !== null} />
        </span>
    );
}

export function PercentChangeCell({ value, animate = false }: { value: number; animate?: boolean }) {
    const isPositive = value >= 0;
    return (
        <span
            className={cn(
                'inline-flex w-full items-center justify-end gap-1 text-[14px] font-medium tabular-nums',
                isPositive ? 'text-green-800' : 'text-red-800',
            )}
        >
            <IconTriangleFill className={cn('size-2 shrink-0 fill-current', !isPositive && 'rotate-180')} aria-hidden />
            <AnimatedPrice value={`${Math.abs(value).toFixed(2)}%`} enabled={animate} />
        </span>
    );
}

export type LiveChangeField = 'priceChange1hPercent' | 'priceChange24hPercent';

/**
 * Percent change that moves with the live price: the snapshot's reference
 * price is carried forward so the column agrees with the live price column
 * (and with the chart header) instead of lagging a snapshot behind it.
 */
export function LivePercentChangeCell({
    token,
    field,
    className,
}: {
    token: Token;
    field: LiveChangeField;
    className?: string;
}) {
    const livePrice = useLiveRowPrice(token);
    const value = applyLiveChangePercent(token.price, token[field], livePrice);
    if (value == null) return <span className="block w-full text-right text-[14px] text-text-extra-low">—</span>;
    return (
        <span className={className}>
            <PercentChangeCell value={value} animate={livePrice !== null} />
        </span>
    );
}

export function TokenLogo({ token, size = 26 }: { token: Token; size?: number }) {
    const [hasError, setHasError] = React.useState(false);

    const symbol = token.symbol || token.name || '??';
    const initials = symbol.slice(0, 2).toUpperCase();
    const resolvedLogoURI = normalizeLogoSrc(
        token.trendingRank != null && token.logoURI
            ? token.logoURI
            : getTokenLogoURLWithSecondarySymbol(token.symbol, token.name, token.logoURI),
    );

    if (!resolvedLogoURI || hasError) {
        return (
            <div
                className="rounded-full bg-gray-1400 flex items-center justify-center shrink-0"
                style={{ width: size, height: size }}
            >
                <span className={cn('font-bold text-white', size >= 40 ? 'text-[14px]' : 'text-[10px]')}>
                    {initials}
                </span>
            </div>
        );
    }

    return (
        <Image
            src={resolvedLogoURI}
            alt={symbol}
            width={size}
            height={size}
            style={{ width: size, height: size }}
            className="rounded-full bg-gray-50 object-cover shrink-0"
            loading="lazy"
            decoding="async"
            onError={() => setHasError(true)}
            referrerPolicy="no-referrer"
        />
    );
}
