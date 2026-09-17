import { Suspense } from 'react';

import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import { AssetLaunchesTable, type AssetLaunchesResponse } from './asset-launches-table';

/**
 * Coins launched on stonk.fun against this asset as the quote token.
 * Renders nothing at all (no heading, no skeleton) for assets nothing was
 * launched against, so untouched pages stay untouched.
 */
export function AssetLaunchesSection({ assetId, displaySymbol }: { assetId: string; displaySymbol: string }) {
    return (
        <Suspense fallback={null}>
            <AssetLaunchesLoader assetId={assetId} displaySymbol={displaySymbol} />
        </Suspense>
    );
}

async function AssetLaunchesLoader({ assetId, displaySymbol }: { assetId: string; displaySymbol: string }) {
    const result = await fetchApiAppJsonOrNull<AssetLaunchesResponse>(
        `/api/v1/assets/${encodeURIComponent(assetId)}/launches?limit=50`,
        { next: { revalidate: 60 } },
    );

    if (!result || (result.launches ?? []).length === 0) return null;

    return (
        <section>
            <div className="flex items-baseline justify-between gap-4 mb-6 mt-12">
                <h3 className="text-title-md text-text-extra-high text-balance">Launched on {displaySymbol}</h3>
                <a
                    href="https://www.stonkfun.xyz/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[13px] text-text-low hover:text-text-medium transition-colors"
                >
                    via stonk.fun
                </a>
            </div>
            <AssetLaunchesTable assetId={assetId} quoteSymbol={displaySymbol} initial={result} />
        </section>
    );
}
