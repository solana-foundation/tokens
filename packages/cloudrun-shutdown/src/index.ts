import { timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';

/**
 * Constant-time string comparison. Returns false immediately on length
 * mismatch (length is not sensitive here), otherwise compares without
 * short-circuiting to avoid leaking a byte-by-byte timing side channel.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

/**
 * Validates an `Authorization: Bearer <token>` header against the expected
 * shared token(s) in constant time. Pass the raw header value (may be
 * undefined). Accepting a list lets a service honour both the current and the
 * previous token during a rotation (`TOKENS_CLOUDRUN_AUTH_TOKEN_PREVIOUS`);
 * each candidate is compared in constant time and empty candidates never match.
 */
export function isValidBearerToken(
    authHeader: string | undefined,
    expectedToken: string | readonly string[],
): boolean {
    const header = authHeader ?? '';
    const candidates = typeof expectedToken === 'string' ? [expectedToken] : expectedToken;
    let valid = false;
    for (const token of candidates) {
        if (!token) continue;
        if (timingSafeEqualString(header, `Bearer ${token}`)) valid = true;
    }
    return valid;
}

/**
 * Builds the bearer candidate list from the current token and an optional
 * previous one (set only during rotation). Shared by every service entrypoint.
 */
export function bearerTokenCandidates(current: string, previous?: string | null): string | readonly string[] {
    const prev = previous?.trim();
    return prev ? [current, prev] : current;
}

let shuttingDown = false;

export function isShuttingDown(): boolean {
    return shuttingDown;
}

export interface ShutdownOptions {
    sql: Sql;
    drainTimeoutSec?: number;
    serviceName?: string;
}

export function registerGracefulShutdown(opts: ShutdownOptions): void {
    const drainTimeoutSec = opts.drainTimeoutSec ?? 8;
    const label = opts.serviceName ?? 'server';
    const handle = (signal: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[graceful:${label}] ${signal} received; new requests will 503, draining SQL pool (timeout=${drainTimeoutSec}s)`);
        opts.sql
            .end({ timeout: drainTimeoutSec })
            .then(() => {
                console.log(`[graceful:${label}] SQL pool drained cleanly`);
                process.exit(0);
            })
            .catch(err => {
                console.error(`[graceful:${label}] SQL drain failed`, err);
                process.exit(1);
            });
    };
    process.on('SIGTERM', () => handle('SIGTERM'));
    process.on('SIGINT', () => handle('SIGINT'));
}

const SHUTDOWN_BODY = JSON.stringify({ error: 'shutting_down' });

export function wrapFetchWithShutdownGuard(
    fetchImpl: (req: Request) => Response | Promise<Response>,
): (req: Request) => Response | Promise<Response> {
    return (req: Request): Response | Promise<Response> => {
        if (shuttingDown) {
            return new Response(SHUTDOWN_BODY, {
                status: 503,
                headers: { 'content-type': 'application/json', 'connection': 'close' },
            });
        }
        return fetchImpl(req);
    };
}
