import { NextResponse } from 'next/server';

import { isPythConfigured, mintPythAccessToken } from '@/lib/realtime-prices/pyth-pro-server';

/**
 * Mints a short-lived Pyth Pro JWT for the browser price stream.
 * The long-lived PYTH_API_KEY stays on the server; the JWT is scoped by Pyth's
 * TTL cap (15 minutes) and only usable for reads on our plan's entitlements.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function isBrowserSameOrigin(request: Request): boolean {
    // Browsers always send Sec-Fetch-Site; reject cross-site callers that try to
    // mint tokens on our quota. Non-browser clients (no header) are allowed so
    // local tooling and tests keep working.
    const site = request.headers.get('sec-fetch-site');
    if (!site) return true;
    return site === 'same-origin' || site === 'same-site' || site === 'none';
}

export async function POST(request: Request): Promise<Response> {
    if (!isBrowserSameOrigin(request)) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    if (!isPythConfigured()) {
        return NextResponse.json({ error: 'pyth_unconfigured' }, { status: 503, headers: NO_STORE });
    }
    const token = await mintPythAccessToken();
    if (!token) {
        return NextResponse.json({ error: 'pyth_token_unavailable' }, { status: 502, headers: NO_STORE });
    }
    return NextResponse.json(token, { headers: NO_STORE });
}
