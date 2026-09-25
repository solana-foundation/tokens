export interface AssetRegistryApiRow {
    token: string;
    mint_address: string;
    solana_asset_class: string;
    coingecko_asset_class: string | null;
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
    solanaClass: string;
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
