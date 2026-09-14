/**
 * `POST /hooks/webacy`: receiver for Webacy `DEPEG_TIER_CHANGE` webhooks.
 *
 * Thin "verify + dedupe + nudge" only, no business logic: the payload is never
 * trusted for the tier. After the HMAC and replay checks pass and the delivery
 * is recorded in `webacy_webhook_deliveries` (keyed by X-Event-ID), the worker
 * is asked to re-fetch the mint and run the same reconciler the sweep uses
 * (`POST /jobs/reconcile-stablecoin-depeg` on the assets jobs service, OIDC
 * bearer minted from the metadata server).
 *
 * Auth is app-level (HMAC) like the Clerk hook; this route is NOT behind the
 * shared bearer token. Every response after the delivery row exists is 2xx so
 * Webacy's 5-retry backoff never hammers us for a downstream failure we have
 * already persisted; the periodic sweep reconciles `forward_failed` rows.
 *
 * Signature input: Webacy documents "HMAC-SHA256 hex over the compact JSON of
 * the `event` object". The exact key order of that serialisation is not
 * documented, so we accept either `JSON.stringify(parsed.event)` or the exact
 * raw `"event":{...}` substring of the request body.
 */

import type { Hono } from 'hono';
import type { Sql } from 'postgres';

import { constantTimeEqual } from './hooks';

export const WEBACY_DEPEG_EVENT_TYPE = 'DEPEG_TIER_CHANGE';
/** Max |now - event.timestamp|; bounds replay to the same window as the svix hook. */
export const WEBACY_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
export const WEBACY_RECONCILE_JOB_PATH = '/jobs/reconcile-stablecoin-depeg';

const FORWARD_TIMEOUT_MS = 10_000;
const METADATA_TOKEN_TIMEOUT_MS = 5_000;
const METADATA_IDENTITY_URL =
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

export type WebacyDeliveryOutcome =
    'received' | 'forwarded' | 'forward_failed' | 'rejected_signature' | 'rejected_stale' | 'ignored';

export interface WebacyHookDeps {
    /** postgres.js client; null means the service cannot persist deliveries and answers 500. */
    sql: Sql | null;
    /** `secret_key` returned once by `POST /webhooks/subscriptions` (WEBACY_WEBHOOK_SECRET). */
    webhookSecret: string | undefined;
    /** Base URL of the assets jobs service (TOKENS_CLOUDRUN_ASSETS_JOBS_URL). */
    assetsJobsUrl: string | undefined;
    fetchImpl?: typeof fetch;
    /** Mint a Google OIDC ID token for `audience`; defaults to the GCE metadata server. */
    mintIdToken?: (audience: string) => Promise<string | null>;
    now?: () => number;
    /** Single-line JSON log sink; defaults to console.log(JSON.stringify(line)). */
    log?: (line: Record<string, unknown>) => void;
}

interface DeliveryRow {
    eventId: string;
    eventType: string;
    chain: string | null;
    address: string | null;
    receivedAt: number;
    signatureOk: boolean;
    outcome: WebacyDeliveryOutcome;
    payloadJson: string;
}

type ForwardResult = { ok: true } | { ok: false; why: string; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isWs(ch: string | undefined): boolean {
    return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

/** Index just past the closing quote of the JSON string starting at `start` (a `"`), or -1. */
function skipJsonString(s: string, start: number): number {
    let i = start + 1;
    while (i < s.length) {
        const ch = s[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '"') return i + 1;
        i++;
    }
    return -1;
}

/** Index just past the `}` matching the `{` at `start`, or -1. */
function skipJsonObject(s: string, start: number): number {
    let depth = 0;
    let i = start;
    while (i < s.length) {
        const ch = s[i];
        if (ch === '"') {
            i = skipJsonString(s, i);
            if (i < 0) return -1;
            continue;
        }
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
            depth--;
            if (depth === 0) return i + 1;
        }
        i++;
    }
    return -1;
}

/**
 * Exact raw text of the top-level `"event": {...}` member of a JSON object
 * body, byte-for-byte as Webacy serialised it (key order and whitespace
 * preserved). Null when the body is not an object or has no object-valued
 * top-level `event` key. Strings and escapes are respected so braces inside
 * values never confuse the scan.
 */
export function extractEventJson(rawBody: string): string | null {
    let i = 0;
    while (i < rawBody.length && isWs(rawBody[i])) i++;
    if (rawBody[i] !== '{') return null;
    i++;
    let depth = 1;
    while (i < rawBody.length) {
        const ch = rawBody[i];
        if (ch === '"') {
            const end = skipJsonString(rawBody, i);
            if (end < 0) return null;
            if (depth === 1) {
                const key = rawBody.slice(i + 1, end - 1);
                let j = end;
                while (isWs(rawBody[j])) j++;
                if (rawBody[j] === ':') {
                    j++;
                    while (isWs(rawBody[j])) j++;
                    if (key === 'event') {
                        if (rawBody[j] !== '{') return null;
                        const objEnd = skipJsonObject(rawBody, j);
                        return objEnd < 0 ? null : rawBody.slice(j, objEnd);
                    }
                    i = j;
                    continue;
                }
            }
            i = end;
            continue;
        }
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
            depth--;
            if (depth === 0) return null;
        }
        i++;
    }
    return null;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * True when `signatureHex` is the HMAC-SHA256 (hex) of the `event` object
 * under `secret`, computed over either `JSON.stringify(parsed.event)` or the
 * exact raw `"event":{...}` substring of `rawBody`. Comparison is constant time.
 */
export async function verifyWebacySignature(secret: string, rawBody: string, signatureHex: string): Promise<boolean> {
    const provided = signatureHex
        .trim()
        .toLowerCase()
        .replace(/^sha256=/, '');
    if (!/^[0-9a-f]{64}$/.test(provided)) return false;

    const candidates: string[] = [];
    try {
        const parsed: unknown = JSON.parse(rawBody);
        if (isRecord(parsed) && isRecord(parsed.event)) candidates.push(JSON.stringify(parsed.event));
    } catch {
        // fall through to the raw-substring strategy
    }
    const raw = extractEventJson(rawBody);
    if (raw && !candidates.includes(raw)) candidates.push(raw);

    let ok = false;
    for (const candidate of candidates) {
        // Evaluate every candidate so timing does not reveal which one matched.
        if (constantTimeEqual(await hmacSha256Hex(secret, candidate), provided)) ok = true;
    }
    return ok;
}

async function mintMetadataIdToken(fetchImpl: typeof fetch, audience: string): Promise<string | null> {
    // format=full is required so the token carries the `email` claim the
    // worker's invoker pin (TOKENS_CRON_INVOKER_SA) compares against.
    const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}&format=full`;
    const res = await fetchImpl(url, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(METADATA_TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const token = (await res.text()).trim();
    return token || null;
}

/** Insert an audit row; never overwrites an existing row for the same event. */
async function recordDeliveryIfAbsent(sql: Sql, row: DeliveryRow): Promise<void> {
    await sql`
        INSERT INTO webacy_webhook_deliveries
            (event_id, event_type, chain, address, received_at, signature_ok, outcome, payload_json)
        VALUES
            (${row.eventId}, ${row.eventType}, ${row.chain}, ${row.address}, ${row.receivedAt},
             ${row.signatureOk}, ${row.outcome}, ${row.payloadJson})
        ON CONFLICT (event_id) DO NOTHING
    `;
}

/**
 * Idempotency claim for a verified delivery. Returns true when this request
 * owns the event (fresh insert, or it supersedes an earlier row whose
 * signature failed, e.g. a retry that lands after a secret rotation); false
 * when a verified row already exists (duplicate).
 */
async function claimDelivery(sql: Sql, row: DeliveryRow): Promise<boolean> {
    const rows = await sql`
        INSERT INTO webacy_webhook_deliveries
            (event_id, event_type, chain, address, received_at, signature_ok, outcome, payload_json)
        VALUES
            (${row.eventId}, ${row.eventType}, ${row.chain}, ${row.address}, ${row.receivedAt},
             ${row.signatureOk}, ${row.outcome}, ${row.payloadJson})
        ON CONFLICT (event_id) DO UPDATE SET
            event_type   = EXCLUDED.event_type,
            chain        = EXCLUDED.chain,
            address      = EXCLUDED.address,
            received_at  = EXCLUDED.received_at,
            signature_ok = EXCLUDED.signature_ok,
            outcome      = EXCLUDED.outcome,
            payload_json = EXCLUDED.payload_json
        WHERE webacy_webhook_deliveries.signature_ok = false
        RETURNING event_id
    `;
    return rows.length > 0;
}

async function forwardToWorker(opts: {
    fetchImpl: typeof fetch;
    mintIdToken: (audience: string) => Promise<string | null>;
    assetsJobsUrl: string | undefined;
    address: string | undefined;
    eventId: string;
}): Promise<ForwardResult> {
    const jobsUrl = opts.assetsJobsUrl?.trim().replace(/\/+$/, '');
    if (!jobsUrl) return { ok: false, why: 'jobs_url_unset' };
    if (!opts.address) return { ok: false, why: 'missing_token_address' };

    let audience: string;
    try {
        audience = new URL(jobsUrl).origin;
    } catch {
        return { ok: false, why: 'jobs_url_invalid' };
    }

    let token: string | null;
    try {
        token = await opts.mintIdToken(audience);
    } catch (err) {
        return { ok: false, why: 'id_token_error', detail: (err as Error).message };
    }
    if (!token) return { ok: false, why: 'id_token_unavailable' };

    try {
        const res = await opts.fetchImpl(`${jobsUrl}${WEBACY_RECONCILE_JOB_PATH}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                mints: [opts.address],
                trigger: 'webhook',
                webhookEventId: opts.eventId,
                requireRefreshEnabled: true,
            }),
            signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            return { ok: false, why: `http_${res.status}`, detail: detail.slice(0, 300) };
        }
        return { ok: true };
    } catch (err) {
        const e = err as Error;
        return { ok: false, why: e.name === 'TimeoutError' ? 'timeout' : 'fetch_error', detail: e.message };
    }
}

export function registerWebacyHookRoutes(app: Hono, deps: WebacyHookDeps): void {
    const log = deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
    const now = deps.now ?? Date.now;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const mintIdToken = deps.mintIdToken ?? ((audience: string) => mintMetadataIdToken(fetchImpl, audience));

    app.post('/hooks/webacy', async c => {
        const sql = deps.sql;
        if (!sql) {
            log({ event: 'depeg_webhook_rejected', why: 'sql_unset' });
            return c.text('server misconfigured', 500);
        }

        const rawBody = await c.req.text();
        const receivedAt = now();

        let envelope: unknown = null;
        try {
            envelope = JSON.parse(rawBody);
        } catch {
            envelope = null;
        }
        const event = isRecord(envelope) && isRecord(envelope.event) ? envelope.event : undefined;
        const data = event && isRecord(event.data) ? event.data : undefined;

        const eventType = str(c.req.header('x-event-type')) ?? str(event?.event_type);
        const eventId = str(c.req.header('x-event-id')) ?? str(event?.event_id);
        const address = str(data?.token_address);
        const chain = str(data?.chain);
        const fields = {
            event_id: eventId ?? null,
            address: address ?? null,
            chain: chain ?? null,
            old_tier: str(data?.old_tier) ?? null,
            new_tier: str(data?.new_tier) ?? null,
        };

        const secret = deps.webhookSecret?.trim() || undefined;
        const signature = str(c.req.header('x-webhook-signature'));

        // 1. Anything but a depeg tier change is acknowledged and dropped. The
        //    audit row is only written when the delivery authenticates, so an
        //    unauthenticated caller cannot fill the table.
        if (eventType !== WEBACY_DEPEG_EVENT_TYPE) {
            let recorded = false;
            if (eventId && secret && signature && (await verifyWebacySignature(secret, rawBody, signature))) {
                await recordDeliveryIfAbsent(sql, {
                    eventId,
                    eventType: eventType ?? 'unknown',
                    chain: chain ?? null,
                    address: address ?? null,
                    receivedAt,
                    signatureOk: true,
                    outcome: 'ignored',
                    payloadJson: rawBody,
                });
                recorded = true;
            }
            log({ event: 'depeg_webhook_ignored', ...fields, event_type: eventType ?? null, recorded });
            return c.json({ ignored: true }, 200);
        }

        // 2. HMAC.
        if (!secret) {
            log({ event: 'depeg_webhook_rejected', why: 'secret_unset', ...fields });
            return c.text('server misconfigured', 500);
        }
        if (!signature) {
            log({ event: 'depeg_webhook_rejected', why: 'missing_signature', ...fields });
            return c.text('missing signature', 401);
        }
        const signatureOk = await verifyWebacySignature(secret, rawBody, signature);
        if (!signatureOk) {
            if (eventId) {
                await recordDeliveryIfAbsent(sql, {
                    eventId,
                    eventType,
                    chain: chain ?? null,
                    address: address ?? null,
                    receivedAt,
                    signatureOk: false,
                    outcome: 'rejected_signature',
                    payloadJson: rawBody,
                });
            }
            log({ event: 'depeg_webhook_rejected', why: 'bad_signature', ...fields });
            return c.text('bad signature', 401);
        }
        if (!eventId) {
            log({ event: 'depeg_webhook_rejected', why: 'missing_event_id', ...fields });
            return c.text('missing event id', 400);
        }

        // 3. Replay bound.
        const eventTs = Date.parse(str(event?.timestamp) ?? '');
        if (!Number.isFinite(eventTs) || Math.abs(receivedAt - eventTs) > WEBACY_TIMESTAMP_TOLERANCE_MS) {
            await recordDeliveryIfAbsent(sql, {
                eventId,
                eventType,
                chain: chain ?? null,
                address: address ?? null,
                receivedAt,
                signatureOk: true,
                outcome: 'rejected_stale',
                payloadJson: rawBody,
            });
            log({ event: 'depeg_webhook_rejected', why: 'stale_timestamp', ...fields, event_timestamp: eventTs });
            return c.text('timestamp out of tolerance', 401);
        }

        // 4. Idempotency. The row lands as 'received' first so a crash during
        //    the forward leaves a visible state for the sweep to reconcile.
        const claimed = await claimDelivery(sql, {
            eventId,
            eventType,
            chain: chain ?? null,
            address: address ?? null,
            receivedAt,
            signatureOk: true,
            outcome: 'received',
            payloadJson: rawBody,
        });
        if (!claimed) {
            log({ event: 'depeg_webhook_received', duplicate: true, ...fields });
            return c.json({ duplicate: true }, 200);
        }
        log({ event: 'depeg_webhook_received', duplicate: false, ...fields });

        // 5 + 6. Nudge the worker; always 200 from here on.
        let forwarded = false;
        try {
            const result = await forwardToWorker({
                fetchImpl,
                mintIdToken,
                assetsJobsUrl: deps.assetsJobsUrl,
                address,
                eventId,
            });
            forwarded = result.ok;
            const outcome: WebacyDeliveryOutcome = result.ok ? 'forwarded' : 'forward_failed';
            await sql`UPDATE webacy_webhook_deliveries SET outcome = ${outcome} WHERE event_id = ${eventId}`;
            if (result.ok) {
                log({ event: 'depeg_webhook_forwarded', ...fields });
            } else {
                log({
                    event: 'depeg_webhook_forward_failed',
                    why: result.why,
                    ...(result.detail ? { detail: result.detail } : {}),
                    ...fields,
                });
            }
        } catch (err) {
            log({
                event: 'depeg_webhook_forward_failed',
                why: 'unexpected_error',
                detail: (err as Error).message,
                ...fields,
            });
        }
        return c.json({ ok: true, forwarded }, 200);
    });
}
