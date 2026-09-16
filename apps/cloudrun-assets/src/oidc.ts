import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface VerifyOidcResult {
    sub: string;
    email: string | undefined;
    aud: string;
    iss: string;
}

export interface VerifyOidc {
    (token: string): Promise<VerifyOidcResult>;
}

export class OidcAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OidcAuthError';
    }
}

export interface MakeGoogleOidcVerifierOptions {
    audience?: string;
    /**
     * Service-account email(s) allowed to invoke. A single value may also be a
     * comma-separated list (so TOKENS_CRON_INVOKER_SA can pin the Scheduler SA
     * and the usage service's runtime SA, which forwards Webacy webhooks).
     */
    invokerEmail?: string;
    /** Additional allowed invoker emails; merged with `invokerEmail`. */
    invokerEmails?: readonly string[];
    jwksUrl?: string;
}

/**
 * Normalise one or more raw invoker values (each possibly comma-separated)
 * into a deduped, lower-cased list. Empty entries are dropped.
 */
export function parseInvokerEmails(...raw: Array<string | readonly string[] | undefined>): string[] {
    const out = new Set<string>();
    for (const value of raw) {
        if (!value) continue;
        const parts = typeof value === 'string' ? [value] : value;
        for (const part of parts) {
            for (const email of part.split(',')) {
                const trimmed = email.trim().toLowerCase();
                if (trimmed) out.add(trimmed);
            }
        }
    }
    return [...out];
}

export function makeGoogleOidcVerifier(opts: MakeGoogleOidcVerifierOptions = {}): VerifyOidc {
    const audience = opts.audience?.trim() || undefined;
    const invokerEmails = parseInvokerEmails(opts.invokerEmail, opts.invokerEmails);
    if (!audience && invokerEmails.length === 0) {
        throw new Error(
            'makeGoogleOidcVerifier requires at least one of `audience` or `invokerEmail` to pin token acceptance; refusing to verify with only the Google issuer (any Google identity would pass).',
        );
    }
    const jwks = createRemoteJWKSet(new URL(opts.jwksUrl ?? GOOGLE_JWKS_URL));
    return async token => {
        let payload: JWTPayload;
        try {
            const verified = await jwtVerify(token, jwks, {
                issuer: GOOGLE_ISSUER,
                ...(audience ? { audience } : {}),
            });
            payload = verified.payload;
        } catch (err) {
            throw new OidcAuthError(`OIDC verification failed: ${(err as Error).message}`);
        }
        const aud = typeof payload.aud === 'string' ? payload.aud : '';
        const iss = typeof payload.iss === 'string' ? payload.iss : '';
        const sub = typeof payload.sub === 'string' ? payload.sub : '';
        const email = typeof payload.email === 'string' ? payload.email : undefined;
        if (invokerEmails.length > 0 && (!email || !invokerEmails.includes(email.toLowerCase()))) {
            throw new OidcAuthError('OIDC token email does not match expected invoker');
        }
        return { sub, email, aud, iss };
    };
}

export function parseBearer(authHeader: string | undefined | null): string | null {
    if (!authHeader) return null;
    const m = /^Bearer\s+(\S+)$/i.exec(authHeader);
    return m ? (m[1] ?? null) : null;
}
