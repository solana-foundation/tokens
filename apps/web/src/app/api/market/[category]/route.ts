import { categoryLabel, getMarketSnapshot } from '@/lib/market-data/catalog';
import { isMarketCategory, MARKET_CATEGORIES } from '@/lib/market-data/types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
    if (!raw) return DEFAULT_LIMIT;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
    return Math.min(parsed, MAX_LIMIT);
}

export async function GET(
    request: Request,
    context: RouteContext<'/api/market/[category]'>,
): Promise<Response> {
    const { category } = await context.params;

    if (!isMarketCategory(category)) {
        return Response.json(
            { error: `Unknown category '${category}'`, supported: MARKET_CATEGORIES },
            { status: 404 },
        );
    }

    const limit = parseLimit(new URL(request.url).searchParams.get('limit'));

    try {
        const snapshot = await getMarketSnapshot(category, limit);
        return Response.json({ label: categoryLabel(category), ...snapshot });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[market-data] ${category} fetch failed:`, message);
        return Response.json(
            { error: 'Upstream market data unavailable', category, detail: message },
            { status: 502 },
        );
    }
}
