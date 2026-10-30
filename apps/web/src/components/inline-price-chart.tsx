'use client';

import { useMemo, useEffect, useRef, useState, useCallback } from 'react';
import { useAssetOHLCV } from '@/hooks/queries/use-asset-ohlcv';
import { useAssetPriceChart } from '@/hooks/queries/use-asset-price-chart';
import { useOHLCV } from '@/hooks/queries/use-ohlcv';
import { Liveline, type LivelinePoint } from 'liveline';

interface InlinePriceChartProps {
    assetId?: string;
    coingeckoId?: string;
    useCanonicalAssetChart?: boolean;
    address: string;
    percentChange24h: number;
    symbol?: string;
    className?: string;
    chartHeight?: number;
    onScrub?: (price: number | null) => void;
    emptyText?: string;
    /**
     * Optional: if the base (24h) window is empty, try again with a larger window.
     * Useful for assets that don't trade continuously (e.g. tokenized equities on weekends).
     */
    fallbackDays?: number;
    /** Soft area under the line (off for the table's inline sparkline). */
    fill?: boolean;
    /** Stretch the y-range to the data (on for the inline sparkline; off reads calmer as a backdrop). */
    exaggerate?: boolean;
    lineWidth?: number;
}

interface ScrubIndicator {
    cursorXPct: number;
    pointXPct: number;
    pointYPct: number;
}

const CHART_PADDING = { top: 2, right: 2, bottom: 2, left: 2 } as const;
const LIVELINE_NO_BADGE_WINDOW_BUFFER = 0.015;

function clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function interpolateLinearAtTime(points: LivelinePoint[], timeSec: number): number | null {
    if (points.length === 0) return null;
    if (timeSec <= points[0]!.time) return points[0]!.value;
    if (timeSec >= points.at(-1)!.time) return points.at(-1)!.value;

    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (points[mid]!.time <= timeSec) lo = mid;
        else hi = mid;
    }

    const before = points[lo]!;
    const after = points[hi]!;
    const dt = after.time - before.time;
    if (dt === 0) return before.value;

    const t = (timeSec - before.time) / dt;
    return before.value + (after.value - before.value) * t;
}

function interpolateSplineAtTime(points: LivelinePoint[], timeSec: number): number | null {
    if (points.length === 0) return null;
    if (points.length === 1) return points[0]!.value;
    if (points.length === 2) return interpolateLinearAtTime(points, timeSec);
    if (timeSec <= points[0]!.time) return points[0]!.value;
    if (timeSec >= points.at(-1)!.time) return points.at(-1)!.value;

    const n = points.length;
    const h = new Array<number>(n - 1);
    const delta = new Array<number>(n - 1);

    for (let i = 0; i < n - 1; i++) {
        const dx = points[i + 1]!.time - points[i]!.time;
        h[i] = dx;
        delta[i] = dx === 0 ? 0 : (points[i + 1]!.value - points[i]!.value) / dx;
    }

    const m = new Array<number>(n);
    m[0] = delta[0] ?? 0;
    m[n - 1] = delta[n - 2] ?? 0;

    for (let i = 1; i < n - 1; i++) {
        const prev = delta[i - 1] ?? 0;
        const next = delta[i] ?? 0;
        m[i] = prev * next <= 0 ? 0 : (prev + next) / 2;
    }

    for (let i = 0; i < n - 1; i++) {
        const slope = delta[i] ?? 0;
        if (slope === 0) {
            m[i] = 0;
            m[i + 1] = 0;
            continue;
        }

        const alpha = (m[i] ?? 0) / slope;
        const beta = (m[i + 1] ?? 0) / slope;
        const sum = alpha * alpha + beta * beta;
        if (sum > 9) {
            const scale = 3 / Math.sqrt(sum);
            m[i] = scale * alpha * slope;
            m[i + 1] = scale * beta * slope;
        }
    }

    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (points[mid]!.time <= timeSec) lo = mid;
        else hi = mid;
    }

    const before = points[lo]!;
    const after = points[hi]!;
    const dx = after.time - before.time;
    if (dx === 0) return before.value;

    const t = (timeSec - before.time) / dx;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    return h00 * before.value + h10 * dx * (m[lo] ?? 0) + h01 * after.value + h11 * dx * (m[hi] ?? 0);
}

function computeExaggeratedRange(points: LivelinePoint[], currentValue: number | null): { min: number; max: number } {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (const point of points) {
        min = Math.min(min, point.value);
        max = Math.max(max, point.value);
    }

    if (currentValue !== null) {
        min = Math.min(min, currentValue);
        max = Math.max(max, currentValue);
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };

    const rawRange = max - min;
    const minRange = rawRange * 0.02 || 0.04;
    if (rawRange < minRange) {
        const mid = (min + max) / 2;
        return { min: mid - minRange / 2, max: mid + minRange / 2 };
    }

    const margin = rawRange * 0.01;
    return { min: min - margin, max: max + margin };
}

function useInlinePriceChartData({
    assetId,
    coingeckoId,
    useCanonicalAssetChart,
    address,
    fallbackDays,
    hasEnteredView,
}: {
    assetId?: string;
    coingeckoId?: string;
    useCanonicalAssetChart: boolean;
    address: string;
    fallbackDays?: number;
    hasEnteredView: boolean;
}) {
    const PRIMARY_INTERVAL = '15m' as const;
    const FALLBACK_INTERVAL = '1H' as const;
    const DAYS = 1;
    const EXTENDED_DAYS =
        typeof fallbackDays === 'number' && Number.isFinite(fallbackDays) && fallbackDays > DAYS
            ? Math.min(90, Math.max(DAYS + 1, Math.floor(fallbackDays)))
            : null;

    // Fetch 1 day of data with 15-minute candles for smooth inline charts.
    // Fallback to 1H if 15m isn’t available in the DB cache yet.
    const normalizedAssetId = assetId?.trim() ?? '';
    const shouldUseAssetApi = normalizedAssetId.length > 0;
    const normalizedCoinId = (coingeckoId ?? '').trim();
    const shouldUseCanonical = shouldUseAssetApi && (useCanonicalAssetChart || normalizedCoinId.length > 0);

    const canonicalQuery = useAssetPriceChart(normalizedAssetId, PRIMARY_INTERVAL, DAYS, {
        enabled: hasEnteredView && shouldUseCanonical,
    });

    const shouldEnableCanonicalFallback =
        hasEnteredView && shouldUseCanonical && !canonicalQuery.isLoading && (canonicalQuery.data?.length ?? 0) < 2;
    const canonicalFallbackQuery = useAssetPriceChart(normalizedAssetId, FALLBACK_INTERVAL, DAYS, {
        enabled: shouldEnableCanonicalFallback,
    });

    const shouldEnableCanonicalExtended =
        EXTENDED_DAYS !== null &&
        hasEnteredView &&
        shouldUseCanonical &&
        !canonicalQuery.isLoading &&
        !canonicalFallbackQuery.isLoading &&
        (canonicalQuery.data?.length ?? 0) < 2 &&
        (canonicalFallbackQuery.data?.length ?? 0) < 2;
    const canonicalExtendedQuery = useAssetPriceChart(normalizedAssetId, FALLBACK_INTERVAL, EXTENDED_DAYS ?? DAYS, {
        enabled: shouldEnableCanonicalExtended,
    });

    const assetQuery = useAssetOHLCV(normalizedAssetId, PRIMARY_INTERVAL, DAYS, {
        mint: address,
        enabled: hasEnteredView && shouldUseAssetApi && !shouldUseCanonical,
    });

    const shouldEnableAssetFallback =
        hasEnteredView &&
        shouldUseAssetApi &&
        !shouldUseCanonical &&
        !assetQuery.isLoading &&
        (assetQuery.data?.length ?? 0) < 2;
    const assetFallbackQuery = useAssetOHLCV(normalizedAssetId, FALLBACK_INTERVAL, DAYS, {
        mint: address,
        enabled: shouldEnableAssetFallback,
    });

    const shouldEnableAssetExtended =
        EXTENDED_DAYS !== null &&
        hasEnteredView &&
        shouldUseAssetApi &&
        !shouldUseCanonical &&
        !assetQuery.isLoading &&
        !assetFallbackQuery.isLoading &&
        (assetQuery.data?.length ?? 0) < 2 &&
        (assetFallbackQuery.data?.length ?? 0) < 2;
    const assetExtendedQuery = useAssetOHLCV(normalizedAssetId, FALLBACK_INTERVAL, EXTENDED_DAYS ?? DAYS, {
        mint: address,
        enabled: shouldEnableAssetExtended,
    });

    // Last resort for asset-backed cards: the mint-pinned OHLCV cache can be
    // empty for thinly traded variants (e.g. Ondo RWA mints), while the asset
    // page still charts fine via /price-chart's server-side fallback chain
    // (stock → CoinGecko → primary mint). Rescue with that same endpoint so a
    // card never shows an empty chart when its asset page has one.
    const shouldEnableCanonicalRescue =
        hasEnteredView &&
        shouldUseAssetApi &&
        !shouldUseCanonical &&
        !assetQuery.isLoading &&
        !assetFallbackQuery.isLoading &&
        (EXTENDED_DAYS === null || !assetExtendedQuery.isLoading) &&
        (assetQuery.data?.length ?? 0) < 2 &&
        (assetFallbackQuery.data?.length ?? 0) < 2 &&
        (assetExtendedQuery.data?.length ?? 0) < 2;
    const canonicalRescueQuery = useAssetPriceChart(normalizedAssetId, FALLBACK_INTERVAL, EXTENDED_DAYS ?? DAYS, {
        enabled: shouldEnableCanonicalRescue,
    });

    const mintQuery = useOHLCV(address, PRIMARY_INTERVAL, DAYS, { enabled: hasEnteredView && !shouldUseAssetApi });
    const shouldEnableMintFallback =
        hasEnteredView && !shouldUseAssetApi && !mintQuery.isLoading && (mintQuery.data?.length ?? 0) < 2;
    const mintFallbackQuery = useOHLCV(address, FALLBACK_INTERVAL, DAYS, { enabled: shouldEnableMintFallback });

    const primaryData = shouldUseCanonical ? canonicalQuery.data : shouldUseAssetApi ? assetQuery.data : mintQuery.data;
    const fallbackData = shouldUseCanonical
        ? canonicalFallbackQuery.data
        : shouldUseAssetApi
          ? assetFallbackQuery.data
          : mintFallbackQuery.data;
    const extendedData = shouldUseCanonical
        ? canonicalExtendedQuery.data
        : shouldUseAssetApi
          ? assetExtendedQuery.data
          : undefined;
    const rescueData = shouldUseAssetApi && !shouldUseCanonical ? canonicalRescueQuery.data : undefined;
    const primaryHasData = (primaryData?.length ?? 0) >= 2;
    const fallbackHasData = (fallbackData?.length ?? 0) >= 2;
    const extendedHasData = (extendedData?.length ?? 0) >= 2;
    const rescueHasData = (rescueData?.length ?? 0) >= 2;

    const ohlcvData = primaryHasData
        ? primaryData
        : fallbackHasData
          ? fallbackData
          : extendedHasData
            ? extendedData
            : rescueHasData
              ? rescueData
              : (fallbackData ?? primaryData);
    const isLoading = shouldUseCanonical
        ? canonicalQuery.isLoading ||
          (!primaryHasData && canonicalFallbackQuery.isLoading) ||
          (!primaryHasData && !fallbackHasData && canonicalExtendedQuery.isLoading)
        : shouldUseAssetApi
          ? assetQuery.isLoading ||
            (!primaryHasData && assetFallbackQuery.isLoading) ||
            (!primaryHasData && !fallbackHasData && assetExtendedQuery.isLoading) ||
            (!primaryHasData && !fallbackHasData && !extendedHasData && canonicalRescueQuery.isLoading)
          : mintQuery.isLoading || (!primaryHasData && mintFallbackQuery.isLoading);

    return { ohlcvData, isLoading, normalizedAssetId };
}

function useChartScrub({
    onScrub,
    chartHeight,
    points,
    windowSecs,
    firstTime,
    lastTime,
    lastValue,
}: {
    onScrub: InlinePriceChartProps['onScrub'];
    chartHeight: number;
    points: LivelinePoint[];
    windowSecs: number;
    firstTime: number | null;
    lastTime: number | null;
    lastValue: number | null;
}) {
    const chartHostRef = useRef<HTMLDivElement>(null);
    const onScrubRef = useRef<InlinePriceChartProps['onScrub']>(onScrub);
    const isPointerDownRef = useRef(false);
    const lastScrubbedValueRef = useRef<number | null>(null);
    const [scrubIndicator, setScrubIndicator] = useState<ScrubIndicator | null>(null);

    useEffect(() => {
        onScrubRef.current = onScrub;
    }, [onScrub]);

    const scrubAtClientX = useCallback(
        (clientX: number) => {
            const callback = onScrubRef.current;
            const host = chartHostRef.current;
            if (!callback || !host || points.length < 2 || firstTime === null || lastTime === null) {
                setScrubIndicator(null);
                return;
            }

            const rect = host.getBoundingClientRect();
            if (!Number.isFinite(rect.width) || rect.width <= 0) return;

            const chartW = rect.width - CHART_PADDING.left - CHART_PADDING.right;
            const chartH = chartHeight - CHART_PADDING.top - CHART_PADDING.bottom;
            if (chartW <= 0 || chartH <= 0) return;

            const rightEdge = lastTime + windowSecs * LIVELINE_NO_BADGE_WINDOW_BUFFER;
            const leftEdge = rightEdge - windowSecs;
            const maxScrubX = CHART_PADDING.left + ((lastTime - leftEdge) / (rightEdge - leftEdge)) * chartW;
            const x = clampNumber(clientX - rect.left, CHART_PADDING.left, maxScrubX);
            const t = leftEdge + ((x - CHART_PADDING.left) / chartW) * (rightEdge - leftEdge);
            const visiblePoints = points.filter(point => point.time >= leftEdge - 2 && point.time <= lastTime);
            const next = interpolateSplineAtTime(visiblePoints, t);
            const valueRange = computeExaggeratedRange(visiblePoints, lastValue);
            const valueSpan = valueRange.max - valueRange.min;

            if (next !== null && valueSpan > 0) {
                const rawY = CHART_PADDING.top + (1 - (next - valueRange.min) / valueSpan) * chartH;
                const pointYPct =
                    (clampNumber(rawY, CHART_PADDING.top, chartHeight - CHART_PADDING.bottom) / chartHeight) * 100;
                const xPct = (x / rect.width) * 100;

                setScrubIndicator({
                    cursorXPct: xPct,
                    pointXPct: xPct,
                    pointYPct,
                });
            } else {
                setScrubIndicator(null);
            }

            // Avoid spamming state updates when the value hasn't changed.
            if (lastScrubbedValueRef.current === next) return;
            lastScrubbedValueRef.current = next;
            callback(next);
        },
        [chartHeight, firstTime, lastTime, lastValue, points, windowSecs],
    );

    useEffect(() => {
        return () => {
            lastScrubbedValueRef.current = null;
            onScrubRef.current?.(null);
        };
    }, []);

    return {
        chartHostRef,
        onScrubRef,
        isPointerDownRef,
        lastScrubbedValueRef,
        scrubIndicator,
        setScrubIndicator,
        scrubAtClientX,
    };
}

export function InlinePriceChart({
    assetId,
    coingeckoId,
    useCanonicalAssetChart = false,
    address,
    percentChange24h,
    symbol = '',
    className,
    chartHeight = 32,
    onScrub,
    emptyText = '—',
    fallbackDays,
    fill = false,
    exaggerate = true,
    lineWidth,
}: InlinePriceChartProps) {
    const isPositive = percentChange24h >= 0;
    const rootRef = useRef<HTMLDivElement>(null);
    const [hasEnteredView, setHasEnteredView] = useState(false);
    const [isInView, setIsInView] = useState(false);

    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;

        const observer = new IntersectionObserver(
            ([entry]) => {
                const nextInView = Boolean(entry?.isIntersecting);
                setIsInView(nextInView);
                if (nextInView) setHasEnteredView(true);
            },
            {
                threshold: 0,
                rootMargin: '200px 0px',
            },
        );

        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const { ohlcvData, isLoading, normalizedAssetId } = useInlinePriceChartData({
        assetId,
        coingeckoId,
        useCanonicalAssetChart,
        address,
        fallbackDays,
        hasEnteredView,
    });

    const { points, windowSecs, firstTime, lastTime, lastValue } = useMemo(() => {
        const raw: Array<{ time: number; value: number }> = [];
        for (const point of ohlcvData ?? []) {
            if (point && typeof point.time === 'number' && typeof point.close === 'number' && point.close > 0) {
                raw.push({ time: point.time, value: point.close });
            }
        }
        raw.sort((a, b) => a.time - b.time);

        if (raw.length < 2) {
            return {
                points: raw,
                windowSecs: 60,
                firstTime: raw[0]?.time ?? null,
                lastTime: raw.at(-1)?.time ?? null,
                lastValue: raw.at(-1)?.value ?? null,
            };
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const lastRawTime = raw.at(-1)!.time;
        const offset = nowSec - lastRawTime;
        const shifted = raw.map(p => ({ time: p.time + offset, value: p.value }));
        const span = shifted.at(-1)!.time - shifted[0]!.time;

        return {
            points: shifted,
            windowSecs: Math.max(60, span),
            firstTime: shifted[0]!.time,
            lastTime: shifted.at(-1)!.time,
            lastValue: shifted.at(-1)!.value,
        };
    }, [ohlcvData]);

    const isScrubbable = Boolean(onScrub);
    const lineColor = isPositive ? '#10b981' : '#ef4444';
    const shouldShowLoading = isLoading && points.length < 2;
    const livelineRenderKey = `${normalizedAssetId || address}:${shouldShowLoading ? 'loading' : points.length >= 2 ? 'data' : 'empty'}`;

    const {
        chartHostRef,
        onScrubRef,
        isPointerDownRef,
        lastScrubbedValueRef,
        scrubIndicator,
        setScrubIndicator,
        scrubAtClientX,
    } = useChartScrub({ onScrub, chartHeight, points, windowSecs, firstTime, lastTime, lastValue });

    const chartTitle = fallbackDays ? `${symbol} trend` : `${symbol} 24h trend`;
    const shouldRenderChart = hasEnteredView && isInView;

    return (
        <div
            ref={rootRef}
            className={className ?? 'w-[200px] h-8 rounded-sm overflow-hidden bg-transparent relative'}
            title={chartTitle}
        >
            {shouldRenderChart && (
                <div
                    ref={chartHostRef}
                    className="relative w-full"
                    style={{
                        height: chartHeight,
                        contain: 'layout style paint',
                    }}
                >
                    <Liveline
                        key={livelineRenderKey}
                        data={points}
                        value={lastValue ?? 0}
                        window={windowSecs}
                        theme="light"
                        color={lineColor}
                        grid={false}
                        badge={false}
                        fill={fill}
                        loading={shouldShowLoading}
                        pulse={false}
                        momentum={false}
                        scrub={false}
                        paused
                        exaggerate={exaggerate}
                        lineWidth={lineWidth}
                        padding={CHART_PADDING}
                        formatTime={() => ''}
                        tooltipY={-1000}
                        tooltipOutline={false}
                        emptyText={emptyText}
                        cursor={isScrubbable ? 'crosshair' : 'default'}
                        className="w-full h-full"
                        style={{ height: '100%', width: '100%' }}
                    />

                    {isScrubbable && points.length >= 2 && (
                        <>
                            {scrubIndicator && (
                                <div className="pointer-events-none absolute inset-0">
                                    <div
                                        className="absolute top-0 h-full w-px bg-text-extra-high/20"
                                        style={{ left: `${scrubIndicator.cursorXPct}%` }}
                                    />
                                    <div
                                        className="absolute size-2.5 rounded-full border-2 border-white shadow-sm ring-1 ring-text-extra-high/20"
                                        style={{
                                            left: `${scrubIndicator.pointXPct}%`,
                                            top: `${scrubIndicator.pointYPct}%`,
                                            backgroundColor: lineColor,
                                            transform: 'translate(-50%, -50%)',
                                        }}
                                    />
                                </div>
                            )}
                            <div
                                className="absolute inset-0"
                                style={{ touchAction: 'none' }}
                                onPointerDown={event => {
                                    isPointerDownRef.current = true;
                                    scrubAtClientX(event.clientX);
                                }}
                                onPointerMove={event => {
                                    // Mouse: scrub on hover. Touch: scrub only while pointer is down.
                                    if (event.pointerType !== 'mouse' && !isPointerDownRef.current) return;
                                    scrubAtClientX(event.clientX);
                                }}
                                onPointerUp={() => {
                                    isPointerDownRef.current = false;
                                }}
                                onPointerCancel={() => {
                                    isPointerDownRef.current = false;
                                    setScrubIndicator(null);
                                }}
                                onPointerLeave={() => {
                                    isPointerDownRef.current = false;
                                    lastScrubbedValueRef.current = null;
                                    setScrubIndicator(null);
                                    onScrubRef.current?.(null);
                                }}
                            />
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
