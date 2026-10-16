/**
 * Mirror of the public v2 asset contract in
 * apps/api/src/app/api/v2/_shared-assets.ts. Keep in sync by hand; the
 * runtime contract check is scripts/verify-assets-api-v2-contract.ts.
 * (The API types depend on v1-internal helpers, so they cannot be imported
 * across apps yet; moving both into a package is a follow-up.)
 *
 * Conventions: every documented key is always present, `null` means unknown
 * or not applicable; timestamps are unix ms; EVM addresses are lowercase;
 * a variant's one identifier is `key = <chain>:<address>`.
 */
import type {
    AdvisorySource,
    AdvisoryStatus,
    AssetCategory,
    CompactPegHealth,
    LiquidityTier,
    PrimaryVariantStrategy,
    StockVariantTier,
    TrustTier,
    VariantKind,
} from '@tokens/asset-registry';
import type { ChainCapabilities, ChainKind } from '@tokens/asset-registry/chains';

export type V2ChainId = ChainKind;
export type V2VariantKey = string;

export type V2MarketSource = 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';

export interface V2Market {
    source: V2MarketSource;
    metricsSource: V2MarketSource | null;
    price: number | null;
    liquidity: number | null;
    volume1hUSD: number | null;
    volume24hUSD: number | null;
    trade1h: number | null;
    trade24h: number | null;
    uniqueWallet1h: number | null;
    uniqueWallet24h: number | null;
    marketCap: number | null;
    fdv: number | null;
    holder: number | null;
    totalSupply: number | null;
    circulatingSupply: number | null;
    priceChange1hPercent: number | null;
    priceChange24hPercent: number | null;
    lastTradeAt: number | null;
    asOf: number | null;
    lastFetchedAt: number | null;
}

export interface V2Advisory {
    status: AdvisoryStatus;
    reason: string;
    url: string | null;
    since: number;
    source: AdvisorySource;
}

export type VariantIssuance = 'native' | 'bridged' | 'wrapped';

export interface V2ExecutionQuality {
    source: 'clickhouse_fill_quality';
    range: '24h';
    horizon: '5s';
    quoteKey: V2VariantKey;
    volume24hUSD: number;
    trade24h: number;
    botVolume24hUSD: number;
    botTrade24h: number;
    botVolumeRatio: number | null;
    fee24hUSD: number;
    feeBps: number;
    flowSourceCount: number;
    markoutPnl24hUSD: number | null;
    markoutCount: number | null;
    markoutBps: number | null;
    executionScore: number;
    isEligibleForPrimary: boolean;
    asOf: number | null;
    lastComputedAt: number;
}

export type V2PegHealth = Required<Pick<CompactPegHealth, 'provider' | 'referenceKind'>> &
    Omit<CompactPegHealth, 'provider' | 'referenceKind'>;

export interface V2VariantPreStocks {
    symbol: string;
    markPriceUsd: number | null;
    markValuationUsd: number | null;
    impliedValuationUsd: number | null;
    premiumToMarkPercent: number | null;
    lastFetchedAt: number;
}

/** Present only when requested with `include=`; `null` off-capability or without data. */
export interface V2VariantEnrichments {
    executionQuality?: V2ExecutionQuality | null;
    pegHealth?: V2PegHealth | null;
    preStocks?: V2VariantPreStocks | null;
}

export interface V2Variant extends V2VariantEnrichments {
    key: V2VariantKey;
    chain: V2ChainId;
    address: string;
    assetId: string;
    variantId: string;
    kind: VariantKind;
    issuance: VariantIssuance;
    symbol: string | null;
    name: string | null;
    label: string | null;
    decimals: number | null;
    logoURI: string | null;
    issuer: string | null;
    issuerUrl: string | null;
    trustTier: TrustTier;
    liquidityTier: LiquidityTier;
    stockVariantTier: StockVariantTier | null;
    tags: string[];
    advisory: V2Advisory | null;
    /** 0-based liquidity rank within the asset across chains; null in batch lookups. */
    rank: number | null;
    explorerUrl: string;
    market: V2Market | null;
}

export interface V2AssetStats {
    price: number | null;
    liquidity: number | null;
    volume24hUSD: number | null;
    volume30dUSD: number | null;
    marketCap: number | null;
    fdv: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
    totalSupply: number | null;
    circulatingSupply: number | null;
}

export interface V2ChainStats {
    liquidity: number | null;
    volume24hUSD: number | null;
    trade24h: number | null;
    marketCap: number | null;
    fdv: number | null;
    circulatingSupply: number | null;
    variantCount: number;
    issuedVariantCount: number;
}

/** `executable` (default): chains we can swap on rank first; `global`: every chain. */
export type V2PrimaryScope = 'executable' | 'global';

export interface V2PrimaryVariantSelection {
    pool: 'executable_active' | 'active' | 'executable' | 'all';
    reason: string | null;
}

export interface V2Aggregate extends V2ChainStats {
    chainCount: number;
    excludedFromSupplyCount: number;
}

export type V2ReferenceMarket =
    | {
          source: 'coingecko';
          coinId: string;
          price: number | null;
          marketCap: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          circulatingSupply: number | null;
          totalSupply: number | null;
          maxSupply: number | null;
          asOf: number | null;
          lastFetchedAt: number | null;
      }
    | {
          source: 'stock';
          symbol: string;
          price: number | null;
          marketCap: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          asOf: number | null;
          lastFetchedAt: number | null;
      }
    | {
          source: 'prestocks';
          symbol: string;
          key: V2VariantKey;
          price: number | null;
          marketCap: number | null;
          markPriceUsd: number | null;
          markValuationUsd: number | null;
          impliedValuationUsd: number | null;
          premiumToMarkPercent: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          asOf: number | null;
          lastFetchedAt: number | null;
      };

export interface V2AssetAdvisory extends V2Advisory {
    key: V2VariantKey;
    chain: V2ChainId;
    address: string;
    variantId: string;
}

export interface V2Asset {
    assetId: string;
    name: string | null;
    symbol: string | null;
    description: string | null;
    category: AssetCategory;
    aliases: string[];
    symbols: string[];
    imageUrl: string | null;
    coingeckoId: string | null;
    chains: V2ChainId[];
    stats: V2AssetStats | null;
    chainStats: Partial<Record<V2ChainId, V2ChainStats>>;
    aggregate: V2Aggregate;
    referenceMarket: V2ReferenceMarket | null;
    advisories: V2AssetAdvisory[];
    primaryVariantStrategy: PrimaryVariantStrategy;
    primaryScope: V2PrimaryScope;
    primaryVariantSelection: V2PrimaryVariantSelection | null;
    primaryVariant: V2Variant | null;
    primaryVariantByChain: Partial<Record<V2ChainId, V2Variant>>;
    rank: number | null;
    variants?: V2Variant[];
}

export type V2AssetSummary = Pick<V2Asset, 'assetId' | 'name' | 'symbol' | 'category' | 'imageUrl' | 'chains'>;

export interface V2AssetResponse extends V2Asset {
    resolvedBy: 'assetId' | 'alias' | 'rename';
    variants: V2Variant[];
}

export interface V2AssetsResponse {
    assets: V2Asset[];
    total: number;
    list: string;
    primaryVariantStrategy: PrimaryVariantStrategy;
    primaryScope: V2PrimaryScope;
}

export type V2VariantSort = 'liquidity' | 'execution_quality' | 'stock_redeemability';

export interface V2AssetVariantsResponse {
    assetId: string;
    variants: V2Variant[];
    total: number;
    sort: V2VariantSort;
}

export interface V2VariantResponse {
    variant: V2Variant;
    asset: V2AssetSummary;
}

export interface V2VariantsBatchResponse {
    variants: V2Variant[];
    missing: Array<{ key: V2VariantKey; chain: V2ChainId; address: string }>;
    total: number;
}

export interface V2Chain {
    id: V2ChainId;
    caip2: string;
    family: 'svm' | 'evm';
    evmChainId: number | null;
    label: string;
    explorer: { name: string; tokenUrlTemplate: string };
    capabilities: ChainCapabilities;
    variantCount: number | null;
    assetCount: number | null;
}

export interface V2ChainsResponse {
    chains: V2Chain[];
    total: number;
}
