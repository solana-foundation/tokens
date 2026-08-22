import 'server-only';

import { auth } from '@clerk/nextjs/server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { callCloudRunUsage } from '@/lib/cloudrun';

const LOCAL_API_BASE_URL = 'http://localhost:3002';
const PLAYGROUND_AUTH_TTL_MS = 60_000;

function logProxyError(message: string, error?: unknown) {
    console.error(message, error);
}

function coerceBaseUrl(value: string): string | null {
    const trimmed = value.trim().replace(/\/$/, '');
    if (!trimmed) return null;

    const hasScheme = /^https?:\/\//i.test(trimmed);
    const withScheme = hasScheme
        ? trimmed
        : trimmed.startsWith('localhost') || trimmed.startsWith('127.0.0.1')
          ? `http://${trimmed}`
          : `https://${trimmed}`;

    try {
        // Ensure it’s a valid absolute URL.
        // We keep any path prefix if present.
        return new URL(withScheme).toString().replace(/\/$/, '');
    } catch {
        return null;
    }
}

function getApiBaseUrl(_requestUrl: string): string | null {
    const raw =
        process.env.API_BASE_URL?.trim() ??
        process.env.TOKENS_API_ORIGIN?.trim() ??
        process.env.TOKENS_API_BASE_URL?.trim() ??
        process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ??
        '';

    if (raw) return coerceBaseUrl(raw);

    if (process.env.NODE_ENV !== 'production') return LOCAL_API_BASE_URL;

    return null;
}

export type PlaygroundProxyVersion = 'v1' | 'v2';

function buildTargetUrl(
    baseUrl: string,
    requestUrl: string,
    pathParts: string[],
    version: PlaygroundProxyVersion,
): URL {
    const incoming = new URL(requestUrl);
    const target = new URL(`/api/${version}/${pathParts.join('/')}`, baseUrl);
    target.search = incoming.search;
    return target;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

function base64UrlEncodeText(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
}

function getPlaygroundProxySecret(): string | null {
    const secret = (process.env.TOKENS_PLAYGROUND_PROXY_SECRET ?? '').trim();
    return secret || null;
}

function getSessionEmail(session: Awaited<ReturnType<typeof auth>>): string | undefined {
    const claims = session.sessionClaims as Record<string, unknown> | null | undefined;
    const raw = claims?.email ?? claims?.primary_email ?? claims?.primaryEmail;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
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

async function signPlaygroundAuthPayload(payload: Record<string, unknown>): Promise<string> {
    const secret = getPlaygroundProxySecret();
    if (!secret) throw new Error('TOKENS_PLAYGROUND_PROXY_SECRET is required');

    const encodedPayload = base64UrlEncodeText(JSON.stringify(payload));
    const signature = await hmacSha256Base64Url(encodedPayload, secret);
    return `${encodedPayload}.${signature}`;
}

async function buildPlaygroundAuthHeaders(request: Request): Promise<Headers | null | Response> {
    if (request.headers.get('x-api-key')?.trim()) return null;

    const projectId = request.headers.get('x-tokens-playground-project-id')?.trim() ?? '';
    const apiKeyId = request.headers.get('x-tokens-playground-api-key-id')?.trim() ?? '';
    if (!projectId || !apiKeyId) return null;

    const session = await auth();
    if (!session.userId) {
        return NextResponse.json({ error: { message: 'Unauthorized' } }, { status: 401 });
    }

    const secret = getPlaygroundProxySecret();
    if (!secret) {
        return NextResponse.json({ error: { message: 'Playground proxy auth is not configured' } }, { status: 500 });
    }

    type RevealResult =
        | { status: 'ok'; apiKeyId: string; rawKey: string; keyPreview: string }
        | { status: 'unavailable'; reason: 'legacy' | 'inactive' | 'not_found' };
    type PlaygroundAuthContext = {
        apiKeyId: string;
        keyPrefix: string;
        projectId: string;
        ownerClerkUserId: string;
        scopes: string[];
        limits?: unknown;
    } | null;

    let reveal: RevealResult;
    let authContext: PlaygroundAuthContext;
    const email = getSessionEmail(session);
    try {
        const identity = {
            clerkUserId: session.userId,
            projectId,
            ...(email ? { email } : {}),
        };
        reveal = await callCloudRunUsage<RevealResult>('query', 'apiKeysReveal', { projectId, apiKeyId }, identity);
        authContext = await callCloudRunUsage<PlaygroundAuthContext>(
            'query',
            'apiKeysGetPlaygroundAuthContext',
            { projectId, apiKeyId },
            identity,
        );
    } catch (error) {
        logProxyError('Dashboard API proxy failed to authorize playground request', error);
        return NextResponse.json({ error: { message: 'Playground API key is unavailable' } }, { status: 403 });
    }

    const headers = new Headers();
    if (reveal.status === 'ok') {
        headers.set('x-api-key', reveal.rawKey);
        return headers;
    }

    if (!authContext) {
        return NextResponse.json({ error: { message: 'Active API key unavailable' } }, { status: 403 });
    }

    const now = Date.now();
    const signed = await signPlaygroundAuthPayload({
        apiKeyId: authContext.apiKeyId,
        keyPrefix: authContext.keyPrefix,
        projectId: authContext.projectId,
        ownerClerkUserId: authContext.ownerClerkUserId,
        scopes: authContext.scopes,
        ...(authContext.limits ? { limits: authContext.limits } : {}),
        iat: now,
        exp: now + PLAYGROUND_AUTH_TTL_MS,
    });
    headers.set('x-tokens-playground-auth', signed);
    return headers;
}

function buildForwardHeaders(request: Request, playgroundHeaders?: Headers | null): Headers {
    const headers = new Headers();

    const accept = request.headers.get('accept');
    if (accept) headers.set('accept', accept);

    const contentType = request.headers.get('content-type');
    if (contentType) headers.set('content-type', contentType);

    const apiKey = request.headers.get('x-api-key');
    if (apiKey) headers.set('x-api-key', apiKey);

    if (playgroundHeaders) {
        for (const [key, value] of playgroundHeaders) headers.set(key, value);
    }

    const requestId = request.headers.get('x-request-id');
    if (requestId) headers.set('x-request-id', requestId);

    return headers;
}

function stripUnsupportedUpstreamHeaders(headers: Headers): void {
    // Next.js uses `x-middleware-*` headers internally; forwarding them through an app route
    // can cause runtime errors (e.g. "NextResponse.rewrite() was used in a app route handler").
    for (const [key] of headers) {
        if (key.toLowerCase().startsWith('x-middleware-')) headers.delete(key);
    }
}

function stripProxyUnsafeResponseHeaders(headers: Headers): void {
    // Node fetch auto-decompresses (gzip/br) but preserves `content-encoding` headers,
    // which will make browsers try to decode twice when proxying.
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    headers.delete('connection');
}

async function proxy(
    version: PlaygroundProxyVersion,
    request: NextRequest,
    ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
    const { path } = await ctx.params;
    const baseUrl = getApiBaseUrl(request.url);
    if (!baseUrl) {
        logProxyError('Dashboard API proxy is not configured', {
            pathname: new URL(request.url).pathname,
            expectedEnv: ['API_BASE_URL', 'TOKENS_API_ORIGIN', 'TOKENS_API_BASE_URL', 'NEXT_PUBLIC_API_BASE_URL'],
        });
        return NextResponse.json(
            {
                error: {
                    _tag: 'MissingEnvError',
                    message: 'API proxy is not configured',
                    details: {
                        requiredAny: [
                            'API_BASE_URL',
                            'TOKENS_API_ORIGIN',
                            'TOKENS_API_BASE_URL',
                            'NEXT_PUBLIC_API_BASE_URL',
                        ],
                    },
                },
            },
            { status: 500 },
        );
    }

    const targetUrl = buildTargetUrl(baseUrl, request.url, path, version);
    const playgroundHeaders = await buildPlaygroundAuthHeaders(request);
    if (playgroundHeaders instanceof Response) return playgroundHeaders;

    const method = request.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';

    const upstreamInit: RequestInit & { duplex?: 'half' } = {
        method,
        headers: buildForwardHeaders(request, playgroundHeaders),
        body: hasBody ? request.body : undefined,
        redirect: 'manual',
        ...(hasBody && request.body ? { duplex: 'half' as const } : {}),
    };

    let upstream: Response;
    try {
        upstream = await fetch(targetUrl, upstreamInit);
    } catch (error) {
        logProxyError('Dashboard API proxy failed to reach upstream', error);
        return NextResponse.json(
            {
                error: {
                    message: 'Upstream API is unavailable',
                },
            },
            { status: 502 },
        );
    }

    const responseHeaders = new Headers(upstream.headers);
    stripUnsupportedUpstreamHeaders(responseHeaders);
    stripProxyUnsafeResponseHeaders(responseHeaders);
    responseHeaders.set('cache-control', 'no-store');

    const bodyBytes = await upstream.arrayBuffer();

    return new Response(bodyBytes, {
        status: upstream.status,
        headers: responseHeaders,
    });
}

type ProxyHandler = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;

/**
 * Bind the playground key-reveal proxy to an API version. Route files export
 * the returned handler for every method — behavior is identical across
 * versions except for the upstream path prefix.
 */
export function createPlaygroundProxy(version: PlaygroundProxyVersion): ProxyHandler {
    return (request, ctx) => proxy(version, request, ctx);
}
