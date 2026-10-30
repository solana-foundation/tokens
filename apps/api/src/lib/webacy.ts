/**
 * Response shapes of the Webacy endpoints the API reads. Webacy calls happen in
 * cloudrun-assets (risk sync + depeg webhooks); the API only re-serves the
 * stored rows, so this module is types only.
 */

// ---------------------------------------------------------------------------
// /tokens/{tokenAddress} - Token Risk Analysis
// ---------------------------------------------------------------------------

export interface WebacyTokenRiskTag {
    key: string;
    name: string;
    type: string;
    severity: number;
    description: string;
}

export interface WebacyTokenRiskIssue {
    tags?: WebacyTokenRiskTag[];
    score?: number;
    riskScore?: string;
    categories?: Record<
        string,
        {
            key: string;
            name: string;
            description?: string;
            tags?: Record<string, boolean>;
            gradedDescription?: Record<string, string>;
        }
    >;
}

export interface WebacyLiquidityPool {
    lpMint: string;
    address: string;
    dexName: string;
    pairAddress: string;
    totalLiquidity: number;
    lockedLiquidityPercent: number;
}

export interface WebacyMarketData {
    id?: string;
    name?: string;
    symbol?: string;
    image?: string;
    current_price?: number;
    market_cap?: number;
    market_cap_rank?: number;
    total_volume?: number;
    price_change_24h?: number;
    price_change_percentage_24h?: number;
    circulating_supply?: number;
    total_supply?: number;
    ath?: number;
    atl?: number;
    liquidityData?: WebacyLiquidityPool[];
}

export interface WebacyTokenInfo {
    name?: string;
    symbol?: string;
    logo?: string;
    isPumpFun?: boolean;
    holderCount?: number;
    is_metadata_immutable?: boolean;
}

export interface WebacyTokenRiskDetails {
    is_trusted?: boolean;
    freezeable?: boolean;
    is_mintable?: boolean;
    is_pump_fun?: boolean;
    renounced?: boolean | null;
    token_standard?: string;
    illegal_unicode?: boolean;
    'mutable-metadata'?: boolean;
}

export interface WebacyBuySellTaxes {
    has_buy_tax?: boolean;
    has_sell_tax?: boolean;
}

export interface WebacyTokenResponse {
    risk?: {
        high?: number;
        medium?: number;
        count?: number;
        issues?: WebacyTokenRiskIssue[];
        details?: {
            marketData?: WebacyMarketData;
            token_info?: WebacyTokenInfo;
            token_risk?: WebacyTokenRiskDetails;
            buy_sell_taxes?: WebacyBuySellTaxes;
            address_info?: Record<string, unknown>;
        };
    };
}

// ---------------------------------------------------------------------------
// /trading-lite/{address} - Quick Trading DD
// ---------------------------------------------------------------------------

export interface WebacyBundlerAddress {
    address: string;
    initiallyAcquiredPercentage: number;
    initiallyAcquiredAmount: number;
    currentHoldingPercentage: number;
    currentHoldingAmount: number;
}

export interface WebacyTradingLiteResponse {
    CA?: string;
    DA?: string;
    Top10Holders?: number;
    SniperPercentageOnLaunch?: number;
    SniperAddresses?: string[];
    SniperPercentageHolding?: number;
    SniperConfidence?: number | null;
    BundlerAddresses?: WebacyBundlerAddress[];
    BundlerPercentageOnLaunch?: number;
    BundlerPercentageHolding?: number;
    TotalHolders?: number;
    DexScreenerPaid?: boolean;
    DevHoldingPercentage?: number;
    DevLaunched24Hours?: number;
    mintable?: boolean;
    freezable?: boolean;
    analysisTimestamp?: number;
}
