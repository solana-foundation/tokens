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
 * Throws on any failure so the error is never cached: the page renders this
 * at request time (see RegistryLoader), falls back to an "unavailable" panel,
 * and the next request retries the API. Returning a value on failure would be
 * cached like a success, and a failure baked into a prerendered page is served
 * from the CDN until a background regeneration happens to succeed.
 */
export async function fetchRegistry(): Promise<RegistryData> {
    'use cache';
    cacheLife('minutes');

    const started = Date.now();
    const result = await Effect.runPromise(
        Effect.result(apiAppJson<V2RegistryResponse>({ path: REGISTRY_PATH, timeout: '20 seconds', retryTimes: 1 })),
    );
    if (!Result.isSuccess(result)) {
        throw failed(`${REGISTRY_PATH} failed: ${result.failure._tag}: ${result.failure.message}`);
    }
    const payload = result.success;
    if (!Array.isArray(payload?.items)) {
        throw failed('Asset registry response is missing items');
    }
    // Before the first worker sync the endpoint is an empty 200; do not keep that.
    if (payload.items.length === 0) {
        throw failed('Asset registry has not been synced yet');
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

/**
 * Logs here because Next replaces the message of an error thrown out of a
 * `use cache` scope with a generic one in production builds.
 */
function failed(message: string): Error {
    console.error(JSON.stringify({ event: 'asset_registry_fetch_failed', message }));
    return new Error(message);
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
