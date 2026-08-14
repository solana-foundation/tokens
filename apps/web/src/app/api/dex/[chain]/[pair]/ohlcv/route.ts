import { isChainId } from '@/lib/market-data/chains';
import { fetchPoolCandles, isPoolChartRange } from '@/lib/market-data/dex-pair-detail';

const DEFAULT_DAYS = 7;

export async function GET(
    request: Request,
    context: { params: Promise<{ chain: string; pair: string }> },
): Promise<Response> {
    const { chain, pair } = await context.params;
    if (!isChainId(chain)) {
        return Response.json({ error: `Unknown chain: ${chain}` }, { status: 404 });
    }

    const requested = Number.parseInt(new URL(request.url).searchParams.get('days') ?? '', 10);
    const days = isPoolChartRange(requested) ? requested : DEFAULT_DAYS;

    const candles = await fetchPoolCandles(chain, pair, days);

    // An empty list is a valid answer here — a pool with no candles upstream is
    // common — so the failure the client cares about is a transport one, and
    // that already surfaced as a fetch error before reaching this point.
    return Response.json(
        { chain, pair, days, candles },
        { headers: { 'cache-control': 'no-store' } },
    );
}
