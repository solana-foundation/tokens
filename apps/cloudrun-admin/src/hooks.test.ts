import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { PIPELINE_HEARTBEAT_SERVICE, registerGcpLogsRoute, type GcpLogsHookDeps } from './hooks';
import { OidcAuthError } from './oidc';

type PushBody = { streams: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> };

function makeApp(deps: Partial<GcpLogsHookDeps> = {}, lokiStatus = 204) {
    const pushed: PushBody[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
        pushed.push(JSON.parse(String(init?.body ?? '{}')) as PushBody);
        return new Response(lokiStatus >= 400 ? 'nope' : null, { status: lokiStatus });
    }) as unknown as typeof fetch;

    const app = new Hono();
    registerGcpLogsRoute(app, {
        lokiPushUrl: 'https://loki.example/push',
        lokiPushAuth: 'Basic abc',
        verifyGcpLogsOidc: async () => ({ sub: 's', email: 'p@x.iam', aud: 'a', iss: 'i' }),
        envLabel: 'stg',
        fetchImpl,
        ...deps,
    });
    return { app, pushed };
}

function heartbeats(body: PushBody) {
    return body.streams
        .filter(s => s.stream.service === PIPELINE_HEARTBEAT_SERVICE)
        .map(s => ({ stream: s.stream, ts: s.values[0]?.[0], line: JSON.parse(s.values[0]?.[1] ?? '{}') as Record<string, unknown> }));
}

function entryStreams(body: PushBody) {
    return body.streams.filter(s => s.stream.service !== PIPELINE_HEARTBEAT_SERVICE);
}

const entry = {
    timestamp: '2026-07-16T12:00:00Z',
    severity: 'ERROR',
    textPayload: 'boom',
    resource: { type: 'cloud_run_revision', labels: { service_name: 'tokens-assets-prd-us' } },
};

function envelope(e: unknown): RequestInit {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good' },
        body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify(e)).toString('base64') } }),
    };
}

async function call(app: Hono, init: RequestInit) {
    return app.fetch(new Request('http://test/hooks/gcp-logs', init));
}

describe('/hooks/gcp-logs', () => {
    it('rejects a bad OIDC token', async () => {
        const { app } = makeApp({
            verifyGcpLogsOidc: async () => {
                throw new OidcAuthError('nope');
            },
        });
        expect((await call(app, envelope(entry))).status).toBe(403);
    });

    it('rejects a missing bearer token', async () => {
        const { app } = makeApp();
        const res = await call(app, { ...envelope(entry), headers: { 'Content-Type': 'application/json' } });
        expect(res.status).toBe(401);
    });

    it('pushes a LogEntry to Loki with service/severity labels', async () => {
        const { app, pushed } = makeApp();
        expect((await call(app, envelope(entry))).status).toBe(204);
        const body = pushed[0]!;
        expect(body.streams[0]!.stream).toEqual({
            service: 'tokens-assets-prd-us',
            env: 'stg',
            source: 'gcp',
            severity: 'ERROR',
        });
        expect(body.streams[0]!.values[0]![1]).toBe('boom');
    });

    it('ACKs entries Loki permanently rejects (4xx) instead of retry-looping', async () => {
        const { app } = makeApp({}, 400);
        expect((await call(app, envelope(entry))).status).toBe(204);
    });

    it('NACKs when Loki is down (5xx) so Pub/Sub retries', async () => {
        const { app } = makeApp({}, 503);
        expect((await call(app, envelope(entry))).status).toBe(502);
    });

    it('mirrors to extra comma-separated targets without letting them affect the result', async () => {
        const calls: Array<{ url: string; auth: string }> = [];
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            const auth = (init?.headers as Record<string, string>).Authorization!;
            calls.push({ url: String(url), auth });
            if (String(url).includes('mirror')) throw new Error('mirror down');
            return new Response(null, { status: 204 });
        }) as unknown as typeof fetch;
        const { app } = makeApp({
            lokiPushUrl: 'https://loki.example/push, https://mirror.example/push',
            lokiPushAuth: 'Basic abc,Basic def',
            fetchImpl,
        });
        expect((await call(app, envelope(entry))).status).toBe(204);
        expect(calls).toEqual([
            { url: 'https://mirror.example/push', auth: 'Basic def' },
            { url: 'https://loki.example/push', auth: 'Basic abc' },
        ]);
    });

    it('coalesces concurrent deliveries into one Loki push', async () => {
        const { app, pushed } = makeApp();
        const statuses = await Promise.all(
            ['a', 'b', 'c'].map(async t => (await call(app, envelope({ ...entry, textPayload: t }))).status),
        );
        expect(statuses).toEqual([204, 204, 204]);
        expect(pushed).toHaveLength(1);
        expect(entryStreams(pushed[0]!).map(s => s.values[0]![1]).sort()).toEqual(['a', 'b', 'c']);
    });

    it('falls back to per-entry pushes when Loki rejects a batch', async () => {
        const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
            const entries = entryStreams(JSON.parse(String(init?.body)) as PushBody);
            if (entries.length > 1 || entries[0]!.values[0]![1] === 'bad') {
                return new Response('nope', { status: 400 });
            }
            return new Response('down', { status: 503 });
        }) as unknown as typeof fetch;
        const { app } = makeApp({ fetchImpl });
        const [bad, good] = await Promise.all([
            call(app, envelope({ ...entry, textPayload: 'bad' })),
            call(app, envelope({ ...entry, textPayload: 'good' })),
        ]);
        expect(bad.status).toBe(204);
        expect(good.status).toBe(502);
    });

    it('rides a pipeline heartbeat on the push, with lag_s measured from the oldest entry', async () => {
        const nowMs = Date.parse('2026-07-16T12:05:00Z');
        const { app, pushed } = makeApp({ now: () => nowMs });
        expect((await call(app, envelope(entry))).status).toBe(204);
        expect(pushed).toHaveLength(1);
        expect(entryStreams(pushed[0]!)).toHaveLength(1);
        const [hb] = heartbeats(pushed[0]!);
        expect(hb!.stream).toEqual({ service: 'tokens-logs-pipeline', env: 'stg', source: 'direct' });
        expect(hb!.ts).toBe(`${BigInt(nowMs) * 1_000_000n}`);
        expect(hb!.line).toEqual({ event: 'gcp_logs_push', lag_s: 300, entries: 1 });
    });

    it('sends at most one heartbeat per interval per instance', async () => {
        let nowMs = 1_000_000;
        const { app, pushed } = makeApp({ now: () => nowMs, heartbeatIntervalMs: 10_000 });
        await call(app, envelope(entry));
        nowMs += 5_000;
        await call(app, envelope(entry));
        nowMs += 5_000;
        await call(app, envelope(entry));
        expect(pushed.map(b => heartbeats(b).length)).toEqual([1, 0, 1]);
    });

    it('re-sends the heartbeat on the next push when Loki was down', async () => {
        let status = 503;
        const pushed: PushBody[] = [];
        const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
            pushed.push(JSON.parse(String(init?.body)) as PushBody);
            return new Response(status >= 400 ? 'x' : null, { status });
        }) as unknown as typeof fetch;
        const { app } = makeApp({ fetchImpl, now: () => 5_000_000 });
        expect((await call(app, envelope(entry))).status).toBe(502);
        status = 204;
        expect((await call(app, envelope(entry))).status).toBe(204);
        expect(pushed.map(b => heartbeats(b).length)).toEqual([1, 1]);
    });

    it('keeps the heartbeat out of per-entry retries after a rejected batch', async () => {
        const pushed: PushBody[] = [];
        const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as PushBody;
            pushed.push(body);
            return new Response(entryStreams(body).length > 1 ? 'nope' : null, {
                status: entryStreams(body).length > 1 ? 400 : 204,
            });
        }) as unknown as typeof fetch;
        const { app } = makeApp({ fetchImpl });
        const statuses = await Promise.all(
            ['a', 'b'].map(async t => (await call(app, envelope({ ...entry, textPayload: t }))).status),
        );
        expect(statuses).toEqual([204, 204]);
        expect(pushed).toHaveLength(3);
        expect(heartbeats(pushed[0]!)).toHaveLength(1);
        expect(heartbeats(pushed[1]!)).toHaveLength(0);
        expect(heartbeats(pushed[2]!)).toHaveLength(0);
    });

    it('acks unparseable payloads without redelivery', async () => {
        const { app, pushed } = makeApp();
        const res = await call(app, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good' },
            body: JSON.stringify({ message: { data: 'not-base64-json!!!' } }),
        });
        expect(res.status).toBe(204);
        expect(pushed.length).toBe(0);
    });
});
