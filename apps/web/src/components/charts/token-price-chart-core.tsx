'use client';

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Liveline, type CandlePoint, type HoverPoint, type LivelinePoint } from 'liveline';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { IconTriangleFill } from 'symbols-react';
import { SegmentedControl } from '@solana/design-system/segmented-control';

import { ChartShareButton } from '@/components/chart-share-button';
import { AnimatedPrice } from '@/components/animated-price';
import { useDominantColor } from '@/hooks/queries/use-dominant-color';
import { formatPrice } from '@/lib/format';
import { cn } from '@tokens/ui/cn';
import {
    DEFAULT_CHART_COLOR,
    findClosestCandleIndex,
    formatAxisTimeLabel,
    formatPointDateLabel,
    formatUsdPrice,
    INTERVALS,
    TIME_RANGES,
} from './price-chart-utils';
import type { TokenPriceChartCoreProps } from './price-chart-types';

type ChartDisplayMode = 'line' | 'candlestick';

const CHART_HEIGHT_PX = 400;

function LineChartModeIcon({ className }: { className?: string }) {
    return (
        <svg
            aria-hidden="true"
            className={className}
            fill="none"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path
                d="M22 8L13.67 16L7 9.6L2 14.4"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
            />
        </svg>
    );
}

function CandlestickChartModeIcon({ className }: { className?: string }) {
    return (
        <svg
            aria-hidden="true"
            className={className}
            fill="none"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path
                d="M6.67 5.33V10.67"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
            />
            <path
                d="M8 10.67H5.33C4.6 10.67 4 11.26 4 12V17.33C4 18.07 4.6 18.67 5.33 18.67H8C8.74 18.67 9.33 18.07 9.33 17.33V12C9.33 11.26 8.74 10.67 8 10.67Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
            />
            <path
                d="M6.67 18.67V21.33"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
            />
            <path
                d="M17.33 2.67V5.33"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
            />
            <path
                d="M18.67 5.33H16C15.26 5.33 14.67 5.93 14.67 6.67V14.67C14.67 15.4 15.26 16 16 16H18.67C19.4 16 20 15.4 20 14.67V6.67C20 5.93 19.4 5.33 18.67 5.33Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
            />
            <path
                d="M17.33 16V20"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
            />
        </svg>
    );
}

const CHART_MODE_ITEMS = [
    { value: 'line', label: 'Line chart', icon: <LineChartModeIcon className="size-4" /> },
    { value: 'candlestick', label: 'Candlestick chart', icon: <CandlestickChartModeIcon className="size-4" /> },
];

function intervalToSeconds(interval: TokenPriceChartCoreProps['interval']): number | null {
    switch (interval) {
        case '1m':
            return 60;
        case '5m':
            return 5 * 60;
        case '15m':
            return 15 * 60;
        case '1H':
            return 60 * 60;
        case '4H':
            return 4 * 60 * 60;
        case '1D':
            return 24 * 60 * 60;
        case '1W':
            return 7 * 24 * 60 * 60;
        default:
            return null;
    }
}

function inferCandleWidthSeconds(candles: Array<{ time: number }>): number {
    const diffs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const diff = candles[i]!.time - candles[i - 1]!.time;
        if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
    }
    diffs.sort((a, b) => a - b);

    if (diffs.length === 0) return 60 * 60;
    return diffs[Math.floor(diffs.length / 2)] ?? 60 * 60;
}

function resolveRealtimeCandleTime(pointTime: number, lastCandleTime: number, candleWidthSeconds: number): number {
    if (!Number.isFinite(candleWidthSeconds) || candleWidthSeconds <= 0) return pointTime;
    if (pointTime < lastCandleTime + candleWidthSeconds) return lastCandleTime;

    const elapsedBuckets = Math.floor((pointTime - lastCandleTime) / candleWidthSeconds);
    return lastCandleTime + elapsedBuckets * candleWidthSeconds;
}

function toLivelineCandle(candle: {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}): CandlePoint {
    return {
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
    };
}

function buildDisplayLinePoints(points: LivelinePoint[], fallbackStepSeconds: number): LivelinePoint[] {
    if (points.length !== 1) return points;

    const point = points[0]!;
    const stepSeconds =
        Number.isFinite(fallbackStepSeconds) && fallbackStepSeconds > 0 ? fallbackStepSeconds : 60 * 60;

    return [{ time: point.time - stepSeconds, value: point.value }, point];
}

function useLivelineChartData(
    candles: TokenPriceChartCoreProps['candles'],
    interval: TokenPriceChartCoreProps['interval'],
    realtimePoint: TokenPriceChartCoreProps['realtimePoint'],
) {
    const pricePoints = useMemo((): LivelinePoint[] => candles.map(d => ({ time: d.time, value: d.close })), [candles]);
    const candleWidthSeconds = useMemo(
        () => intervalToSeconds(interval) ?? inferCandleWidthSeconds(candles),
        [candles, interval],
    );
    const candlesWithLive = useMemo(() => {
        if (!realtimePoint) return candles;
        const last = candles.at(-1);
        if (!last) {
            return [
                {
                    time: realtimePoint.time,
                    open: realtimePoint.value,
                    high: realtimePoint.value,
                    low: realtimePoint.value,
                    close: realtimePoint.value,
                    volume: null,
                },
            ];
        }
        if (realtimePoint.time < last.time) return candles;

        const realtimeCandleTime = resolveRealtimeCandleTime(realtimePoint.time, last.time, candleWidthSeconds);
        if (realtimeCandleTime === last.time) {
            return [
                ...candles.slice(0, -1),
                {
                    ...last,
                    high: Math.max(last.high, realtimePoint.value),
                    low: Math.min(last.low, realtimePoint.value),
                    close: realtimePoint.value,
                },
            ];
        }
        return [
            ...candles,
            {
                time: realtimeCandleTime,
                open: last.close,
                high: Math.max(last.close, realtimePoint.value),
                low: Math.min(last.close, realtimePoint.value),
                close: realtimePoint.value,
                volume: null,
            },
        ];
    }, [candleWidthSeconds, candles, realtimePoint]);
    const livelineCandleData = useMemo<{ candles: CandlePoint[]; liveCandle?: CandlePoint }>(
        () => {
            if (!realtimePoint) return { candles: candles.map(toLivelineCandle) };

            const last = candles.at(-1);
            if (!last || realtimePoint.time < last.time) {
                return { candles: candles.map(toLivelineCandle) };
            }

            const realtimeCandleTime = resolveRealtimeCandleTime(realtimePoint.time, last.time, candleWidthSeconds);
            if (realtimeCandleTime === last.time) {
                const liveCandle = toLivelineCandle({
                    ...last,
                    high: Math.max(last.high, realtimePoint.value),
                    low: Math.min(last.low, realtimePoint.value),
                    close: realtimePoint.value,
                });

                return candles.length > 2
                    ? { candles: candles.slice(0, -1).map(toLivelineCandle), liveCandle }
                    : { candles: candlesWithLive.map(toLivelineCandle) };
            }

            return {
                candles: candles.map(toLivelineCandle),
                liveCandle: toLivelineCandle({
                    time: realtimeCandleTime,
                    open: last.close,
                    high: Math.max(last.close, realtimePoint.value),
                    low: Math.min(last.close, realtimePoint.value),
                    close: realtimePoint.value,
                }),
            };
        },
        [candleWidthSeconds, candles, candlesWithLive, realtimePoint],
    );
    const pricePointsWithLive = useMemo((): LivelinePoint[] => {
        if (!realtimePoint) return pricePoints;
        if (pricePoints.length === 0) return [realtimePoint];
        const last = pricePoints.at(-1)!;
        if (realtimePoint.time < last.time) return pricePoints;
        if (realtimePoint.time === last.time) return [...pricePoints.slice(0, -1), realtimePoint];
        return [...pricePoints, realtimePoint];
    }, [pricePoints, realtimePoint]);
    const displayLinePoints = useMemo(
        () => buildDisplayLinePoints(pricePointsWithLive, candleWidthSeconds),
        [candleWidthSeconds, pricePointsWithLive],
    );

    return { pricePoints, candleWidthSeconds, candlesWithLive, livelineCandleData, displayLinePoints };
}

function useChartScrub(candlesWithLive: TokenPriceChartCoreProps['candles']) {
    const [crosshair, setCrosshair] = useState<{ time: number; value: number } | null>(null);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const isScrubbingRef = useRef(false);

    const setScrubbing = useCallback((next: boolean) => {
        if (isScrubbingRef.current === next) return;
        isScrubbingRef.current = next;
        setIsScrubbing(next);
    }, []);

    const clearHover = useCallback(() => {
        setScrubbing(false);
        setCrosshair(null);
    }, [setScrubbing]);

    const handleHover = useCallback(
        (point: HoverPoint | null) => {
            if (!point) {
                clearHover();
                return;
            }

            setScrubbing(true);
            const idx = findClosestCandleIndex(candlesWithLive, point.time);
            if (idx === null) {
                setCrosshair({ time: point.time, value: point.value });
                return;
            }

            const candle = candlesWithLive[idx]!;
            const hoverPrice = candle.close;
            setCrosshair(prev => {
                if (prev && prev.time === candle.time && prev.value === hoverPrice) return prev;
                return { time: candle.time, value: hoverPrice };
            });
        },
        [candlesWithLive, clearHover, setScrubbing],
    );

    return { crosshair, isScrubbing, clearHover, handleHover };
}

const TimeScaleSelector = memo(function TimeScaleSelector({
    timeRange,
    setTimeRange,
    interval,
    onIntervalChange,
    actions,
}: {
    timeRange: number;
    setTimeRange: (range: number) => void;
    interval?: string;
    // Named to avoid shadowing the global `setInterval` timer function.
    onIntervalChange?: (interval: (typeof INTERVALS)[number]['value']) => void;
    actions?: React.ReactNode;
}) {
    const isHourlyDisabled = timeRange >= 365;

    return (
        <div className="flex items-start justify-between gap-3 w-full">
            <div className="flex flex-col gap-1">
                <div className="flex bg-gray-50 border border-border-light rounded-full p-1">
                    {TIME_RANGES.map(range => (
                        <button
                            key={range.days}
                            type="button"
                            onClick={() => setTimeRange(range.days)}
                            className={cn(
                                'px-3 py-1.5 text-xs rounded-full transition-[color,background-color,border-color] duration-150 cursor-pointer',
                                timeRange === range.days
                                    ? 'bg-white border border-border-medium shadow-sm text-text-extra-high font-medium'
                                    : 'bg-transparent text-text-medium hover:text-text-high',
                            )}
                        >
                            {range.label}
                        </button>
                    ))}
                </div>
            </div>
            {(onIntervalChange || actions) && (
                <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-2">
                        {onIntervalChange && interval && (
                            <div className="flex bg-gray-50 border border-border-light rounded-full p-1">
                                {INTERVALS.map(int => (
                                    <button
                                        key={int.value}
                                        type="button"
                                        onClick={() => onIntervalChange(int.value)}
                                        disabled={isHourlyDisabled && int.value === '1H'}
                                        className={cn(
                                            'px-3 py-1.5 text-xs rounded-full transition-[color,background-color,border-color] duration-150 cursor-pointer',
                                            isHourlyDisabled && int.value === '1H' && 'opacity-50 cursor-not-allowed',
                                            interval === int.value
                                                ? 'bg-white border border-border-medium shadow-sm text-text-extra-high font-medium'
                                                : 'bg-transparent text-text-medium hover:text-text-high',
                                        )}
                                    >
                                        {int.label}
                                    </button>
                                ))}
                            </div>
                        )}
                        {actions}
                    </div>
                </div>
            )}
        </div>
    );
});

const TimeframeTabs = memo(function TimeframeTabs({
    timeRange,
    setTimeRange,
}: {
    timeRange: number;
    setTimeRange: (range: number) => void;
}) {
    const items = TIME_RANGES.map(range => ({
        value: String(range.days),
        label: range.label,
    }));

    return (
        <SegmentedControl
            className="w-fit"
            items={items}
            value={String(timeRange)}
            onValueChange={value => {
                const nextRange = Number(value);
                if (Number.isFinite(nextRange)) setTimeRange(nextRange);
            }}
            aria-label="Chart timeframe"
        />
    );
});

function InlineAssetChartLayout({
    chartCardRef,
    displayPrice,
    isScrubbing,
    displayPriceChange,
    isPriceUp,
    displayPointDateLabel,
    error,
    chart,
    timeRangeDays,
    onTimeRangeChange,
    chartActions,
}: {
    chartCardRef: React.RefObject<HTMLDivElement | null>;
    displayPrice: number | null;
    isScrubbing: boolean;
    displayPriceChange: number | null | undefined;
    isPriceUp: boolean;
    displayPointDateLabel: string | null;
    error: string | null;
    chart: React.ReactNode;
    timeRangeDays: number;
    onTimeRangeChange: (days: number) => void;
    chartActions: React.ReactNode;
}) {
    return (
        <div className="will-change-auto transform-gpu">
            <div
                ref={chartCardRef}
                className={cn(
                    'bg-transparent border-0 shadow-none rounded-none overflow-hidden',
                    'border-t border-border-light',
                )}
            >
                <div className="p-0 relative">
                    <div className="absolute inset-0 z-0 size-full opacity-20" />

                    <div className="relative z-10 flex flex-row items-start justify-between py-4 sm:py-6">
                        <div className="flex flex-col space-y-1">
                            {displayPrice != null && (
                                <>
                                    <div className="flex items-center">
                                        <AnimatedPrice
                                            value={formatPrice(displayPrice)}
                                            className="text-3xl font-semibold text-text-extra-high"
                                            enabled={!isScrubbing}
                                        />
                                    </div>

                                    {displayPriceChange !== undefined && displayPriceChange !== null && (
                                        <div
                                            className={cn(
                                                'text-xs font-medium flex items-center gap-1',
                                                isPriceUp ? 'text-green-600' : 'text-red-600',
                                            )}
                                        >
                                            <IconTriangleFill
                                                className={cn('size-2 fill-current', !isPriceUp && 'rotate-180')}
                                            />
                                            <span className="tabular-nums">
                                                {Math.abs(displayPriceChange).toFixed(2)}%
                                            </span>
                                            {displayPointDateLabel && (
                                                <span className="text-text-low ml-1">{displayPointDateLabel}</span>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    <div className="relative z-10 pb-4">
                        {error && (
                            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-20 rounded-xl">
                                <p className="text-body-md text-text-medium">{error}</p>
                            </div>
                        )}
                        <div
                            className="relative h-[400px] w-full will-change-auto transform-gpu"
                            style={{ height: CHART_HEIGHT_PX, contain: 'layout style paint' }}
                        >
                            {chart}
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between mt-4 gap-3">
                <TimeframeTabs timeRange={timeRangeDays} setTimeRange={onTimeRangeChange} />
                {chartActions}
            </div>
        </div>
    );
}

export const TokenPriceChartCore = memo(function TokenPriceChartCore({
    candles,
    isLoading,
    isPending = false,
    error,
    symbol,
    tokenName,
    logoURI,
    currentPrice,
    priceChange24h,
    timeRangeDays,
    onTimeRangeChange,
    interval,
    onIntervalChange,
    showIntervalSelector,
    realtimePoint,
    variant,
    shareContext,
}: TokenPriceChartCoreProps) {
    const [chartMode, setChartMode] = useState<ChartDisplayMode>('line');
    const chartCardRef = useRef<HTMLDivElement>(null);
    const { data: accentColor } = useDominantColor(logoURI);

    const { pricePoints, candleWidthSeconds, candlesWithLive, livelineCandleData, displayLinePoints } =
        useLivelineChartData(candles, interval, realtimePoint);
    const { crosshair, isScrubbing, clearHover, handleHover } = useChartScrub(candlesWithLive);

    const handleTimeRangeChange = useCallback(
        (range: number) => {
            clearHover();
            onTimeRangeChange(range);
        },
        [clearHover, onTimeRangeChange],
    );

    const handleIntervalChange = useCallback(
        (next: (typeof INTERVALS)[number]['value']) => {
            clearHover();
            onIntervalChange?.(next);
        },
        [clearHover, onIntervalChange],
    );

    const handleChartModeChange = useCallback(
        (value: string) => {
            if (value !== 'line' && value !== 'candlestick') return;
            clearHover();
            setChartMode(value);
        },
        [clearHover],
    );

    const latestClose = candles.at(-1)?.close ?? null;
    const idlePrice = realtimePoint?.value ?? latestClose ?? currentPrice ?? null;
    const displayPrice = crosshair?.value ?? idlePrice;
    const startPrice = candles.length > 0 ? candles[0]?.open : currentPrice;
    const scrubPriceChange = crosshair && startPrice ? ((crosshair.value - startPrice) / startPrice) * 100 : null;
    const timeframePriceChange =
        variant === 'inline-asset' && startPrice && idlePrice
            ? ((idlePrice - startPrice) / startPrice) * 100
            : priceChange24h;
    const displayPriceChange = crosshair ? scrubPriceChange : timeframePriceChange;
    const isPriceUp = (displayPriceChange ?? 0) >= 0;
    const chartValue = displayLinePoints.at(-1)?.value ?? currentPrice ?? 0;
    const isChartLoading = isLoading && displayLinePoints.length === 0;
    const hasCandleData = livelineCandleData.candles.length >= 2;
    const showPending = isPending || isLoading;
    const timeframeLabel = TIME_RANGES.find(r => r.days === timeRangeDays)?.label ?? `${timeRangeDays}D`;
    const displayPointTimeSec = crosshair?.time ?? realtimePoint?.time ?? candles.at(-1)?.time ?? null;
    const displayPointDateLabel =
        displayPointTimeSec != null ? formatPointDateLabel(displayPointTimeSec, timeRangeDays) : null;
    const shareKey = `${shareContext.address ?? shareContext.assetId ?? shareContext.coinId ?? ''}:${shareContext.mint ?? ''}:${symbol}:${tokenName ?? ''}:${logoURI ?? ''}`;
    const canShare = Boolean(shareContext.address || shareContext.assetId || shareContext.mint);

    const shareButton = canShare ? (
        <ChartShareButton
            key={shareKey}
            chartContainerRef={chartCardRef}
            symbol={symbol}
            timeframeLabel={timeframeLabel}
            disabled={isChartLoading || displayLinePoints.length === 0 || !!error}
            onBeforeCapture={clearHover}
            tokenName={tokenName ?? symbol}
            logoURI={logoURI}
            currentPrice={idlePrice ?? undefined}
            percentChange={variant === 'inline-asset' ? (timeframePriceChange ?? priceChange24h) : priceChange24h}
            pricePoints={pricePoints.length <= 1 ? displayLinePoints : pricePoints}
            chartWindowSecs={timeRangeDays * 24 * 60 * 60}
            chartColor={accentColor ?? DEFAULT_CHART_COLOR}
            shareTimeframeDays={variant === 'inline-asset' ? timeRangeDays : undefined}
            onShareTimeframeChange={variant === 'inline-asset' ? handleTimeRangeChange : undefined}
        />
    ) : null;
    const chartModeControl = (
        <SegmentedControl
            className="w-fit shrink-0 [&>button]:size-8 [&>button]:px-0 [&>button]:py-0 [&>button>span>span:last-child]:sr-only"
            items={CHART_MODE_ITEMS}
            value={chartMode}
            onValueChange={handleChartModeChange}
            disabled={isChartLoading || !hasCandleData || !!error}
            aria-label="Chart display mode"
        />
    );
    const livelineChart = (
        <Liveline
            data={displayLinePoints}
            value={chartValue}
            mode={hasCandleData ? 'candle' : 'line'}
            candles={hasCandleData ? livelineCandleData.candles : undefined}
            candleWidth={hasCandleData ? candleWidthSeconds : undefined}
            liveCandle={hasCandleData ? livelineCandleData.liveCandle : undefined}
            lineMode={hasCandleData ? chartMode === 'line' : undefined}
            lineData={displayLinePoints}
            lineValue={chartValue}
            window={timeRangeDays * 24 * 60 * 60}
            theme="light"
            color={accentColor ?? DEFAULT_CHART_COLOR}
            grid
            padding={{ right: 60 }}
            badge={false}
            showValue={false}
            fill
            momentum
            scrub
            paused={isScrubbing}
            loading={isChartLoading}
            emptyText="No price data to display"
            onHover={handleHover}
            formatValue={formatUsdPrice}
            formatTime={t => formatAxisTimeLabel(t, timeRangeDays)}
            tooltipY={-1000}
            tooltipOutline={false}
            cursor="crosshair"
        />
    );
    const inlineLivelineChart = (
        <Liveline
            data={displayLinePoints}
            value={chartValue}
            mode={hasCandleData ? 'candle' : 'line'}
            candles={hasCandleData ? livelineCandleData.candles : undefined}
            candleWidth={hasCandleData ? candleWidthSeconds : undefined}
            liveCandle={hasCandleData ? livelineCandleData.liveCandle : undefined}
            lineMode={hasCandleData ? chartMode === 'line' : undefined}
            lineData={displayLinePoints}
            lineValue={chartValue}
            window={timeRangeDays * 24 * 60 * 60}
            theme="light"
            color={accentColor ?? DEFAULT_CHART_COLOR}
            grid={false}
            padding={{ right: 60 }}
            badge={false}
            fill
            momentum
            scrub
            paused={isScrubbing}
            loading={isChartLoading}
            emptyText="No price data to display"
            onHover={handleHover}
            formatValue={formatUsdPrice}
            formatTime={t => formatAxisTimeLabel(t, timeRangeDays)}
            tooltipY={-1000}
            tooltipOutline={false}
            cursor="crosshair"
        />
    );
    const chartActions = (
        <div className="flex shrink-0 items-center justify-end gap-2">
            {chartModeControl}
            {shareButton}
        </div>
    );

    if (variant === 'inline-asset') {
        return (
            <InlineAssetChartLayout
                chartCardRef={chartCardRef}
                displayPrice={displayPrice}
                isScrubbing={isScrubbing}
                displayPriceChange={displayPriceChange}
                isPriceUp={isPriceUp}
                displayPointDateLabel={displayPointDateLabel}
                error={error}
                chart={livelineChart}
                timeRangeDays={timeRangeDays}
                onTimeRangeChange={handleTimeRangeChange}
                chartActions={chartActions}
            />
        );
    }

    return (
        <div
            className={`will-change-auto transform-gpu ${showPending ? 'opacity-90 transition-opacity duration-200' : ''}`}
        >
            <div
                ref={chartCardRef}
                className={`
                bg-white border border-border-medium rounded-[24px] overflow-hidden
                shadow-[inset_0_1px_2px_rgba(255,255,255,0.8),0_4px_12px_rgba(0,0,0,0.04)]
                ${showPending ? 'opacity-95' : ''}
            `}
            >
                <div className="p-0 relative">
                    <div
                        className="absolute inset-0 z-0 size-full opacity-20"
                        style={{
                            backgroundImage: `url("data:image/svg+xml,%3Csvg width='4' height='4' viewBox='0 0 4 4' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='3' cy='3' r='0.5' fill='rgba(168,162,158,1)'/%3E%3C/svg%3E")`,
                            backgroundRepeat: 'repeat',
                        }}
                    />

                    <div className="relative z-10 flex flex-row items-start justify-between p-6">
                        <div className="flex flex-col space-y-1">
                            <div className="flex items-center gap-1.5">
                                <span className="text-text-extra-high font-semibold text-sm">{symbol}</span>
                                <span className="text-text-low text-xs">price is currently</span>
                            </div>

                            {displayPrice != null && (
                                <>
                                    <div className="flex items-center">
                                        <span
                                            className={`text-3xl font-semibold text-text-extra-high tabular-nums ${showPending ? 'animate-pulse' : ''}`}
                                        >
                                            {formatPrice(displayPrice)}
                                        </span>
                                        {showPending && (
                                            <div className="inline-flex items-center ml-2">
                                                <div className="w-2 h-2 bg-gray-200 rounded-full animate-pulse" />
                                            </div>
                                        )}
                                    </div>

                                    {displayPriceChange !== undefined && displayPriceChange !== null && (
                                        <div
                                            className={`text-xs font-sans flex items-center gap-1 ${
                                                isPriceUp ? 'text-green-600' : 'text-red-600'
                                            }`}
                                        >
                                            {isPriceUp ? (
                                                <TrendingUp className="w-3 h-3" />
                                            ) : (
                                                <TrendingDown className="w-3 h-3" />
                                            )}
                                            <span className="tabular-nums">
                                                {isPriceUp ? '+' : ''}
                                                {displayPriceChange.toFixed(2)}%
                                            </span>
                                            <span className="text-text-low ml-1">
                                                {crosshair ? 'from start' : '24h'}
                                            </span>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    <div
                        className={`relative z-10 px-4 pb-4 ${showPending ? 'opacity-80 transition-opacity duration-300' : ''}`}
                    >
                        {error && (
                            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-20 rounded-xl">
                                <p className="text-body-md text-text-medium">{error}</p>
                            </div>
                        )}
                        <div
                            className="min-h-[400px] w-full will-change-auto transform-gpu"
                            style={{
                                height: CHART_HEIGHT_PX,
                                minHeight: `${CHART_HEIGHT_PX}px`,
                                contain: 'layout style paint',
                            }}
                        >
                            {inlineLivelineChart}
                        </div>
                    </div>
                </div>
            </div>

            <div className={`flex items-center justify-between mt-4 ${showPending ? 'opacity-80' : ''}`}>
                <TimeScaleSelector
                    timeRange={timeRangeDays}
                    setTimeRange={handleTimeRangeChange}
                    interval={showIntervalSelector ? interval : undefined}
                    onIntervalChange={showIntervalSelector ? handleIntervalChange : undefined}
                    actions={chartActions}
                />
            </div>
        </div>
    );
});
