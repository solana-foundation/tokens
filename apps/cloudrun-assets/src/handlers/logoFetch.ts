import { lookup } from 'node:dns/promises';

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
    /** Test seam; production resolves with `dns.lookup(all)`. Must return every address the host resolves to. */
    resolveHost?: ResolveHost;
}

export type ResolveHost = (hostname: string) => Promise<string[]>;

function parseIpv4(hostname: string): [number, number, number, number] | null {
    const parts = hostname.split('.');
    if (parts.length !== 4) return null;
    const nums = parts.map(part => Number(part));
    if (nums.some(num => !Number.isInteger(num) || num < 0 || num > 255)) return null;
    return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isBlockedIpv4(ip: [number, number, number, number]): boolean {
    const [a, b] = ip;
    if (a === 0 || a === 10 || a === 127) return true; // this-network, RFC1918, loopback
    if (a === 169 && b === 254) return true; // link-local incl. the GCE metadata server
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups. Accepts `::` compression,
 * a dotted-quad tail (`::ffff:169.254.169.254`, `64:ff9b::1.2.3.4`), brackets
 * and a zone id. Returns null for anything that is not a well-formed IPv6.
 */
export function parseIpv6Groups(address: string): number[] | null {
    let addr = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
    const zone = addr.indexOf('%');
    if (zone !== -1) addr = addr.slice(0, zone);
    if (!addr.includes(':')) return null;

    // Dotted-quad tail → two hex groups.
    const lastColon = addr.lastIndexOf(':');
    const tail = addr.slice(lastColon + 1);
    if (tail.includes('.')) {
        const v4 = parseIpv4(tail);
        if (!v4) return null;
        addr = `${addr.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
    }

    const parts = addr.split('::');
    if (parts.length > 2) return null;
    const toGroups = (chunk: string): number[] | null => {
        if (chunk === '') return [];
        const out: number[] = [];
        for (const piece of chunk.split(':')) {
            if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
            out.push(parseInt(piece, 16));
        }
        return out;
    };
    const head = toGroups(parts[0] ?? '');
    const rest = parts.length === 2 ? toGroups(parts[1] ?? '') : [];
    if (!head || !rest) return null;
    if (parts.length === 2) {
        const fill = 8 - head.length - rest.length;
        if (fill < 1) return null;
        return [...head, ...new Array<number>(fill).fill(0), ...rest];
    }
    return head.length === 8 ? head : null;
}

function groupsToIpv4(hi: number, lo: number): [number, number, number, number] {
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * A resolved address (IPv4 or IPv6 literal) the worker must never connect to:
 * loopback, RFC1918, link-local (GCE metadata), CGNAT, unique-local, and every
 * IPv6 encoding that wraps an IPv4 (mapped `::ffff:a.b.c.d` / `::ffff:a9fe:a9fe`,
 * deprecated compatible `::a.b.c.d`, NAT64 `64:ff9b::/96`). Parsed structurally
 * so the textual form cannot dodge the check.
 */
export function isBlockedLogoAddress(address: string): boolean {
    const addr = address.trim().toLowerCase();
    if (!addr) return true;
    const v4 = parseIpv4(addr);
    if (v4) return isBlockedIpv4(v4);
    const g = parseIpv6Groups(addr);
    if (!g) return true; // neither an IPv4 nor a well-formed IPv6 literal
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
    const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
    if (leadingZero && g5 === 0xffff) return isBlockedIpv4(groupsToIpv4(g6, g7)); // IPv4-mapped
    if (leadingZero && g5 === 0) {
        if (g6 === 0 && g7 === 0) return true; // :: unspecified
        if (g6 === 0 && g7 === 1) return true; // ::1 loopback
        return isBlockedIpv4(groupsToIpv4(g6, g7)); // deprecated IPv4-compatible ::a.b.c.d
    }
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
        return isBlockedIpv4(groupsToIpv4(g6, g7)); // NAT64 well-known prefix
    }
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
}

/** Hostname-text denylist (same shape as apps/web `_remote-asset-fetch.ts`); resolved addresses are checked separately. */
export function isBlockedLogoHost(hostname: string): boolean {
    const host = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;
    if (host.includes(':')) return true; // IPv6 literals never appear in legitimate logo URLs
    const ip = parseIpv4(host);
    return ip ? isBlockedIpv4(ip) : false;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.map(r => r.address);
}

/**
 * Resolve `hostname` and reject if ANY address is private/loopback/link-local.
 * This is what stops a provider-controlled logo hostname that points at
 * 169.254.169.254 or 10.x from turning the worker into an SSRF proxy; the
 * hostname-text check alone cannot. Residual risk: a TTL race between this
 * lookup and the connect (Bun's fetch cannot pin the address), which is why
 * the denylist also covers the ranges by name and the worker runs with no
 * credentials a logo fetch could exfiltrate.
 */
export async function assertResolvesPublic(
    hostname: string,
    resolveHost: ResolveHost,
): Promise<{ ok: true } | { ok: false; message: string }> {
    const literal = parseIpv4(hostname);
    if (literal) return isBlockedIpv4(literal) ? { ok: false, message: `${hostname} is a private address` } : { ok: true };
    let addresses: string[];
    try {
        addresses = await resolveHost(hostname);
    } catch (err) {
        return { ok: false, message: `dns lookup failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (addresses.length === 0) return { ok: false, message: `${hostname} did not resolve` };
    const blocked = addresses.find(isBlockedLogoAddress);
    if (blocked) return { ok: false, message: `${hostname} resolves to ${blocked}` };
    return { ok: true };
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
    // Caller headers (e.g. the Pinata gateway token) are credentials for the
    // origin we were asked to fetch. A redirect elsewhere must not carry them.
    const initialOrigin = current.origin;

    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (current.protocol !== 'https:' && current.protocol !== 'http:') {
                return { ok: false, reason: 'blocked_host', message: `unsupported protocol ${current.protocol}` };
            }
            if (isBlockedLogoHost(current.hostname)) {
                return { ok: false, reason: 'blocked_host', message: current.hostname };
            }
            const resolved = await assertResolvesPublic(current.hostname, opts.resolveHost ?? defaultResolveHost);
            if (!resolved.ok) {
                const isDns = resolved.message.startsWith('dns lookup failed') || resolved.message.endsWith('did not resolve');
                return { ok: false, reason: isDns ? 'network' : 'blocked_host', message: resolved.message };
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
                            ...(current.origin === initialOrigin ? (opts.headers ?? {}) : {}),
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
