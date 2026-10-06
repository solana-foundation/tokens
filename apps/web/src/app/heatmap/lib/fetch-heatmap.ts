import 'server-only';

import { Effect, Result } from 'effect';
import { cacheLife } from 'next/cache';
import { CURATED_LIST_FALLBACK_NAMES } from '@tokens/asset-registry/curated-lists';

import { apiAppJson } from '@/lib/api-app';
import { CURATED_LIST_ORDER_WITHOUT_LSTS } from '@/lib/curated-lists';
import { buildHeatmapData } from './build-heatmap';
import type { HeatmapData, HeatmapSectorMembership, RawCuratedResponse } from './types';

/**
 * Market data comes from the `all` union in one request. The per-list
 * endpoints cannot supply it: with `variants=all` a single list returns every
 * yield variant (over a thousand for Solana) instead of the curated set.
 */
const CURATED_ALL_PATH = '/api/v1/assets/curated?list=all&groupBy=asset&variants=all';

async function fetchJson<T>(path: string): Promise<T> {
    const result = await Effect.runPromise(
        Effect.result(apiAppJson<T>({ path, timeout: '20 seconds', retryTimes: 1 })),
    );
    if (!Result.isSuccess(result)) {
        throw new Error(`${path} failed: ${result.failure._tag}: ${result.failure.message}`);
    }
    return result.success;
}

/** The home page's category tabs: the same lists, order, and display names. */
async function fetchSectorMembership(): Promise<HeatmapSectorMembership[]> {
    const [meta, ...lists] = await Promise.all([
        // Names only; the slugs below are authoritative, so a failed meta call falls back to defaults.
        fetchJson<Array<{ id: string; name?: string }>>('/api/v1/assets/curated/lists').catch(() => []),
        ...CURATED_LIST_ORDER_WITHOUT_LSTS.map(listId =>
            fetchJson<RawCuratedResponse>(`/api/v1/assets/curated?list=${encodeURIComponent(listId)}&groupBy=asset`),
        ),
    ]);

    return CURATED_LIST_ORDER_WITHOUT_LSTS.map((id, index) => ({
        id,
        label:
            (Array.isArray(meta) ? meta.find(row => row.id === id)?.name : undefined) ??
            CURATED_LIST_FALLBACK_NAMES[id],
        assetIds: (lists[index]?.assets ?? []).map(asset => asset.assetId),
    }));
}

/**
 * Caches the slimmed tree, not the upstream responses: the raw union is
 * ~1.5 MB (every variant's full market snapshot), the tree a fifth of that.
 * Throws on any failure so the error is never cached: the page falls back to
 * an "unavailable" panel and the next request retries the API.
 */
export async function fetchHeatmapData(): Promise<HeatmapData> {
    'use cache';
    cacheLife('minutes');

    const [response, membership] = await Promise.all([
        fetchJson<RawCuratedResponse>(CURATED_ALL_PATH),
        fetchSectorMembership(),
    ]);

    const data = buildHeatmapData(response, membership, Date.now());
    if (data.assetCount === 0) throw new Error('Curated assets response contained no assets');
    return data;
}
