/**
 * Webhook/log-ingest routes: `POST /hooks/log-drain` and `POST /hooks/clerk-webhook`.
 * (`POST /hooks/gcp-logs` lives on cloudrun-admin so log ingestion cannot
 * contend with the API-key auth path served here.)
 *
 * Verbatim ports of the Vercel log-drain and Clerk webhook handlers from
 * `convex/http.ts` (the `/convex-logs` route intentionally dies with Convex).
 * Both push to Grafana Loki. Cutover: re-point the Vercel drain destination
 * and the Clerk webhook endpoint at this service.
 *
 * Auth is app-level (drain secret / svix HMAC) — these routes are NOT behind
 * the shared bearer token, matching the Convex originals.
 */

import type { Hono } from 'hono';

export interface HookDeps {
    lokiPushUrl?: string;
    lokiPushAuth?: string;
    vercelDrainSecret?: string;
    vercelVerifyToken?: string;
    clerkWebhookSecret?: string;
    /** Env label attached to Loki streams; defaults to 'prd' like the Convex original. */
    envLabel?: string;
    fetchImpl?: typeof fetch;
}

type LokiStream = {
    stream: Record<string, string>;
    values: Array<[string, string]>;
};

function tsNs(ms: number): string {
    return `${BigInt(Math.floor(Number.isFinite(ms) ? ms : Date.now())) * 1_000_000n}`;
}

async function pushToLoki(deps: HookDeps, streams: LokiStream[]): Promise<boolean> {
    const lokiUrl = deps.lokiPushUrl;
    const lokiAuth = deps.lokiPushAuth;
    if (!lokiUrl || !lokiAuth) {
        console.error('loki: LOKI_PUSH_URL / LOKI_PUSH_AUTH unset');
        return false;
    }
    if (streams.length === 0 || streams.every(s => s.values.length === 0)) return true;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl(lokiUrl, {
        method: 'POST',
        headers: { Authorization: lokiAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ streams }),
    });
    if (!res.ok) {
        const body = await res.text();
        console.error(`loki: push failed status=${res.status} body=${body.slice(0, 300)}`);
        // Loki 4xx = permanently unshippable (too-old timestamp, bad labels):
        // retrying can never succeed, so report success to stop redelivery.
        return res.status >= 400 && res.status < 500;
    }
    return true;
}

/**
 * Max allowed skew between the svix-timestamp header and server time, in
 * seconds. Mirrors the official svix libraries' 5-minute tolerance (both
 * directions) and bounds webhook replay to that window.
 */
const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

function svixTimestampInTolerance(timestamp: string, nowMs: number): boolean {
    const tsSeconds = Number(timestamp);
    if (!Number.isFinite(tsSeconds)) return false;
    return Math.abs(nowMs / 1000 - tsSeconds) <= SVIX_TIMESTAMP_TOLERANCE_SECONDS;
}

export function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function verifySvix(
    secret: string,
    id: string,
    timestamp: string,
    body: string,
    signatureHeader: string,
): Promise<boolean> {
    const base64Key = secret.replace(/^whsec_/, '');
    let keyBuf: ArrayBuffer;
    try {
        const bin = atob(base64Key);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        keyBuf = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
    } catch {
        return false;
    }
    const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const message = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
    const sigBytes = await crypto.subtle.sign('HMAC', key, message);
    const expected = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
    for (const part of signatureHeader.split(/\s+/)) {
        const [version, value] = part.split(',');
        if (version === 'v1' && value && constantTimeEqual(value, expected)) return true;
    }
    return false;
}

export function registerHookRoutes(app: Hono, deps: HookDeps): void {
    const envLabel = deps.envLabel ?? 'prd';

    app.post('/hooks/log-drain', async c => {
        const verifyToken = deps.vercelVerifyToken ?? c.req.header('x-vercel-verify');
        if (!c.req.header('x-vercel-drain-secret') && verifyToken) {
            c.header('x-vercel-verify', verifyToken);
            return c.body(null, 200);
        }

        const drainSecret = deps.vercelDrainSecret;
        if (!drainSecret) return c.text('server misconfigured', 500);
        if (!constantTimeEqual(c.req.header('x-vercel-drain-secret') ?? '', drainSecret)) {
            return c.text('forbidden', 403);
        }

        const url = new URL(c.req.url);
        const service = url.searchParams.get('service') ?? 'tokens-unknown';
        const env = url.searchParams.get('env') ?? envLabel;

        const body = await c.req.text();
        if (!body.trim()) {
            if (verifyToken) c.header('x-vercel-verify', verifyToken);
            return c.body(null, 204);
        }

        const bySource = new Map<string, Array<[string, string]>>();
        for (const line of body.split('\n')) {
            if (!line.trim()) continue;
            let evt: Record<string, unknown>;
            try {
                evt = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }
            const tsMs = Number(evt.timestamp ?? evt.timestampInMs ?? Date.now());
            const message = typeof evt.message === 'string' ? evt.message : JSON.stringify(evt);
            const source = typeof evt.source === 'string' ? evt.source : 'unknown';
            const bucket = bySource.get(source) ?? [];
            bucket.push([tsNs(tsMs), message]);
            bySource.set(source, bucket);
        }
        const streams: LokiStream[] = Array.from(bySource.entries()).map(([source, values]) => ({
            stream: { service, env, source },
            values,
        }));
        const ok = await pushToLoki(deps, streams);
        if (ok && verifyToken) c.header('x-vercel-verify', verifyToken);
        return c.body(null, ok ? 204 : 502);
    });

    app.post('/hooks/clerk-webhook', async c => {
        const secret = deps.clerkWebhookSecret;
        if (!secret) return c.text('server misconfigured', 500);

        const svixId = c.req.header('svix-id');
        const svixTimestamp = c.req.header('svix-timestamp');
        const svixSignature = c.req.header('svix-signature');
        if (!svixId || !svixTimestamp || !svixSignature) {
            return c.text('missing svix headers', 400);
        }
        if (!svixTimestampInTolerance(svixTimestamp, Date.now())) {
            return c.text('timestamp out of tolerance', 403);
        }

        const body = await c.req.text();
        const valid = await verifySvix(secret, svixId, svixTimestamp, body, svixSignature);
        if (!valid) return c.text('bad signature', 403);

        let evt: Record<string, unknown>;
        try {
            evt = JSON.parse(body) as Record<string, unknown>;
        } catch {
            return c.text('bad json', 400);
        }

        const eventType = typeof evt.type === 'string' ? evt.type : 'unknown';
        const ts = Number(svixTimestamp) * 1000;
        const line = JSON.stringify({ event_type: eventType, ...evt });
        await pushToLoki(deps, [
            {
                stream: { service: 'tokens-clerk', env: envLabel, event_type: eventType },
                values: [[tsNs(ts), line]],
            },
        ]);
        return c.body(null, 200);
    });
}
