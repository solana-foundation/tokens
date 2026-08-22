/**
 * Hand-copied return/arg shapes for the `/api/admin/[name]` curation functions
 * (ported from the Convex validators in `convex/adminCuratedTokens.ts` and
 * `convex/adminCuratedTokensActions.ts`; `Id<'…'>` fields became plain strings
 * and the Convex `_storage` upload concept was dropped — logos are uploaded via
 * `generateCanonicalLogoUploadUrl` and stored as `imageUrl`).
 */

export type AssetCategory = 'crypto' | 'stablecoin' | 'lst' | 'rwa' | 'commodity' | 'equity' | 'etf' | 'index';

export type CuratedCategorySlug = 'majors' | 'currencies' | 'rwas' | 'etfs' | 'metals' | 'stocks';

export type VariantKind =
    | 'native'
    | 'wrapped'
    | 'bridged'
    | 'etf'
    | 'yield'
    | 'leveraged'
    | 'basket'
    | 'lst'
    | 'stablecoin'
    | 'tokenized_equity';

export type LiquidityTier = 'tier1' | 'tier2' | 'tier3';

export type TrustTier = 'tier1' | 'tier2' | 'tier3' | 'experimental';

export type StockVariantTier = 'share_redeemable' | 'cash_redeemable' | 'not_redeemable';

export type LogoSource = 'url' | 'override' | 'variant' | 'none';

/* ── listCategories ─────────────────────────────────────────────────────── */

export type CategoryRow = {
    id: CuratedCategorySlug;
    name: string;
    count: number;
    lastAddedAssetId: string | null;
};

/* ── listCanonicalAssets ────────────────────────────────────────────────── */

export type CanonicalRow = {
    assetId: string;
    category: string;
    name: string;
    symbol: string;
    imageUrl?: string;
    isActive: boolean;
    variantCount: number;
    collections: string[];
    representativeMint?: string;
    lastFetchedAt?: number;
    searchHints: string[];
};

/* ── listVariantsByAssetIds ─────────────────────────────────────────────── */

export type AdminVariantRow = {
    assetId: string;
    mint: string;
    variantId: string;
    kind: VariantKind;
    liquidityTier: LiquidityTier;
    trustTier: TrustTier;
    storedTrustTier: TrustTier;
    tags: string[];
    label?: string;
    symbol?: string;
    name?: string;
    issuer?: string;
    issuerUrl?: string;
    stockVariantTier?: StockVariantTier;
    logoURI?: string;
    isActive: boolean;
    lastFetchedAt?: number;
};

export type VariantsByAssetIdRow = {
    assetId: string;
    variants: AdminVariantRow[];
};

/* ── getCanonicalEditor ─────────────────────────────────────────────────── */

export type CanonicalEditor = {
    asset: {
        assetId: string;
        category: AssetCategory;
        name?: string;
        symbol?: string;
        coingeckoId?: string;
        description?: string;
        imageUrl?: string;
        resolvedImageUrl?: string;
        logoSource: LogoSource;
        fallbackImageUrl?: string;
        fallbackLogoSource: LogoSource;
        isActive: boolean;
    };
    aliases: string[];
    collections: CuratedCategorySlug[];
} | null;

/* ── getVariantEditor ───────────────────────────────────────────────────── */

export type VariantEditor = {
    variant: {
        assetId: string;
        mint: string;
        variantId: string;
        kind: VariantKind;
        trustTier: TrustTier;
        tags: string[];
        label?: string;
        issuer?: string;
        issuerUrl?: string;
        stockVariantTier?: StockVariantTier;
        isActive: boolean;
    };
    canonical: {
        assetId: string;
        name?: string;
        symbol?: string;
    };
    market: {
        symbol?: string;
        name?: string;
        logoURI?: string;
    } | null;
} | null;

/* ── searchCanonicalAssets ──────────────────────────────────────────────── */

export type CanonicalSearchRow = {
    assetId: string;
    name?: string;
    symbol?: string;
    category: string;
};

/* ── previewMint ────────────────────────────────────────────────────────── */

export type PreviewMintResult = {
    exists: boolean;
    assetId: string;
    category?: string;
    name?: string;
    symbol?: string;
    imageUrl?: string;
    hasMarketData: boolean;
    lastFetchedAt?: number;
} | null;

/* ── mutations ──────────────────────────────────────────────────────────── */

export type CreateCanonicalAssetResult = { assetId: string; created: boolean };

export type UpdateCanonicalAssetResult = { assetId: string; updated: boolean };

export type DeleteCanonicalAssetResult = { assetId: string; deleted: boolean };

export type UpdateVariantResult = { mint: string; updated: boolean };

export type DeleteVariantResult = { mint: string; deleted: boolean };

export type DeactivateVariantResult = { mint: string; isActive: boolean; updated: boolean };

export type MoveVariantToCanonicalResult = { mint: string; fromAssetId: string; toAssetId: string; moved: boolean };

export type RemoveFromCategoryResult = { removed: boolean };

/** `PUT` the file bytes to `uploadUrl` (matching Content-Type), then persist `publicUrl` as `imageUrl`. */
export type GenerateCanonicalLogoUploadUrlResult = { uploadUrl: string; publicUrl: string };

export type HardDeleteAssetResult = {
    deleted: boolean;
    assetId: string;
    membershipsDeleted: number;
    aliasesDeleted: number;
    variantsDeleted: number;
    variantMarketsDeleted: number;
    tokenMarketsDeleted: number;
    tokenDocsDeleted: number;
    tokenDescriptionSummariesDeleted: number;
    assetRiskDeleted: number;
    ohlcvDeleted: number;
    webacyDeleted: number;
    rwaTokenCacheDeleted: number;
    rwaAssetCacheDeleted: number;
    assetMarketDeleted: number;
    coingeckoPricesDeleted: number;
    coingeckoTickersDeleted: number;
    coingeckoOhlcvDeleted: number;
    tombstonesCreated: number;
    pendingOhlcvDelete: boolean;
};

/* ── cloudrun-assets admin actions ──────────────────────────────────────── */

export type RefreshChartDataResult = {
    mint: string;
    scheduled: string[];
};

export type CheckedVariantPreview = {
    assetId: string;
    mint: string;
    checkedAt: number;
    conflict:
        | { type: 'same_canonical'; assetId: string; variantId: string }
        | { type: 'other_canonical'; assetId: string; variantId: string }
        | null;
    variantWrite: {
        assetId: string;
        chain: 'solana';
        mint: string;
        variantId: string;
        kind: VariantKind;
        trustTier: TrustTier;
        stockVariantTier?: StockVariantTier;
        tags: string[];
        label: string | null;
        isActive: boolean;
    };
    marketWrite: {
        mint: string;
        source: 'birdeye';
        symbol: string;
        name: string;
        decimals: number;
        logoURI: string | null;
        price: number | null;
        priceChange24hPercent: number | null;
        priceChange1hPercent: number | null;
        volume24hUSD: number | null;
        liquidity: number | null;
        marketCap: number | null;
        fdv: number | null;
        holder: number | null;
        totalSupply: number | null;
        circulatingSupply: number | null;
        lastTradeHumanTime: string | null;
        extensions: Record<string, string> | null;
        lastFetchedAt: number;
    };
};

export type AddCheckedVariantResult = {
    assetId: string;
    mint: string;
    variantId: string;
    scheduled: string[];
};

export type AdminSeedAssetResult = {
    assetId: string;
    mint: string;
    slug?: CuratedCategorySlug;
    rank?: number;
    seededAt: number;
};

/** Mirrors `TokenListAdminRow` in cloudrun-admin handlers/tokenListsAdmin.ts. */
export type TokenListAdminRow = {
    id: string;
    slug: string;
    ownerProjectId: string;
    name: string;
    status: string;
    memberCount: number;
    createdAt: number;
    updatedAt: number;
};
