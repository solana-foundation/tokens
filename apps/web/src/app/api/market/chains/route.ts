import { getCrossChainLiquidity } from '@/lib/market-data/cross-chain';

export async function GET(): Promise<Response> {
    try {
        return Response.json(await getCrossChainLiquidity());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[market-data] cross-chain fetch failed:', message);
        return Response.json(
            { error: 'Cross-chain liquidity unavailable', detail: message },
            { status: 502 },
        );
    }
}
