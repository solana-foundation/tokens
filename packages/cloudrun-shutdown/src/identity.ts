/**
 * Signed caller-identity token for `x-tokens-identity`.
 *
 * apps/app (Vercel) authenticates a dashboard user with Clerk and then calls
 * the usage service on the user's behalf. The service must know *which* user
 * the call acts as, and must not take that on faith from a header anyone
 * holding the shared bearer token could forge. So the identity travels as a
 * compact signed token:
 *
 *   base64url(JSON payload) "." base64url(HMAC-SHA256(secret, encodedPayload))
 *
 * The payload binds the identity to one RPC (`kind` + `fn`), to the exact
 * request body (`bodySha256`), and to a short validity window (`iat`/`exp`),
 * so a captured token cannot be replayed against another function, with
 * different arguments, or after 60 s.
 *
 * WebCrypto only (no `node:crypto`, no `Buffer`) so the same code signs on
 * Vercel and verifies on Cloud Run. Signature comparison goes through
 * `crypto.subtle.verify`, which is constant-time.
 *
 * Secret: TOKENS_IDENTITY_SIGNING_SECRET, held by the signer and the verifier
 * only. See docs/security/threat-model-api-keys.md.
 */

export const IDENTITY_HEADER = 'x-tokens-identity';

/** How long a freshly signed token is valid. */
export const IDENTITY_TOKEN_TTL_MS = 60_000;
/** Verifier rejects tokens whose `exp - iat` exceeds this (guards a buggy signer). */
export const IDENTITY_TOKEN_MAX_TTL_MS = 120_000;
/** Verifier tolerates `iat` this far in the future (clock skew between hosts). */
export const IDENTITY_TOKEN_CLOCK_SKEW_MS = 30_000;

export type IdentityRpcKind = 'query' | 'mutation';

export interface IdentityClaims {
    clerkUserId: string;
    projectId?: string;
    email?: string;
}

export interface IdentityBinding {
    kind: IdentityRpcKind;
    fn: string;
    /** The exact request body string as sent on the wire. */
    body: string;
}

export interface IdentityTokenPayload extends IdentityClaims {
    v: 1;
    kind: IdentityRpcKind;
    fn: string;
    bodySha256: string;
    iat: number;
    exp: number;
}

export type IdentityVerifyFailure =
    | 'malformed'
    | 'bad_signature'
    | 'invalid_claims'
    | 'expired'
    | 'not_yet_valid'
    | 'binding_mismatch';

export type IdentityVerifyResult =
    | { ok: true; identity: IdentityClaims; payload: IdentityTokenPayload }
    | { ok: false; reason: IdentityVerifyFailure };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncodeBytes(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeText(text: string): string {
    return base64UrlEncodeBytes(encoder.encode(text));
}

/** Returns null when the input is not valid base64url. */
function base64UrlDecodeBytes(value: string): Uint8Array<ArrayBuffer> | null {
    if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    let binary: string;
    try {
        binary = atob(padded);
    } catch {
        return null;
    }
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function toHex(bytes: Uint8Array): string {
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
}

export async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
    return toHex(new Uint8Array(digest));
}

async function importHmacKey(secret: string, usages: ('sign' | 'verify')[]): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

/**
 * Legacy (unsigned) identity headers are plain base64 JSON and never contain
 * a `.`; signed tokens always do. Used by the verifier during the migration
 * window to pick the decoding path.
 */
export function isSignedIdentityHeader(raw: string): boolean {
    return raw.includes('.');
}

export async function signIdentityToken(
    identity: IdentityClaims,
    binding: IdentityBinding,
    secret: string,
    nowMs: number = Date.now(),
): Promise<string> {
    if (!secret) throw new Error('signIdentityToken: secret is required');
    const clerkUserId = identity.clerkUserId.trim();
    if (!clerkUserId) throw new Error('signIdentityToken: clerkUserId is required');

    const payload: IdentityTokenPayload = {
        v: 1,
        clerkUserId,
        ...(identity.projectId?.trim() ? { projectId: identity.projectId.trim() } : {}),
        ...(identity.email?.trim() ? { email: identity.email.trim() } : {}),
        kind: binding.kind,
        fn: binding.fn,
        bodySha256: await sha256Hex(binding.body),
        iat: nowMs,
        exp: nowMs + IDENTITY_TOKEN_TTL_MS,
    };

    const encodedPayload = base64UrlEncodeText(JSON.stringify(payload));
    const key = await importHmacKey(secret, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(encodedPayload));
    return `${encodedPayload}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function parsePayload(decoded: unknown): IdentityTokenPayload | null {
    if (typeof decoded !== 'object' || decoded === null) return null;
    const obj = decoded as Record<string, unknown>;
    if (obj.v !== 1) return null;
    if (typeof obj.clerkUserId !== 'string' || !obj.clerkUserId.trim()) return null;
    if (obj.kind !== 'query' && obj.kind !== 'mutation') return null;
    if (typeof obj.fn !== 'string' || !obj.fn) return null;
    if (typeof obj.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(obj.bodySha256)) return null;
    if (!isFiniteNumber(obj.iat) || !isFiniteNumber(obj.exp)) return null;
    if (obj.projectId !== undefined && typeof obj.projectId !== 'string') return null;
    if (obj.email !== undefined && typeof obj.email !== 'string') return null;

    return {
        v: 1,
        clerkUserId: obj.clerkUserId.trim(),
        ...(typeof obj.projectId === 'string' && obj.projectId.trim() ? { projectId: obj.projectId.trim() } : {}),
        ...(typeof obj.email === 'string' && obj.email.trim() ? { email: obj.email.trim() } : {}),
        kind: obj.kind,
        fn: obj.fn,
        bodySha256: obj.bodySha256,
        iat: obj.iat,
        exp: obj.exp,
    };
}

function timingSafeEqualAscii(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export async function verifyIdentityToken(
    token: string,
    binding: IdentityBinding,
    secret: string,
    nowMs: number = Date.now(),
): Promise<IdentityVerifyResult> {
    // An empty secret must never verify anything.
    if (!secret) return { ok: false, reason: 'bad_signature' };

    const parts = token.trim().split('.');
    if (parts.length !== 2) return { ok: false, reason: 'malformed' };
    const [encodedPayload, encodedSignature] = parts as [string, string];
    if (!encodedPayload || !encodedSignature) return { ok: false, reason: 'malformed' };

    const signature = base64UrlDecodeBytes(encodedSignature);
    const payloadBytes = base64UrlDecodeBytes(encodedPayload);
    if (!signature || !payloadBytes) return { ok: false, reason: 'malformed' };

    // Verify before parsing so untrusted JSON is never interpreted.
    const key = await importHmacKey(secret, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(encodedPayload));
    if (!valid) return { ok: false, reason: 'bad_signature' };

    let decoded: unknown;
    try {
        decoded = JSON.parse(decoder.decode(payloadBytes));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    const payload = parsePayload(decoded);
    if (!payload) return { ok: false, reason: 'invalid_claims' };
    if (payload.exp <= payload.iat || payload.exp - payload.iat > IDENTITY_TOKEN_MAX_TTL_MS) {
        return { ok: false, reason: 'invalid_claims' };
    }

    if (payload.kind !== binding.kind || payload.fn !== binding.fn) {
        return { ok: false, reason: 'binding_mismatch' };
    }
    const expectedBodyHash = await sha256Hex(binding.body);
    if (!timingSafeEqualAscii(payload.bodySha256, expectedBodyHash)) {
        return { ok: false, reason: 'binding_mismatch' };
    }

    if (payload.iat > nowMs + IDENTITY_TOKEN_CLOCK_SKEW_MS) return { ok: false, reason: 'not_yet_valid' };
    if (payload.exp <= nowMs) return { ok: false, reason: 'expired' };

    const identity: IdentityClaims = {
        clerkUserId: payload.clerkUserId,
        ...(payload.projectId ? { projectId: payload.projectId } : {}),
        ...(payload.email ? { email: payload.email } : {}),
    };
    return { ok: true, identity, payload };
}
