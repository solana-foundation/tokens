import { withExternalTiming } from '../externalTiming';

/** 2 MiB hard cap on upstream artwork (mirrors apps/web image-proxy). */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'tokens.xyz-logo-sync/1 (+https://tokens.xyz)';

export type LogoFetchFailureReason =
    | 'http_429'
    | 'http_403'
    | 'http_404'
    | 'http_error'
    | 'too_large'
    | 'timeout'
    | 'network'
    | 'redirect'
    | 'blocked_host'
    | 'empty';

export type LogoFetchResult =
    | { ok: true; bytes: Uint8Array; contentType: string | null; finalUrl: string }
    | { ok: false; reason: LogoFetchFailureReason; status?: number; message?: string };

export interface FetchLogoOptions {
    /** Label for the `external_call` timing log (dashboards group by provider). */
    provider: string;
    headers?: Record<string, string>;
    timeoutMs: number;
    maxBytes?: number;
    fetchImpl?: typeof fetch;
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
    const parts = hostname.split('.');
    if (parts.length !== 4) return null;
    const nums = parts.map(part => Number(part));
    if (nums.some(num => !Number.isInteger(num) || num < 0 || num > 255)) return null;
    return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

/** Same denylist as apps/web `_remote-asset-fetch.ts`: loopback, RFC1918, link-local, CGNAT, all IPv6 literals. */
export function isBlockedLogoHost(hostname: string): boolean {
    const host = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;
    if (host.includes(':')) return true;
    const ip = parseIpv4(host);
    if (!ip) return false;
    const [a, b] = ip;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
}

async function readCapped(response: Response, maxBytes: number, abort: AbortController): Promise<Uint8Array | 'too_large'> {
    const body = response.body;
    if (!body) {
        const buf = new Uint8Array(await response.arrayBuffer());
        return buf.byteLength > maxBytes ? 'too_large' : buf;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
            abort.abort();
            await reader.cancel().catch(() => undefined);
            return 'too_large';
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/**
 * Fetch upstream artwork with a timeout, a streamed size cap, manual redirect
 * following (re-validating the host on every hop) and a tagged failure
 * instead of a throw, so a job can walk its fallback plan.
 */
export async function fetchLogoBytes(url: string, opts: FetchLogoOptions): Promise<LogoFetchResult> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const maxBytes = Math.min(opts.maxBytes ?? LOGO_MAX_BYTES, LOGO_MAX_BYTES);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, opts.timeoutMs));
    let current: URL;
    try {
        current = new URL(url);
    } catch {
        clearTimeout(timer);
        return { ok: false, reason: 'network', message: 'invalid url' };
    }

    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (current.protocol !== 'https:' && current.protocol !== 'http:') {
                return { ok: false, reason: 'blocked_host', message: `unsupported protocol ${current.protocol}` };
            }
            if (isBlockedLogoHost(current.hostname)) {
                return { ok: false, reason: 'blocked_host', message: current.hostname };
            }
            const target = current.toString();
            let response: Response;
            try {
                response = await withExternalTiming(opts.provider, target, () =>
                    fetchImpl(target, {
                        method: 'GET',
                        redirect: 'manual',
                        signal: controller.signal,
                        headers: {
                            accept: 'image/*,*/*;q=0.8',
                            'user-agent': USER_AGENT,
                            ...(opts.headers ?? {}),
                        },
                    }),
                );
            } catch (err) {
                if (controller.signal.aborted) return { ok: false, reason: 'timeout' };
                return { ok: false, reason: 'network', message: err instanceof Error ? err.message : String(err) };
            }

            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                await response.body?.cancel().catch(() => undefined);
                if (!location) return { ok: false, reason: 'redirect', status: response.status, message: 'no location' };
                try {
                    current = new URL(location, current);
                } catch {
                    return { ok: false, reason: 'redirect', status: response.status, message: 'bad location' };
                }
                continue;
            }

            if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                const reason: LogoFetchFailureReason =
                    response.status === 429
                        ? 'http_429'
                        : response.status === 403
                          ? 'http_403'
                          : response.status === 404
                            ? 'http_404'
                            : 'http_error';
                return { ok: false, reason, status: response.status };
            }

            const declared = Number(response.headers.get('content-length') ?? '');
            if (Number.isFinite(declared) && declared > maxBytes) {
                await response.body?.cancel().catch(() => undefined);
                return { ok: false, reason: 'too_large', status: response.status };
            }

            let bytes: Uint8Array | 'too_large';
            try {
                bytes = await readCapped(response, maxBytes, controller);
            } catch (err) {
                if (controller.signal.aborted) return { ok: false, reason: 'timeout' };
                return { ok: false, reason: 'network', message: err instanceof Error ? err.message : String(err) };
            }
            if (bytes === 'too_large') return { ok: false, reason: 'too_large', status: response.status };
            if (bytes.byteLength === 0) return { ok: false, reason: 'empty', status: response.status };

            const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || null;
            return { ok: true, bytes, contentType, finalUrl: target };
        }
        return { ok: false, reason: 'redirect', message: 'too many redirects' };
    } finally {
        clearTimeout(timer);
    }
}
