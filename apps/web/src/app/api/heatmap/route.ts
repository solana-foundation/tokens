import { NextResponse } from 'next/server';

import { fetchHeatmapData } from '@/app/heatmap/lib/fetch-heatmap';
import { sectorPreview } from '@/app/heatmap/lib/preview';

/** The mini map draws about 40 tiles; the rest would only fill its "+N more" corner. */
const MINI_MAP_ASSET_LIMIT = 48;

/** Mini map data for the floating market feed: one category of the heat map, e.g. `?sector=stocks`. */
export async function GET(request: Request): Promise<Response> {
    const sectorId = new URL(request.url).searchParams.get('sector')?.trim() || 'stocks';

    try {
        const sector = sectorPreview(await fetchHeatmapData(), sectorId, MINI_MAP_ASSET_LIMIT);
        if (!sector) {
            return NextResponse.json({ error: { message: `No heat map category "${sectorId}"` } }, { status: 404 });
        }
        return NextResponse.json(sector, {
            headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
        });
    } catch (error) {
        console.error(
            JSON.stringify({
                event: 'heatmap_api_failed',
                message: error instanceof Error ? error.message : String(error),
            }),
        );
        return NextResponse.json(
            { error: { message: 'Heat map data is temporarily unavailable' } },
            { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
    }
}
