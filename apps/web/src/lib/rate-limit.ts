import 'server-only';

/**
 * Fixed-window rate limiting for web route handlers.
 *
 * Backed by Upstash Redis over REST (shared with the API app; keys are
 * namespaced under `web:rl:`), so the limit holds across every serverless
 * instance. One atomic Lua call per check: INCR the window counter and set its
 * expiry on first use. Without Upstash credentials (local dev, tests) a
 * per-process map enforces the same limits. A Redis error fails open and is
 * logged: the browser check on the route still applies, and a limiter outage
 * must not take live prices down with it.
 */

const KEY_PREFIX = 'web:rl';
const UPSTASH_TIMEOUT_MS = 1_500;

const WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

export interface RateLimitRule {
    /** Namespace for the counter, e.g. `pyth-token`. */
    scope: string;
    /** Max requests per window. */
    limit: number;
    windowMs: number;
}

export interface RateLimitResult {
    ok: boolean;
    limit: number;
    remaining: number;
    /** Seconds until the window resets (≥ 1 when `ok` is false). */
    retryAfterSeconds: number;
    backend: 'upstash' | 'memory' | 'open';
}

function readUpstash(): { url: string; token: string } | null {
    const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
    const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
    return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

/** Best-effort client identity: Vercel's real-ip, else the first forwarded hop. */
export function clientIdentifier(request: Request): string {
    const direct = request.headers.get('x-real-ip')?.trim();
    if (direct) return direct;
    const forwarded = request.headers.get('x-forwarded-for') ?? request.headers.get('x-vercel-forwarded-for') ?? '';
    const first = forwarded.split(',')[0]?.trim();
    return first || 'unknown';
}

// --- in-memory fallback -------------------------------------------------------

const memoryWindows = new Map<string, { count: number; expiresAtMs: number }>();

function memoryLimit(key: string, rule: RateLimitRule, now: number): RateLimitResult {
    const current = memoryWindows.get(key);
    const entry = current && current.expiresAtMs > now ? current : { count: 0, expiresAtMs: now + rule.windowMs };
    entry.count += 1;
    memoryWindows.set(key, entry);
    // Opportunistic sweep so the map cannot grow without bound.
    if (memoryWindows.size > 10_000) {
        for (const [k, v] of memoryWindows) if (v.expiresAtMs <= now) memoryWindows.delete(k);
    }
    return toResult(entry.count, entry.expiresAtMs - now, rule, 'memory');
}

/** Test hook. */
export function __resetRateLimitMemory(): void {
    memoryWindows.clear();
}

// --- upstash -------------------------------------------------------------------

async function upstashLimit(
    key: string,
    rule: RateLimitRule,
    creds: { url: string; token: string },
): Promise<RateLimitResult | null> {
    const res = await fetch(creds.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(['EVAL', WINDOW_SCRIPT, 1, key, String(rule.windowMs)]),
        cache: 'no-store',
        signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    if (json.error) throw new Error(String(json.error));
    const [count, ttl] = Array.isArray(json.result) ? json.result : [];
    const n = Number(count);
    const ttlMs = Number(ttl);
    if (!Number.isFinite(n)) return null;
    return toResult(n, Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : rule.windowMs, rule, 'upstash');
}

function toResult(
    count: number,
    msToReset: number,
    rule: RateLimitRule,
    backend: RateLimitResult['backend'],
): RateLimitResult {
    const ok = count <= rule.limit;
    return {
        ok,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - count),
        retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil(msToReset / 1000)),
        backend,
    };
}

/**
 * Check `identifier` against `rule`. Call once per request; the request counts
 * whether or not it is allowed.
 */
export async function enforceRateLimit(rule: RateLimitRule, identifier: string): Promise<RateLimitResult> {
    const now = Date.now();
    const key = `${KEY_PREFIX}:${rule.scope}:${identifier}`;
    const creds = readUpstash();
    if (!creds) return memoryLimit(key, rule, now);
    try {
        const result = await upstashLimit(key, rule, creds);
        if (result) return result;
    } catch (error) {
        console.error('[rate-limit] upstash check failed; failing open', { scope: rule.scope, error: String(error) });
    }
    return { ok: true, limit: rule.limit, remaining: rule.limit, retryAfterSeconds: 0, backend: 'open' };
}

/** 429 with `Retry-After`, never cached. */
export function rateLimitedResponse(result: RateLimitResult): Response {
    return Response.json(
        { error: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds },
        {
            status: 429,
            headers: {
                'Cache-Control': 'no-store',
                'Retry-After': String(result.retryAfterSeconds),
                'X-RateLimit-Limit': String(result.limit),
                'X-RateLimit-Remaining': String(result.remaining),
            },
        },
    );
}
