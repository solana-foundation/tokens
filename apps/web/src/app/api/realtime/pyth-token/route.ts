import { NextResponse } from 'next/server';

import { clientIdentifier, enforceRateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { isPythConfigured, mintPythAccessToken } from '@/lib/realtime-prices/pyth-pro-server';

/**
 * Mints a short-lived Pyth Pro JWT for the browser price stream.
 *
 * The long-lived PYTH_API_KEY stays on the server; the JWT is capped by Pyth at
 * 15 minutes and can only read what our plan is entitled to. Because every JWT
 * draws on the shared Pro quota, minting is rate limited server-side: a tab
 * needs one token per 15 minutes, so the per-client budget below covers many
 * tabs while a scripted caller is cut off quickly, and a global ceiling bounds
 * total exposure regardless of how many addresses an abuser can reach us from.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Per client: 12 mints per 15 minutes (one legitimate tab mints once per 15 minutes). */
const PER_CLIENT = { scope: 'pyth-token', limit: 12, windowMs: 15 * 60_000 } as const;
/** All clients together: 1,500 mints per 15 minutes. */
const GLOBAL = { scope: 'pyth-token-global', limit: 1_500, windowMs: 15 * 60_000 } as const;

function isBrowserSameOrigin(request: Request): boolean {
    // Browsers always send Sec-Fetch-Site; reject cross-site pages that try to
    // mint on our quota. Scripted clients omit the header, which is why this is
    // only the first gate: the rate limits below are the enforceable control.
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

    const perClient = await enforceRateLimit(PER_CLIENT, clientIdentifier(request));
    if (!perClient.ok) return rateLimitedResponse(perClient);
    const global = await enforceRateLimit(GLOBAL, 'all');
    if (!global.ok) return rateLimitedResponse(global);

    const token = await mintPythAccessToken();
    if (!token) {
        return NextResponse.json({ error: 'pyth_token_unavailable' }, { status: 502, headers: NO_STORE });
    }
    return NextResponse.json(token, { headers: NO_STORE });
}
