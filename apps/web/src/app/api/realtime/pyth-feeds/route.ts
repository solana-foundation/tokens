import { NextResponse } from 'next/server';

import { clientIdentifier, enforceRateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { parsePythFeedBatchBody, pythFeedResolutionKey } from '@/lib/realtime-prices/pyth-feed-batch';
import { isPythConfigured, resolveEntitledPythFeeds } from '@/lib/realtime-prices/pyth-pro-server';

/**
 * Batch feed resolution for tables: POST { items: [{ symbol, category, mode }] }
 * → { feeds: { "<mode>:<category>:<TICKER>": feed | null } }. Only feeds this plan can
 * stream are returned; everything else is null and the row keeps its snapshot price.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
/** Per client: 30 batches per minute (a table resolves once per tab change, up to 200 rows each). */
const PER_CLIENT = { scope: 'pyth-feeds', limit: 30, windowMs: 60_000 } as const;

export async function POST(request: Request): Promise<Response> {
    if (!isPythConfigured()) {
        return NextResponse.json({ error: 'pyth_unconfigured' }, { status: 503, headers: NO_STORE });
    }
    const limit = await enforceRateLimit(PER_CLIENT, clientIdentifier(request));
    if (!limit.ok) return rateLimitedResponse(limit);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers: NO_STORE });
    }
    const items = parsePythFeedBatchBody(body);
    if (items.length === 0) {
        return NextResponse.json({ error: 'no_items' }, { status: 400, headers: NO_STORE });
    }

    const resolved = await resolveEntitledPythFeeds(items);
    if (!resolved) {
        return NextResponse.json({ error: 'pyth_directory_unavailable' }, { status: 502, headers: NO_STORE });
    }
    const feeds: Record<string, unknown> = {};
    for (const item of items) {
        const key = pythFeedResolutionKey(item);
        feeds[key] = resolved.get(key) ?? null;
    }
    // Entitlements change only with the plan; let the browser cache the answer briefly.
    return NextResponse.json({ feeds }, { headers: { 'Cache-Control': 'private, max-age=600' } });
}
