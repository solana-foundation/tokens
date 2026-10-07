import 'server-only';

import { IDENTITY_HEADER, signIdentityToken, type IdentityClaims } from '@tokens/cloudrun-shutdown/identity';

/**
 * Minimal Cloud Run client for the dashboard (usage service only).
 * Trimmed copy of `apps/api/src/lib/cloudrun/client.ts` — bearer token plus a
 * signed `x-tokens-identity` token carrying the Clerk-session-verified caller,
 * bound to this exact RPC and body (see `@tokens/cloudrun-shutdown/identity`).
 */

export type CloudRunCallerIdentity = IdentityClaims;

export const CLOUDRUN_IDENTITY_HEADER = IDENTITY_HEADER;

export class CloudRunCallError extends Error {
    constructor(
        message: string,
        readonly kind: 'query' | 'mutation',
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

export async function callCloudRunUsage<T>(
    kind: 'query' | 'mutation',
    name: string,
    args: Record<string, unknown>,
    identity: CloudRunCallerIdentity,
): Promise<T> {
    const base = requireEnv('TOKENS_CLOUDRUN_USAGE_URL').replace(/\/$/, '');
    const authToken = requireEnv('TOKENS_CLOUDRUN_AUTH_TOKEN');
    const signingSecret = requireEnv('TOKENS_IDENTITY_SIGNING_SECRET');
    const timeoutMs = Number(process.env.TOKENS_CLOUDRUN_TIMEOUT_MS) || 15_000;

    // The body string is hashed into the identity token, so serialise once and
    // send those exact bytes.
    const body = JSON.stringify(args);
    const identityToken = await signIdentityToken(identity, { kind, fn: name, body }, signingSecret);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}/${kind}/${encodeURIComponent(name)}`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${authToken}`,
                [CLOUDRUN_IDENTITY_HEADER]: identityToken,
            },
            body,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new CloudRunCallError(
                `CloudRun ${kind} usage.${name} failed: HTTP ${res.status}`,
                kind,
                name,
                res.status,
                body.slice(0, 1024),
            );
        }
        return (await res.json()) as T;
    } catch (err) {
        if (err instanceof CloudRunCallError) throw err;
        if (err instanceof Error && err.name === 'AbortError') {
            throw new CloudRunCallError(`CloudRun ${kind} usage.${name} timed out after ${timeoutMs}ms`, kind, name);
        }
        throw new CloudRunCallError(`CloudRun ${kind} usage.${name} threw: ${String(err)}`, kind, name);
    } finally {
        clearTimeout(timeout);
    }
}
