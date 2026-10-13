import type { SolanaDataAssetResult } from '@/lib/cloudrun';

/** Shapes shared by GET /api/v2/registry and GET /api/v2/registry/{mint}. */

// Type alias (not interface): withStaleFallback needs Record<string, unknown>-assignable payloads.
export type V2RegistryItem = {
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

export function toRegistryItem(row: SolanaDataAssetResult): V2RegistryItem {
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

export type V2RegistryAssetResponse = V2RegistryItem & {
    /** The upstream row verbatim; may gain fields without notice. */
    upstream: Record<string, unknown>;
    generatedAt: string | null;
    syncedAt: number | null;
    provider: { name: string | null; logoURI: string | null; fetchedAt: number | null };
};
