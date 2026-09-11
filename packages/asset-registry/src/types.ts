/**
 * Canonical assets model.
 *
 * This package is a "source of truth" for how we group Solana mints into
 * higher-level assets (e.g. Bitcoin) and how we categorize them (e.g. crypto, ETF).
 *
 * Some token display metadata (symbol/name) may be resolved dynamically from
 * Birdeye/Convex; the registry focuses on stable IDs + grouping.
 */

export const ASSET_CATEGORIES = [
    'crypto',
    'stablecoin',
    'lst',
    'rwa',
    'commodity',
    'equity',
    'etf',
    'index',
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const VARIANT_KINDS = [
    'native',
    'wrapped',
    'bridged',
    /** Tokenized direct commodity exposure (e.g. per-oz metal tokens), distinct from `etf` fund-share trackers. */
    'spot',
    'etf',
    'yield',
    'leveraged',
    'basket',
    'lst',
    'stablecoin',
    'tokenized_equity',
] as const;
export type VariantKind = (typeof VARIANT_KINDS)[number];

export const LIQUIDITY_TIERS = ['tier1', 'tier2', 'tier3'] as const;
export type LiquidityTier = (typeof LIQUIDITY_TIERS)[number];
/** @deprecated Trust tier currently mirrors liquidity tier. Prefer LiquidityTier for market-derived ranking. */
export type TrustTier = LiquidityTier;

export const STOCK_VARIANT_TIERS = ['share_redeemable', 'cash_redeemable', 'not_redeemable'] as const;
export type StockVariantTier = (typeof STOCK_VARIANT_TIERS)[number];

/**
 * Admin-set advisory on a mint.
 *
 * - `caution`: informational notice; nothing is gated.
 * - `compromised`: visible with a warning; excluded from primary-variant
 *   selection and trending; trade links and execution endpoints refuse it.
 * - `blocked`: `compromised` plus hidden from list/search surfaces. Direct
 *   asset/mint reads still serve it with the advisory attached.
 *
 * Stored in `asset_variant_advisories` (DB), never in the compiled registry.
 * The API annotates DB/registry variants with it at serialization time.
 */
export const ADVISORY_STATUSES = ['caution', 'compromised', 'blocked'] as const;
export type AdvisoryStatus = (typeof ADVISORY_STATUSES)[number];

export interface VariantAdvisory {
    status: AdvisoryStatus;
    reason: string;
    url: string | null;
    /** Unix ms when the current status was set. */
    since: number;
}

export function isAdvisoryStatus(value: unknown): value is AdvisoryStatus {
    return typeof value === 'string' && (ADVISORY_STATUSES as readonly string[]).includes(value);
}

/** `compromised` or `blocked`: trade links and execution must refuse the mint. */
export function isTradeRestrictedAdvisory(advisory: VariantAdvisory | null | undefined): boolean {
    return advisory?.status === 'compromised' || advisory?.status === 'blocked';
}

/** `blocked`: hidden from curated lists, search, trending, and v2 list hydration. */
export function isHiddenAdvisory(advisory: VariantAdvisory | null | undefined): boolean {
    return advisory?.status === 'blocked';
}

export interface AssetVariant {
    /** Stable variant identity within an asset, e.g. `bitcoin:cbBTC` */
    variantId: string;
    /** Solana mint address */
    mint: string;

    /** Best-effort token display metadata (may be resolved dynamically). */
    symbol?: string;
    name?: string;

    kind: VariantKind;
    issuer?: string;
    issuerUrl?: string;
    trustTier: TrustTier;
    tags: string[];

    /** Optional short label, used when symbol/name are unknown. */
    label?: string;

    /** Equity/tokenized-equity redeemability tier for API clients comparing stock variants. */
    stockVariantTier?: StockVariantTier;

    /**
     * Active admin advisory, if any. Never set in compiled registry data; the
     * API attaches it from `asset_variant_advisories` before ranking/serializing.
     */
    advisory?: VariantAdvisory | null;
}

export interface CanonicalAsset {
    /** Stable asset identity, e.g. `bitcoin`, `gold`, `tesla` */
    assetId: string;

    /** Best-effort display metadata (may be resolved dynamically). */
    name?: string;
    symbol?: string;

    category: AssetCategory;
    aliases: string[];
    coingeckoId?: string;
    variants: AssetVariant[];
}

export interface VariantMatch {
    asset: CanonicalAsset;
    variant: AssetVariant;
}
