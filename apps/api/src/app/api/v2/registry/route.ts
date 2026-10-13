import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { BadRequestError, decodeLimit, decodeOffset } from '@tokens/effect';
import { solanaDataAssetsList, type SolanaDataAssetResult } from '@/lib/cloudrun';

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

export interface V2RegistryItem {
    mint: string;
    symbol: string;
    name: string | null;
    logoURI: string | null;
    /** True when tokens.xyz has a token page for the mint (`/token/{mint}`). */
    hasTokenPage: boolean;
    /** Foundation taxonomy, top to leaf. */
    group: string | null;
    category: string | null;
    assetClass: string | null;
    alliumClass: string | null;
    alliumValueUsd: number | null;
    rwaClass: string | null;
    rwaValueUsd: number | null;
    marketCapUsd: number | null;
    /** Upstream row order, 0-based; stable across pages. */
    rank: number;
}

// Type alias (not interface) so the payload satisfies withStaleFallback's
// Record<string, unknown> bound via the implicit index signature.
export type V2RegistryResponse = {
    /** Upstream `generatedAt` (ISO 8601) of the synced snapshot; null before the first sync. */
    generatedAt: string | null;
    /** Our last successful sync, unix ms; null before the first sync. */
    syncedAt: number | null;
    total: number;
    items: V2RegistryItem[];
};

function toItem(row: SolanaDataAssetResult): V2RegistryItem {
    return {
        mint: row.mint,
        symbol: row.symbol,
        name: row.name,
        logoURI: row.logoURI,
        hasTokenPage: row.hasTokenPage,
        group: row.group,
        category: row.category,
        assetClass: row.assetClass,
        alliumClass: row.alliumClass,
        alliumValueUsd: row.alliumValueUsd,
        rwaClass: row.rwaClass,
        rwaValueUsd: row.rwaValueUsd,
        marketCapUsd: row.marketCapUsd,
        rank: row.rank,
    };
}

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
                    items: result.items.map(toItem),
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
                    // An empty page before the first sync must not become "last good".
                    isHealthy: (payload: V2RegistryResponse) => payload.total > 0,
                },
                main,
            );
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 300, staleWhileRevalidate: 600 } },
);
