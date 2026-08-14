import { isChainId, type ChainId } from '@/lib/market-data/chains';
import { dexScreenerPairToDexPair, fromDexScreenerChain, searchDexScreener } from '@/lib/market-data/dexscreener';
import type { DexPair } from '@/lib/market-data/dex-pairs';

/**
 * Pair lookup for the explorer's filter box: what the table falls back to when
 * a query matches none of the chain's ranked pools. Accepts a contract address,
 * a symbol or a name, and returns rows in the table's own shape.
 *
 * Note this sits at `/api/dex/search`, which the `[chain]` segment would
 * otherwise swallow — `isChainId` rejects "search", so the two never collide.
 */

const MAX_RESULTS = 40;

export async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const query = url.searchParams.get('q')?.trim() ?? '';
    const rawChain = url.searchParams.get('chain')?.trim() ?? '';
    const chainFilter: ChainId | null = isChainId(rawChain) ? rawChain : null;

    if (query.length < 2) {
        return Response.json({ query, pairs: [] as DexPair[] });
    }

    const live = await searchDexScreener(query);
    const pairs: DexPair[] = [];
    const seen = new Set<string>();

    for (const entry of live) {
        const chain = entry.chainId ? fromDexScreenerChain(entry.chainId) : null;
        if (!chain) continue;
        // A chain-scoped search still answers across chains when the active one
        // has nothing: a pasted Base address should not come back empty just
        // because the Solana tab was open.
        const key = `${chain}:${entry.pairAddress?.toLowerCase() ?? ''}`;
        if (!entry.pairAddress || seen.has(key)) continue;
        seen.add(key);
        pairs.push(dexScreenerPairToDexPair(chain, entry));
    }

    const ordered = chainFilter
        ? [...pairs].sort((a, b) => Number(b.chain === chainFilter) - Number(a.chain === chainFilter))
        : pairs;

    return Response.json(
        { query, pairs: ordered.slice(0, MAX_RESULTS) },
        { headers: { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=120' } },
    );
}
