const DEFAULT_ALLOWED_HOSTS = new Set<string>([
    'assets.coingecko.com',
    'static.coingecko.com',
    'coin-images.coingecko.com',
    'cdn.jsdelivr.net',
    'static.jup.ag',
    'cdn.jup.ag',
    'img.birdeye.so',
    'raw.githubusercontent.com',
    'user-images.githubusercontent.com',
    'avatars.githubusercontent.com',
    'cdn.ondo.finance',
    'arweave.net',
    // First-party logo copies (logo-sync job → public GCS bucket; img.tokens.xyz is the planned custom host).
    // Public IPFS gateways are deliberately absent: they 429/403 everyone, so logos are re-hosted instead.
    'storage.googleapis.com',
    'img.tokens.xyz',
    'shdw-drive.genesysgo.net',
    '*.arweave.net',
]);

function parseApiOriginHostFromEnv(): string | null {
    const raw = (process.env.TOKENS_API_ORIGIN ?? '').trim();
    if (!raw) return null;

    try {
        const url = new URL(raw);
        return url.hostname.trim().toLowerCase() || null;
    } catch {
        return null;
    }
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
    const parts = hostname.split('.');
    if (parts.length !== 4) return null;
    const nums = parts.map(part => Number(part));
    if (nums.some(num => !Number.isInteger(num) || num < 0 || num > 255)) return null;
    return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

export function isPrivateIpHost(hostname: string): boolean {
    if (hostname.includes(':')) return true;

    const ip = parseIpv4(hostname);
    if (!ip) return false;

    const [a, b] = ip;

    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;

    return false;
}

export function isAllowedRemoteHost(hostname: string, allowedHosts: Set<string>): boolean {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === 'localhost') return false;
    if (normalized === '::1') return false;
    if (normalized.endsWith('.local')) return false;
    if (isPrivateIpHost(normalized)) return false;

    for (const allowedHost of allowedHosts) {
        const allowed = allowedHost.trim().toLowerCase();
        if (!allowed) continue;
        if (allowed.startsWith('*.')) {
            const suffix = allowed.slice(2);
            if (normalized.endsWith(`.${suffix}`)) return true;
            continue;
        }
        if (normalized === allowed) return true;
    }

    return false;
}

export function buildAllowedRemoteHosts(options?: { requestUrl?: string; allowRequestHost?: boolean }): Set<string> {
    const allowedHosts = new Set(DEFAULT_ALLOWED_HOSTS);
    const raw = (process.env.TOKENS_IMAGE_PROXY_ALLOWED_HOSTS ?? '').trim();

    const apiOriginHost = parseApiOriginHostFromEnv();
    if (apiOriginHost) allowedHosts.add(apiOriginHost);

    if (raw) {
        const hosts = raw
            .split(',')
            .map(value => value.trim().toLowerCase())
            .filter(Boolean);

        for (const host of hosts) allowedHosts.add(host);
    }

    if (options?.allowRequestHost && options.requestUrl) {
        try {
            const requestHost = new URL(options.requestUrl).hostname.trim().toLowerCase();
            if (
                requestHost &&
                !isPrivateIpHost(requestHost) &&
                requestHost !== 'localhost' &&
                !requestHost.endsWith('.local')
            ) {
                allowedHosts.add(requestHost);
            }
        } catch {
            // Ignore malformed request URLs and fall back to env/default allowlist only.
        }
    }

    return allowedHosts;
}

export async function fetchWithValidatedRedirects(
    url: URL,
    init: RequestInit,
    allowedHosts: Set<string>,
    maxRedirects = 3,
): Promise<Response> {
    let current = url;

    for (let i = 0; i <= maxRedirects; i++) {
        if (!isAllowedRemoteHost(current.hostname, allowedHosts)) {
            throw new Error('Host not allowed');
        }

        const response = await fetch(current, { ...init, redirect: 'manual' });
        if (response.status < 300 || response.status >= 400) return response;

        const location = response.headers.get('location');
        if (!location) return response;
        current = new URL(location, current);
    }

    throw new Error('Too many redirects');
}
