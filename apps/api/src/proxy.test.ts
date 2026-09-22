/**
 * The Clerk middleware allowlist decides which paths API-key callers can reach
 * at all: anything not listed demands a Clerk *session* and 401s before route
 * auth runs. `/v2/search` + `/v2/resolve` shipped without an entry and were
 * unreachable in prod for every key — this pins the contract.
 */

import { describe, expect, it, mock } from 'bun:test';
import { createRouteMatcher } from '@clerk/nextjs/server';
import { NextRequest } from 'next/server';

mock.module('server-only', () => ({}));

const { PUBLIC_ROUTE_PATTERNS } = await import('./proxy');

const isPublicRoute = createRouteMatcher(PUBLIC_ROUTE_PATTERNS);
const req = (path: string) => new NextRequest(`https://api.tokens.xyz${path}`);

describe('proxy public route allowlist', () => {
    it('lets API-key routes through without a Clerk session', () => {
        for (const path of [
            '/api/health',
            '/api/v1/health',
            '/api/v1/assets/search?q=sol',
            '/api/v1/assets/usd/launches',
            '/api/v1/news/feed',
            '/api/v2/lists',
            '/api/v2/lists/majors',
            '/api/v2/lists/check-slug?slug=x',
            '/api/v2/lists/search-tokens?q=usdc',
            '/api/v2/search?q=usdc',
            '/api/v2/resolve?q=usdc',
        ]) {
            expect(isPublicRoute(req(path))).toBe(true);
        }
    });

    it('keeps first-party and admin routes behind Clerk', () => {
        for (const path of ['/api/v1/whoami', '/api/x/other', '/api/admin/anything']) {
            expect(isPublicRoute(req(path))).toBe(false);
        }
    });
});
