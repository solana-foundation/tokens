import { fetchHeatmapData } from '../lib/fetch-heatmap';
import { toPreviewData } from '../lib/preview';
import { HeatmapPreview } from './heatmap-preview';

/**
 * Home-page heat map card. Render inside its own <Suspense>: a cold cache takes a couple of
 * seconds, and the highlights and token table must not wait on it. On failure it renders nothing.
 */
export async function HeatmapPreviewSection() {
    try {
        const data = await fetchHeatmapData();
        return <HeatmapPreview preview={toPreviewData(data)} />;
    } catch (error) {
        console.error(
            JSON.stringify({
                event: 'heatmap_preview_fetch_failed',
                message: error instanceof Error ? error.message : String(error),
            }),
        );
        return null;
    }
}
