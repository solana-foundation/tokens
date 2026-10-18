import { Effect } from 'effect';

import type { SolanaDataAssetResult } from '@/lib/cloudrun';
import { getVariantByMint } from '@tokens/asset-registry';
import { partitionRegisteredMints } from '../../v1/assets/_registered-only';
import { looksLikeSolanaMintAddress, mintToSingletonAssetId } from '../../v1/assets/_singleton-asset-id';

/** Shapes shared by GET /api/v2/registry and GET /api/v2/registry/{mint}. */

// Type alias (not interface): withStaleFallback needs Record<string, unknown>-assignable payloads.
export type V2RegistryItem = {
    mint: string;
    symbol: string;
    name: string | null;
    logoURI: string | null;
    /** True when the mint is a registered asset, i.e. tokens.xyz has a page: `tokens.xyz/{assetId}?solana={mint}`. */
    hasTokenPage: boolean;
    /**
     * tokens.xyz asset id the mint resolves to (`GET /v1/assets/resolve?mint=` agrees): the registered
     * asset that owns the mint (a `solana-{mint}` id when that asset is a per-mint one); null when the
     * mint is not registered. v1 serves registered assets only, so null also means "no v1 data".
     */
    assetId: string | null;
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
};

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

/** `solana-<mint>` when the owning asset's id is itself a mint, else the id as is. */
function publicIdFor(assetId: string): string {
    return looksLikeSolanaMintAddress(assetId) ? mintToSingletonAssetId(assetId) : assetId;
}

/**
 * Mirrors `/v1/assets/resolve?mint=` (v1 serves registered assets only), using
 * the same registration tiers as `_registered-only.ts`:
 *   1. the DB asset that owns the mint (`registryAssetIdColumn`: active variant,
 *      active asset, no tombstone) — already on the row;
 *   2. the compiled registry (in-process);
 *   3. Sanctum LSTs and admin-approved launch coins — one batched Cloud Run
 *      check, only for rows the platform knows (`row.hasTokenPage`, which the
 *      SQL sets from the token index) that tiers 1-2 did not place. Those get
 *      their per-mint `solana-<mint>` id, which v1 resolves.
 * A mint none of the tiers knows has no page: `assetId: null`, `hasTokenPage: false`.
 */
export function resolvePublicAssetIds(
    rows: readonly SolanaDataAssetResult[],
): Effect.Effect<Map<string, string | null>, never> {
    return Effect.gen(function* () {
        const out = new Map<string, string | null>();
        const pending: string[] = [];
        for (const row of rows) {
            if (row.assetId) {
                out.set(row.mint, publicIdFor(row.assetId));
                continue;
            }
            const registry = getVariantByMint(row.mint);
            if (registry) {
                out.set(row.mint, publicIdFor(registry.asset.assetId));
                continue;
            }
            if (row.hasTokenPage) pending.push(row.mint);
            else out.set(row.mint, null);
        }
        if (pending.length > 0) {
            const { registered } = yield* partitionRegisteredMints(pending);
            const registeredSet = new Set(registered);
            for (const mint of pending) out.set(mint, registeredSet.has(mint) ? mintToSingletonAssetId(mint) : null);
        }
        return out;
    });
}

/** Items for a page of rows, with `assetId` / `hasTokenPage` from `resolvePublicAssetIds`. */
export function toRegistryItems(rows: readonly SolanaDataAssetResult[]): Effect.Effect<V2RegistryItem[], never> {
    return resolvePublicAssetIds(rows).pipe(
        Effect.map(ids => rows.map(row => toRegistryItem(row, ids.get(row.mint) ?? null))),
    );
}

export function toRegistryItem(row: SolanaDataAssetResult, assetId: string | null): V2RegistryItem {
    return {
        mint: row.mint,
        symbol: row.symbol,
        name: row.name,
        logoURI: row.logoURI,
        hasTokenPage: assetId !== null,
        assetId,
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

export type V2RegistryAssetResponse = V2RegistryItem & {
    /** The upstream row verbatim; may gain fields without notice. */
    upstream: Record<string, unknown>;
    generatedAt: string | null;
    syncedAt: number | null;
    provider: { name: string | null; logoURI: string | null; fetchedAt: number | null };
};
