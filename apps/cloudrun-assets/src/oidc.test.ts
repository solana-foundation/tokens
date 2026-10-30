/**
 * Verifier tests against a locally served JWKS: tokens are RS256-signed with a
 * key generated per run, so issuer/audience/email pinning is exercised through
 * the real jose path rather than a mocked verify.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';

import { GOOGLE_ISSUER, makeGoogleOidcVerifier, OidcAuthError, parseBearer, parseInvokerEmails } from './oidc';

const AUDIENCE = 'https://tokens-assets-jobs-prd-us-abc123-uk.a.run.app';
const SCHEDULER_SA = 'tokens-scheduler-prd@tokens-498908.iam.gserviceaccount.com';
const RUNTIME_SA = 'tokens-cloud-run-runtime-prd@tokens-498908.iam.gserviceaccount.com';

let privateKey: KeyLike;
let server: ReturnType<typeof Bun.serve>;
let jwksUrl: string;

beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    server = Bun.serve({
        port: 0,
        fetch: () => Response.json({ keys: [jwk] }),
    });
    jwksUrl = `http://127.0.0.1:${server.port}/certs`;
});

afterAll(() => {
    server.stop(true);
});

async function sign(claims: { email?: string; aud?: string; iss?: string }): Promise<string> {
    const jwt = new SignJWT({ ...(claims.email ? { email: claims.email, email_verified: true } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(claims.iss ?? GOOGLE_ISSUER)
        .setAudience(claims.aud ?? AUDIENCE)
        .setSubject('1234567890')
        .setIssuedAt()
        .setExpirationTime('5m');
    return jwt.sign(privateKey);
}

describe('parseInvokerEmails', () => {
    it('splits comma-separated values, trims, lower-cases, dedupes, and drops empties', () => {
        expect(parseInvokerEmails(` ${SCHEDULER_SA}, ${RUNTIME_SA.toUpperCase()} ,,`, [RUNTIME_SA, ''])).toEqual([
            SCHEDULER_SA,
            RUNTIME_SA,
        ]);
        expect(parseInvokerEmails(undefined, undefined)).toEqual([]);
        expect(parseInvokerEmails('   ')).toEqual([]);
    });
});

describe('makeGoogleOidcVerifier', () => {
    it('refuses to build with neither an audience nor an invoker pin', () => {
        expect(() => makeGoogleOidcVerifier({})).toThrow(/requires at least one/);
        expect(() => makeGoogleOidcVerifier({ invokerEmail: ' , ' })).toThrow(/requires at least one/);
    });

    it('keeps the single-email option working', async () => {
        const verify = makeGoogleOidcVerifier({ audience: AUDIENCE, invokerEmail: SCHEDULER_SA, jwksUrl });
        const result = await verify(await sign({ email: SCHEDULER_SA }));
        expect(result).toEqual({ sub: '1234567890', email: SCHEDULER_SA, aud: AUDIENCE, iss: GOOGLE_ISSUER });
        await expect(verify(await sign({ email: RUNTIME_SA }))).rejects.toBeInstanceOf(OidcAuthError);
    });

    it('accepts any email in a comma-separated invokerEmail (TOKENS_CRON_INVOKER_SA) value', async () => {
        const verify = makeGoogleOidcVerifier({
            audience: AUDIENCE,
            invokerEmail: `${SCHEDULER_SA},${RUNTIME_SA}`,
            jwksUrl,
        });
        expect((await verify(await sign({ email: SCHEDULER_SA }))).email).toBe(SCHEDULER_SA);
        expect((await verify(await sign({ email: RUNTIME_SA }))).email).toBe(RUNTIME_SA);
        await expect(verify(await sign({ email: 'someone-else@example.com' }))).rejects.toThrow(
            /does not match expected invoker/,
        );
    });

    it('merges invokerEmails with invokerEmail and compares case-insensitively', async () => {
        const verify = makeGoogleOidcVerifier({
            invokerEmail: SCHEDULER_SA,
            invokerEmails: [RUNTIME_SA.toUpperCase()],
            jwksUrl,
        });
        expect((await verify(await sign({ email: RUNTIME_SA }))).email).toBe(RUNTIME_SA);
        expect((await verify(await sign({ email: SCHEDULER_SA }))).email).toBe(SCHEDULER_SA);
    });

    it('rejects a token without an email claim when an invoker pin is set', async () => {
        const verify = makeGoogleOidcVerifier({ audience: AUDIENCE, invokerEmail: SCHEDULER_SA, jwksUrl });
        await expect(verify(await sign({}))).rejects.toThrow(/does not match expected invoker/);
    });

    it('still enforces the audience and issuer pins', async () => {
        const verify = makeGoogleOidcVerifier({ audience: AUDIENCE, invokerEmail: SCHEDULER_SA, jwksUrl });
        await expect(verify(await sign({ email: SCHEDULER_SA, aud: 'https://other.example' }))).rejects.toThrow(
            /OIDC verification failed/,
        );
        await expect(verify(await sign({ email: SCHEDULER_SA, iss: 'https://evil.example' }))).rejects.toThrow(
            /OIDC verification failed/,
        );
    });

    it('accepts any Google identity for the audience when no invoker pin is given', async () => {
        const verify = makeGoogleOidcVerifier({ audience: AUDIENCE, jwksUrl });
        expect((await verify(await sign({ email: 'anyone@example.com' }))).aud).toBe(AUDIENCE);
        expect((await verify(await sign({}))).email).toBeUndefined();
    });
});

describe('parseBearer', () => {
    it('extracts the token from a Bearer header and rejects other shapes', () => {
        expect(parseBearer('Bearer abc.def')).toBe('abc.def');
        expect(parseBearer('bearer abc')).toBe('abc');
        expect(parseBearer('Basic abc')).toBeNull();
        expect(parseBearer(undefined)).toBeNull();
        expect(parseBearer('Bearer')).toBeNull();
    });
});
