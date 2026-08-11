export interface PlaygroundProxyAuthPayload {
    apiKeyId: string;
    keyPrefix: string;
    projectId: string;
    ownerClerkUserId: string;
    scopes: string[];
    limits?: {
        rateLimit?: { requests: number; windowSeconds: number };
        quota?: { requestsPerMonth: number };
    };
    iat: number;
    exp: number;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

function base64UrlEncodeText(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecodeText(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
}

function timingSafeEqualString(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

function getPlaygroundProxySecret(): string | null {
    const secret = (process.env.TOKENS_PLAYGROUND_PROXY_SECRET ?? '').trim();
    return secret || null;
}

async function hmacSha256Base64Url(value: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
    return base64UrlEncodeBytes(new Uint8Array(signature));
}

function parsePayload(value: unknown): PlaygroundProxyAuthPayload | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;

    if (typeof record.apiKeyId !== 'string') return null;
    if (typeof record.keyPrefix !== 'string') return null;
    if (typeof record.projectId !== 'string') return null;
    if (typeof record.ownerClerkUserId !== 'string') return null;
    if (!Array.isArray(record.scopes) || !record.scopes.every(scope => typeof scope === 'string')) return null;
    if (typeof record.iat !== 'number' || !Number.isFinite(record.iat)) return null;
    if (typeof record.exp !== 'number' || !Number.isFinite(record.exp)) return null;

    const limits = record.limits as PlaygroundProxyAuthPayload['limits'] | undefined;

    return {
        apiKeyId: record.apiKeyId,
        keyPrefix: record.keyPrefix,
        projectId: record.projectId,
        ownerClerkUserId: record.ownerClerkUserId,
        scopes: record.scopes,
        ...(limits ? { limits } : {}),
        iat: record.iat,
        exp: record.exp,
    };
}

export async function signPlaygroundProxyAuthPayload(payload: PlaygroundProxyAuthPayload): Promise<string> {
    const secret = getPlaygroundProxySecret();
    if (!secret) throw new Error('TOKENS_PLAYGROUND_PROXY_SECRET is required');

    const encodedPayload = base64UrlEncodeText(JSON.stringify(payload));
    const signature = await hmacSha256Base64Url(encodedPayload, secret);
    return `${encodedPayload}.${signature}`;
}

export async function verifyPlaygroundProxyAuthHeader(headerValue: string | null): Promise<PlaygroundProxyAuthPayload | null> {
    const token = (headerValue ?? '').trim();
    if (!token) return null;

    const secret = getPlaygroundProxySecret();
    if (!secret) return null;

    const [encodedPayload, signature, extra] = token.split('.');
    if (!encodedPayload || !signature || extra !== undefined) return null;

    const expected = await hmacSha256Base64Url(encodedPayload, secret);
    if (!timingSafeEqualString(signature, expected)) return null;

    let decoded: unknown;
    try {
        decoded = JSON.parse(base64UrlDecodeText(encodedPayload));
    } catch {
        return null;
    }

    const payload = parsePayload(decoded);
    if (!payload) return null;
    if (payload.exp < Date.now()) return null;
    return payload;
}
import { timingSafeEqual } from 'node:crypto';
