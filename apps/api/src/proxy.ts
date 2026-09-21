import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import { logApiError, logHttpRequest } from '@/lib/http-metrics';

// Public routes bypass Clerk auth (API-key gating is enforced in route handlers).
export const PUBLIC_ROUTE_PATTERNS = [
    '/api/health(.*)',
    '/api/v1/health(.*)',
    '/api/v1/assets(.*)',
    '/api/v1/news(.*)',
    // Every v2 handler MUST go through `route(..., { platform })` — this
    // wildcard is what lets API-key callers reach them at all. A v2 handler
    // without `platform` would be fully unauthenticated.
    '/api/v2(.*)',
    '/api/token(.*)',
    '/api/coingecko(.*)',
    '/api/x/tokens-feed',
    '/api/ohlcv(.*)',
    // Read-only token helper endpoints (admin/seed routes stay Clerk-protected).
    '/api/tokens/curated',
    '/api/tokens/search',
    '/api/tokens/by-addresses',
    '/api/tokens/market-snapshots',
    '/api/tokens/descriptions/by-address',
];

const isPublicRoute = createRouteMatcher(PUBLIC_ROUTE_PATTERNS);

function parseAuthorizedParties(): string[] | undefined {
    const raw = process.env.CLERK_AUTHORIZED_PARTIES?.trim();
    if (!raw) return undefined;

    const parties = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    return parties.length > 0 ? parties : undefined;
}

const authorizedParties = parseAuthorizedParties();

export default clerkMiddleware(
    async (auth, req) => {
        if (isPublicRoute(req)) return;

        const startedAt = Date.now();
        const requestId = req.headers.get('x-request-id')?.trim() || crypto.randomUUID();
        const pathname = req.nextUrl.pathname;
        const { isAuthenticated, tokenType } = await auth();
        const isUserSession = tokenType === 'session_token';

        if (!isAuthenticated || !isUserSession) {
            const status = 401;
            const durationMs = Date.now() - startedAt;

            logHttpRequest({
                requestId,
                method: req.method,
                path: pathname,
                status,
                durationMs,
                source: 'proxy',
                authType: 'clerk_session',
                authFailure: true,
            });

            logApiError({
                requestId,
                method: req.method,
                path: pathname,
                status,
                durationMs,
                errorType: 'UnauthorizedError',
                source: 'proxy',
                authType: 'clerk_session',
                authFailure: true,
            });

            return NextResponse.json(
                { error: { _tag: 'UnauthorizedError', message: 'Unauthorized' } },
                {
                    status,
                    headers: {
                        'Cache-Control': 'no-store',
                        'x-request-id': requestId,
                    },
                },
            );
        }
    },
    authorizedParties ? { authorizedParties } : undefined,
);

export const config = {
    matcher: ['/api/:path*'],
};
