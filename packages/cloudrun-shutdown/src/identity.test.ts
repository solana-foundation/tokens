import { describe, expect, it } from 'bun:test';

import {
    IDENTITY_TOKEN_MAX_TTL_MS,
    IDENTITY_TOKEN_TTL_MS,
    isSignedIdentityHeader,
    sha256Hex,
    signIdentityToken,
    verifyIdentityToken,
    type IdentityBinding,
    type IdentityClaims,
} from './identity';

const SECRET = 'test-identity-signing-secret';
const NOW = 1_700_000_000_000;
const identity: IdentityClaims = { clerkUserId: 'user_1', projectId: 'proj_1', email: 'a@b.co' };
const binding: IdentityBinding = { kind: 'query', fn: 'usersGetMe', body: '{"projectId":"proj_1"}' };

function base64UrlEncode(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64url');
}

function base64UrlDecode(text: string): string {
    return Buffer.from(text, 'base64url').toString('utf8');
}

/** Re-sign an arbitrary payload object so claim-validation paths can be exercised. */
async function signRaw(payload: Record<string, unknown>, secret = SECRET): Promise<string> {
    const encoded = base64UrlEncode(JSON.stringify(payload));
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
    return `${encoded}.${Buffer.from(sig).toString('base64url')}`;
}

async function validPayload(): Promise<Record<string, unknown>> {
    return {
        v: 1,
        ...identity,
        kind: binding.kind,
        fn: binding.fn,
        bodySha256: await sha256Hex(binding.body),
        iat: NOW,
        exp: NOW + IDENTITY_TOKEN_TTL_MS,
    };
}

describe('signIdentityToken / verifyIdentityToken', () => {
    it('round-trips the claims and binding', async () => {
        const token = await signIdentityToken(identity, binding, SECRET, NOW);
        const result = await verifyIdentityToken(token, binding, SECRET, NOW + 1_000);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.identity).toEqual(identity);
        expect(result.payload.kind).toBe('query');
        expect(result.payload.fn).toBe('usersGetMe');
        expect(result.payload.iat).toBe(NOW);
        expect(result.payload.exp).toBe(NOW + IDENTITY_TOKEN_TTL_MS);
    });

    it('omits optional claims that are absent or blank', async () => {
        const token = await signIdentityToken({ clerkUserId: ' user_2 ', email: '  ' }, binding, SECRET, NOW);
        const result = await verifyIdentityToken(token, binding, SECRET, NOW);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.identity).toEqual({ clerkUserId: 'user_2' });
    });

    it('rejects a tampered payload', async () => {
        const token = await signIdentityToken(identity, binding, SECRET, NOW);
        const [payload, sig] = token.split('.') as [string, string];
        const forged = base64UrlEncode(base64UrlDecode(payload).replace('user_1', 'user_9'));
        const result = await verifyIdentityToken(`${forged}.${sig}`, binding, SECRET, NOW);
        expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects a tampered signature', async () => {
        const token = await signIdentityToken(identity, binding, SECRET, NOW);
        const [payload, sig] = token.split('.') as [string, string];
        const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
        const result = await verifyIdentityToken(`${payload}.${flipped}`, binding, SECRET, NOW);
        expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects a token signed with a different secret', async () => {
        const token = await signIdentityToken(identity, binding, 'other-secret', NOW);
        const result = await verifyIdentityToken(token, binding, SECRET, NOW);
        expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects an expired token', async () => {
        const token = await signIdentityToken(identity, binding, SECRET, NOW);
        const result = await verifyIdentityToken(token, binding, SECRET, NOW + IDENTITY_TOKEN_TTL_MS + 1);
        expect(result).toEqual({ ok: false, reason: 'expired' });
    });

    it('accepts a token up to the clock-skew allowance and rejects beyond it', async () => {
        const token = await signIdentityToken(identity, binding, SECRET, NOW);
        expect((await verifyIdentityToken(token, binding, SECRET, NOW - 29_000)).ok).toBe(true);
        expect(await verifyIdentityToken(token, binding, SECRET, NOW - 31_000)).toEqual({
            ok: false,
            reason: 'not_yet_valid',
        });
    });

    it('rejects a validity window longer than the maximum', async () => {
        const token = await signRaw({ ...(await validPayload()), exp: NOW + IDENTITY_TOKEN_MAX_TTL_MS + 1 });
        expect(await verifyIdentityToken(token, binding, SECRET, NOW)).toEqual({
            ok: false,
            reason: 'invalid_claims',
        });
    });

    it('rejects exp <= iat', async () => {
        const token = await signRaw({ ...(await validPayload()), exp: NOW });
        expect(await verifyIdentityToken(token, binding, SECRET, NOW)).toEqual({
            ok: false,
            reason: 'invalid_claims',
        });
    });

    it('rejects a token presented to a different function, kind, or body', async () => {
        const token = await signIdentityToken(identity, binding, SECRET, NOW);
        expect(await verifyIdentityToken(token, { ...binding, fn: 'usersDeleteProject' }, SECRET, NOW)).toEqual({
            ok: false,
            reason: 'binding_mismatch',
        });
        expect(await verifyIdentityToken(token, { ...binding, kind: 'mutation' }, SECRET, NOW)).toEqual({
            ok: false,
            reason: 'binding_mismatch',
        });
        expect(await verifyIdentityToken(token, { ...binding, body: '{"projectId":"proj_2"}' }, SECRET, NOW)).toEqual({
            ok: false,
            reason: 'binding_mismatch',
        });
    });

    it('rejects malformed tokens', async () => {
        const legacy = Buffer.from(JSON.stringify(identity), 'utf8').toString('base64');
        expect(await verifyIdentityToken(legacy, binding, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
        expect(await verifyIdentityToken('a.b.c', binding, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
        expect(await verifyIdentityToken('.', binding, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
        expect(await verifyIdentityToken('not+base64url.sig', binding, SECRET, NOW)).toEqual({
            ok: false,
            reason: 'malformed',
        });
        expect(await verifyIdentityToken('', binding, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('rejects a correctly signed payload that is not JSON', async () => {
        const encoded = base64UrlEncode('not json');
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(SECRET),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
        const token = `${encoded}.${Buffer.from(sig).toString('base64url')}`;
        expect(await verifyIdentityToken(token, binding, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('rejects signed payloads with invalid claims', async () => {
        const base = await validPayload();
        const cases: Record<string, unknown>[] = [
            { ...base, v: 2 },
            { ...base, clerkUserId: '' },
            { ...base, kind: 'job' },
            { ...base, fn: '' },
            { ...base, bodySha256: 'nope' },
            { ...base, iat: 'now' },
            { ...base, projectId: 42 },
        ];
        for (const payload of cases) {
            const token = await signRaw(payload);
            expect(await verifyIdentityToken(token, binding, SECRET, NOW)).toEqual({
                ok: false,
                reason: 'invalid_claims',
            });
        }
    });

    it('never signs or verifies with an empty secret', async () => {
        await expect(signIdentityToken(identity, binding, '', NOW)).rejects.toThrow('secret is required');
        const token = await signIdentityToken(identity, binding, SECRET, NOW);
        expect(await verifyIdentityToken(token, binding, '', NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('refuses to sign without a clerkUserId', async () => {
        await expect(signIdentityToken({ clerkUserId: '  ' }, binding, SECRET, NOW)).rejects.toThrow(
            'clerkUserId is required',
        );
    });
});

describe('isSignedIdentityHeader', () => {
    it('distinguishes signed tokens from legacy base64 JSON', async () => {
        const token = await signIdentityToken(identity, binding, SECRET, NOW);
        expect(isSignedIdentityHeader(token)).toBe(true);
        const legacy = Buffer.from(JSON.stringify(identity), 'utf8').toString('base64');
        expect(isSignedIdentityHeader(legacy)).toBe(false);
    });
});

describe('sha256Hex', () => {
    it('matches the known digest of an empty string', async () => {
        expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
});
