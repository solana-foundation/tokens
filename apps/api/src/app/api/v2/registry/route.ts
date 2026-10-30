import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { BadRequestError, decodeLimit, decodeOffset } from '@tokens/effect';
import { solanaDataAssetsList } from '@/lib/cloudrun';

import { toRegistryItems, type V2RegistryResponse } from './_shared';

/**
 * GET /api/v2/registry — the Project Canon asset registry: every Solana asset the
 * Solana Foundation data team classifies (group > category > class) with the
 * Allium and RWA.xyz classifications / values and the CoinGecko market cap, in
 * the upstream's order (coalesce(Allium value, RWA.xyz value) desc, then market
 * cap). Synced hourly from data.solana.com into Postgres by the assets worker
 * (`sync-solana-data-assets`); identity (name, logo, token page) is resolved
 * from the platform's own index at read time. tokens.xyz's /registry page is
 * a consumer of this endpoint like any other key.
 */

const DEFAULT_LIMIT = '500';
const MAX_LIMIT = 5000;
const FILTER_MAX_LENGTH = 80;
const STALE_TTL_SECONDS = 60 * 60;

function decodeFilter(url: URL, key: string): Effect.Effect<string | undefined, BadRequestError> {
    const raw = url.searchParams.get(key);
    if (raw === null) return Effect.succeed(undefined);
    const trimmed = raw.trim();
    if (!trimmed) return Effect.succeed(undefined);
    if (trimmed.length > FILTER_MAX_LENGTH) {
        return Effect.fail(new BadRequestError({ message: `${key} must be at most ${FILTER_MAX_LENGTH} characters` }));
    }
    return Effect.succeed(trimmed);
}

export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const limit = yield* decodeLimit(url.searchParams.get('limit'), {
                defaultValue: DEFAULT_LIMIT,
                max: MAX_LIMIT,
            });
            const offset = yield* decodeOffset(url.searchParams.get('offset'));
            const group = yield* decodeFilter(url, 'group');
            const category = yield* decodeFilter(url, 'category');
            const assetClass = yield* decodeFilter(url, 'class');
            const hasFilters = group !== undefined || category !== undefined || assetClass !== undefined;

            const main = Effect.gen(function* () {
                const result = yield* solanaDataAssetsList({
                    limit,
                    offset,
                    ...(group !== undefined ? { group } : {}),
                    ...(category !== undefined ? { category } : {}),
                    ...(assetClass !== undefined ? { class: assetClass } : {}),
                });
                const response: V2RegistryResponse = {
                    generatedAt: result.generatedAt,
                    syncedAt: result.syncedAt,
                    total: result.total,
                    items: yield* toRegistryItems(result.items),
                };
                return response;
            });

            // Last-good copy: the registry changes hourly at most, so an hour of
            // staleness beats a 5xx when the assets backend blips.
            return yield* withStaleFallback(
                {
                    operation: 'v2.registry.list',
                    cacheKey: `v2:registry:${limit}:${offset}:${group ?? ''}:${category ?? ''}:${assetClass ?? ''}`,
                    ttlSeconds: STALE_TTL_SECONDS,
                    // An empty unfiltered registry (before the first sync, or a wiped
                    // table) must not become "last good". A filtered query can be
                    // legitimately empty, so filters bypass the check.
                    isHealthy: (payload: V2RegistryResponse) => hasFilters || payload.total > 0,
                },
                main,
            );
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 300, staleWhileRevalidate: 600 } },
);
