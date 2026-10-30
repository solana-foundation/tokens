'use client';

import { memo, useMemo } from 'react';

import { TokenPriceChartCore } from '@/components/charts/token-price-chart-core';
import { normalizeCandles, normalizeQueryError, TIME_RANGES } from '@/components/charts/price-chart-utils';
import { useAutoChartRange } from '@/components/charts/use-auto-chart-range';
import { useAssetOHLCV } from '@/hooks/queries/use-asset-ohlcv';
import { useAssetPriceChart } from '@/hooks/queries/use-asset-price-chart';
import { useRealtimeQuote } from '@/hooks/use-realtime-quote';
import { useLiveSpotPrice } from '@/lib/realtime-prices/live-spot-store';
import { trackEvent } from '@/lib/posthog-client';

interface AssetPriceChartProps {
    assetId: string;
    mint?: string;
    mode?: 'canonical' | 'variant';
    coingeckoId?: string;
    category?: string;
    symbol: string;
    realtimeSymbol?: string;
    tokenName?: string;
    logoURI?: string;
    currentPrice?: number;
    priceChange24h?: number;
    realtimeEnabled?: boolean;
}

export const AssetPriceChart = memo(function AssetPriceChart({
    assetId,
    mint,
    mode = 'variant',
    coingeckoId,
    category,
    symbol,
    realtimeSymbol,
    tokenName,
    logoURI,
    currentPrice,
    priceChange24h,
    realtimeEnabled = true,
}: AssetPriceChartProps) {
    const range = useAutoChartRange({
        onTimeRangeChanged: (next, previous) => {
            const rangeLabel = TIME_RANGES.find(r => r.days === next)?.label ?? `${next}D`;
            trackEvent('chart_timeframe_changed', {
                asset_id: assetId,
                token_symbol: symbol,
                timeframe_days: next,
                timeframe_label: rangeLabel,
                previous_timeframe_days: previous,
            });
        },
    });

    const isCanonical = mode === 'canonical';
    const canonicalQuery = useAssetPriceChart(assetId, range.interval, range.deferredTimeRange, {
        enabled: isCanonical,
    });
    const variantQuery = useAssetOHLCV(assetId, range.interval, range.deferredTimeRange, {
        mint,
        enabled: !isCanonical,
    });

    const ohlcvDataRaw = useMemo(
        () => (isCanonical ? canonicalQuery.data : variantQuery.data) ?? [],
        [canonicalQuery.data, isCanonical, variantQuery.data],
    );
    const candles = useMemo(() => normalizeCandles(ohlcvDataRaw), [ohlcvDataRaw]);
    const isLoading = isCanonical ? canonicalQuery.isLoading : variantQuery.isLoading;
    const queryError = isCanonical ? canonicalQuery.error : variantQuery.error;

    const quoteKey = useMemo(() => {
        if (isCanonical) return (coingeckoId ?? '').trim() || assetId;
        return (mint ?? '').trim() || assetId;
    }, [assetId, coingeckoId, isCanonical, mint]);
    const latestClose = candles.at(-1)?.close ?? null;
    const seedPriceUsd = latestClose ?? currentPrice ?? null;
    const realtimeSymbolTrimmed = (realtimeSymbol ?? '').trim();
    const shouldEnableRealtime = realtimeEnabled && (isCanonical || realtimeSymbolTrimmed.length > 0);

    useRealtimeQuote({
        quoteKey,
        symbol: shouldEnableRealtime ? realtimeSymbolTrimmed || symbol : undefined,
        category,
        mode: isCanonical ? 'canonical' : 'variant',
        seedPriceUsd,
        enabled: shouldEnableRealtime,
        streamEnabled: shouldEnableRealtime,
    });

    const liveSpot = useLiveSpotPrice(quoteKey);
    const livePrice =
        shouldEnableRealtime &&
        liveSpot &&
        liveSpot.source === 'pyth' &&
        Date.now() - liveSpot.updatedAtMs <= 10_000 &&
        Number.isFinite(liveSpot.priceUsd) &&
        liveSpot.priceUsd > 0
            ? liveSpot.priceUsd
            : null;
    const realtimePoint = useMemo(() => {
        if (livePrice === null) return null;
        const time = liveSpot ? Math.floor(liveSpot.updatedAtMs / 1000) : null;
        if (time === null || !Number.isFinite(time)) return null;
        return { time, value: livePrice };
    }, [livePrice, liveSpot]);

    return (
        <TokenPriceChartCore
            candles={candles}
            isLoading={isLoading}
            isPending={range.isPending}
            error={normalizeQueryError(queryError)}
            symbol={symbol}
            tokenName={tokenName}
            logoURI={logoURI}
            currentPrice={currentPrice}
            priceChange24h={priceChange24h}
            timeRangeDays={range.deferredTimeRange}
            onTimeRangeChange={range.handleTimeRangeChange}
            interval={range.interval}
            showIntervalSelector={false}
            realtimePoint={realtimePoint}
            variant="inline-asset"
            shareContext={{ assetId, mint }}
        />
    );
});
