import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { registerHookRoutes, type HookDeps } from './hooks';

function makeApp(deps: Partial<HookDeps> = {}, lokiStatus = 204) {
    const pushed: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
        pushed.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(lokiStatus >= 400 ? 'nope' : null, { status: lokiStatus });
    }) as unknown as typeof fetch;

    const app = new Hono();
    registerHookRoutes(app, {
        lokiPushUrl: 'https://loki.example/push',
        lokiPushAuth: 'Basic abc',
        vercelDrainSecret: 'drain-secret',
        clerkWebhookSecret: `whsec_${Buffer.from('svix-test-key').toString('base64')}`,
        envLabel: 'stg',
        fetchImpl,
        ...deps,
    });
    return { app, pushed };
}

async function call(app: Hono, path: string, init: RequestInit = {}) {
    return app.fetch(new Request(`http://test${path}`, init));
}

describe('/hooks/log-drain', () => {
    it('answers the Vercel verification handshake', async () => {
        const { app } = makeApp();
        const res = await call(app, '/hooks/log-drain', {
            method: 'POST',
            headers: { 'x-vercel-verify': 'verify-me' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('x-vercel-verify')).toBe('verify-me');
    });

    it('rejects a missing/wrong drain secret', async () => {
        const { app } = makeApp();
        const res = await call(app, '/hooks/log-drain', {
            method: 'POST',
            headers: { 'x-vercel-drain-secret': 'wrong' },
            body: '{}',
        });
        expect(res.status).toBe(403);
    });

    it('answers drain-creation validation with the configured verify token', async () => {
        const { app } = makeApp({ vercelVerifyToken: 'team-token' });
        const res = await call(app, '/hooks/log-drain', { method: 'POST' });
        expect(res.status).toBe(200);
        expect(res.headers.get('x-vercel-verify')).toBe('team-token');
    });

    it('answers an authenticated empty-body validation ping with the verify token', async () => {
        const { app } = makeApp({ vercelVerifyToken: 'team-token' });
        const res = await call(app, '/hooks/log-drain', {
            method: 'POST',
            headers: { 'x-vercel-drain-secret': 'drain-secret' },
            body: '',
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('x-vercel-verify')).toBe('team-token');
    });

    it('attaches the verify token to authenticated responses but not auth failures', async () => {
        const { app } = makeApp({ vercelVerifyToken: 'team-token' });
        const data = await call(app, '/hooks/log-drain?service=tokens-api', {
            method: 'POST',
            headers: { 'x-vercel-drain-secret': 'drain-secret' },
            body: JSON.stringify({ timestamp: 1_750_000_000_000, message: 'hi', source: 'lambda' }),
        });
        expect(data.status).toBe(204);
        expect(data.headers.get('x-vercel-verify')).toBe('team-token');

        const denied = await call(app, '/hooks/log-drain', {
            method: 'POST',
            headers: { 'x-vercel-drain-secret': 'wrong' },
            body: '{}',
        });
        expect(denied.status).toBe(403);
        expect(denied.headers.get('x-vercel-verify')).toBeNull();
    });

    it('rejects an unauthenticated request when no verify token is configured', async () => {
        const { app } = makeApp();
        const res = await call(app, '/hooks/log-drain', { method: 'POST', body: '{}' });
        expect(res.status).toBe(403);
        expect(res.headers.get('x-vercel-verify')).toBeNull();
    });

    it('groups NDJSON lines by source and pushes to Loki with service/env labels', async () => {
        const { app, pushed } = makeApp();
        const lines = [
            JSON.stringify({ timestamp: 1_750_000_000_000, message: 'hello', source: 'lambda' }),
            JSON.stringify({ timestamp: 1_750_000_000_001, message: 'world', source: 'lambda' }),
            JSON.stringify({ timestamp: 1_750_000_000_002, message: 'edge!', source: 'edge' }),
            'not-json',
        ].join('\n');
        const res = await call(app, '/hooks/log-drain?service=tokens-api&env=prd', {
            method: 'POST',
            headers: { 'x-vercel-drain-secret': 'drain-secret' },
            body: lines,
        });
        expect(res.status).toBe(204);
        const payload = pushed[0] as { streams: Array<{ stream: Record<string, string>; values: unknown[] }> };
        expect(payload.streams).toHaveLength(2);
        const lambda = payload.streams.find(s => s.stream.source === 'lambda');
        expect(lambda?.stream).toEqual({ service: 'tokens-api', env: 'prd', source: 'lambda' });
        expect(lambda?.values).toHaveLength(2);
    });

    it('mirrors to extra comma-separated targets without letting them affect the result', async () => {
        const calls: Array<{ url: string; auth: string; body: string }> = [];
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            const auth = (init?.headers as Record<string, string>).Authorization!;
            calls.push({ url: String(url), auth, body: String(init?.body) });
            if (String(url).includes('mirror')) return new Response('nope', { status: 401 });
            return new Response(null, { status: 204 });
        }) as unknown as typeof fetch;
        const { app } = makeApp({
            lokiPushUrl: 'https://loki.example/push,https://mirror.example/push',
            lokiPushAuth: 'Basic abc, Basic def',
            fetchImpl,
        });
        const res = await call(app, '/hooks/log-drain?service=tokens-api&env=prd', {
            method: 'POST',
            headers: { 'x-vercel-drain-secret': 'drain-secret' },
            body: JSON.stringify({ timestamp: 1_750_000_000_000, message: 'hello', source: 'lambda' }),
        });
        expect(res.status).toBe(204);
        expect(calls.map(c => [c.url, c.auth])).toEqual([
            ['https://loki.example/push', 'Basic abc'],
            ['https://mirror.example/push', 'Basic def'],
        ]);
        expect(calls[1]!.body).toBe(calls[0]!.body);
    });

    it('returns 204 for empty bodies without pushing', async () => {
        const { app, pushed } = makeApp();
        const res = await call(app, '/hooks/log-drain', {
            method: 'POST',
            headers: { 'x-vercel-drain-secret': 'drain-secret' },
            body: '  ',
        });
        expect(res.status).toBe(204);
        expect(pushed).toHaveLength(0);
    });

    it('500s when the drain secret is unconfigured', async () => {
        const app = new Hono();
        registerHookRoutes(app, {});
        const res = await call(app, '/hooks/log-drain', { method: 'POST', body: '{}' });
        expect(res.status).toBe(500);
    });
});

describe('/hooks/clerk-webhook', () => {
    async function svixSign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
        const base64Key = secret.replace(/^whsec_/, '');
        const keyBytes = Uint8Array.from(atob(base64Key), ch => ch.charCodeAt(0));
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
            'sign',
        ]);
        const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
        return `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
    }

    const SECRET = `whsec_${Buffer.from('svix-test-key').toString('base64')}`;

    it('accepts a correctly signed event and pushes it to Loki', async () => {
        const { app, pushed } = makeApp({ clerkWebhookSecret: SECRET });
        const body = JSON.stringify({ type: 'user.created', data: { id: 'user_1' } });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = await svixSign(SECRET, 'msg_1', timestamp, body);

        const res = await call(app, '/hooks/clerk-webhook', {
            method: 'POST',
            headers: { 'svix-id': 'msg_1', 'svix-timestamp': timestamp, 'svix-signature': signature },
            body,
        });
        expect(res.status).toBe(200);
        const payload = pushed[0] as { streams: Array<{ stream: Record<string, string> }> };
        expect(payload.streams[0]?.stream).toEqual({
            service: 'tokens-clerk',
            env: 'stg',
            event_type: 'user.created',
        });
    });

    it('rejects bad signatures and missing headers', async () => {
        const { app } = makeApp({ clerkWebhookSecret: SECRET });
        const body = JSON.stringify({ type: 'user.created' });

        const missing = await call(app, '/hooks/clerk-webhook', { method: 'POST', body });
        expect(missing.status).toBe(400);

        const timestamp = String(Math.floor(Date.now() / 1000));
        const bad = await call(app, '/hooks/clerk-webhook', {
            method: 'POST',
            headers: { 'svix-id': 'msg_1', 'svix-timestamp': timestamp, 'svix-signature': 'v1,AAAA' },
            body,
        });
        expect(bad.status).toBe(403);
    });

    it('rejects correctly signed events with a stale, future, or garbage timestamp', async () => {
        const { app, pushed } = makeApp({ clerkWebhookSecret: SECRET });
        const body = JSON.stringify({ type: 'user.created' });
        const nowSec = Math.floor(Date.now() / 1000);

        for (const timestamp of [
            String(nowSec - 6 * 60), // stale (replay)
            String(nowSec + 6 * 60), // too far in the future
            'not-a-number',
        ]) {
            const signature = await svixSign(SECRET, 'msg_1', timestamp, body);
            const res = await call(app, '/hooks/clerk-webhook', {
                method: 'POST',
                headers: { 'svix-id': 'msg_1', 'svix-timestamp': timestamp, 'svix-signature': signature },
                body,
            });
            expect(res.status).toBe(403);
        }
        expect(pushed).toHaveLength(0);
    });
});

describe('/hooks/log-drain loki failure semantics', () => {
    const drainInit = {
        method: 'POST',
        headers: { 'x-vercel-drain-secret': 'drain-secret' },
        body: '{"timestamp":1752666000000,"message":"hello","source":"lambda"}',
    };

    it('ACKs when Loki permanently rejects the entries (4xx)', async () => {
        const { app } = makeApp({}, 400);
        const res = await call(app, '/hooks/log-drain', drainInit);
        expect(res.status).toBe(204);
    });

    it('returns 502 when Loki is down (5xx) so the drain retries', async () => {
        const { app } = makeApp({}, 503);
        const res = await call(app, '/hooks/log-drain', drainInit);
        expect(res.status).toBe(502);
    });

    it('never attaches the verify token to a 502 failure response', async () => {
        const { app } = makeApp({ vercelVerifyToken: 'team-token' }, 503);
        const res = await call(app, '/hooks/log-drain', drainInit);
        expect(res.status).toBe(502);
        expect(res.headers.get('x-vercel-verify')).toBeNull();
    });
});
