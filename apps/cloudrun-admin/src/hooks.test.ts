import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { registerGcpLogsRoute, type GcpLogsHookDeps } from './hooks';
import { OidcAuthError } from './oidc';

function makeApp(deps: Partial<GcpLogsHookDeps> = {}, lokiStatus = 204) {
    const pushed: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
        pushed.push(JSON.parse(String(init?.body ?? '{}')));
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
        const body = pushed[0] as { streams: Array<{ stream: Record<string, string>; values: [string, string][] }> };
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
