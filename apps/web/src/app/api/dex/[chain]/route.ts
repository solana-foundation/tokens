import { isChainId } from '@/lib/market-data/chains';
import { fetchDexPairs } from '@/lib/market-data/dex-pairs';

/** Cap on pages a caller may request, mirroring the upstream page limit. */
const MAX_PAGES = 10;

export async function GET(request: Request, context: { params: Promise<{ chain: string }> }): Promise<Response> {
    const { chain } = await context.params;
    if (!isChainId(chain)) {
        return Response.json({ error: `Unknown chain: ${chain}` }, { status: 404 });
    }

    const requested = Number.parseInt(new URL(request.url).searchParams.get('pages') ?? '', 10);
    const pages = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_PAGES, requested)) : undefined;

    const result = await fetchDexPairs(chain, pages);
    // `fetchDexPairs` reports an unreachable chain rather than throwing, so the
    // status reflects that: an empty list from a working provider is a 200.
    return Response.json(
        { ...result, fetchedAt: Date.now() },
        { status: result.degraded ? 502 : 200, headers: { 'cache-control': 'no-store' } },
    );
}
