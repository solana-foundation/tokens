import { fromDexScreenerChain, searchDexScreener } from '@/lib/market-data/dexscreener';
import { isChainId } from '@/lib/market-data/chains';

/**
 * Pool-level search: the half of "find a token" the asset registry cannot
 * answer. The registry only knows assets someone curated, and only on Solana,
 * so a pasted contract address from any other chain — or a brand new pool —
 * has nowhere to resolve. DexScreener indexes both, keyed by contract address,
 * symbol or name.
 */

const MAX_RESULTS = 8;

export interface PairSearchHit {
    chain: string;
    pairAddress: string;
    baseSymbol: string;
    baseName: string;
    baseAddress: string;
    quoteSymbol: string;
    dex: string | null;
    priceUsd: number | null;
    volume24hUSD: number | null;
    liquidityUsd: number | null;
    imageUrl: string | null;
}

function num(value: unknown): number | null {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
    if (query.length < 2) {
        return Response.json({ query, hits: [] as PairSearchHit[] });
    }

    const pairs = await searchDexScreener(query);
    const hits: PairSearchHit[] = [];
    const seen = new Set<string>();

    for (const pair of pairs) {
        // Only chains this site has a page for; DexScreener answers across all
        // of theirs and a hit we cannot route to is worse than no hit.
        const chain = pair.chainId ? fromDexScreenerChain(pair.chainId) : null;
        if (!chain || !isChainId(chain) || !pair.pairAddress) continue;

        const key = `${chain}:${pair.pairAddress.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        hits.push({
            chain,
            pairAddress: pair.pairAddress,
            baseSymbol: pair.baseToken?.symbol ?? '—',
            baseName: pair.baseToken?.name ?? '',
            baseAddress: pair.baseToken?.address ?? '',
            quoteSymbol: pair.quoteToken?.symbol ?? '—',
            dex: pair.dexId ?? null,
            priceUsd: num(pair.priceUsd),
            volume24hUSD: num(pair.volume?.h24),
            liquidityUsd: num(pair.liquidity?.usd),
            imageUrl: pair.info?.imageUrl ?? null,
        });
    }

    // Relevance order upstream buries the liquid pool for a symbol under a pile
    // of copycats; depth then volume is what makes the real one come first.
    hits.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) || (b.volume24hUSD ?? 0) - (a.volume24hUSD ?? 0));

    return Response.json(
        { query, hits: hits.slice(0, MAX_RESULTS) },
        { headers: { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=120' } },
    );
}
