import type { Metadata } from 'next';
import { Suspense } from 'react';
import { connection } from 'next/server';

import { Skeleton } from '@tokens/ui/skeleton';
import { FloatingMarketFeedPageContext } from '@/components/floating-market-feed-context';
import { SiteFooter } from '@/components/site-footer';
import { Heatmap } from './components/heatmap';
import { fetchHeatmapData } from './lib/fetch-heatmap';

export const metadata: Metadata = {
    title: 'Heat map | Tokens',
    description:
        'Canonical assets on Solana sized by 24h trading volume and coloured by price change. Click an asset to see its variants.',
    robots: { index: false, follow: false },
};

export default function HeatmapPage() {
    return (
        <main className="min-h-dvh bg-white relative overflow-x-hidden">
            {/* The floating feed would sit on top of the map's bottom-right tiles. */}
            <FloatingMarketFeedPageContext displayName="Heatmap" suppressFeed />
            {/* Same column as the home page's sections. Title, then the breadcrumb, then the map. */}
            <section className="relative mx-auto max-w-7xl px-6 pt-24 pb-10">
                <h1 className="mb-3 text-[26px] leading-[1.1] font-medium text-text-extra-high">Heatmap</h1>

                <Suspense fallback={<HeatmapFallback />}>
                    <HeatmapLoader />
                </Suspense>
            </section>

            <section className="border-t border-gray-1400/10">
                <div className="mx-auto max-w-[1120px] px-6 pb-10">
                    <SiteFooter tone="light" />
                </div>
            </section>
        </main>
    );
}

/**
 * `connection()` keeps the fetch out of the build-time prerender so the static
 * shell never depends on the API being reachable; the `use cache` inside
 * fetchHeatmapData still applies across requests.
 */
async function HeatmapLoader() {
    await connection();
    try {
        const data = await fetchHeatmapData();
        return <Heatmap data={data} />;
    } catch (error) {
        console.error(
            JSON.stringify({
                event: 'heatmap_fetch_failed',
                message: error instanceof Error ? error.message : String(error),
            }),
        );
        return <HeatmapUnavailable />;
    }
}

function HeatmapUnavailable() {
    return (
        <div className="rounded-[24px] border border-border-light bg-white p-6 text-center md:p-12">
            <p className="text-text-low text-[14px] md:text-[16px]">The heat map is temporarily unavailable</p>
            <p className="text-text-extra-low text-[12px] md:text-[14px] mt-2">Please try again in a few minutes.</p>
        </div>
    );
}

function HeatmapFallback() {
    return (
        <div>
            <Skeleton className="mb-3 h-9 w-full max-w-[420px] rounded-full bg-gray-50" />
            <Skeleton className="h-[max(440px,calc(100dvh-280px))] w-full rounded-lg bg-gray-50" />
        </div>
    );
}
