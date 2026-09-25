/**
 * Recognise IPFS logo URL shapes so they can be served through our own
 * Pinata gateway instead of public gateways (which 429/403 everyone).
 * Ported from apps/cloudrun-assets/src/handlers/logoSource.ts; pure, no I/O.
 *
 *   ipfs://<cid>[/path]            ipfs://ipfs/<cid>[/path]
 *   https://<host>/ipfs/<cid>[/path][?q]   (public gateways and *.mypinata.cloud alike)
 *   https://<cid>.ipfs.<host>[/path]       (subdomain gateways)
 */

const CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_BASE32_RE = /^b[a-z2-7]{58,}$/i;
const CID_V1_BASE36_RE = /^k[a-z0-9]{50,}$/i;

/** Public IPFS gateways that rate-limit or block server/browser fetches. */
const PUBLIC_IPFS_GATEWAY_HOSTS: readonly string[] = [
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

export interface IpfsRef {
    cid: string;
    /** Sub-path after the CID including the leading slash, or '' (query/fragment dropped). */
    path: string;
}

export function isValidCid(value: string): boolean {
    return CID_V0_RE.test(value) || CID_V1_BASE32_RE.test(value) || CID_V1_BASE36_RE.test(value);
}

function normalizeSubPath(raw: string): string {
    const withoutQuery = raw.split(/[?#]/, 1)[0] ?? '';
    const trimmed = withoutQuery.replace(/\/+$/, '');
    if (!trimmed || trimmed === '/') return '';
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function isPublicIpfsGatewayHost(hostname: string): boolean {
    const host = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!host) return false;
    return PUBLIC_IPFS_GATEWAY_HOSTS.some(gateway => host === gateway || host.endsWith(`.${gateway}`));
}

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

/** Canonical `ipfs://<cid>[/path]` form, or null when `url` is not an IPFS reference. */
export function toIpfsUri(url: string): string | null {
    const ref = extractIpfsRef(url);
    return ref ? `ipfs://${ref.cid}${ref.path}` : null;
}

/**
 * Rewrites logo URLs that point at a public IPFS gateway (or a raw `ipfs://`
 * ref) to our image proxy, which fetches them through the dedicated Pinata
 * gateway. Dedicated third-party gateways (e.g. `*.mypinata.cloud`) are left
 * alone: they work and are not ours to proxy.
 */
export function proxiedIpfsLogoUrl(url: string): string | null {
    const trimmed = url.trim();
    if (!trimmed) return null;
    const isRawRef = /^ipfs:\/\//i.test(trimmed);
    let onPublicGateway = false;
    if (!isRawRef) {
        try {
            onPublicGateway = isPublicIpfsGatewayHost(new URL(trimmed).hostname);
        } catch {
            return null;
        }
    }
    if (!isRawRef && !onPublicGateway) return null;
    const uri = toIpfsUri(trimmed);
    return uri ? `/api/image-proxy?src=${encodeURIComponent(uri)}` : null;
}
