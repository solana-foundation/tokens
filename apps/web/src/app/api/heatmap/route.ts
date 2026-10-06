import { NextResponse } from 'next/server';

import { fetchHeatmapData } from '@/app/heatmap/lib/fetch-heatmap';
import { miniPreview } from '@/app/heatmap/lib/preview';

/** The mini map draws about 40 tiles; the rest would only fill its "+N more" corner. */
const MINI_MAP_ASSET_LIMIT = 48;

/**
 * Mini map data for the floating market feed: the heat map's categories, and one of them in full
 * (`?sector=stocks`; an unknown or empty category falls back to Stocks).
 */
export async function GET(request: Request): Promise<Response> {
    const sectorId = new URL(request.url).searchParams.get('sector')?.trim() || 'stocks';

    try {
        const preview = miniPreview(await fetchHeatmapData(), sectorId, MINI_MAP_ASSET_LIMIT);
        if (!preview) {
            return NextResponse.json({ error: { message: 'The heat map has no categories to show' } }, { status: 404 });
        }
        return NextResponse.json(preview, {
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
