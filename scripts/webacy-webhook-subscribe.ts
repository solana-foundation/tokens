/**
 * Manage the Webacy `DEPEG_TIER_CHANGE` webhook subscription that feeds
 * `POST /hooks/webacy` on the usage service (apps/cloudrun-usage/src/hooks.webacy.ts).
 *
 *   bun scripts/webacy-webhook-subscribe.ts --list
 *   bun scripts/webacy-webhook-subscribe.ts --create [--dry-run]
 *   bun scripts/webacy-webhook-subscribe.ts --deliveries [--since 2026-06-19T00:00:00Z]
 *   bun scripts/webacy-webhook-subscribe.ts --retry <deliveryId>
 *   bun scripts/webacy-webhook-subscribe.ts --delete <subscriptionId>
 *
 * Env: WEBACY_API_KEY (required), WEBACY_WEBHOOK_URL (required for --create;
 * `<usage service url>/hooks/webacy`), WEBACY_API_BASE (default
 * https://api.webacy.com), DOPPLER_PROJECT (default tokens), DOPPLER_CONFIG
 * (default prd).
 *
 * `--create` refuses when a subscription for the same webhookUrl already
 * exists, then POSTs `{ webhookUrl, eventTypes: ['DEPEG_TIER_CHANGE'],
 * filters: { chains: ['sol'] } }`. Webacy returns `secret_key` exactly once;
 * it is piped straight into `doppler secrets set WEBACY_WEBHOOK_SECRET` over
 * stdin and never printed. Only the subscription id is echoed.
 *
 * Rotation procedure (the secret is per subscription, so rotating means a new
 * subscription):
 *   1. `--create` with the same WEBACY_WEBHOOK_URL is refused while the old
 *      subscription exists. Point WEBACY_WEBHOOK_URL at a temporary variant
 *      that resolves to the same route (e.g. append `?rot=2`), or run
 *      `--delete <oldId>` first if a short gap is acceptable.
 *   2. `--create` writes the new secret_key to Doppler.
 *   3. `GCP_PROJECT=... scripts/seed-usage-hook-secrets.sh` copies Doppler to
 *      Secret Manager and rolls the usage service; deliveries signed with the
 *      old key are recorded as rejected_signature until the new revision
 *      serves. Verified retries supersede those rows, so nothing is lost.
 *   4. `--delete <oldId>`; confirm with `--list` and `--deliveries`.
 *
 * Staging first: run the whole flow against the staging usage URL with
 * DOPPLER_CONFIG=stg before touching prd (plan: docs/operations/asset-advisory-runbook.md).
 */

/* eslint-disable no-console */

const EVENT_TYPES = ['DEPEG_TIER_CHANGE'] as const;
// Webacy's Solana slug is `sol` (verified against /rwa: items echo chain: 'sol').
const FILTERS = { chains: ['sol'] } as const;

const apiKey = (process.env.WEBACY_API_KEY ?? '').trim();
const apiBase = (process.env.WEBACY_API_BASE ?? 'https://api.webacy.com').trim().replace(/\/+$/, '');
const webhookUrl = (process.env.WEBACY_WEBHOOK_URL ?? '').trim();
const dopplerProject = (process.env.DOPPLER_PROJECT ?? 'tokens').trim();
const dopplerConfig = (process.env.DOPPLER_CONFIG ?? 'prd').trim();

type Subscription = {
    id?: string;
    subscription_id?: string;
    webhookUrl?: string;
    webhook_url?: string;
    eventTypes?: string[];
    event_types?: string[];
    filters?: unknown;
    active?: boolean;
    status?: string;
    createdAt?: string;
    created_at?: string;
};

type Delivery = {
    id?: string;
    delivery_id?: string;
    event_id?: string;
    event_type?: string;
    status?: string;
    response_status?: number;
    attempts?: number;
    delivered_at?: string;
    created_at?: string;
};

interface Args {
    list: boolean;
    create: boolean;
    deliveries: boolean;
    since: string | null;
    retry: string | null;
    del: string | null;
    dryRun: boolean;
}

function usage(exitCode: number): never {
    console.error(
        [
            'usage: bun scripts/webacy-webhook-subscribe.ts <command> [--dry-run]',
            '  --list',
            '  --create                      (env WEBACY_WEBHOOK_URL required)',
            '  --deliveries [--since <iso>]',
            '  --retry <deliveryId>',
            '  --delete <subscriptionId>',
        ].join('\n'),
    );
    process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        list: false,
        create: false,
        deliveries: false,
        since: null,
        retry: null,
        del: null,
        dryRun: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const next = () => {
            const value = argv[i + 1];
            if (!value || value.startsWith('--')) {
                console.error(`${flag} requires a value`);
                usage(2);
            }
            i++;
            return value;
        };
        switch (flag) {
            case '--list':
                args.list = true;
                break;
            case '--create':
                args.create = true;
                break;
            case '--deliveries':
                args.deliveries = true;
                break;
            case '--since':
                args.since = next();
                break;
            case '--retry':
                args.retry = next();
                break;
            case '--delete':
                args.del = next();
                break;
            case '--dry-run':
                args.dryRun = true;
                break;
            case '-h':
            case '--help':
                usage(0);
                break;
            default:
                console.error(`unknown flag: ${flag}`);
                usage(2);
        }
    }
    const commands = [args.list, args.create, args.deliveries, args.retry !== null, args.del !== null].filter(
        Boolean,
    ).length;
    if (commands !== 1) usage(2);
    if (args.since && !Number.isFinite(Date.parse(args.since))) {
        console.error(`--since must be an ISO timestamp, got ${args.since}`);
        process.exit(2);
    }
    return args;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
            'x-api-key': apiKey,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
    }
    if (!res.ok) {
        const detail = typeof data === 'string' ? data : JSON.stringify(data);
        throw new Error(`${method} ${path} failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
    }
    return { status: res.status, data: data as T };
}

function unwrapList<T>(data: unknown, keys: string[]): T[] {
    if (Array.isArray(data)) return data as T[];
    if (data && typeof data === 'object') {
        for (const key of keys) {
            const value = (data as Record<string, unknown>)[key];
            if (Array.isArray(value)) return value as T[];
        }
    }
    return [];
}

function subscriptionId(sub: Subscription): string {
    return sub.id ?? sub.subscription_id ?? '(no id)';
}

function subscriptionUrl(sub: Subscription): string {
    return sub.webhookUrl ?? sub.webhook_url ?? '';
}

function normalizeUrl(url: string): string {
    try {
        const u = new URL(url);
        u.hash = '';
        return u.toString().replace(/\/+$/, '');
    } catch {
        return url.trim().replace(/\/+$/, '');
    }
}

async function listSubscriptions(): Promise<Subscription[]> {
    const { data } = await api<unknown>('GET', '/webhooks/subscriptions');
    return unwrapList<Subscription>(data, ['subscriptions', 'data', 'items', 'results']);
}

function printSubscriptions(subs: Subscription[]): void {
    if (subs.length === 0) {
        console.log('no subscriptions');
        return;
    }
    for (const sub of subs) {
        console.log(
            JSON.stringify({
                id: subscriptionId(sub),
                webhookUrl: subscriptionUrl(sub),
                eventTypes: sub.eventTypes ?? sub.event_types ?? null,
                filters: sub.filters ?? null,
                active: sub.active ?? sub.status ?? null,
                createdAt: sub.createdAt ?? sub.created_at ?? null,
            }),
        );
    }
}

async function dopplerAvailable(): Promise<boolean> {
    const probe = Bun.spawn(['doppler', '--version'], { stdout: 'ignore', stderr: 'ignore' });
    try {
        return (await probe.exited) === 0;
    } catch {
        return false;
    }
}

async function storeSecretInDoppler(secret: string): Promise<void> {
    const proc = Bun.spawn(
        [
            'doppler',
            'secrets',
            'set',
            'WEBACY_WEBHOOK_SECRET',
            '--project',
            dopplerProject,
            '--config',
            dopplerConfig,
            '--silent',
        ],
        { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
    );
    proc.stdin.write(secret);
    await proc.stdin.end();
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
        throw new Error(`doppler secrets set failed (exit ${code}): ${stderr.trim().slice(0, 500)}`);
    }
}

async function create(dryRun: boolean): Promise<void> {
    if (!webhookUrl) {
        console.error(
            'FAILED: WEBACY_WEBHOOK_URL must be set for --create (e.g. https://<usage service>/hooks/webacy)',
        );
        process.exit(2);
    }
    if (!/^https:\/\//.test(webhookUrl) || !webhookUrl.includes('/hooks/webacy')) {
        console.error(`FAILED: WEBACY_WEBHOOK_URL must be an https URL ending in /hooks/webacy, got ${webhookUrl}`);
        process.exit(2);
    }
    if (!dryRun && !(await dopplerAvailable())) {
        console.error(
            'FAILED: the doppler CLI is not installed or not on PATH. Install it (https://docs.doppler.com/docs/install-cli) and `doppler login` before running --create; the secret_key is shown once and must land in Doppler.',
        );
        process.exit(2);
    }

    const existing = await listSubscriptions();
    const clash = existing.find(sub => normalizeUrl(subscriptionUrl(sub)) === normalizeUrl(webhookUrl));
    if (clash) {
        console.error(
            `REFUSED: subscription ${subscriptionId(clash)} already targets ${webhookUrl}. Delete it first (--delete ${subscriptionId(clash)}) or use a distinct URL; see the rotation notes in this file's header.`,
        );
        process.exit(1);
    }

    const body = { webhookUrl, eventTypes: [...EVENT_TYPES], filters: { chains: [...FILTERS.chains] } };
    if (dryRun) {
        console.log(`DRY RUN: would POST ${apiBase}/webhooks/subscriptions`);
        console.log(JSON.stringify(body, null, 2));
        console.log(
            `DRY RUN: would write secret_key to Doppler ${dopplerProject}/${dopplerConfig} WEBACY_WEBHOOK_SECRET`,
        );
        return;
    }

    const { status, data } = await api<Record<string, unknown>>('POST', '/webhooks/subscriptions', body);
    const record = (
        data && typeof data === 'object' && 'subscription' in data && data.subscription
            ? (data.subscription as Record<string, unknown>)
            : data
    ) as Record<string, unknown>;
    const secret = [record.secret_key, record.secretKey, data.secret_key, data.secretKey].find(
        (v): v is string => typeof v === 'string' && v.length > 0,
    );
    const id = [record.id, record.subscription_id, data.id, data.subscription_id].find(
        (v): v is string => typeof v === 'string' && v.length > 0,
    );
    if (!secret) {
        console.error(
            `FAILED: HTTP ${status} but no secret_key in the response (keys: ${Object.keys(record).join(', ')}). The subscription may exist without a stored secret; check --list and delete it before retrying.`,
        );
        process.exit(1);
    }

    try {
        await storeSecretInDoppler(secret);
    } catch (err) {
        console.error(
            `FAILED: subscription ${id ?? '(unknown id)'} was created but the secret could not be stored: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.error(
            'The secret_key is not recoverable from Webacy. Delete this subscription (--delete <id>) and run --create again once doppler works.',
        );
        process.exit(1);
    }

    console.log(`created subscription ${id ?? '(id not returned)'} for ${webhookUrl} (HTTP ${status})`);
    console.log(
        `secret_key stored in Doppler ${dopplerProject}/${dopplerConfig} as WEBACY_WEBHOOK_SECRET (not printed)`,
    );
    console.log(
        'next: GCP_PROJECT=<project> scripts/seed-usage-hook-secrets.sh  (copies it to Secret Manager and rolls the usage service)',
    );
}

async function deliveries(since: string | null): Promise<void> {
    const query = since ? `?since=${encodeURIComponent(new Date(since).toISOString())}` : '';
    const { data } = await api<unknown>('GET', `/webhooks/deliveries${query}`);
    const rows = unwrapList<Delivery>(data, ['deliveries', 'data', 'items', 'results']);
    const sinceMs = since ? Date.parse(since) : null;
    const filtered =
        sinceMs === null
            ? rows
            : rows.filter(row => {
                  const ts = Date.parse(row.delivered_at ?? row.created_at ?? '');
                  return !Number.isFinite(ts) || ts >= sinceMs;
              });
    if (filtered.length === 0) {
        console.log('no deliveries');
        return;
    }
    for (const row of filtered) {
        console.log(
            JSON.stringify({
                id: row.id ?? row.delivery_id ?? null,
                eventId: row.event_id ?? null,
                eventType: row.event_type ?? null,
                status: row.status ?? null,
                responseStatus: row.response_status ?? null,
                attempts: row.attempts ?? null,
                deliveredAt: row.delivered_at ?? row.created_at ?? null,
            }),
        );
    }
    console.log(`${filtered.length} deliveries`);
}

async function retry(deliveryId: string, dryRun: boolean): Promise<void> {
    if (dryRun) {
        console.log(`DRY RUN: would POST ${apiBase}/webhooks/deliveries/${encodeURIComponent(deliveryId)}/retry`);
        return;
    }
    const { status, data } = await api<unknown>('POST', `/webhooks/deliveries/${encodeURIComponent(deliveryId)}/retry`);
    console.log(`retry requested for delivery ${deliveryId} (HTTP ${status})`);
    if (data) console.log(JSON.stringify(data));
}

async function remove(id: string, dryRun: boolean): Promise<void> {
    const existing = await listSubscriptions();
    const target = existing.find(sub => subscriptionId(sub) === id);
    if (!target) {
        console.error(`FAILED: no subscription with id ${id}. Current subscriptions:`);
        printSubscriptions(existing);
        process.exit(1);
    }
    if (dryRun) {
        console.log(
            `DRY RUN: would DELETE ${apiBase}/webhooks/subscriptions/${encodeURIComponent(id)} (${subscriptionUrl(target)})`,
        );
        return;
    }
    const { status } = await api<unknown>('DELETE', `/webhooks/subscriptions/${encodeURIComponent(id)}`);
    console.log(`deleted subscription ${id} (${subscriptionUrl(target)}) (HTTP ${status})`);
    console.log(
        "reminder: WEBACY_WEBHOOK_SECRET in Doppler / Secret Manager still holds the deleted subscription's key until the next --create.",
    );
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!apiKey) {
        console.error('FAILED: WEBACY_API_KEY must be set');
        process.exit(2);
    }
    if (args.list) {
        printSubscriptions(await listSubscriptions());
    } else if (args.create) {
        await create(args.dryRun);
    } else if (args.deliveries) {
        await deliveries(args.since);
    } else if (args.retry !== null) {
        await retry(args.retry, args.dryRun);
    } else if (args.del !== null) {
        await remove(args.del, args.dryRun);
    }
}

main().catch(err => {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
