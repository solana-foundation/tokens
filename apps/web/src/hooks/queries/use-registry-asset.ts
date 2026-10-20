'use client';

import { useQuery } from '@tanstack/react-query';
import { Effect } from 'effect';

import { apiJson } from '@/effect/api-client';
import type { V2RegistryAssetResponse } from '@/app/registry/lib/types';

/**
 * One registry asset with the raw data.solana.com row, via the keyless
 * `/api/v2/registry/{mint}` proxy. Fetched on demand when the Response sheet
 * opens; the API caches it for 5 minutes, so mirror that client-side.
 */
export async function fetchRegistryAsset(mint: string, signal?: AbortSignal): Promise<V2RegistryAssetResponse> {
    return Effect.runPromise(
        apiJson<V2RegistryAssetResponse>({ url: `/api/v2/registry/${encodeURIComponent(mint)}` }),
        { signal },
    );
}

export function useRegistryAsset(mint: string | null) {
    return useQuery({
        queryKey: ['registry-asset', mint],
        enabled: mint !== null,
        staleTime: 5 * 60_000,
        retry: (failureCount, error) => {
            // A 404 is the answer (the asset left the registry); do not hammer it.
            if (error && typeof error === 'object' && '_tag' in error && error._tag === 'ApiResponseError') {
                const status = (error as { status?: number }).status;
                if (status === 404) return false;
            }
            return failureCount < 2;
        },
        queryFn: ({ signal }) => fetchRegistryAsset(mint!, signal),
    });
}
