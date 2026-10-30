import 'server-only';

import { getVercelOidcToken } from '@vercel/oidc';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Minimal Cloud Run client for the admin app (admin + assets services).
 *
 * Auth for the hop to Cloud Run, in order of preference:
 * 1. Vercel OIDC → GCP Workload Identity Federation: exchange the request-time
 *    Vercel OIDC token for a Google ID token minted as the dedicated invoker
 *    SA, with the target service URL as audience. Cloud Run IAM verifies it on
 *    the IAM-gated admin service; cloudrun-assets verifies it in-app against
 *    the same audience/SA pinning (`oidc.ts`). Requires `GCP_WIF_AUDIENCE` and
 *    `GCP_ADMIN_INVOKER_SA`.
 * 2. Legacy shared bearer (`TOKENS_CLOUDRUN_AUTH_TOKEN`) — local dev only; the
 *    shared bearer must not be configured on the deployed Vercel project.
 *
 * Local development may set `TOKENS_CLOUDRUN_LOCAL_GCLOUD_AUTH=true` to put a
 * short-lived gcloud user identity token in `x-serverless-authorization` for
 * the Cloud Run IAM layer while retaining the shared bearer in `authorization`
 * for the application layer. This lets the local Next.js app use the deployed
 * services (and their Cloud SQL database) without copying DATABASE_URL.
 *
 * Either way the Clerk-session-verified caller travels in the base64
 * `x-tokens-identity` header (same wire contract as apps/api's client).
 */

export interface CloudRunCallerIdentity {
    clerkUserId: string;
    email?: string;
}

const SERVICE_URL_ENV: Record<'admin' | 'assets', string> = {
    admin: 'TOKENS_CLOUDRUN_ADMIN_URL',
    assets: 'TOKENS_CLOUDRUN_ASSETS_URL',
};

const STS_URL = 'https://sts.googleapis.com/v1/token';
const execFileAsync = promisify(execFile);

export class CloudRunCallError extends Error {
    constructor(
        message: string,
        readonly service: string,
        readonly callName: string,
        readonly status?: number,
        readonly body?: string,
    ) {
        super(message);
        this.name = 'CloudRunCallError';
    }
}

function requireEnv(name: string): string {
    const v = process.env[name]?.trim();
    if (!v) throw new Error(`CloudRun client: missing required env var ${name}`);
    return v;
}

interface CachedIdToken {
    token: string;
    expiresAtMs: number;
}

// Google ID tokens live ~1h; refresh with margin. Keyed by audience (one per service).
const ID_TOKEN_TTL_MS = 50 * 60 * 1000;
const idTokenCache = new Map<string, CachedIdToken>();

function isWifConfigured(): boolean {
    return Boolean(process.env.GCP_WIF_AUDIENCE?.trim() && process.env.GCP_ADMIN_INVOKER_SA?.trim());
}

function isLocalGcloudAuthConfigured(): boolean {
    return process.env.TOKENS_CLOUDRUN_LOCAL_GCLOUD_AUTH?.trim().toLowerCase() === 'true';
}

// The STS and generateIdToken hops run before callCloudRun's own timer starts,
// so they need a bound of their own.
const GOOGLE_AUTH_HOP_TIMEOUT_MS = 10_000;

async function fetchJson(url: string, init: RequestInit, context: string): Promise<Record<string, unknown>> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(GOOGLE_AUTH_HOP_TIMEOUT_MS) });
    const body = await res.text();
    if (!res.ok) {
        throw new Error(`${context} failed: HTTP ${res.status} ${body.slice(0, 512)}`);
    }
    return JSON.parse(body) as Record<string, unknown>;
}

/**
 * Vercel request OIDC token → STS federated access token → SA-minted Google ID
 * token with the target service's URL as audience. `getVercelOidcToken()` reads
 * the request-context `x-vercel-oidc-token` header in Vercel Functions and the
 * environment variable only in builds/local development.
 */
async function mintGoogleIdToken(audience: string): Promise<string> {
    const now = Date.now();
    const cached = idTokenCache.get(audience);
    if (cached && cached.expiresAtMs > now) return cached.token;

    const vercelOidcToken = (await getVercelOidcToken())?.trim();
    if (!vercelOidcToken) {
        throw new Error('CloudRun client: Vercel OIDC token is not available (enable Vercel OIDC on the project)');
    }
    const wifAudience = requireEnv('GCP_WIF_AUDIENCE');
    const invokerSa = requireEnv('GCP_ADMIN_INVOKER_SA');

    const sts = await fetchJson(
        STS_URL,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                audience: wifAudience,
                grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
                requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
                scope: 'https://www.googleapis.com/auth/cloud-platform',
                subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
                subjectToken: vercelOidcToken,
            }),
        },
        'GCP STS token exchange',
    );
    const federatedToken = typeof sts.access_token === 'string' ? sts.access_token : '';
    if (!federatedToken) throw new Error('GCP STS token exchange returned no access_token');

    const minted = await fetchJson(
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(invokerSa)}:generateIdToken`,
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${federatedToken}`,
            },
            body: JSON.stringify({ audience, includeEmail: true }),
        },
        'GCP generateIdToken',
    );
    const idToken = typeof minted.token === 'string' ? minted.token : '';
    if (!idToken) throw new Error('GCP generateIdToken returned no token');

    idTokenCache.set(audience, { token: idToken, expiresAtMs: now + ID_TOKEN_TTL_MS });
    return idToken;
}

async function mintLocalGcloudIdToken(): Promise<string> {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('CloudRun client: local gcloud auth is disabled in production');
    }

    const now = Date.now();
    const cacheKey = 'local-gcloud-user';
    const cached = idTokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) return cached.token;

    let stdout: string;
    try {
        const result = await execFileAsync('gcloud', ['auth', 'print-identity-token'], {
            encoding: 'utf8',
            timeout: 20_000,
        });
        stdout = result.stdout;
    } catch (error) {
        throw new Error(
            `CloudRun client: local gcloud identity-token mint failed; run \`gcloud auth login\` and verify Cloud Run invoker access (${String(error)})`,
        );
    }

    const idToken = stdout.trim();
    if (!idToken) throw new Error('CloudRun client: gcloud returned no identity token');

    idTokenCache.set(cacheKey, { token: idToken, expiresAtMs: now + ID_TOKEN_TTL_MS });
    return idToken;
}

async function buildAuthHeaders(baseUrl: string): Promise<Record<string, string>> {
    if (isWifConfigured()) {
        return { authorization: `Bearer ${await mintGoogleIdToken(baseUrl)}` };
    }
    if (isLocalGcloudAuthConfigured()) {
        return {
            authorization: `Bearer ${requireEnv('TOKENS_CLOUDRUN_AUTH_TOKEN')}`,
            'x-serverless-authorization': `Bearer ${await mintLocalGcloudIdToken()}`,
        };
    }
    return { authorization: `Bearer ${requireEnv('TOKENS_CLOUDRUN_AUTH_TOKEN')}` };
}

export async function callCloudRun<T>(
    service: 'admin' | 'assets',
    kind: 'query' | 'mutation',
    name: string,
    args: Record<string, unknown>,
    identity: CloudRunCallerIdentity,
    timeoutMs = 15_000,
): Promise<T> {
    const base = requireEnv(SERVICE_URL_ENV[service]).replace(/\/$/, '');

    let authHeaders: Record<string, string>;
    try {
        authHeaders = await buildAuthHeaders(base);
    } catch (err) {
        throw new CloudRunCallError(`CloudRun ${kind} ${service}.${name} auth failed: ${String(err)}`, service, name);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}/${kind}/${encodeURIComponent(name)}`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'content-type': 'application/json',
                ...authHeaders,
                'x-tokens-identity': Buffer.from(JSON.stringify(identity), 'utf8').toString('base64'),
            },
            body: JSON.stringify(args),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new CloudRunCallError(
                `CloudRun ${kind} ${service}.${name} failed: HTTP ${res.status}`,
                service,
                name,
                res.status,
                body.slice(0, 1024),
            );
        }
        return (await res.json()) as T;
    } catch (err) {
        if (err instanceof CloudRunCallError) throw err;
        if (err instanceof Error && err.name === 'AbortError') {
            throw new CloudRunCallError(`CloudRun ${kind} ${service}.${name} timed out after ${timeoutMs}ms`, service, name);
        }
        throw new CloudRunCallError(`CloudRun ${kind} ${service}.${name} threw: ${String(err)}`, service, name);
    } finally {
        clearTimeout(timeout);
    }
}
