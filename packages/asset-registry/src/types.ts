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

/**
 * Who owns an advisory. `admin` rows are human-authored; `webacy_depeg` rows
 * are set (and cleared) automatically by the stablecoin depeg reconciler and
 * are always `caution`. Any admin write on a system row turns it into an
 * `admin` row, after which the automation leaves it alone.
 */
export const ADVISORY_SOURCES = ['admin', 'webacy_depeg', 'peg_guard'] as const;
export type AdvisorySource = (typeof ADVISORY_SOURCES)[number];

/** Automated sources: the Webacy depeg monitor and the in-house peg guard. */
export const SYSTEM_ADVISORY_SOURCES = ['webacy_depeg', 'peg_guard'] as const;
export type SystemAdvisorySource = (typeof SYSTEM_ADVISORY_SOURCES)[number];

/** Prefix of every non-human `set_by` / actor id. */
export const ADVISORY_SYSTEM_ACTOR_PREFIX = 'system:';
/** `set_by` / actor id written by the Webacy depeg reconciler (no Clerk user exists for it). */
export const WEBACY_DEPEG_ACTOR = 'system:webacy_depeg';
/** `set_by` / actor id written by the in-house peg guard. */
export const PEG_GUARD_ACTOR = 'system:peg_guard';
export const SYSTEM_ACTOR_BY_SOURCE: Record<SystemAdvisorySource, string> = {
    webacy_depeg: WEBACY_DEPEG_ACTOR,
    peg_guard: PEG_GUARD_ACTOR,
};

export interface VariantAdvisory {
    status: AdvisoryStatus;
    reason: string;
    url: string | null;
    /** Unix ms when the current status was set. */
    since: number;
    /**
     * Omitted by services that predate 0019; readers treat `undefined` as
     * `'admin'`.
     */
    source?: AdvisorySource;
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

export function isAdvisorySource(value: unknown): value is AdvisorySource {
    return typeof value === 'string' && (ADVISORY_SOURCES as readonly string[]).includes(value);
}

export function isSystemAdvisorySource(value: unknown): value is SystemAdvisorySource {
    return typeof value === 'string' && (SYSTEM_ADVISORY_SOURCES as readonly string[]).includes(value);
}

/** True for advisories set by an automated source (anything but `admin`). */
export function isSystemManagedAdvisory(advisory: Pick<VariantAdvisory, 'source'> | null | undefined): boolean {
    return advisory?.source !== undefined && advisory.source !== 'admin';
}

export function isSystemActorId(actorId: string): boolean {
    return actorId.startsWith(ADVISORY_SYSTEM_ACTOR_PREFIX);
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
