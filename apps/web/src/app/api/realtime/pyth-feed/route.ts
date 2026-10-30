import { NextResponse } from 'next/server';

import { isSupportedPythTicker, normalizePythTicker } from '@/lib/realtime-prices/pyth-feed-selection';
import { resolvePythFeed } from '@/lib/realtime-prices/pyth-pro-server';

/**
 * Resolves an asset ticker + category to a Pyth Pro feed id the browser can subscribe to.
 * GET /api/realtime/pyth-feed?symbol=TSLA&category=equity&mode=canonical
 */

const CACHEABLE = { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' } as const;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: Request): Promise<Response> {
    const { searchParams } = new URL(request.url);
    const ticker = normalizePythTicker(searchParams.get('symbol'));
    const modeRaw = (searchParams.get('mode') ?? 'canonical').trim();
    const mode = modeRaw === 'variant' ? 'variant' : 'canonical';
    const category = (searchParams.get('category') ?? '').trim().toLowerCase() || null;

    if (!ticker || !isSupportedPythTicker(ticker)) {
        return NextResponse.json({ error: 'invalid_symbol' }, { status: 400, headers: NO_STORE });
    }

    const resolution = await resolvePythFeed({ ticker, category, mode });
    switch (resolution.status) {
        case 'unconfigured':
            return NextResponse.json({ status: 'unconfigured' }, { status: 503, headers: NO_STORE });
        case 'error':
            // Upstream hiccup: never let the CDN or the browser cache this as "no feed".
            return NextResponse.json({ status: 'error' }, { status: 502, headers: NO_STORE });
        case 'not_found':
            return NextResponse.json(
                { status: 'not_found', candidates: resolution.candidates },
                { status: 404, headers: CACHEABLE },
            );
        case 'not_entitled':
        case 'ok':
            return NextResponse.json({ status: resolution.status, feed: resolution.feed }, { headers: CACHEABLE });
    }
}
