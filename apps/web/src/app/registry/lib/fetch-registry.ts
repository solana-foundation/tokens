import 'server-only';

import { Effect, Result } from 'effect';
import { cacheLife } from 'next/cache';

import { apiAppJson } from '@/lib/api-app';
import { normalizeLogoURI } from '@/lib/ipfs-ref';
import type { RegistryData, RegistryRow, V2RegistryItem, V2RegistryResponse } from './types';

/**
 * The registry is synced hourly from data.solana.com into the platform DB by
 * the assets worker and served as one DB read; the page asks for everything
 * (the upstream is ~3.3k rows, the endpoint caps at 5000) and keeps the
 * filter / sort / CSV UX client-side.
 */
const REGISTRY_PATH = '/api/v2/registry?limit=5000';

/**
 * Resolves to `null` instead of throwing on failure. The page is prerendered
 * with this call inside it, and an error escaping a `use cache` scope fails
 * the build outright even when the caller catches it, so a failure becomes a
 * value: it is cached for one second only (the route then revalidates on the
 * next request) and the page shows an "unavailable" panel until the API
 * answers again.
 */
export async function fetchRegistry(): Promise<RegistryData | null> {
    'use cache';
    cacheLife('minutes');

    const started = Date.now();
    const result = await Effect.runPromise(
        Effect.result(apiAppJson<V2RegistryResponse>({ path: REGISTRY_PATH, timeout: '20 seconds', retryTimes: 1 })),
    );
    if (!Result.isSuccess(result)) {
        return unavailable(`${REGISTRY_PATH} failed: ${result.failure._tag}: ${result.failure.message}`);
    }
    const payload = result.success;
    if (!Array.isArray(payload?.items)) {
        return unavailable('Asset registry response is missing items');
    }
    // Before the first worker sync the endpoint is an empty 200; do not keep that.
    if (payload.items.length === 0) {
        return unavailable('Asset registry has not been synced yet');
    }

    const rows = payload.items.map(toRegistryRow);
    const generatedAt = payload.generatedAt ?? new Date(payload.syncedAt ?? started).toISOString();

    console.info(
        JSON.stringify({
            event: 'asset_registry_loaded',
            rows: rows.length,
            total: payload.total,
            withLogo: rows.filter(row => row.logoURI).length,
            withName: rows.filter(row => row.name).length,
            // Drops to 0 if the upstream classification contract drifts again.
            withGroup: rows.filter(row => row.group).length,
            generatedAt,
            syncedAt: payload.syncedAt,
            durationMs: Date.now() - started,
        }),
    );

    // Row order is the data team's (coalesce(Allium value, RWA.xyz value) desc,
    // then CoinGecko market cap); the API preserves it as `rank`.
    return {
        generatedAt,
        truncated: payload.total > payload.items.length,
        rows,
    };
}

/** Logs the failure and makes sure it does not outlive the next request. */
function unavailable(message: string): null {
    console.error(JSON.stringify({ event: 'asset_registry_fetch_failed', message }));
    // The shortest cacheLife in a scope wins: the failed entry expires at once
    // so the following request re-fetches instead of serving the panel.
    cacheLife({ stale: 0, revalidate: 1, expire: 1 });
    return null;
}

function toRegistryRow(item: V2RegistryItem): RegistryRow {
    return {
        symbol: item.symbol,
        mintAddress: item.mint,
        name: item.name?.trim() || null,
        logoURI: normalizeLogoURI(item.logoURI),
        hasTokenPage: item.hasTokenPage,
        assetId: item.assetId ?? null,
        group: item.group,
        category: item.category,
        assetClass: item.assetClass,
        rwaClass: item.rwaClass,
        alliumClass: item.alliumClass,
        rwaValueUsd: item.rwaValueUsd,
        alliumValueUsd: item.alliumValueUsd,
        marketCapUsd: item.marketCapUsd,
        providerValueUsd: item.alliumValueUsd ?? item.rwaValueUsd,
        providerValueSource: item.alliumValueUsd !== null ? 'allium' : item.rwaValueUsd !== null ? 'rwa' : null,
        valueUsd: item.alliumValueUsd ?? item.rwaValueUsd ?? item.marketCapUsd,
    };
}
