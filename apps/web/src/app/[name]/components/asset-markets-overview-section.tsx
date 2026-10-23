import { Suspense } from 'react';

import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import { AssetMarketsOverviewTable, type VariantTopMarketsResponse } from './asset-markets-overview-table';

export function AssetMarketsOverviewSection({ assetId, title = 'Markets' }: { assetId: string; title?: string }) {
    return (
        <section>
            <div className="flex items-baseline justify-between gap-4 mb-6 mt-12">
                <h3 className="text-title-md text-text-extra-high text-balance">{title}</h3>
            </div>

            <Suspense fallback={<AssetMarketsOverviewSkeleton />}>
                <AssetMarketsOverviewLoader assetId={assetId} />
            </Suspense>
        </section>
    );
}

async function AssetMarketsOverviewLoader({ assetId }: { assetId: string }) {
    const params = new URLSearchParams({
        offset: '0',
        limit: '50',
    });

    const result = await fetchApiAppJsonOrNull<VariantTopMarketsResponse>(
        `/api/v1/assets/${encodeURIComponent(assetId)}/variant-top-markets?${params.toString()}`,
        { next: { revalidate: 60 } },
    );

    if (!result) {
        return (
            <div className="rounded-[24px] border border-border-light bg-white p-12 text-center shadow-[0_8px_40px_rgba(0,0,0,0.03)]">
                <p className="text-[16px] text-text-low">Markets unavailable</p>
                <p className="mt-2 text-[14px] text-text-extra-low text-pretty">
                    Couldn&apos;t load aggregated markets for this asset.
                </p>
            </div>
        );
    }

    if ((result.total ?? 0) === 0 || (result.variants ?? []).length === 0) {
        return (
            <div className="rounded-[24px] border border-border-light bg-white p-12 text-center shadow-[0_8px_40px_rgba(0,0,0,0.03)]">
                <p className="text-[16px] text-text-low">No markets found</p>
                <p className="mt-2 text-[14px] text-text-extra-low text-pretty">
                    We don&apos;t have any cached DEX pools for these variants yet.
                </p>
            </div>
        );
    }

    return <AssetMarketsOverviewTable assetId={assetId} initial={result} />;
}

function AssetMarketsOverviewSkeleton() {
    return (
        <div className="rounded-[28px] bg-border-light/30 p-2 sm:p-3">
            <div className="space-y-3">
                {Array.from({ length: 4 }, (_, cardIndex) => (
                    <div
                        key={cardIndex}
                        className="overflow-hidden rounded-[22px] border border-border-medium bg-white"
                    >
                        <div className="border-b border-border-extra-light px-4 py-3">
                            <div className="flex items-center justify-between gap-4">
                                <div className="flex items-center gap-2">
                                    <div className="h-7 w-20 animate-pulse rounded-full bg-gray-100" />
                                    <div className="h-4 w-28 animate-pulse rounded bg-gray-100" />
                                </div>
                                <div className="h-4 w-20 animate-pulse rounded bg-gray-100" />
                            </div>
                        </div>
                        <div className="grid grid-cols-[52%_24%_24%] border-b border-border-extra-light bg-gray-50/50 px-4 py-2.5">
                            <div className="h-3 w-10 animate-pulse rounded bg-gray-100" />
                            <div className="ml-auto h-3 w-12 animate-pulse rounded bg-gray-100" />
                            <div className="ml-auto h-3 w-14 animate-pulse rounded bg-gray-100" />
                        </div>
                        <div className="px-4 py-3">
                            <div className="space-y-4">
                                {Array.from({ length: 2 }, (_, rowIndex) => (
                                    <div key={rowIndex} className="grid grid-cols-[minmax(0,1fr)_84px_84px] gap-4">
                                        <div>
                                            <div className="h-4 w-36 animate-pulse rounded bg-gray-100" />
                                            <div className="mt-2 h-3 w-24 animate-pulse rounded bg-gray-100" />
                                        </div>
                                        <div className="ml-auto h-4 w-16 animate-pulse rounded bg-gray-100" />
                                        <div className="ml-auto h-4 w-16 animate-pulse rounded bg-gray-100" />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
