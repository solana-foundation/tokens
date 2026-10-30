/**
 * Pure helpers for the logo-sync job: recognise IPFS URL shapes, decide which
 * hosts are unusable public gateways, and build the ordered fetch plan for a
 * mint. No I/O here so every branch is unit-testable.
 */

/**
 * Public IPFS gateways. Measured 2026-09-22: ipfs.io / dweb.link / w3s.link /
 * nftstorage.link are one Cloudflare front returning 429 (Retry-After: 900) to
 * servers and 403 to browser user agents, so they are never fetched directly.
 * Matched exactly or as a `*.host` suffix (`<cid>.ipfs.dweb.link`).
 */
export const PUBLIC_IPFS_GATEWAY_HOSTS: readonly string[] = [
    'ipfs.io',
    'gateway.ipfs.io',
    'dweb.link',
    'w3s.link',
    'nftstorage.link',
    'cf-ipfs.com',
    'cloudflare-ipfs.com',
    'gateway.pinata.cloud',
    'ipfs.infura.io',
    '4everland.io',
    'ipfs.fleek.co',
    'ipfs.filebase.io',
];

/** Hosts whose logo paths are already ours; never re-hosted. */
const FIRST_PARTY_HOSTS: readonly string[] = ['tokens.xyz', 'www.tokens.xyz', 'api.tokens.xyz', 'token.solana.com'];

const DEFAULT_GCS_BUCKET_PREFIX = 'https://storage.googleapis.com/tokens-asset-logos-';

export const DEXSCREENER_LOGO_URL_TEMPLATE = 'https://dd.dexscreener.com/ds-data/tokens/solana/{mint}.png';
/**
 * "Jupiter static": Jupiter has no per-mint static image URL, so the fallback
 * is a token-API lookup whose `icon` field is then fetched through the same
 * origin/pinata rules. Overridable via `JUPITER_TOKEN_API_URL` (`{mint}` placeholder).
 */
export const DEFAULT_JUPITER_TOKEN_API_URL = 'https://lite-api.jup.ag/tokens/v2/search?query={mint}';

const CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_BASE32_RE = /^b[a-z2-7]{58,}$/i;
const CID_V1_BASE36_RE = /^k[a-z0-9]{50,}$/i;

export function isValidCid(value: string): boolean {
    return CID_V0_RE.test(value) || CID_V1_BASE32_RE.test(value) || CID_V1_BASE36_RE.test(value);
}

export function isPublicGatewayHost(hostname: string): boolean {
    const host = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!host) return false;
    for (const gateway of PUBLIC_IPFS_GATEWAY_HOSTS) {
        if (host === gateway || host.endsWith(`.${gateway}`)) return true;
    }
    return false;
}

export interface IpfsRef {
    cid: string;
    /** Sub-path after the CID including the leading slash, or '' (query/fragment dropped). */
    path: string;
}

function normalizeSubPath(raw: string): string {
    const withoutQuery = raw.split(/[?#]/, 1)[0] ?? '';
    const trimmed = withoutQuery.replace(/\/+$/, '');
    if (!trimmed || trimmed === '/') return '';
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Recognise every IPFS URL shape we have seen in registry data:
 *   ipfs://<cid>[/path]            ipfs://ipfs/<cid>[/path]
 *   https://<host>/ipfs/<cid>[/path][?q]   (public gateways and *.mypinata.cloud alike)
 *   https://<cid>.ipfs.<host>[/path]       (subdomain gateways)
 */
export function extractIpfsRef(url: string): IpfsRef | null {
    const trimmed = url.trim();
    if (!trimmed) return null;

    if (/^ipfs:\/\//i.test(trimmed)) {
        let rest = trimmed.slice('ipfs://'.length).replace(/^\/+/, '');
        if (/^ipfs\//i.test(rest)) rest = rest.slice('ipfs/'.length);
        const slash = rest.search(/[/?#]/);
        const cid = slash === -1 ? rest : rest.slice(0, slash);
        const path = slash === -1 ? '' : normalizeSubPath(rest.slice(slash));
        return isValidCid(cid) ? { cid, path } : null;
    }

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

    const pathMatch = parsed.pathname.match(/^\/ipfs\/([^/?#]+)(\/.*)?$/);
    if (pathMatch?.[1] && isValidCid(pathMatch[1])) {
        return { cid: pathMatch[1], path: normalizeSubPath(pathMatch[2] ?? '') };
    }

    const host = parsed.hostname.toLowerCase();
    const subdomainMatch = host.match(/^([a-z0-9]+)\.ipfs\./);
    if (subdomainMatch?.[1] && isValidCid(subdomainMatch[1])) {
        return { cid: subdomainMatch[1], path: normalizeSubPath(parsed.pathname) };
    }

    return null;
}

export function isIpfsSourceUrl(url: string): boolean {
    return extractIpfsRef(url) !== null;
}

/**
 * True for URLs that are already first-party (local `/logos/...` overrides,
 * our own hosts, the GCS logo bucket). These must reach apps/api unrewritten:
 * `v1/assets/trending` infers xStock symbols from `/logos/xstocks/<sym>.png`.
 */
export function isFirstPartyLogoUrl(url: string, publicBaseUrl?: string): boolean {
    const trimmed = url.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('/')) return true;
    if (publicBaseUrl && trimmed.startsWith(publicBaseUrl.replace(/\/$/, ''))) return true;
    if (trimmed.startsWith(DEFAULT_GCS_BUCKET_PREFIX)) return true;
    try {
        const parsed = new URL(trimmed);
        const host = parsed.hostname.toLowerCase();
        return FIRST_PARTY_HOSTS.includes(host);
    } catch {
        return false;
    }
}

export type LogoSourceKind = 'pinata' | 'origin' | 'dexscreener' | 'jupiter';

export type FetchAttempt =
    | { source: 'pinata' | 'origin' | 'dexscreener'; url: string; headers: Record<string, string> }
    /** Two-step: GET lookupUrl (JSON), take `icon`, then fetch that through direct rules. */
    | { source: 'jupiter'; lookupUrl: string };

export interface FetchPlanConfig {
    pinataGatewayHost?: string | undefined;
    pinataGatewayToken?: string | undefined;
    jupiterTokenApiUrl?: string | undefined;
}

function pinataAttempt(ref: IpfsRef, cfg: FetchPlanConfig): FetchAttempt | null {
    const host = cfg.pinataGatewayHost?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!host) return null;
    const headers: Record<string, string> = {};
    const token = cfg.pinataGatewayToken?.trim();
    if (token) headers['x-pinata-gateway-token'] = token;
    return { source: 'pinata', url: `https://${host}/ipfs/${ref.cid}${ref.path}`, headers };
}

/**
 * Attempts that fetch `url` itself: our Pinata gateway when it is an IPFS
 * reference, then the URL as given unless its host is a public gateway.
 * Dedicated `*.mypinata.cloud` hosts count as origin (tried after ours).
 */
export function buildDirectAttempts(url: string, cfg: FetchPlanConfig): FetchAttempt[] {
    const out: FetchAttempt[] = [];
    const trimmed = url.trim();
    const ref = extractIpfsRef(trimmed);
    if (ref) {
        const pinata = pinataAttempt(ref, cfg);
        if (pinata) out.push(pinata);
    }
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            if (!isPublicGatewayHost(parsed.hostname)) out.push({ source: 'origin', url: trimmed, headers: {} });
        } catch {
            // unparsable URL: no origin attempt
        }
    }
    return out;
}

export function buildFetchPlan(mint: string, sourceUrl: string, cfg: FetchPlanConfig): FetchAttempt[] {
    const out = buildDirectAttempts(sourceUrl, cfg);
    out.push({
        source: 'dexscreener',
        url: DEXSCREENER_LOGO_URL_TEMPLATE.replace('{mint}', encodeURIComponent(mint)),
        headers: {},
    });
    const template = cfg.jupiterTokenApiUrl?.trim() || DEFAULT_JUPITER_TOKEN_API_URL;
    out.push({ source: 'jupiter', lookupUrl: template.replace('{mint}', encodeURIComponent(mint)) });
    return out;
}

/** `icon` of the first entry whose address matches `mint` in a Jupiter token-API payload. */
export function extractJupiterIcon(payload: unknown, mint: string): string | null {
    const list: unknown[] = Array.isArray(payload)
        ? payload
        : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
          ? ((payload as { data: unknown[] }).data)
          : payload && typeof payload === 'object'
            ? [payload]
            : [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const address = typeof rec.id === 'string' ? rec.id : typeof rec.address === 'string' ? rec.address : null;
        if (address !== null && address !== mint) continue;
        const icon = typeof rec.icon === 'string' ? rec.icon : typeof rec.logoURI === 'string' ? rec.logoURI : null;
        if (icon && icon.trim()) return icon.trim();
    }
    return null;
}

export async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
