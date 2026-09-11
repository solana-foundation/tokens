/* eslint-disable no-console */

import { readFileSync } from 'node:fs';

const SERVICE = 'tokens-api';
const WINDOW_HOURS = 24;
const TREND_DAYS = 7;
const MAX_ROWS = 10;

const HIDDEN_PROJECT_IDS = new Set<string>([
    'kx78mvpskwd2wrjpb3e0s0a0d181mc7e',
]);

const grafanaUrl = (process.env.GRAFANA_API_URL ?? '').trim().replace(/\/$/, '');
const grafanaToken = (process.env.GRAFANA_API_TOKEN ?? '').trim();
const slackWebhook = (process.env.SLACK_USAGE_DIGEST_WEBHOOK_URL ?? '').trim();
const datasourceUid = (process.env.LOKI_DATASOURCE_UID ?? 'grafanacloud-logs').trim();
const projectLookupPath = (process.env.PROJECT_LOOKUP_PATH ?? '').trim();

if (!grafanaUrl || !grafanaToken || !slackWebhook) {
    console.error('FAILED: missing GRAFANA_API_URL, GRAFANA_API_TOKEN, or SLACK_USAGE_DIGEST_WEBHOOK_URL');
    process.exit(1);
}

type ProjectInfo = { name: string; isPersonal: boolean };
type LokiVectorEntry = { metric: Record<string, string>; value: [number, string] };
type LokiMatrixEntry = { metric: Record<string, string>; values: Array<[number, string]> };

function loadProjectLookup(path: string): Map<string, ProjectInfo> {
    const map = new Map<string, ProjectInfo>();
    if (!path) return map;
    try {
        const rows = JSON.parse(readFileSync(path, 'utf8')) as Array<{ id: string; name?: string; isPersonal?: boolean }>;
        for (const row of rows) {
            if (!row?.id) continue;
            map.set(row.id, { name: row.name ?? row.id, isPersonal: Boolean(row.isPersonal) });
        }
    } catch (err) {
        console.error(`WARN: could not parse project lookup at ${path}: ${err instanceof Error ? err.message : err}`);
    }
    return map;
}

async function lokiFetch(kind: string, url: URL, query: string): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${grafanaToken}`, Accept: 'application/json' },
        });
        if (res.ok) return res.json();
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= 3) throw new Error(`Loki ${kind} ${res.status}: ${query.slice(0, 80)}`);
        console.error(`WARN: Loki ${kind} ${res.status} (attempt ${attempt}/3), retrying: ${query.slice(0, 80)}`);
        await new Promise(r => setTimeout(r, attempt * 5000));
    }
}

async function logqlInstant(query: string): Promise<LokiVectorEntry[]> {
    const url = new URL(`${grafanaUrl}/api/datasources/proxy/uid/${datasourceUid}/loki/api/v1/query`);
    url.searchParams.set('query', query);
    const body = (await lokiFetch('instant', url, query)) as { data?: { result?: LokiVectorEntry[] } };
    return body.data?.result ?? [];
}

async function logqlRange(query: string, startSec: number, endSec: number, stepSec: number): Promise<LokiMatrixEntry[]> {
    const url = new URL(`${grafanaUrl}/api/datasources/proxy/uid/${datasourceUid}/loki/api/v1/query_range`);
    url.searchParams.set('query', query);
    url.searchParams.set('start', `${startSec}000000000`);
    url.searchParams.set('end', `${endSec}000000000`);
    url.searchParams.set('step', `${stepSec}s`);
    const body = (await lokiFetch('range', url, query)) as { data?: { result?: LokiMatrixEntry[] } };
    return body.data?.result ?? [];
}

function scalarOrZero(rows: LokiVectorEntry[]): number {
    const value = rows[0]?.value?.[1];
    const n = value === undefined ? 0 : Number(value);
    return Number.isFinite(n) ? n : 0;
}

function pctChange(now: number, prior: number): { delta: number; label: string } {
    if (prior === 0) return { delta: 0, label: now > 0 ? 'new' : '—' };
    const delta = ((now - prior) / prior) * 100;
    const sign = delta >= 0 ? '+' : '';
    return { delta, label: `${sign}${delta.toFixed(1)}%` };
}

function fmtCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return n.toFixed(0);
}

function fmtMs(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function fmtDelta(delta: number, hasPrior: boolean): string {
    if (!hasPrior) return 'new';
    if (Math.abs(delta) < 0.5) return '—';
    const arrow = delta >= 0 ? '▲' : '▼';
    return `${arrow}${Math.abs(delta).toFixed(0)}%`;
}

function trendArrow(delta: number): string {
    if (Math.abs(delta) < 1) return '→';
    return delta > 0 ? '↑' : '↓';
}

function fmtTps(rps: number): string {
    if (!Number.isFinite(rps) || rps <= 0) return '—';
    if (rps >= 100) return rps.toFixed(0);
    if (rps >= 10) return rps.toFixed(1);
    return rps.toFixed(2);
}

function fmtTimestamp(unixSec: number): string {
    const d = new Date(unixSec * 1000);
    const hh = d.getUTCHours().toString().padStart(2, '0');
    const mm = d.getUTCMinutes().toString().padStart(2, '0');
    return `${hh}:${mm} UTC`;
}

function truncate(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function pad(value: string, width: number, align: 'left' | 'right' = 'left'): string {
    if (value.length >= width) return value;
    const padding = ' '.repeat(width - value.length);
    return align === 'left' ? value + padding : padding + value;
}

function vectorToMap(rows: LokiVectorEntry[], labelKey: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of rows) {
        const key = (row.metric?.[labelKey] ?? '').trim();
        if (!key) continue;
        const value = Number(row.value?.[1] ?? 0);
        if (Number.isFinite(value)) out.set(key, value);
    }
    return out;
}

type Row = {
    user: string;
    isUnknown: boolean;
    queries: number;
    failed: number;
    slow: number;
    p50: number;
    p95: number;
    p99: number;
    prior: number;
};

async function main(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowEnd = nowSec;
    const trendStart = nowSec - TREND_DAYS * 24 * 3600;

    const lookup = loadProjectLookup(projectLookupPath);

    const evt = `event="event"`;
    const projTag = `project_id="project_id"`;
    const baseLight = `{service="${SERVICE}"} | json ${evt} | event="http_request"`;
    const baseStatus = `{service="${SERVICE}"} | json ${evt}, status_class="status_class" | event="http_request"`;
    const baseProject = `{service="${SERVICE}"} | json ${evt}, ${projTag} | event="http_request"`;
    const baseProjectStatus = `{service="${SERVICE}"} | json ${evt}, ${projTag}, status_class="status_class" | event="http_request"`;
    const baseProjectSlow = `{service="${SERVICE}"} | json ${evt}, ${projTag}, slow_request="slow_request" | event="http_request"`;
    const baseProjectDur = `{service="${SERVICE}"} | json ${evt}, ${projTag}, duration_ms="duration_ms" | event="http_request"`;
    const baseDur = `{service="${SERVICE}"} | json ${evt}, duration_ms="duration_ms" | event="http_request"`;

    const [
        totalNow,
        totalPrior,
        statusBreakdown,
        p50All,
        p95All,
        p99All,
        trend7d,
        tpsTimeseries,
        perProjQueries,
        perProjQueriesPrior,
        perProjFailed,
        perProjSlow,
        perProjP50,
        perProjP95,
        perProjP99,
    ] = await Promise.all([
        logqlInstant(`sum(count_over_time(${baseLight} [${WINDOW_HOURS}h]))`),
        logqlInstant(`sum(count_over_time(${baseLight} [${WINDOW_HOURS}h] offset ${WINDOW_HOURS}h))`),
        logqlInstant(`sum by (status_class) (count_over_time(${baseStatus} [${WINDOW_HOURS}h]))`),
        logqlInstant(`quantile_over_time(0.50, ${baseDur} | unwrap duration_ms [${WINDOW_HOURS}h])`),
        logqlInstant(`quantile_over_time(0.95, ${baseDur} | unwrap duration_ms [${WINDOW_HOURS}h])`),
        logqlInstant(`quantile_over_time(0.99, ${baseDur} | unwrap duration_ms [${WINDOW_HOURS}h])`),
        logqlRange(`sum(count_over_time(${baseLight} [1h]))`, trendStart, windowEnd, 3600 * 6),
        logqlRange(`sum(rate(${baseLight} [1m]))`, nowSec - WINDOW_HOURS * 3600, nowSec, 60),
        logqlInstant(`sum by (project_id) (count_over_time(${baseProject} [${WINDOW_HOURS}h]))`),
        logqlInstant(`sum by (project_id) (count_over_time(${baseProject} [${WINDOW_HOURS}h] offset ${WINDOW_HOURS}h))`),
        logqlInstant(`sum by (project_id) (count_over_time(${baseProjectStatus} | status_class="5xx" [${WINDOW_HOURS}h]))`),
        logqlInstant(`sum by (project_id) (count_over_time(${baseProjectSlow} | slow_request="true" [${WINDOW_HOURS}h]))`),
        logqlInstant(`quantile_over_time(0.50, ${baseProjectDur} | unwrap duration_ms [${WINDOW_HOURS}h]) by (project_id)`),
        logqlInstant(`quantile_over_time(0.95, ${baseProjectDur} | unwrap duration_ms [${WINDOW_HOURS}h]) by (project_id)`),
        logqlInstant(`quantile_over_time(0.99, ${baseProjectDur} | unwrap duration_ms [${WINDOW_HOURS}h]) by (project_id)`),
    ]);

    const totalReq = scalarOrZero(totalNow);
    const priorReq = scalarOrZero(totalPrior);
    const growth = pctChange(totalReq, priorReq);

    const statusCounts = vectorToMap(statusBreakdown, 'status_class');
    const count2xx = statusCounts.get('2xx') ?? 0;
    const count4xx = statusCounts.get('4xx') ?? 0;
    const count5xx = statusCounts.get('5xx') ?? 0;
    const ratio5xx = totalReq === 0 ? 0 : (count5xx / totalReq) * 100;
    const ratio4xx = totalReq === 0 ? 0 : (count4xx / totalReq) * 100;
    const p50 = Number(p50All[0]?.value?.[1] ?? NaN);
    const p95 = Number(p95All[0]?.value?.[1] ?? NaN);
    const p99 = Number(p99All[0]?.value?.[1] ?? NaN);

    const avgTps = totalReq / (WINDOW_HOURS * 3600);
    const tpsPoints = tpsTimeseries[0]?.values ?? [];
    let peakTps = 0;
    let peakTpsAt = 0;
    for (const [ts, v] of tpsPoints) {
        const value = Number(v) || 0;
        if (value > peakTps) {
            peakTps = value;
            peakTpsAt = Number(ts) || 0;
        }
    }
    const peakMultiple = avgTps > 0 ? peakTps / avgTps : 0;

    const trendSeries = trend7d[0]?.values ?? [];
    const trendBuckets = trendSeries.map(([, v]) => Number(v) || 0);
    const trendHead = trendBuckets.slice(0, Math.ceil(trendBuckets.length / 2));
    const trendTail = trendBuckets.slice(Math.ceil(trendBuckets.length / 2));
    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
    const trendCompare = pctChange(sum(trendTail), sum(trendHead));

    const queriesByProject = vectorToMap(perProjQueries, 'project_id');
    const priorByProject = vectorToMap(perProjQueriesPrior, 'project_id');
    const failedByProject = vectorToMap(perProjFailed, 'project_id');
    const slowByProject = vectorToMap(perProjSlow, 'project_id');
    const p50ByProject = vectorToMap(perProjP50, 'project_id');
    const p95ByProject = vectorToMap(perProjP95, 'project_id');
    const p99ByProject = vectorToMap(perProjP99, 'project_id');

    const allProjectIds = new Set<string>([
        ...queriesByProject.keys(),
        ...priorByProject.keys(),
    ]);

    const rows: Row[] = [];
    for (const pid of allProjectIds) {
        if (HIDDEN_PROJECT_IDS.has(pid)) continue;
        const info = lookup.get(pid);
        if (info?.isPersonal) continue;
        const queries = queriesByProject.get(pid) ?? 0;
        if (queries === 0) continue;
        rows.push({
            user: info?.name ?? `${pid.slice(0, 8)}…`,
            isUnknown: !info,
            queries,
            failed: failedByProject.get(pid) ?? 0,
            slow: slowByProject.get(pid) ?? 0,
            p50: p50ByProject.get(pid) ?? NaN,
            p95: p95ByProject.get(pid) ?? NaN,
            p99: p99ByProject.get(pid) ?? NaN,
            prior: priorByProject.get(pid) ?? 0,
        });
    }
    rows.sort((a, b) => b.queries - a.queries);
    const visibleRows = rows.slice(0, MAX_ROWS);

    const userCol = Math.max(8, ...visibleRows.map(r => Math.min(r.user.length, 28)));

    const COL = {
        user: userCol,
        queries: 10,
        failed: 8,
        slow: 9,
        p50: 8,
        p95: 8,
        p99: 8,
        delta: 10,
    };

    const headerLine =
        `${pad('user', COL.user)}  ${pad('queries', COL.queries, 'right')}  ${pad('failed', COL.failed, 'right')}  ${pad('slow>1s', COL.slow, 'right')}  ${pad('p50ms', COL.p50, 'right')}  ${pad('p95ms', COL.p95, 'right')}  ${pad('p99ms', COL.p99, 'right')}  ${pad('Δqueries', COL.delta, 'right')}`;
    const divider = '─'.repeat(headerLine.length);

    const bodyLines = visibleRows.map(r => {
        const queriesStr = r.queries.toLocaleString('en-US');
        const failedStr = r.failed.toLocaleString('en-US');
        const slowStr = r.slow.toLocaleString('en-US');
        const delta = pctChange(r.queries, r.prior);
        const deltaStr = fmtDelta(delta.delta, r.prior > 0);
        return [
            pad(truncate(r.user, COL.user), COL.user),
            pad(queriesStr, COL.queries, 'right'),
            pad(failedStr, COL.failed, 'right'),
            pad(slowStr, COL.slow, 'right'),
            pad(fmtMs(r.p50), COL.p50, 'right'),
            pad(fmtMs(r.p95), COL.p95, 'right'),
            pad(fmtMs(r.p99), COL.p99, 'right'),
            pad(deltaStr, COL.delta, 'right'),
        ].join('  ');
    });

    const tableText = bodyLines.length === 0
        ? '(no external projects with traffic in window)'
        : [headerLine, divider, ...bodyLines].join('\n');

    const today = new Date(windowEnd * 1000).toISOString().slice(0, 10);

    const notable: string[] = [];
    for (const r of visibleRows) {
        const d = pctChange(r.queries, r.prior);
        if (r.prior > 0 && d.delta >= 100) notable.push(`🚀 *${r.user}* up \`${d.label}\` (${r.prior.toLocaleString('en-US')} → ${r.queries.toLocaleString('en-US')})`);
        else if (r.prior > 0 && d.delta <= -50) notable.push(`⚠️ *${r.user}* down \`${d.label}\` (${r.prior.toLocaleString('en-US')} → ${r.queries.toLocaleString('en-US')})`);
        if (r.failed > 0) notable.push(`🔥 *${r.user}* — ${r.failed} 5xx response${r.failed === 1 ? '' : 's'} in 24h`);
        if (Number.isFinite(r.p95) && r.p95 >= 2000) notable.push(`🐢 *${r.user}* — p95 ${fmtMs(r.p95)}ms (slow)`);
    }
    if (peakMultiple >= 5 && peakTps > 1) {
        notable.push(`📈 traffic spike: peak ${fmtTps(peakTps)} TPS at ${fmtTimestamp(peakTpsAt)} (${peakMultiple.toFixed(1)}× the 24h average)`);
    }

    const blocks: Array<Record<string, unknown>> = [
        { type: 'header', text: { type: 'plain_text', text: `📊 tokens-api daily usage digest — ${today}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Requests (24h)*\n${fmtCount(totalReq)} ${trendArrow(growth.delta)} \`${growth.label}\` vs prior 24h` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Throughput*\navg ${fmtTps(avgTps)} TPS · peak ${fmtTps(peakTps)} TPS at ${fmtTimestamp(peakTpsAt)} (${peakMultiple.toFixed(1)}× avg)` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*7-day trend*\nlate half vs early half: \`${trendCompare.label}\` ${trendArrow(trendCompare.delta)}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Latency*\np50 ${fmtMs(p50)}ms · p95 ${fmtMs(p95)}ms · p99 ${fmtMs(p99)}ms` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Health*\n2xx ${fmtCount(count2xx)} · 4xx ${fmtCount(count4xx)} (${ratio4xx.toFixed(1)}%) · 5xx ${fmtCount(count5xx)} (${ratio5xx.toFixed(2)}%)` } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: `*Per-user breakdown*\n\`\`\`\n${tableText}\n\`\`\`` } },
    ];

    if (notable.length > 0) {
        blocks.push({ type: 'divider' });
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*Notable*\n${notable.join('\n')}` },
        });
    }

    const payload = {
        text: `tokens-api daily digest — ${fmtCount(totalReq)} requests in last ${WINDOW_HOURS}h (${growth.label} vs prior)`,
        blocks,
    };

    const slackRes = await fetch(slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const slackBody = await slackRes.text();
    if (!slackRes.ok || slackBody.trim() !== 'ok') {
        throw new Error(`Slack webhook ${slackRes.status}: ${slackBody.slice(0, 200)}`);
    }
    console.log(JSON.stringify({
        event: 'usage_digest_sent',
        total_24h: totalReq,
        prior_24h: priorReq,
        growth_pct: Number(growth.delta.toFixed(2)),
        avg_tps: Number(avgTps.toFixed(2)),
        peak_tps: Number(peakTps.toFixed(2)),
        peak_tps_at_unix: peakTpsAt || null,
        projects_shown: visibleRows.length,
        projects_filtered: rows.length - visibleRows.length,
        notable_count: notable.length,
        ratio_5xx_pct: Number(ratio5xx.toFixed(3)),
        p95_ms: Number.isFinite(p95) ? Math.round(p95) : null,
    }));
}

main().catch(err => {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
