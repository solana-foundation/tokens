'use client';

import { AlertTriangle, CheckCircle2, Clock3, HelpCircle, RefreshCw, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import type {
    StatusBucket,
    StatusDayResponse,
    StatusFailure,
    StatusOverviewResponse,
    StatusState,
} from './lib/status-types';

interface StatusTimelineProps {
    initialData: StatusOverviewResponse;
}

const stateStyles: Record<
    StatusState,
    {
        label: string;
        pillClassName: string;
        barClassName: string;
        textClassName: string;
        Icon: typeof CheckCircle2;
    }
> = {
    operational: {
        label: 'Operational',
        pillClassName: 'border-emerald-200 bg-emerald-50 text-emerald-700',
        barClassName: 'bg-emerald-500 hover:bg-emerald-600',
        textClassName: 'text-emerald-700',
        Icon: CheckCircle2,
    },
    degraded: {
        label: 'Degraded',
        pillClassName: 'border-amber-200 bg-amber-50 text-amber-700',
        barClassName: 'bg-amber-400 hover:bg-amber-500',
        textClassName: 'text-amber-700',
        Icon: AlertTriangle,
    },
    down: {
        label: 'Down',
        pillClassName: 'border-rose-200 bg-rose-50 text-rose-700',
        barClassName: 'bg-rose-500 hover:bg-rose-600',
        textClassName: 'text-rose-700',
        Icon: XCircle,
    },
    unknown: {
        label: 'Unknown',
        pillClassName: 'border-gray-1400/10 bg-gray-1400/5 text-text-medium',
        barClassName: 'bg-gray-1400/15 hover:bg-gray-1400/25',
        textClassName: 'text-text-medium',
        Icon: HelpCircle,
    },
};

export function StatusTimeline({ initialData }: StatusTimelineProps) {
    const [overview, setOverview] = useState(initialData);
    const [dayData, setDayData] = useState<StatusDayResponse | null>(null);
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [loadingDate, setLoadingDate] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const loadIdRef = useRef(0);

    const selectedFailures = dayData?.recentFailures ?? overview.recentFailures;
    const selectedBucket = useMemo(
        () => (selectedDate ? overview.daily.find(bucket => bucket.id === selectedDate) : null),
        [overview.daily, selectedDate],
    );

    async function loadDay(date: string) {
        const loadId = loadIdRef.current + 1;
        loadIdRef.current = loadId;
        setSelectedDate(date);
        setLoadingDate(date);
        setError(null);

        try {
            const response = await fetch(`/api/status?date=${encodeURIComponent(date)}`, {
                cache: 'no-store',
            });
            if (!response.ok) throw new Error('Status detail failed');

            const data = (await response.json()) as StatusDayResponse;
            if (data.kind !== 'day') throw new Error('Unexpected status detail response');
            if (loadIdRef.current !== loadId) return;
            setDayData(data);
        } catch {
            if (loadIdRef.current !== loadId) return;
            setDayData(null);
            setError('Hourly status is temporarily unavailable.');
        } finally {
            if (loadIdRef.current === loadId) setLoadingDate(null);
        }
    }

    async function refreshOverview() {
        setError(null);
        try {
            const response = await fetch('/api/status');
            if (!response.ok) throw new Error('Status refresh failed');

            const data = (await response.json()) as StatusOverviewResponse;
            if (data.kind !== 'overview') throw new Error('Unexpected status response');
            setOverview(data);
        } catch {
            setError('Status refresh is temporarily unavailable.');
        }
    }

    return (
        <section className="mx-auto flex max-w-280 flex-col gap-10 px-6 py-10">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
                <div className="rounded-lg border border-gray-1400/10 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                            <StatusPill state={overview.current.state} />
                            <p className="mt-4 text-(length:--text-heading-xs-size) font-medium leading-tight text-text-extra-high">
                                {overview.current.summary}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={refreshOverview}
                            className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-gray-1400/10 px-3 text-(length:--text-button-md) font-semibold text-text-high transition-colors hover:bg-gray-1400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high/30"
                        >
                            <RefreshCw className="size-4" aria-hidden />
                            Refresh
                        </button>
                    </div>

                    <div className="mt-6 grid gap-3 sm:grid-cols-3">
                        <Metric label="Last checked" value={formatDateTime(overview.current.checkedAt)} />
                        <Metric label="Latency" value={formatLatency(overview.current.latencyMs)} />
                        <Metric label="Source" value={overview.source === 'loki' ? 'Canary' : 'Unavailable'} />
                    </div>
                </div>

                <div className="rounded-lg border border-gray-1400/10 bg-gray-1400/2 p-5">
                    <p className="text-(length:--text-body-sm-size) font-medium text-text-medium">Live health</p>
                    {overview.liveCheck ? (
                        <div className="mt-3">
                            <StatusPill state={overview.liveCheck.state} compact />
                            <div className="mt-4 space-y-2 text-(length:--text-body-sm-size) text-text-medium">
                                <p>{formatDateTime(overview.liveCheck.checkedAt)}</p>
                                <p>{formatLatency(overview.liveCheck.latencyMs)}</p>
                                <p>{overview.liveCheck.status ?? 'No status code'}</p>
                            </div>
                        </div>
                    ) : (
                        <p className="mt-3 text-(length:--text-body-sm-size) leading-normal text-text-medium">
                            Not configured.
                        </p>
                    )}
                </div>
            </div>

            {overview.warning ? <Notice tone="warning" message={overview.warning} /> : null}
            {error ? <Notice tone="error" message={error} /> : null}

            <div className="min-w-0 rounded-lg border border-gray-1400/10 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <h2 className="text-(length:--text-heading-sm-size) font-medium leading-tight text-text-extra-high">
                            90-day history
                        </h2>
                        <p className="mt-1 text-(length:--text-body-sm-size) text-text-medium">UTC daily checks</p>
                    </div>
                    <StatusLegend />
                </div>

                <StatusBars
                    buckets={overview.daily}
                    selectedId={selectedDate}
                    loadingId={loadingDate}
                    onSelect={loadDay}
                    heightClassName="h-12"
                />
            </div>

            {dayData ? (
                <div className="min-w-0 rounded-lg border border-gray-1400/10 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <h2 className="text-(length:--text-heading-sm-size) font-medium leading-tight text-text-extra-high">
                                {dayData.selectedDate}
                            </h2>
                            <p className="mt-1 text-(length:--text-body-sm-size) text-text-medium">
                                24-hour detail in UTC
                            </p>
                        </div>
                        {selectedBucket ? (
                            <p className="text-(length:--text-body-sm-size) text-text-medium">
                                {formatCoverage(selectedBucket.coverage)} coverage
                            </p>
                        ) : null}
                    </div>

                    <StatusBars buckets={dayData.hourly} heightClassName="h-14" />
                    {dayData.warning ? (
                        <div className="mt-5">
                            <Notice tone="warning" message={dayData.warning} />
                        </div>
                    ) : null}
                </div>
            ) : null}

            {selectedFailures.length > 0 ? <FailurePanel failures={selectedFailures} /> : null}
        </section>
    );
}

function StatusPill({ state, compact = false }: { state: StatusState; compact?: boolean }) {
    const styles = stateStyles[state];
    const Icon = styles.Icon;
    return (
        <span
            className={`inline-flex items-center gap-2 rounded-full border font-semibold ${styles.pillClassName} ${
                compact
                    ? 'px-2.5 py-1 text-(length:--text-body-sm-size)'
                    : 'px-3 py-1.5 text-(length:--text-body-md-size)'
            }`}
        >
            <Icon className="size-4" aria-hidden />
            {styles.label}
        </span>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-md border border-gray-1400/10 bg-gray-1400/2 p-3">
            <p className="text-(length:--text-body-xs-size) font-medium uppercase text-text-low">{label}</p>
            <p className="mt-1 text-(length:--text-body-md-size) font-medium text-text-extra-high">{value}</p>
        </div>
    );
}

function StatusBars({
    buckets,
    selectedId,
    loadingId,
    heightClassName,
    onSelect,
}: {
    buckets: StatusBucket[];
    selectedId?: string | null;
    loadingId?: string | null;
    heightClassName: string;
    onSelect?: (id: string) => void;
}) {
    return (
        <div className="mt-5 min-w-0 overflow-hidden">
            <div
                className="grid w-full items-end gap-0.5 sm:gap-1"
                style={{
                    gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))`,
                }}
            >
                {buckets.map(bucket => {
                    const styles = stateStyles[bucket.state];
                    const isSelected = selectedId === bucket.id;
                    const isLoading = loadingId === bucket.id;
                    const label = `${bucket.label}: ${styles.label}, ${bucket.sampleCount}/${bucket.expectedSamples} checks`;

                    return (
                        <button
                            key={bucket.id}
                            type="button"
                            aria-label={label}
                            title={label}
                            disabled={!onSelect || isLoading}
                            onClick={() => onSelect?.(bucket.id)}
                            className={`${heightClassName} min-w-0 rounded-[2px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high/30 ${
                                styles.barClassName
                            } ${isSelected ? 'ring-2 ring-inset ring-text-extra-high/20' : ''} ${
                                onSelect ? 'cursor-pointer' : 'cursor-default'
                            } ${isLoading ? 'animate-pulse' : ''}`}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function StatusLegend() {
    return (
        <div className="flex flex-wrap items-center gap-3 text-(length:--text-body-sm-size) text-text-medium">
            {(['operational', 'degraded', 'down', 'unknown'] as const).map(state => (
                <span key={state} className="inline-flex items-center gap-1.5">
                    <span className={`size-2 rounded-full ${stateStyles[state].barClassName.split(' ')[0]}`} />
                    {stateStyles[state].label}
                </span>
            ))}
        </div>
    );
}

function FailurePanel({ failures }: { failures: StatusFailure[] }) {
    return (
        <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-5">
            <div className="flex items-center gap-2 text-rose-700">
                <AlertTriangle className="size-4" aria-hidden />
                <h2 className="text-(length:--text-heading-xs-size) font-medium leading-tight">Recent failures</h2>
            </div>
            <div className="mt-4 divide-y divide-rose-200/70">
                {failures.map(failure => (
                    <div
                        key={`${failure.checkedAt}-${failure.probe}-${failure.method}-${failure.path}`}
                        className="grid gap-2 py-3 md:grid-cols-[180px_minmax(0,1fr)_90px]"
                    >
                        <p className="text-(length:--text-body-sm-size) font-medium text-rose-700">
                            {formatDateTime(failure.checkedAt)}
                        </p>
                        <div className="min-w-0">
                            <p className="truncate text-(length:--text-body-sm-size) font-medium text-text-extra-high">
                                {failure.probe}
                            </p>
                            <p className="truncate text-(length:--text-body-sm-size) text-text-medium">
                                {failure.method} {failure.path}
                            </p>
                            {failure.message ? (
                                <p className="mt-1 truncate text-(length:--text-body-xs-size) text-rose-700">
                                    {failure.message}
                                </p>
                            ) : null}
                        </div>
                        <p className="text-(length:--text-body-sm-size) font-medium text-rose-700 md:text-right">
                            {failure.status ?? '---'}
                        </p>
                    </div>
                ))}
            </div>
        </div>
    );
}

function Notice({ tone, message }: { tone: 'warning' | 'error'; message: string }) {
    const isError = tone === 'error';
    return (
        <div
            className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-(length:--text-body-sm-size) ${
                isError ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}
        >
            {isError ? <XCircle className="size-4" aria-hidden /> : <Clock3 className="size-4" aria-hidden />}
            {message}
        </div>
    );
}

const dateTimeFormat = new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
});

function formatDateTime(value: string | null): string {
    if (!value) return 'Not available';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Not available';
    return dateTimeFormat.format(date);
}

function formatLatency(value: number | null): string {
    return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : 'Not available';
}

function formatCoverage(value: number): string {
    return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}
