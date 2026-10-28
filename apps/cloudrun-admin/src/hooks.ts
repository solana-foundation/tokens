/**
 * `POST /hooks/gcp-logs`: Cloud Logging -> Pub/Sub push consumer, forwards
 * LogEntries to Grafana Loki. Lives on the admin service (IAM-locked, no
 * user-facing traffic) so log ingestion can never contend with the API-key
 * auth path on the usage service — Pub/Sub's OIDC identity is enforced by
 * Cloud Run IAM first and re-verified here.
 */

import type { Hono } from 'hono';

import { OidcAuthError, type VerifyOidc } from './oidc';

export interface GcpLogsHookDeps {
    lokiPushUrl?: string;
    lokiPushAuth?: string;
    /** Verifies the Google OIDC token Pub/Sub attaches to push deliveries. */
    verifyGcpLogsOidc?: VerifyOidc;
    /** Env label attached to Loki streams. */
    envLabel?: string;
    fetchImpl?: typeof fetch;
    /** Minimum spacing between pipeline heartbeats per instance (default 10 s). */
    heartbeatIntervalMs?: number;
    /**
     * Upper bound on one Loki push (default 20 s). Pub/Sub's ack deadline on
     * the subscription is 60 s: a push that hangs longer than that expires
     * the deadline and the entries are redelivered on top of the hung push,
     * so a hung push must fail fast and turn into a 502 (retry) instead.
     */
    lokiPushTimeoutMs?: number;
    now?: () => number;
}

/**
 * Stream the pipeline heartbeat is written to. It rides on a Loki push the
 * hook is already making and never goes through Cloud Logging or Pub/Sub, so
 * its timestamp is "now" even when everything else is queued: `lag_s` is how
 * far behind the pipeline is, and the Grafana rule `tokens-logs-pipeline-lagging`
 * (plus the lag guard on every Loki "silent/stale" rule) reads it.
 *
 * `publish_lag_s` is the same measurement from the Pub/Sub publish time
 * instead of the Cloud Logging entry timestamp. `lag_s − publish_lag_s` is
 * therefore Cloud Logging receipt → Logs Router → sink publish (Google's
 * side, no metric of its own) and `publish_lag_s` alone is Pub/Sub delivery
 * plus any redelivery after this hook answered 502. On 2026-10-28 a 4–6 min
 * tail on 1–3 % of entries could only be attributed by elimination because
 * the split was not recorded.
 */
export const PIPELINE_HEARTBEAT_SERVICE = 'tokens-logs-pipeline';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_LOKI_PUSH_TIMEOUT_MS = 20_000;

type LokiStream = {
    stream: Record<string, string>;
    values: Array<[string, string]>;
};

/** One Cloud Logging entry on its way to Loki, with when Pub/Sub published it. */
type PendingEntry = {
    stream: LokiStream;
    publishedMs?: number;
};

function tsNs(ms: number): string {
    return `${BigInt(Math.floor(Number.isFinite(ms) ? ms : Date.now())) * 1_000_000n}`;
}

export type LokiPushResult = 'pushed' | 'rejected' | 'retryable';

function mirrorTargets(url: string, auth: string): { primary: [string, string]; mirrors: Array<[string, string]> } {
    const urls = url.split(',').map(s => s.trim());
    const auths = auth.split(',').map(s => s.trim());
    const mirrors = urls
        .slice(1)
        .map((u, i): [string, string] => [u, auths[i + 1] ?? ''])
        .filter(([u, a]) => u && a);
    return { primary: [urls[0] ?? '', auths[0] ?? ''], mirrors };
}

async function pushMirror(
    fetchImpl: typeof fetch,
    url: string,
    auth: string,
    body: string,
    timeoutMs: number,
): Promise<void> {
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) console.error(`loki: mirror push failed status=${res.status} url=${url}`);
    } catch (err) {
        console.error(`loki: mirror push threw ${err instanceof Error ? err.message : 'unknown'} url=${url}`);
    }
}

/**
 * 4xx from Loki means the entry is permanently unshippable (too-old
 * timestamp, bad labels) — retrying can never succeed, so callers must ACK.
 * Only 5xx/network errors are retryable. Without this distinction, one
 * unshippable message NACK-loops through Pub/Sub forever.
 */
export async function pushToLoki(deps: GcpLogsHookDeps, streams: LokiStream[]): Promise<LokiPushResult> {
    const lokiUrl = deps.lokiPushUrl;
    const lokiAuth = deps.lokiPushAuth;
    if (!lokiUrl || !lokiAuth) {
        console.error('loki: LOKI_PUSH_URL / LOKI_PUSH_AUTH unset');
        return 'retryable';
    }
    if (streams.length === 0 || streams.every(s => s.values.length === 0)) return 'pushed';
    const fetchImpl = deps.fetchImpl ?? fetch;
    const timeoutMs = deps.lokiPushTimeoutMs ?? DEFAULT_LOKI_PUSH_TIMEOUT_MS;
    const { primary, mirrors } = mirrorTargets(lokiUrl, lokiAuth);
    const body = JSON.stringify({ streams });
    const mirrored = Promise.all(mirrors.map(([url, auth]) => pushMirror(fetchImpl, url, auth, body, timeoutMs)));
    let res: Response;
    try {
        res = await fetchImpl(primary[0], {
            method: 'POST',
            headers: { Authorization: primary[1], 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        await mirrored;
        console.error(`loki: push threw ${err instanceof Error ? err.message : 'unknown'}`);
        return 'retryable';
    }
    await mirrored;
    if (res.ok) return 'pushed';
    const text = await res.text().catch(() => '');
    console.error(`loki: push failed status=${res.status} body=${text.slice(0, 300)}`);
    return res.status >= 400 && res.status < 500 ? 'rejected' : 'retryable';
}

const BATCH_WINDOW_MS = 250;
const BATCH_MAX_ENTRIES = 500;

function heartbeatStream(envLabel: string, nowMs: number, batch: PendingEntry[]): LokiStream {
    let oldestMs = nowMs;
    let oldestPublishedMs = Infinity;
    let entries = 0;
    for (const { stream, publishedMs } of batch) {
        for (const [ts] of stream.values) {
            entries += 1;
            const ms = Number(BigInt(ts) / 1_000_000n);
            if (ms < oldestMs) oldestMs = ms;
        }
        if (publishedMs !== undefined && publishedMs < oldestPublishedMs) oldestPublishedMs = publishedMs;
    }
    const lagS = Math.max(0, Math.round((nowMs - oldestMs) / 1000));
    const line: Record<string, unknown> = { event: 'gcp_logs_push', lag_s: lagS };
    if (Number.isFinite(oldestPublishedMs)) {
        line.publish_lag_s = Math.max(0, Math.round((nowMs - oldestPublishedMs) / 1000));
    }
    line.entries = entries;
    return {
        stream: { service: PIPELINE_HEARTBEAT_SERVICE, env: envLabel, source: 'direct' },
        values: [[tsNs(nowMs), JSON.stringify(line)]],
    };
}

function createLokiBatcher(deps: GcpLogsHookDeps): (entry: PendingEntry) => Promise<LokiPushResult> {
    let pending: Array<PendingEntry & { resolve: (result: LokiPushResult) => void }> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const envLabel = deps.envLabel ?? 'prd';
    const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const now = deps.now ?? Date.now;
    let lastHeartbeatAt = -Infinity;

    const flush = async (): Promise<void> => {
        clearTimeout(timer);
        timer = undefined;
        const batch = pending;
        pending = [];
        if (batch.length === 0) return;
        try {
            const streams = batch.map(p => p.stream);
            const nowMs = now();
            const withHeartbeat = nowMs - lastHeartbeatAt >= heartbeatIntervalMs;
            const result = await pushToLoki(
                deps,
                withHeartbeat ? [...streams, heartbeatStream(envLabel, nowMs, batch)] : streams,
            );
            if (withHeartbeat && result === 'pushed') lastHeartbeatAt = nowMs;
            if (result !== 'rejected' || batch.length === 1) {
                for (const p of batch) p.resolve(result);
                return;
            }
            // Per-entry retries carry no heartbeat: the batch was rejected,
            // nothing about the pipeline's lag is known to have landed.
            await Promise.all(batch.map(async p => p.resolve(await pushToLoki(deps, [p.stream]))));
        } catch (err) {
            console.error(`loki: batch flush threw ${err instanceof Error ? err.message : 'unknown'}`);
            for (const p of batch) p.resolve('retryable');
        }
    };

    return entry =>
        new Promise(resolve => {
            pending.push({ ...entry, resolve });
            if (pending.length >= BATCH_MAX_ENTRIES) void flush();
            else timer ??= setTimeout(() => void flush(), BATCH_WINDOW_MS);
        });
}

export function registerGcpLogsRoute(app: Hono, deps: GcpLogsHookDeps): void {
    const envLabel = deps.envLabel ?? 'prd';
    const pushBatched = createLokiBatcher({ ...deps, envLabel });

    app.post('/hooks/gcp-logs', async c => {
        const verify = deps.verifyGcpLogsOidc;
        if (!verify) return c.text('server misconfigured', 500);
        const authz = c.req.header('authorization') ?? '';
        const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
        if (!token) return c.text('unauthorized', 401);
        try {
            await verify(token);
        } catch (err) {
            if (err instanceof OidcAuthError) return c.text('forbidden', 403);
            console.error('[hooks/gcp-logs] verify threw', err);
            return c.text('unauthorized', 401);
        }

        // Pub/Sub push envelope: { message: { data: base64(LogEntry JSON), publishTime } }.
        let envelope: { message?: { data?: string; publishTime?: string } };
        try {
            envelope = (await c.req.json()) as { message?: { data?: string; publishTime?: string } };
        } catch {
            return c.text('bad json', 400);
        }
        const data = envelope.message?.data;
        if (!data) return c.body(null, 204);
        const publishedMs = Date.parse(envelope.message?.publishTime ?? '');

        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as Record<string, unknown>;
        } catch {
            // Never NACK unparseable entries: Pub/Sub would redeliver them forever.
            return c.body(null, 204);
        }

        const resource = entry.resource as { labels?: Record<string, string> } | undefined;
        const service = resource?.labels?.service_name ?? 'gcp-unknown';
        const severity = typeof entry.severity === 'string' ? entry.severity : 'DEFAULT';
        const tsMs = Date.parse(typeof entry.timestamp === 'string' ? entry.timestamp : '') || Date.now();
        const line =
            typeof entry.textPayload === 'string'
                ? entry.textPayload
                : JSON.stringify(entry.jsonPayload ?? entry.protoPayload ?? entry.httpRequest ?? entry);

        const result = await pushBatched({
            stream: {
                stream: { service, env: envLabel, source: 'gcp', severity },
                values: [[tsNs(tsMs), line]],
            },
            publishedMs: Number.isFinite(publishedMs) ? publishedMs : undefined,
        });
        // 'rejected' entries are ACKed (204): Loki will never accept them.
        return c.body(null, result === 'retryable' ? 502 : 204);
    });
}
