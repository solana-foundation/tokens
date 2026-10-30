/**
 * Prefer the first-party copy of a token logo (`mint_logos.logo_cdn_url`,
 * resolved into every logo-bearing SELECT as `logo_cdn_url`) over the raw
 * upstream `logo_uri`. Every handler that emits `logoURI` / `logoUri` goes
 * through here so the API contract stays a single nullable string.
 */
export interface LogoUriRow {
    logo_uri: string | null;
    /** Optional so row fixtures built before the column existed keep compiling. */
    logo_cdn_url?: string | null;
}

export function resolveLogoUri(row: LogoUriRow): string | null {
    const cdn = typeof row.logo_cdn_url === 'string' ? row.logo_cdn_url.trim() : '';
    if (cdn) return cdn;
    const raw = typeof row.logo_uri === 'string' ? row.logo_uri.trim() : '';
    return raw ? raw : null;
}
