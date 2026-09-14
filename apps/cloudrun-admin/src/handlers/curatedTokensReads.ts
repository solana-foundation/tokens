/**
 * Admin curated-tokens read handlers.
 *
 * Ports of the query exports in `convex/adminCuratedTokens.ts`:
 * `listCanonicalAssets`, `listVariantsByAssetIds`, `getCanonicalEditor`,
 * `getVariantEditor`, `searchCanonicalAssets`, `previewMint`.
 *
 * Return shapes are field-for-field identical to the Convex validators
 * (optional keys OMITTED — not null — and epoch-ms number timestamps),
 * except `imageStorageId`/`logoSource: 'storage'` which no longer exist in
 * Postgres (the migrator dropped Convex file storage).
 *
 * Every handler enforces the Clerk admin allowlist against the
 * `x-tokens-identity` caller (defense in depth on top of the Next.js proxy).
 */

import { classifyLiquidityTier, getCanonicalFallbackLogoPath } from '@tokens/asset-registry';
import type {
    AssetCategory,
    LiquidityTier,
    PegProvider,
    PegReferenceKind,
    PegTier,
    StockVariantTier,
    StructuralGrade,
    VariantAdvisory,
    VariantKind,
} from '@tokens/asset-registry';

import {
    CURATED_CATEGORY_SLUGS,
    asArgsObject,
    isFiniteNumber,
    looksLikeSolanaMintAddress,
    optionalBoolean,
    optionalNumber,
    requireString,
    requireStringArray,
    resolveCanonicalLogoState,
    uniqueStrings,
    type CuratedCategorySlug,
    type LogoSource,
    type StoredTrustTier,
} from './shared';
import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import type { CallerIdentity } from '../server';

/* ------------------------------------------------------------------------- *
 * Repo interface
 * ------------------------------------------------------------------------- */

export interface AssetRow {
    assetId: string;
    category: string;
    name: string | null;
    symbol: string | null;
    coingeckoId: string | null;
    description: string | null;
    imageUrl: string | null;
    isActive: boolean;
}

export interface VariantMarketRow {
    symbol: string | null;
    name: string | null;
    logoURI: string | null;
    liquidity: number | null;
    lastFetchedAt: number | null;
}

/**
 * Latest peg observation for a stablecoin mint: Webacy (`webacy_depeg_latest`)
 * while it covers the mint, else the in-house peg guard (`peg_guard_latest`).
 */
export interface VariantPegHealthRow {
    /** `webacy` or `tokens` (in-house peg guard). Optional for builds that predate 0020. */
    provider?: PegProvider;
    /** ISO 4217 code of the peg when the observer knows it; optional for builds that predate peg guard phase 2. */
    pegCurrency?: string | null;
    /**
     * What the tier was judged against: a fixed 1.00, a CoinGecko-implied fiat
     * rate (`fx`) or the token's own high-water price (`high_water`). Webacy
     * rows are always `fixed`; null for peg guard rows written before phase 2.
     * Optional for builds that predate peg guard phase 2 (treat as `fixed`).
     */
    referenceKind?: PegReferenceKind | null;
    tier: PegTier;
    /** Signed percent from peg; negative = below peg. */
    deviationPct: number | null;
    /** False when the observer's last fetch failed; `tier` is then the last good value. */
    ok: boolean;
    errorMessage: string | null;
    /** Unix ms of the last fetch attempt. */
    updatedAt: number;
}

/** Latest Webacy structural-health grade for a stablecoin mint (webacy_structural_health_latest). */
export interface VariantStructuralHealthRow {
    grade: StructuralGrade;
    /** Unix ms of the last fetch attempt. */
    updatedAt: number;
}

export interface VariantWithMarketRow {
    assetId: string;
    mint: string;
    variantId: string;
    kind: VariantKind;
    trustTier: StoredTrustTier;
    tags: string[];
    label: string | null;
    issuer: string | null;
    issuerUrl: string | null;
    stockVariantTier: StockVariantTier | null;
    isActive: boolean;
    market: VariantMarketRow | null;
    /** Active admin advisory on this mint (asset_variant_advisories), or null. */
    advisory: VariantAdvisory | null;
    /** Live depeg tier for stablecoin mints, or null when unmonitored. */
    pegHealth: VariantPegHealthRow | null;
    /** Webacy structural grade for stablecoin mints, or null when unmonitored. */
    structuralHealth: VariantStructuralHealthRow | null;
}

export interface SearchAssetRow {
    assetId: string;
    name: string | null;
    symbol: string | null;
    category: string;
}

export interface AdminReadsRepo {
    /** All assets ordered by asset_id (byte order), capped at `limit`. */
    listAssets(args: { includeInactive: boolean; limit: number }): Promise<AssetRow[]>;
    /** All variants LEFT JOINed to variant_markets_latest. */
    listAllVariantsWithMarkets(): Promise<VariantWithMarketRow[]>;
    /** Variants (+ market join) for a batch of asset ids. */
    listVariantsWithMarketsByAssetIds(assetIds: readonly string[]): Promise<VariantWithMarketRow[]>;
    /** All custom-kind aliases (creation order) as {assetId, alias}. */
    listCustomAliases(): Promise<Array<{ assetId: string; alias: string }>>;
    /** Custom-kind aliases for one asset (creation order). */
    listCustomAliasesByAssetId(assetId: string): Promise<string[]>;
    /** Collection memberships for the given slugs as {slug, assetId}. */
    listCollectionMembers(
        slugs: readonly CuratedCategorySlug[],
    ): Promise<Array<{ slug: CuratedCategorySlug; assetId: string }>>;
    getAssetByAssetId(assetId: string): Promise<AssetRow | null>;
    /** Variant looked up by mint, with its market join. */
    getVariantByMint(mint: string): Promise<VariantWithMarketRow | null>;
    getMarketByMint(mint: string): Promise<VariantMarketRow | null>;
    /**
     * ILIKE search over (asset_id || name || symbol || coingecko_id) within the
     * first `scanLimit` assets by asset_id; empty query matches everything.
     */
    searchAssets(args: { query: string; limit: number; scanLimit: number }): Promise<SearchAssetRow[]>;
}

export interface AdminReadsDeps {
    repo: AdminReadsRepo;
    adminAllowlist: AdminAllowlist;
}

/* ------------------------------------------------------------------------- *
 * Variant editor rows (shared by listVariantsByAssetIds / getCanonicalEditor)
 * ------------------------------------------------------------------------- */

export interface AdminVariantRow {
    assetId: string;
    mint: string;
    variantId: string;
    kind: VariantKind;
    liquidityTier: LiquidityTier;
    trustTier: LiquidityTier;
    storedTrustTier: StoredTrustTier;
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
    /** Active admin advisory on this mint, or null. Always present (not omitted). */
    advisory: VariantAdvisory | null;
    /** Webacy depeg status, or null. Always present, like `advisory`. */
    pegHealth: VariantPegHealthRow | null;
    /** Webacy structural grade, or null. Always present, like `advisory`. */
    structuralHealth: VariantStructuralHealthRow | null;
}

interface RankedVariantRow {
    row: AdminVariantRow;
    liquidity: number;
}

/** Port of Convex `listVariantRowsForAssetId` row-building + sort. */
export function buildVariantEditorRows(variants: readonly VariantWithMarketRow[]): AdminVariantRow[] {
    const ranked: RankedVariantRow[] = variants.map(variant => {
        const market = variant.market;
        const lastFetchedAt = isFiniteNumber(market?.lastFetchedAt) ? market.lastFetchedAt : null;
        const liquidity = isFiniteNumber(market?.liquidity) ? market.liquidity : 0;
        const liquidityTier = classifyLiquidityTier(liquidity);
        const row: AdminVariantRow = {
            assetId: variant.assetId,
            mint: variant.mint,
            variantId: variant.variantId,
            kind: variant.kind,
            liquidityTier,
            trustTier: liquidityTier,
            storedTrustTier: variant.trustTier,
            tags: variant.tags,
            ...(variant.label ? { label: variant.label } : {}),
            ...(variant.issuer ? { issuer: variant.issuer } : {}),
            ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
            ...(variant.stockVariantTier ? { stockVariantTier: variant.stockVariantTier } : {}),
            ...(market?.symbol ? { symbol: market.symbol } : {}),
            ...(market?.name ? { name: market.name } : {}),
            ...(market?.logoURI ? { logoURI: market.logoURI } : {}),
            isActive: variant.isActive,
            ...(lastFetchedAt ? { lastFetchedAt } : {}),
            advisory: variant.advisory ?? null,
            pegHealth: variant.pegHealth ?? null,
            structuralHealth: variant.structuralHealth ?? null,
        };
        return { row, liquidity };
    });

    ranked.sort((a, b) => {
        if (a.row.isActive !== b.row.isActive) return a.row.isActive ? -1 : 1;
        if (a.liquidity !== b.liquidity) return b.liquidity - a.liquidity;
        const symbolA = (a.row.symbol ?? a.row.label ?? a.row.variantId).toLowerCase();
        const symbolB = (b.row.symbol ?? b.row.label ?? b.row.variantId).toLowerCase();
        return symbolA.localeCompare(symbolB);
    });

    return ranked.map(r => r.row);
}

/* ------------------------------------------------------------------------- *
 * listCanonicalAssets
 * ------------------------------------------------------------------------- */

const LIST_CANONICAL_ASSETS_SCAN_LIMIT = 2500;

export interface CanonicalAssetListRow {
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
}

/** Convex best-variant comparator: active first, liquidity desc, mint asc. */
function sortVariantsForAsset(variants: VariantWithMarketRow[]): VariantWithMarketRow[] {
    return variants
        .map(variant => ({
            variant,
            liquidity: isFiniteNumber(variant.market?.liquidity) ? variant.market.liquidity : 0,
        }))
        .sort((a, b) => {
            if (a.variant.isActive !== b.variant.isActive) return a.variant.isActive ? -1 : 1;
            if (a.liquidity !== b.liquidity) return b.liquidity - a.liquidity;
            return a.variant.mint.localeCompare(b.variant.mint);
        })
        .map(entry => entry.variant);
}

export async function listCanonicalAssets(
    deps: AdminReadsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<CanonicalAssetListRow[]> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const includeInactive = optionalBoolean(obj, 'includeInactive') ?? true;

    const [assets, allVariants, customAliases, members] = await Promise.all([
        deps.repo.listAssets({ includeInactive, limit: LIST_CANONICAL_ASSETS_SCAN_LIMIT }),
        deps.repo.listAllVariantsWithMarkets(),
        deps.repo.listCustomAliases(),
        deps.repo.listCollectionMembers(CURATED_CATEGORY_SLUGS),
    ]);

    const variantsByAssetId = new Map<string, VariantWithMarketRow[]>();
    for (const variant of allVariants) {
        const existing = variantsByAssetId.get(variant.assetId) ?? [];
        existing.push(variant);
        variantsByAssetId.set(variant.assetId, existing);
    }

    const customAliasesByAssetId = new Map<string, string[]>();
    for (const alias of customAliases) {
        const existing = customAliasesByAssetId.get(alias.assetId) ?? [];
        existing.push(alias.alias);
        customAliasesByAssetId.set(alias.assetId, existing);
    }

    // Convex iterated slugs in CURATED_CATEGORY_SLUGS order, so each asset's
    // collections array is ordered by slug order.
    const collectionsByAssetId = new Map<string, string[]>();
    for (const slug of CURATED_CATEGORY_SLUGS) {
        for (const member of members) {
            if (member.slug !== slug) continue;
            const existing = collectionsByAssetId.get(member.assetId) ?? [];
            existing.push(slug);
            collectionsByAssetId.set(member.assetId, existing);
        }
    }

    return assets.map(asset => {
        const variants = sortVariantsForAsset(variantsByAssetId.get(asset.assetId) ?? []);
        const bestVariant = variants[0] ?? null;
        const logoState = resolveCanonicalLogoState(asset, bestVariant?.market?.logoURI ?? null);
        const searchHints = uniqueStrings([
            asset.assetId,
            asset.name ?? '',
            asset.symbol ?? '',
            asset.coingeckoId ?? '',
            ...(customAliasesByAssetId.get(asset.assetId) ?? []),
            ...variants.flatMap(variant => [
                variant.mint,
                variant.variantId,
                variant.label ?? '',
                variant.market?.symbol ?? '',
                variant.market?.name ?? '',
            ]),
        ]);

        const lastFetchedAt = bestVariant?.market?.lastFetchedAt;
        return {
            assetId: asset.assetId,
            category: asset.category,
            name: (asset.name ?? '').trim() || '—',
            symbol: (asset.symbol ?? '').trim() || '—',
            ...(logoState.resolvedImageUrl ? { imageUrl: logoState.resolvedImageUrl } : {}),
            isActive: asset.isActive,
            variantCount: variants.length,
            collections: collectionsByAssetId.get(asset.assetId) ?? [],
            ...(bestVariant?.mint ? { representativeMint: bestVariant.mint } : {}),
            ...(lastFetchedAt ? { lastFetchedAt } : {}),
            searchHints,
        };
    });
}

/* ------------------------------------------------------------------------- *
 * listVariantsByAssetIds
 * ------------------------------------------------------------------------- */

const LIST_VARIANTS_MAX_ASSET_IDS = 100;

export async function listVariantsByAssetIds(
    deps: AdminReadsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<Array<{ assetId: string; variants: AdminVariantRow[] }>> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const rawAssetIds = requireStringArray(obj, 'assetIds');
    const assetIds = uniqueStrings(rawAssetIds.map(assetId => assetId.trim()).filter(Boolean)).slice(
        0,
        LIST_VARIANTS_MAX_ASSET_IDS,
    );
    if (assetIds.length === 0) return [];

    const rows = await deps.repo.listVariantsWithMarketsByAssetIds(assetIds);
    const byAssetId = new Map<string, VariantWithMarketRow[]>();
    for (const row of rows) {
        const existing = byAssetId.get(row.assetId) ?? [];
        existing.push(row);
        byAssetId.set(row.assetId, existing);
    }

    return assetIds.map(assetId => ({
        assetId,
        variants: buildVariantEditorRows(byAssetId.get(assetId) ?? []),
    }));
}

/* ------------------------------------------------------------------------- *
 * getCanonicalEditor
 * ------------------------------------------------------------------------- */

export interface CanonicalEditorResult {
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
}

export async function getCanonicalEditor(
    deps: AdminReadsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<CanonicalEditorResult | null> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const assetId = requireString(obj, 'assetId').trim();
    if (!assetId) return null;

    const asset = await deps.repo.getAssetByAssetId(assetId);
    if (!asset) return null;

    const [aliases, members, variantRows] = await Promise.all([
        deps.repo.listCustomAliasesByAssetId(assetId),
        deps.repo.listCollectionMembers(CURATED_CATEGORY_SLUGS),
        deps.repo.listVariantsWithMarketsByAssetIds([assetId]),
    ]);
    const collections = CURATED_CATEGORY_SLUGS.filter(slug =>
        members.some(member => member.slug === slug && member.assetId === assetId),
    );
    const variants = buildVariantEditorRows(variantRows);

    const bestVariantLogo = variants[0]?.logoURI ?? null;
    const logoState = resolveCanonicalLogoState(asset, bestVariantLogo);
    const overrideUrl = getCanonicalFallbackLogoPath({
        assetId: asset.assetId,
        symbol: asset.symbol ?? null,
        name: asset.name ?? null,
    });
    const fallbackImageUrl = overrideUrl ?? ((bestVariantLogo ?? '').trim() || null);
    const fallbackLogoSource: LogoSource = overrideUrl ? 'override' : bestVariantLogo ? 'variant' : 'none';

    return {
        asset: {
            assetId: asset.assetId,
            category: asset.category as AssetCategory,
            ...(asset.name ? { name: asset.name } : {}),
            ...(asset.symbol ? { symbol: asset.symbol } : {}),
            ...(asset.coingeckoId ? { coingeckoId: asset.coingeckoId } : {}),
            ...(asset.description ? { description: asset.description } : {}),
            ...(asset.imageUrl ? { imageUrl: asset.imageUrl } : {}),
            ...(logoState.resolvedImageUrl ? { resolvedImageUrl: logoState.resolvedImageUrl } : {}),
            logoSource: logoState.logoSource,
            ...(fallbackImageUrl ? { fallbackImageUrl } : {}),
            fallbackLogoSource,
            isActive: asset.isActive,
        },
        aliases,
        collections,
    };
}

/* ------------------------------------------------------------------------- *
 * getVariantEditor
 * ------------------------------------------------------------------------- */

export interface VariantEditorResult {
    variant: {
        assetId: string;
        mint: string;
        variantId: string;
        kind: VariantKind;
        trustTier: StoredTrustTier;
        tags: string[];
        label?: string;
        issuer?: string;
        issuerUrl?: string;
        stockVariantTier?: StockVariantTier;
        isActive: boolean;
        advisory: VariantAdvisory | null;
        pegHealth: VariantPegHealthRow | null;
        structuralHealth: VariantStructuralHealthRow | null;
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
}

export async function getVariantEditor(
    deps: AdminReadsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<VariantEditorResult | null> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const mint = requireString(obj, 'mint').trim();
    if (!mint) return null;

    const variant = await deps.repo.getVariantByMint(mint);
    if (!variant) return null;
    const asset = await deps.repo.getAssetByAssetId(variant.assetId);
    if (!asset) return null;
    const market = variant.market;

    return {
        variant: {
            assetId: variant.assetId,
            mint: variant.mint,
            variantId: variant.variantId,
            kind: variant.kind,
            trustTier: variant.trustTier,
            tags: variant.tags,
            ...(variant.label ? { label: variant.label } : {}),
            ...(variant.issuer ? { issuer: variant.issuer } : {}),
            ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
            ...(variant.stockVariantTier ? { stockVariantTier: variant.stockVariantTier } : {}),
            isActive: variant.isActive,
            advisory: variant.advisory ?? null,
            pegHealth: variant.pegHealth ?? null,
            structuralHealth: variant.structuralHealth ?? null,
        },
        canonical: {
            assetId: asset.assetId,
            ...(asset.name ? { name: asset.name } : {}),
            ...(asset.symbol ? { symbol: asset.symbol } : {}),
        },
        market: market
            ? {
                  ...(market.symbol ? { symbol: market.symbol } : {}),
                  ...(market.name ? { name: market.name } : {}),
                  ...(market.logoURI ? { logoURI: market.logoURI } : {}),
              }
            : null,
    };
}

/* ------------------------------------------------------------------------- *
 * searchCanonicalAssets
 * ------------------------------------------------------------------------- */

const SEARCH_SCAN_LIMIT = 2500;

export async function searchCanonicalAssets(
    deps: AdminReadsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<Array<{ assetId: string; name?: string; symbol?: string; category: string }>> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const queryText = requireString(obj, 'query').trim().toLowerCase();
    const limit = Math.min(Math.max(optionalNumber(obj, 'limit') ?? 25, 1), 100);

    const rows = await deps.repo.searchAssets({ query: queryText, limit, scanLimit: SEARCH_SCAN_LIMIT });
    return rows.map(asset => ({
        assetId: asset.assetId,
        ...(asset.name ? { name: asset.name } : {}),
        ...(asset.symbol ? { symbol: asset.symbol } : {}),
        category: asset.category,
    }));
}

/* ------------------------------------------------------------------------- *
 * previewMint
 * ------------------------------------------------------------------------- */

export interface PreviewMintResult {
    exists: boolean;
    assetId: string;
    category?: string;
    name?: string;
    symbol?: string;
    imageUrl?: string;
    hasMarketData: boolean;
    lastFetchedAt?: number;
}

export async function previewMint(
    deps: AdminReadsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<PreviewMintResult | null> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const mint = requireString(obj, 'mint').trim();
    if (!mint || !looksLikeSolanaMintAddress(mint)) return null;

    const existingVariant = await deps.repo.getVariantByMint(mint);
    const existingAsset = existingVariant ? await deps.repo.getAssetByAssetId(existingVariant.assetId) : null;
    const market = existingVariant ? existingVariant.market : await deps.repo.getMarketByMint(mint);

    const suggestedAssetId = existingVariant?.assetId || `solana-${mint}`;
    const name = market?.name ?? existingAsset?.name ?? null;
    const symbol = market?.symbol ?? existingAsset?.symbol ?? null;

    return {
        exists: !!existingVariant,
        assetId: suggestedAssetId,
        ...(existingAsset?.category ? { category: existingAsset.category } : {}),
        ...(market?.name || existingAsset?.name ? { name: name! } : {}),
        ...(market?.symbol || existingAsset?.symbol ? { symbol: symbol! } : {}),
        ...(market?.logoURI
            ? { imageUrl: market.logoURI }
            : existingAsset?.imageUrl
              ? { imageUrl: existingAsset.imageUrl }
              : {}),
        hasMarketData: !!market,
        ...(market?.lastFetchedAt ? { lastFetchedAt: market.lastFetchedAt } : {}),
    };
}
