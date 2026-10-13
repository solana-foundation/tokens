/**
 * One item of `GET /api/v2/registry` (apps/api/src/app/api/v2/registry/route.ts).
 * Mirrored here rather than imported: apps/web only talks to the API over HTTP.
 */
export interface V2RegistryItem {
    mint: string;
    symbol: string;
    name: string | null;
    logoURI: string | null;
    hasTokenPage: boolean;
    group: string | null;
    category: string | null;
    assetClass: string | null;
    alliumClass: string | null;
    alliumValueUsd: number | null;
    rwaClass: string | null;
    rwaValueUsd: number | null;
    marketCapUsd: number | null;
    rank: number;
}

/** One item of `GET /api/v2/registry/{mint}`: the list item plus the raw upstream row and sync metadata. */
export interface V2RegistryAssetResponse extends V2RegistryItem {
    /** The data.solana.com row exactly as delivered (snake_case keys, numerics as strings). */
    upstream: Record<string, unknown>;
    generatedAt: string | null;
    syncedAt: number | null;
    provider: { name: string | null; logoURI: string | null; fetchedAt: number | null };
}

export interface V2RegistryResponse {
    /** Upstream data.solana.com `generatedAt` (ISO 8601); null before the first sync. */
    generatedAt: string | null;
    /** Our last successful sync, unix ms; null before the first sync. */
    syncedAt: number | null;
    total: number;
    items: V2RegistryItem[];
}

export interface RegistryRow {
    symbol: string;
    mintAddress: string;
    /** Display name resolved by the platform (its index first, Birdeye fallback); null when unknown to both. */
    name: string | null;
    /** Per-mint logo: first-party CDN copy, platform index, then the Birdeye fallback; never a symbol-level override. */
    logoURI: string | null;
    /** True when the Tokens API knows this mint, so `/token/<mint>` resolves. */
    hasTokenPage: boolean;
    /** Top tier of the Foundation taxonomy, e.g. "RWA", "Crypto Native", "Stablecoins". */
    group: string | null;
    /** Middle tier, e.g. "Equities", "Fixed Income", "Fiat-Backed". */
    category: string | null;
    /** Leaf tier, e.g. "Stocks", "US Treasuries", "USD Stablecoins". */
    assetClass: string | null;
    rwaClass: string | null;
    alliumClass: string | null;
    rwaValueUsd: number | null;
    alliumValueUsd: number | null;
    marketCapUsd: number | null;
    /**
     * The on-chain value shown in the table's single "Value" column: Allium first,
     * RWA.xyz otherwise (the two providers measure the same thing; when both report,
     * the median ratio is ~1.01). Null when neither provider covers the asset.
     */
    providerValueUsd: number | null;
    providerValueSource: 'allium' | 'rwa' | null;
    /** Ranking value: Allium > RWA.xyz > CoinGecko mcap (data-team ordering). */
    valueUsd: number | null;
}

export interface RegistryData {
    generatedAt: string;
    truncated: boolean;
    rows: RegistryRow[];
}
