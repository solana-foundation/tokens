import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Sql } from 'postgres';

import {
    extractEventJson,
    registerWebacyHookRoutes,
    verifyWebacySignature,
    WEBACY_RECONCILE_JOB_PATH,
    type WebacyHookDeps,
} from './hooks.webacy';

const SECRET = 'not-a-real-webhook-signing-key';
const NOW = Date.parse('2026-06-19T18:01:45.000Z');
const ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JOBS_URL = 'https://tokens-assets-jobs-prd-us-abc123-uk.a.run.app';

interface RecordedQuery {
    text: string;
    params: unknown[];
}

interface FakeSql {
    sql: Sql;
    queries: RecordedQuery[];
    /** event_ids that already have a verified row (claim returns no row for these). */
    verified: Set<string>;
}

function makeFakeSql(opts: { verified?: string[] } = {}): FakeSql {
    const queries: RecordedQuery[] = [];
    const verified = new Set(opts.verified ?? []);
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = { text: strings.join('$'), params: values };
        queries.push(query);
        if (query.text.includes('RETURNING event_id')) {
            const eventId = String(values[0]);
            if (verified.has(eventId)) return [];
            verified.add(eventId);
            return [{ event_id: eventId }];
        }
        return [];
    }) as unknown as Sql;
    return { sql, queries, verified };
}

async function hmacHex(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

function makeEvent(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
    return {
        event_type: 'DEPEG_TIER_CHANGE',
        event_id: 'e4c2e1d0-0000-4000-8000-000000000001',
        timestamp: '2026-06-19T18:01:30.702Z',
        data: {
            token_address: ADDRESS,
            chain: 'solana',
            symbol: 'USDC',
            old_tier: 'ok',
            new_tier: 'warning',
            risk_score: 55.2,
            deviation_pct: -2.5,
            price_usd: '0.975',
            peg_usd: '1.000',
            ...data,
        },
        ...overrides,
    };
}

/** Fixture whose signature is over JSON.stringify(event). */
async function signedBody(event: Record<string, unknown>, secret = SECRET) {
    const signature = await hmacHex(secret, JSON.stringify(event));
    const body = JSON.stringify({ event, signature, delivered_at: '2026-06-19T18:01:31.000Z' });
    return { body, signature };
}

/**
 * Fixture whose raw `event` member has a key order JSON.stringify(parsed.event)
 * would NOT reproduce, so only the raw-substring strategy can match.
 */
async function rawOrderSignedBody(secret = SECRET) {
    const rawEvent =
        '{"data": {"symbol":"USDC","token_address":"' +
        ADDRESS +
        '","chain":"solana","new_tier":"critical","old_tier":"warning","note":"brace } and \\"quote\\" inside"},' +
        ' "timestamp":"2026-06-19T18:01:30.702Z","event_id":"raw-order-0002","event_type":"DEPEG_TIER_CHANGE"}';
    const signature = await hmacHex(secret, rawEvent);
    const body = `{"delivered_at":"2026-06-19T18:01:31.000Z","event":${rawEvent},"signature":"${signature}"}`;
    return { body, signature, rawEvent };
}

interface Harness {
    app: Hono;
    fake: FakeSql;
    forwards: Array<{ url: string; init: RequestInit }>;
    logs: Array<Record<string, unknown>>;
    tokenAudiences: string[];
}

function makeApp(
    overrides: Partial<WebacyHookDeps> = {},
    opts: { fake?: FakeSql; forwardStatus?: number; forwardThrows?: boolean } = {},
): Harness {
    const fake = opts.fake ?? makeFakeSql();
    const forwards: Harness['forwards'] = [];
    const logs: Harness['logs'] = [];
    const tokenAudiences: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        forwards.push({ url: String(url), init: init ?? {} });
        if (opts.forwardThrows) throw new Error('connect ECONNREFUSED');
        const status = opts.forwardStatus ?? 200;
        return new Response(status >= 400 ? 'boom' : '{"ok":true}', { status });
    }) as unknown as typeof fetch;

    const app = new Hono();
    registerWebacyHookRoutes(app, {
        sql: fake.sql,
        webhookSecret: SECRET,
        assetsJobsUrl: JOBS_URL,
        fetchImpl,
        mintIdToken: async audience => {
            tokenAudiences.push(audience);
            return 'id-token-xyz';
        },
        now: () => NOW,
        log: line => logs.push(line),
        ...overrides,
    });
    return { app, fake, forwards, logs, tokenAudiences };
}

function post(app: Hono, body: string, headers: Record<string, string> = {}) {
    return app.fetch(
        new Request('http://test/hooks/webacy', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body,
        }),
    );
}

function depegHeaders(event: { event_id?: string }, signature: string): Record<string, string> {
    return {
        'X-Event-Type': 'DEPEG_TIER_CHANGE',
        'X-Event-ID': event.event_id ?? '',
        'X-Webhook-Signature': signature,
    };
}

describe('extractEventJson', () => {
    it('returns the exact raw event substring, preserving key order and whitespace', async () => {
        const { body, rawEvent } = await rawOrderSignedBody();
        expect(extractEventJson(body)).toBe(rawEvent);
    });

    it('skips non-event members whose string values contain braces or the word event', () => {
        const body = '{"note":"{ \\"event\\": 1 }","event":{"a":[1,{"b":"}"}],"c":"\\\\"},"x":1}';
        expect(extractEventJson(body)).toBe('{"a":[1,{"b":"}"}],"c":"\\\\"}');
    });

    it('ignores a nested "event" key that is not top-level', () => {
        expect(extractEventJson('{"outer":{"event":{"a":1}},"event":{"b":2}}')).toBe('{"b":2}');
        expect(extractEventJson('{"outer":{"event":{"a":1}}}')).toBeNull();
    });

    it('returns null for non-object bodies, non-object events, and truncated input', () => {
        expect(extractEventJson('[{"event":{}}]')).toBeNull();
        expect(extractEventJson('{"event":"str"}')).toBeNull();
        expect(extractEventJson('{"event":{"a":1')).toBeNull();
        expect(extractEventJson('not json')).toBeNull();
    });
});

describe('verifyWebacySignature', () => {
    it('accepts an HMAC over JSON.stringify(event)', async () => {
        const { body, signature } = await signedBody(makeEvent());
        expect(await verifyWebacySignature(SECRET, body, signature)).toBe(true);
        expect(await verifyWebacySignature(SECRET, body, `sha256=${signature.toUpperCase()}`)).toBe(true);
    });

    it('accepts an HMAC over the raw event substring when key order differs from JSON.stringify', async () => {
        const { body, signature, rawEvent } = await rawOrderSignedBody();
        const parsed = JSON.parse(body) as { event: unknown };
        expect(JSON.stringify(parsed.event)).not.toBe(rawEvent);
        expect(await verifyWebacySignature(SECRET, body, signature)).toBe(true);
    });

    it('rejects the wrong secret, a tampered body, and malformed signatures', async () => {
        const { body, signature } = await signedBody(makeEvent());
        expect(await verifyWebacySignature('other-secret', body, signature)).toBe(false);
        expect(await verifyWebacySignature(SECRET, body.replace('"warning"', '"critical"'), signature)).toBe(false);
        expect(await verifyWebacySignature(SECRET, body, 'zz')).toBe(false);
        expect(await verifyWebacySignature(SECRET, body, '')).toBe(false);
    });
});

describe('POST /hooks/webacy', () => {
    it('verifies, records, forwards with an OIDC bearer, and marks the row forwarded', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const h = makeApp();

        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, forwarded: true });

        const insert = h.fake.queries.find(q => q.text.includes('INSERT INTO webacy_webhook_deliveries'));
        expect(insert).toBeDefined();
        expect(insert?.text).toContain('RETURNING event_id');
        expect(insert?.params.slice(0, 7)).toEqual([
            event.event_id,
            'DEPEG_TIER_CHANGE',
            'solana',
            ADDRESS,
            NOW,
            true,
            'received',
        ]);
        expect(insert?.params[7]).toBe(body);

        expect(h.forwards).toHaveLength(1);
        const forward = h.forwards[0]!;
        expect(forward.url).toBe(`${JOBS_URL}${WEBACY_RECONCILE_JOB_PATH}`);
        expect(forward.init.method).toBe('POST');
        const headers = forward.init.headers as Record<string, string>;
        expect(headers.authorization).toBe('Bearer id-token-xyz');
        expect(JSON.parse(String(forward.init.body))).toEqual({
            mints: [ADDRESS],
            trigger: 'webhook',
            webhookEventId: event.event_id,
            requireRefreshEnabled: true,
        });
        expect(h.tokenAudiences).toEqual([new URL(JOBS_URL).origin]);

        const update = h.fake.queries.find(q => q.text.startsWith('UPDATE webacy_webhook_deliveries'));
        expect(update?.params).toEqual(['forwarded', event.event_id]);

        expect(h.logs.map(l => l.event)).toEqual(['depeg_webhook_received', 'depeg_webhook_forwarded']);
        expect(h.logs[0]).toMatchObject({
            duplicate: false,
            event_id: event.event_id,
            address: ADDRESS,
            chain: 'solana',
            old_tier: 'ok',
            new_tier: 'warning',
        });
    });

    it('acknowledges Webacy test deliveries ({ test: true }, no token) as ignored without forwarding', async () => {
        // Shape documented for POST /webhooks/subscriptions/{id}/test.
        const event = {
            event_type: 'DEPEG_TIER_CHANGE',
            event_id: 'e4c2e1d0-0000-4000-8000-00000000test',
            timestamp: '2026-06-19T18:01:30.702Z',
            test: true,
            data: { message: 'This is a test delivery' },
        };
        const { body, signature } = await signedBody(event);
        const h = makeApp();
        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ignored: true, why: 'test_event' });
        expect(h.forwards).toHaveLength(0);
        const update = h.fake.queries.find(q => q.text.startsWith('UPDATE webacy_webhook_deliveries'));
        expect(update?.params).toEqual([event.event_id]);
        expect(update?.text).toContain("'ignored'");
        expect(h.logs.map(l => l.event)).toEqual(['depeg_webhook_received', 'depeg_webhook_ignored']);
    });

    it('acknowledges a verified event without token_address as ignored (missing_token_address)', async () => {
        const event = makeEvent({}, { token_address: undefined });
        const { body, signature } = await signedBody(event);
        const h = makeApp();
        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ignored: true, why: 'missing_token_address' });
        expect(h.forwards).toHaveLength(0);
        expect(h.logs.some(l => l.event === 'depeg_webhook_forward_failed')).toBe(false);
    });

    it('accepts the X-Webhook-Previous-Signature header during a rotate-secret grace window', async () => {
        const event = makeEvent();
        const { body, signature: oldKeySignature } = await signedBody(event, 'previous-signing-key');
        const h = makeApp({ webhookSecret: 'previous-signing-key' });
        const res = await post(h.app, body, {
            ...depegHeaders(event, 'a'.repeat(64)),
            'X-Webhook-Previous-Signature': oldKeySignature,
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, forwarded: true });
    });

    it('verifies a delivery whose raw key order differs from JSON.stringify via the substring strategy', async () => {
        const { body, signature } = await rawOrderSignedBody();
        const h = makeApp();
        const res = await post(h.app, body, {
            'X-Event-Type': 'DEPEG_TIER_CHANGE',
            'X-Event-ID': 'raw-order-0002',
            'X-Webhook-Signature': signature,
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, forwarded: true });
        expect(h.forwards).toHaveLength(1);
        expect(h.logs.at(-1)).toMatchObject({ event: 'depeg_webhook_forwarded', new_tier: 'critical' });
    });

    it('rejects a bad signature with 401 and records signature_ok=false without forwarding', async () => {
        const event = makeEvent();
        const { body } = await signedBody(event);
        const h = makeApp();
        const res = await post(h.app, body, depegHeaders(event, 'a'.repeat(64)));
        expect(res.status).toBe(401);

        expect(h.fake.queries).toHaveLength(1);
        const insert = h.fake.queries[0]!;
        expect(insert.text).toContain('ON CONFLICT (event_id) DO NOTHING');
        expect(insert.text).not.toContain('RETURNING');
        expect(insert.params.slice(4, 7)).toEqual([NOW, false, 'rejected_signature']);
        expect(h.forwards).toHaveLength(0);
        expect(h.logs).toEqual([
            expect.objectContaining({
                event: 'depeg_webhook_rejected',
                why: 'bad_signature',
                event_id: event.event_id,
            }),
        ]);
    });

    it('returns 401 for a missing signature header without touching the database', async () => {
        const event = makeEvent();
        const { body } = await signedBody(event);
        const h = makeApp();
        const res = await post(h.app, body, { 'X-Event-Type': 'DEPEG_TIER_CHANGE', 'X-Event-ID': event.event_id });
        expect(res.status).toBe(401);
        expect(h.fake.queries).toHaveLength(0);
        expect(h.logs[0]).toMatchObject({ event: 'depeg_webhook_rejected', why: 'missing_signature' });
    });

    it('acks a duplicate event id with { duplicate: true } and does not forward', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const h = makeApp({}, { fake: makeFakeSql({ verified: [event.event_id] }) });
        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ duplicate: true });
        expect(h.forwards).toHaveLength(0);
        expect(h.fake.queries.some(q => q.text.startsWith('UPDATE'))).toBe(false);
        expect(h.logs).toEqual([expect.objectContaining({ event: 'depeg_webhook_received', duplicate: true })]);
    });

    it('lets a verified retry supersede an earlier signature-rejected row for the same event id', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const fake = makeFakeSql();
        const h = makeApp({}, { fake });

        const rejected = await post(h.app, body, depegHeaders(event, 'b'.repeat(64)));
        expect(rejected.status).toBe(401);
        // The rejected row is not a verified claim, so the fake still allows the claim.
        const accepted = await post(h.app, body, depegHeaders(event, signature));
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({ ok: true, forwarded: true });
        const claim = fake.queries.find(q => q.text.includes('RETURNING event_id'));
        expect(claim?.text).toContain('WHERE webacy_webhook_deliveries.signature_ok = false');
    });

    it('rejects stale and future timestamps with 401 and records rejected_stale', async () => {
        const h = makeApp();
        for (const timestamp of [
            new Date(NOW - 6 * 60 * 1000).toISOString(),
            new Date(NOW + 6 * 60 * 1000).toISOString(),
            'not-a-date',
        ]) {
            const event = makeEvent({ timestamp, event_id: `stale-${timestamp}` });
            const { body, signature } = await signedBody(event);
            const res = await post(h.app, body, depegHeaders(event, signature));
            expect(res.status).toBe(401);
        }
        expect(h.forwards).toHaveLength(0);
        expect(h.fake.queries).toHaveLength(3);
        for (const q of h.fake.queries) {
            expect(q.text).toContain('DO NOTHING');
            expect(q.params.slice(5, 7)).toEqual([true, 'rejected_stale']);
        }
        expect(h.logs.every(l => l.event === 'depeg_webhook_rejected' && l.why === 'stale_timestamp')).toBe(true);
    });

    it('accepts a timestamp just inside the 5 minute window', async () => {
        const event = makeEvent({ timestamp: new Date(NOW - 5 * 60 * 1000 + 1000).toISOString() });
        const { body, signature } = await signedBody(event);
        const h = makeApp();
        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(200);
        expect(h.forwards).toHaveLength(1);
    });

    it('still answers 200 and records forward_failed when the worker returns non-2xx', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const h = makeApp({}, { forwardStatus: 503 });
        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, forwarded: false });
        const update = h.fake.queries.find(q => q.text.startsWith('UPDATE webacy_webhook_deliveries'));
        expect(update?.params).toEqual(['forward_failed', event.event_id]);
        expect(h.logs.at(-1)).toMatchObject({ event: 'depeg_webhook_forward_failed', why: 'http_503' });
    });

    it('still answers 200 and records forward_failed when the forward throws', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const h = makeApp({}, { forwardThrows: true });
        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(200);
        const update = h.fake.queries.find(q => q.text.startsWith('UPDATE webacy_webhook_deliveries'));
        expect(update?.params).toEqual(['forward_failed', event.event_id]);
        expect(h.logs.at(-1)).toMatchObject({ event: 'depeg_webhook_forward_failed', why: 'fetch_error' });
    });

    it('records forward_failed with jobs_url_unset when TOKENS_CLOUDRUN_ASSETS_JOBS_URL is missing', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const h = makeApp({ assetsJobsUrl: undefined });
        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(200);
        expect(h.forwards).toHaveLength(0);
        expect(h.tokenAudiences).toHaveLength(0);
        expect(h.logs.at(-1)).toMatchObject({ event: 'depeg_webhook_forward_failed', why: 'jobs_url_unset' });
    });

    it('records forward_failed when no ID token can be minted', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const h = makeApp({ mintIdToken: async () => null });
        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(200);
        expect(h.forwards).toHaveLength(0);
        expect(h.logs.at(-1)).toMatchObject({ event: 'depeg_webhook_forward_failed', why: 'id_token_unavailable' });
    });

    it('mints the ID token from the GCE metadata server by default (audience + format=full)', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), init: init ?? {} });
            if (String(url).startsWith('http://metadata.google.internal/')) return new Response('meta-token\n');
            return new Response('{"ok":true}');
        }) as unknown as typeof fetch;
        const fake = makeFakeSql();
        const app = new Hono();
        registerWebacyHookRoutes(app, {
            sql: fake.sql,
            webhookSecret: SECRET,
            assetsJobsUrl: `${JOBS_URL}/`,
            fetchImpl,
            now: () => NOW,
            log: () => {},
        });
        const res = await post(app, body, depegHeaders(event, signature));
        expect(res.status).toBe(200);
        expect(calls).toHaveLength(2);
        const meta = new URL(calls[0]!.url);
        expect(meta.origin + meta.pathname).toBe(
            'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity',
        );
        expect(meta.searchParams.get('audience')).toBe(new URL(JOBS_URL).origin);
        expect(meta.searchParams.get('format')).toBe('full');
        expect((calls[0]!.init.headers as Record<string, string>)['Metadata-Flavor']).toBe('Google');
        expect(calls[1]!.url).toBe(`${JOBS_URL}${WEBACY_RECONCILE_JOB_PATH}`);
        expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer meta-token');
    });

    it('acks other event types with { ignored: true }, recording only when the delivery authenticates', async () => {
        const other = makeEvent({ event_type: 'TOKEN_LAUNCH_ANALYSIS', event_id: 'other-1' });
        const { body, signature } = await signedBody(other);
        const h = makeApp();

        const signed = await post(h.app, body, {
            'X-Event-Type': 'TOKEN_LAUNCH_ANALYSIS',
            'X-Event-ID': 'other-1',
            'X-Webhook-Signature': signature,
        });
        expect(signed.status).toBe(200);
        expect(await signed.json()).toEqual({ ignored: true });
        expect(h.fake.queries).toHaveLength(1);
        expect(h.fake.queries[0]!.params.slice(0, 2)).toEqual(['other-1', 'TOKEN_LAUNCH_ANALYSIS']);
        expect(h.fake.queries[0]!.params.slice(5, 7)).toEqual([true, 'ignored']);

        const unsigned = await post(h.app, body, { 'X-Event-Type': 'TOKEN_LAUNCH_ANALYSIS', 'X-Event-ID': 'other-2' });
        expect(unsigned.status).toBe(200);
        expect(await unsigned.json()).toEqual({ ignored: true });
        expect(h.fake.queries).toHaveLength(1);
        expect(h.forwards).toHaveLength(0);
        expect(h.logs.map(l => l.event)).toEqual(['depeg_webhook_ignored', 'depeg_webhook_ignored']);
        expect(h.logs[0]).toMatchObject({ recorded: true });
        expect(h.logs[1]).toMatchObject({ recorded: false });
    });

    it('falls back to event.event_type when the X-Event-Type header is absent', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const h = makeApp();
        const res = await post(h.app, body, { 'X-Webhook-Signature': signature });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, forwarded: true });
    });

    it('returns 400 for a verified depeg event with no event id', async () => {
        const event = makeEvent({ event_id: undefined });
        delete (event as Record<string, unknown>).event_id;
        const { body, signature } = await signedBody(event);
        const h = makeApp();
        const res = await post(h.app, body, { 'X-Event-Type': 'DEPEG_TIER_CHANGE', 'X-Webhook-Signature': signature });
        expect(res.status).toBe(400);
        expect(h.fake.queries).toHaveLength(0);
    });

    it('500s when the webhook secret is unconfigured', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const h = makeApp({ webhookSecret: undefined });
        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(500);
        expect(h.fake.queries).toHaveLength(0);
        expect(h.logs[0]).toMatchObject({ event: 'depeg_webhook_rejected', why: 'secret_unset' });
    });

    it('500s when no sql client is available', async () => {
        const event = makeEvent();
        const { body, signature } = await signedBody(event);
        const h = makeApp({ sql: null });
        const res = await post(h.app, body, depegHeaders(event, signature));
        expect(res.status).toBe(500);
        expect(h.forwards).toHaveLength(0);
    });
});
