/**
 * The data team is mid-migration (solana-data DAT-553): classification is
 * served as `tier_{1,2,3}_class` today and as `group` / `category` / `class`
 * once that ships, at which point `solana_asset_class` disappears. Every
 * classification field is optional so either shape normalizes cleanly.
 */
export interface AssetRegistryApiRow {
    token: string;
    mint_address: string;
    group?: string | null;
    category?: string | null;
    class?: string | null;
    tier_1_class?: string | null;
    tier_2_class?: string | null;
    tier_3_class?: string | null;
    /** Legacy name for the class tier; identical to `tier_3_class`. */
    solana_asset_class?: string | null;
    allium_asset_class: string | null;
    rwa_asset_class: string | null;
    allium_asset_value_usd: string | null;
    rwa_asset_value_usd: string | null;
    coingecko_market_cap: string | null;
}

export interface AssetRegistryApiResponse {
    source: string;
    data: {
        generatedAt: string;
        truncated: boolean;
        rows: AssetRegistryApiRow[];
    };
}

/** One entry of `POST /api/v1/assets/market-snapshots`, in request order. */
export interface MarketSnapshotEntry {
    address: string;
    token: {
        address: string;
        symbol: string;
        name: string;
        logoURI?: string | null;
    } | null;
    hasMarket: boolean;
}

/** One row of `GET /api/v1/assets/curated?groupBy=mint`; only the fields we read. */
export interface CuratedMintEntry {
    primaryVariant: {
        mint: string;
        name?: string | null;
        market?: { logoURI?: string | null } | null;
    } | null;
}

export interface RegistryRow {
    symbol: string;
    mintAddress: string;
    /** Display name from the Tokens platform API, else Birdeye metadata; null when unknown to both. */
    name: string | null;
    /** Per-mint logo: platform index first, then Birdeye token metadata; never a symbol-level override. */
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
    /** Ranking value: Allium > RWA.xyz > CoinGecko mcap (data-team ordering). */
    valueUsd: number | null;
}

export interface RegistryData {
    generatedAt: string;
    truncated: boolean;
    rows: RegistryRow[];
}
