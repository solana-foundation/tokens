import { isChainId } from '@/lib/market-data/chains';
import { ensureDexSnapshot, readDexSnapshot } from '@/lib/market-data/dex-snapshot';

export async function GET(request: Request, context: { params: Promise<{ chain: string }> }): Promise<Response> {
    const { chain } = await context.params;
    if (!isChainId(chain)) {
        return Response.json({ error: `Unknown chain: ${chain}` }, { status: 404 });
    }

    // The snapshot is kept warm by a background loop, so this is a memory read
    // in the steady state; only the first call after a cold start waits, and
    // even then no longer than the snapshot's own timeout.
    const cached = readDexSnapshot(chain);
    const result = cached.pairs.length > 0 ? cached : await ensureDexSnapshot(chain);

    // An empty list from a warm snapshot is a working provider with nothing to
    // say; only a chain that has never filled is reported as an upstream error.
    return Response.json(
        { ...result, fetchedAt: result.fetchedAt ?? Date.now() },
        {
            status: result.pairs.length === 0 && result.degraded ? 502 : 200,
            headers: { 'cache-control': 'no-store' },
        },
    );
}
