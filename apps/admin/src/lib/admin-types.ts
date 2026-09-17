/**
 * Hand-copied return/arg shapes for the `/api/admin/[name]` curation functions
 * (ported from the Convex validators in `convex/adminCuratedTokens.ts` and
 * `convex/adminCuratedTokensActions.ts`; `Id<'…'>` fields became plain strings
 * and the Convex `_storage` upload concept was dropped — logos are uploaded via
 * `generateCanonicalLogoUploadUrl` and stored as `imageUrl`).
 */

export type AssetCategory = 'crypto' | 'stablecoin' | 'lst' | 'rwa' | 'commodity' | 'equity' | 'etf' | 'index';

// Hand-copied from ADMIN_ASSIGNABLE_CURATED_SLUGS in
// packages/asset-registry/src/curated-lists.ts (the source of truth —
// deliberately excludes `lsts`, whose membership is Sanctum-dynamic).
export type CuratedCategorySlug = 'majors' | 'currencies' | 'rwas' | 'etfs' | 'metals' | 'stocks';

// Hand-copied from CURATED_LIST_SLUGS: every curated list, including `lsts`.
// Membership for `lsts` is Sanctum-driven, but its display metadata is editable.
export type CuratedListSlug = CuratedCategorySlug | 'lsts';

/** Display order for the metadata editor; mirrors CURATED_LIST_SLUGS. */
export const CURATED_LIST_SLUGS: readonly CuratedListSlug[] = [
    'majors',
    'lsts',
    'currencies',
    'rwas',
    'etfs',
    'metals',
    'stocks',
];

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
    /** All seven curated slugs are addressable; `listCategories` defaults to the six assignable ones. */
    id: CuratedListSlug;
    name: string;
    /** Public list description (`asset_collections.description`); null when unset. */
    description: string | null;
    count: number;
    lastAddedAssetId: string | null;
};

/* ── updateCollectionMeta ───────────────────────────────────────────────── */

/** Edit a curated list's public display metadata. Omitted fields are left untouched. */
export type UpdateCollectionMetaArgs = {
    slug: CuratedListSlug;
    title?: string;
    /** Empty string clears the description. */
    description?: string;
};

export type UpdateCollectionMetaResult = {
    slug: CuratedListSlug;
    updated: boolean;
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

/* ── variant advisories ─────────────────────────────────────────────────── */

// Hand-copied from ADVISORY_STATUSES / VariantAdvisory in
// packages/asset-registry/src/types.ts (the source of truth).
export type AdvisoryStatus = 'caution' | 'compromised' | 'blocked';

/** The active advisory attached to a variant mint, as serialized on admin variant rows. */
export type VariantAdvisory = {
    status: AdvisoryStatus;
    reason: string;
    url: string | null;
    /** Unix ms; reset when the status changes, kept when only reason/url are edited. */
    since: number;
};

/** Mirrors `VariantAdvisoryRow` in cloudrun-admin handlers/variantAdvisories.ts. */
export type VariantAdvisoryRow = {
    mint: string;
    status: AdvisoryStatus;
    reason: string;
    url: string | null;
    setBy: string;
    setByEmail: string | null;
    setAt: number;
    updatedAt: number;
};

/** Mirrors `VariantAdvisoryEventRow` in cloudrun-admin handlers/variantAdvisories.ts (append-only audit log). */
export type VariantAdvisoryEventRow = {
    id: string;
    mint: string;
    action: 'set' | 'clear';
    status: AdvisoryStatus | null;
    reason: string | null;
    url: string | null;
    reactivatedVariant: boolean;
    actorClerkUserId: string;
    actorEmail: string | null;
    createdAt: number;
};

export type SetVariantAdvisoryArgs = {
    mint: string;
    status: AdvisoryStatus;
    reason: string;
    url?: string | null;
    /** When the variant is inactive, flip `is_active` back on in the same transaction. */
    activateVariant?: boolean;
};

export type SetVariantAdvisoryResult = { mint: string; status: AdvisoryStatus; updated: true; reactivated: boolean };

export type ClearVariantAdvisoryResult = { mint: string; cleared: boolean };

/** `events` is only populated when `mint` was passed to `listVariantAdvisories`. */
export type ListVariantAdvisoriesResult = {
    advisories: VariantAdvisoryRow[];
    events: VariantAdvisoryEventRow[];
};

/* ── launchpad approvals (mirrors cloudrun-admin handlers/launchpadApprovals.ts) ── */

export type LaunchpadApproval = {
    note: string | null;
    approvedBy: string;
    approvedByEmail: string | null;
    /** Unix ms of the first approval; kept across re-approves. */
    approvedAt: number;
    updatedAt: number;
};

/**
 * One row of the admin Launches table. `synced: false` = approved by address
 * but not stored by the sync yet (token fields null); `isActive: false` on a
 * synced row = missing identity or not in the last provider response.
 */
export type LaunchpadCandidateRow = {
    launchpad: string;
    mint: string;
    synced: boolean;
    isActive: boolean;
    quoteMint: string | null;
    quoteSymbol: string | null;
    symbol: string | null;
    name: string | null;
    logoURI: string | null;
    marketCapUsd: number | null;
    volume24hUsd: number | null;
    launchedAt: number | null;
    lastSyncedAt: number | null;
    /** Canonical asset that owns the quote mint (the page the coin shows on); null when unsynced or not curated. */
    quoteAsset: LaunchpadQuoteAsset | null;
    approval: LaunchpadApproval | null;
};

export type LaunchpadQuoteAsset = {
    assetId: string;
    name: string | null;
    symbol: string | null;
    imageUrl: string | null;
};

/* ── stonk.fun lookups (mirror cloudrun-assets handlers/launchpadAdminActions.ts) ── */

export type LaunchpadTokenMarket = {
    priceUsd: number | null;
    marketCapUsd: number | null;
    fdvUsd: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    priceChange24h: number | null;
};

export type LaunchpadTokenSummary = {
    mint: string;
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    status: string | null;
    launchpad: string | null;
    mode: string | null;
    quoteMint: string;
    quoteSymbol: string | null;
    market: LaunchpadTokenMarket;
    createdAt: number | null;
    graduatedAt: number | null;
};

export type LaunchpadMintPreview = {
    mint: string;
    checkedAt: number;
    found: boolean;
    token: LaunchpadTokenSummary | null;
    quote: {
        mint: string;
        symbol: string | null;
        curated: boolean;
        asset: { assetId: string; symbol: string | null; name: string | null; imageUrl: string | null } | null;
    } | null;
    synced: boolean;
    isActive: boolean;
    approved: { note: string | null; approvedAt: number } | null;
    meetsThreshold: boolean;
    warnings: string[];
};

export type LaunchpadQuoteTokenRow = LaunchpadTokenSummary & {
    synced: boolean;
    isActive: boolean;
    approved: { note: string | null; approvedAt: number } | null;
    meetsThreshold: boolean;
};

export type ListLaunchpadTokensForQuoteResult = {
    quoteMints: string[];
    fetchedAt: number;
    tokens: LaunchpadQuoteTokenRow[];
};

/** A curated asset stonk.fun accepts as a quote token (a Launches row, coins or not). */
export type LaunchpadPairAsset = {
    assetId: string;
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    quoteMints: Array<{ mint: string; symbol: string | null; category: string | null }>;
};

export type ListLaunchpadPairsResult = {
    fetchedAt: number;
    pairsTotal: number;
    curatedPairs: number;
    assets: LaunchpadPairAsset[];
};

export type SyncLaunchpadMintResult = {
    mint: string;
    synced: boolean;
    isActive: boolean;
    reason: 'not_found' | 'not_graduated' | 'quote_not_curated' | 'identity_pending' | null;
};

export type ListLaunchpadCandidatesArgs = { launchpad?: 'stonkfun'; approvedOnly?: boolean; limit?: number };
export type ApproveLaunchpadMintArgs = {
    mint: string;
    note?: string | null;
    launchpad?: 'stonkfun';
    /** Snapshot from the Check preview so the row shows under its asset before the sync stores it. */
    quoteMint?: string | null;
    symbol?: string | null;
    name?: string | null;
    logoURI?: string | null;
};
export type ApproveLaunchpadMintResult = {
    launchpad: string;
    mint: string;
    approved: true;
    created: boolean;
    approvedAt: number;
};
export type RevokeLaunchpadMintArgs = { mint: string; launchpad?: 'stonkfun' };
export type RevokeLaunchpadMintResult = { launchpad: string; mint: string; revoked: boolean };

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
    /**
     * Active advisory for this mint, or null. Optional for rollout safety: a
     * cloudrun-admin build that predates advisories omits the key entirely, and
     * the UI treats `undefined` the same as `null`.
     */
    advisory?: VariantAdvisory | null;
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
    /** Unix ms; set while the admin takedown lock is active. */
    adminLockedAt: number | null;
    memberCount: number;
    createdAt: number;
    updatedAt: number;
};

/** Mirrors `TokenListMutationErrorCode` in cloudrun-assets handlers/tokenListsMutations.ts. */
export type TokenListMutationErrorCode =
    | 'invalid_slug'
    | 'reserved_slug'
    | 'slug_conflict'
    | 'unknown_project'
    | 'not_found'
    | 'forbidden'
    | 'invalid_mint'
    | 'unknown_mint'
    | 'batch_too_large'
    | 'list_full';

export type TokenListMutationOutcome<T> = { ok: true; value: T } | { ok: false; error: TokenListMutationErrorCode };

/** `adminCreateTokenList` result (cloudrun-assets handlers/tokenListsAdmin.ts). */
export type AdminCreateTokenListResult = TokenListMutationOutcome<{
    id: string;
    slug: string;
    ownerProjectId: string;
    name: string;
    status: string;
    createdAt: number;
    updatedAt: number;
}>;

/** `adminImportTokenListMembers` result (cloudrun-assets handlers/tokenListsAdmin.ts). */
export type AdminImportTokenListMembersResult = TokenListMutationOutcome<{
    slug: string;
    received: number;
    added: Array<{ mint: string; verified: boolean }>;
    failed: Array<{ mint: string; error: TokenListMutationErrorCode }>;
}>;
