/**
 * Admin curated-tokens mutation handlers.
 *
 * Ports of the mutation exports in `convex/adminCuratedTokens.ts`:
 * `createCanonicalAsset`, `updateCanonicalAsset`, `deleteCanonicalAsset`,
 * `createVariant`, `updateVariant`, `deleteVariant`, `deactivateVariant`,
 * `moveVariantToCanonical`, `removeFromCategory`.
 *
 * Handlers validate args and map repo outcomes to `InvalidArgsError`s carrying
 * the exact Convex error messages; each repo method is a single Postgres
 * transaction (postgres-js `sql.begin`).
 */

import type { AssetCategory, StockVariantTier, VariantKind } from '@tokens/asset-registry';
import { CURATED_LIST_SLUGS, type CuratedListSlug } from '@tokens/asset-registry/curated-lists';

import { InvalidArgsError } from './errors';
import {
    ASSET_CATEGORY_VALUES,
    CURATED_CATEGORY_SLUGS,
    STOCK_VARIANT_TIER_VALUES,
    TRUST_TIER_VALUES,
    VARIANT_KIND_VALUES,
    asArgsObject,
    looksLikeSolanaMintAddress,
    normalizeOptionalText,
    optionalBoolean,
    optionalCuratedSlugArray,
    optionalEnum,
    optionalNullableEnum,
    optionalNullableString,
    optionalString,
    optionalStringArray,
    requireEnum,
    requireString,
    requireStringArray,
    uniqueStrings,
    type CuratedCategorySlug,
    type StoredTrustTier,
} from './shared';
import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import type { CallerIdentity } from '../server';

/** Alias priorities per kind (mirrors Convex `replaceAliasesForKind*` call sites). */
export const ALIAS_PRIORITIES = {
    name: 900,
    symbol: 800,
    coingeckoId: 700,
    custom: 500,
} as const;

/* ------------------------------------------------------------------------- *
 * Repo interface — each method is one transaction.
 * ------------------------------------------------------------------------- */

export interface CreateCanonicalAssetWrite {
    assetId: string;
    category: AssetCategory;
    name: string | null;
    symbol: string | null;
    coingeckoId: string | null;
    description: string | null;
    imageUrl: string | null;
    /** Unique, trimmed custom aliases (priority 500). */
    aliases: string[];
    collections: CuratedCategorySlug[];
    nowMs: number;
}

export interface UpdateCanonicalAssetWrite {
    assetId: string;
    category?: AssetCategory;
    /** undefined = unchanged; null = clear; string = set (already normalized). */
    name?: string | null;
    symbol?: string | null;
    coingeckoId?: string | null;
    description?: string | null;
    imageUrl?: string | null;
    clearImage: boolean;
    aliases?: string[];
    collections?: CuratedCategorySlug[];
    isActive?: boolean;
    nowMs: number;
}

export interface CreateVariantWrite {
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
    /** undefined = untouched; null = clear; string = set (already normalized). */
    marketSymbol?: string | null;
    marketName?: string | null;
    marketLogoURI?: string | null;
    nowMs: number;
}

export interface UpdateVariantWrite {
    mint: string;
    variantId?: string;
    kind?: VariantKind;
    trustTier?: StoredTrustTier;
    tags?: string[];
    label?: string | null;
    issuer?: string | null;
    issuerUrl?: string | null;
    stockVariantTier?: StockVariantTier | null;
    isActive?: boolean;
    marketSymbol?: string | null;
    marketName?: string | null;
    marketLogoURI?: string | null;
    nowMs: number;
}

export type CreateVariantOutcome =
    | { status: 'created' }
    | { status: 'asset_not_found' }
    | { status: 'mint_exists'; ownerAssetId: string }
    | { status: 'variant_id_exists' };

export type MoveVariantOutcome =
    | { status: 'moved'; fromAssetId: string }
    | { status: 'noop'; fromAssetId: string }
    | { status: 'variant_not_found' }
    | { status: 'asset_not_found' }
    | { status: 'variant_id_collision' };

export interface UpdateCollectionMetaWrite {
    slug: CuratedListSlug;
    /** Undefined leaves the column untouched. */
    title?: string;
    /** Undefined leaves the column untouched; null clears it. */
    description?: string | null;
    nowMs: number;
}

export interface AdminMutationsRepo {
    createCanonicalAsset(args: CreateCanonicalAssetWrite): Promise<'created' | 'exists'>;
    updateCanonicalAsset(args: UpdateCanonicalAssetWrite): Promise<'updated' | 'not_found'>;
    deleteCanonicalAsset(args: { assetId: string }): Promise<'deleted' | 'not_found' | 'has_variants'>;
    createVariant(args: CreateVariantWrite): Promise<CreateVariantOutcome>;
    updateVariant(args: UpdateVariantWrite): Promise<'updated' | 'not_found' | 'variant_id_collision'>;
    deleteVariant(args: { mint: string }): Promise<'deleted' | 'not_found'>;
    deactivateVariant(args: { mint: string; isActive: boolean; nowMs: number }): Promise<'updated' | 'not_found'>;
    moveVariantToCanonical(args: { mint: string; toAssetId: string; nowMs: number }): Promise<MoveVariantOutcome>;
    /** Returns true when a membership row was deleted. */
    removeFromCategory(args: { slug: CuratedCategorySlug; assetId: string }): Promise<boolean>;
    updateCollectionMeta(args: UpdateCollectionMetaWrite): Promise<void>;
}

export interface AdminMutationsDeps {
    repo: AdminMutationsRepo;
    adminAllowlist: AdminAllowlist;
    now?: () => number;
}

function nowMs(deps: AdminMutationsDeps): number {
    return deps.now ? deps.now() : Date.now();
}

/* ------------------------------------------------------------------------- *
 * createCanonicalAsset
 * ------------------------------------------------------------------------- */

export async function createCanonicalAsset(
    deps: AdminMutationsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ assetId: string; created: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const assetId = requireString(obj, 'assetId').trim();
    if (!assetId) throw new InvalidArgsError('assetId is required');
    const category = requireEnum(obj, 'category', ASSET_CATEGORY_VALUES);
    const aliases = optionalStringArray(obj, 'aliases') ?? [];
    const collections = optionalCuratedSlugArray(obj, 'collections') ?? [];

    const outcome = await deps.repo.createCanonicalAsset({
        assetId,
        category,
        name: normalizeOptionalText(optionalNullableString(obj, 'name')),
        symbol: normalizeOptionalText(optionalNullableString(obj, 'symbol')),
        coingeckoId: normalizeOptionalText(optionalNullableString(obj, 'coingeckoId')),
        description: normalizeOptionalText(optionalNullableString(obj, 'description')),
        imageUrl: normalizeOptionalText(optionalNullableString(obj, 'imageUrl')),
        aliases: uniqueStrings(aliases),
        collections,
        nowMs: nowMs(deps),
    });
    if (outcome === 'exists') throw new InvalidArgsError('Canonical asset already exists');
    return { assetId, created: true };
}

/* ------------------------------------------------------------------------- *
 * updateCanonicalAsset
 * ------------------------------------------------------------------------- */

export async function updateCanonicalAsset(
    deps: AdminMutationsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ assetId: string; updated: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const assetId = requireString(obj, 'assetId').trim();
    if (!assetId) throw new InvalidArgsError('assetId is required');

    const clearImage = optionalBoolean(obj, 'clearImage') ?? false;
    const normalizeTriState = (key: string): string | null | undefined => {
        const value = optionalNullableString(obj, key);
        return value === undefined ? undefined : normalizeOptionalText(value);
    };

    const category = optionalEnum(obj, 'category', ASSET_CATEGORY_VALUES);
    const name = normalizeTriState('name');
    const symbol = normalizeTriState('symbol');
    const coingeckoId = normalizeTriState('coingeckoId');
    const description = normalizeTriState('description');
    const imageUrl = normalizeTriState('imageUrl');
    const aliases = optionalStringArray(obj, 'aliases');
    const collections = optionalCuratedSlugArray(obj, 'collections');
    const isActive = optionalBoolean(obj, 'isActive');

    const outcome = await deps.repo.updateCanonicalAsset({
        assetId,
        ...(category !== undefined ? { category } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(symbol !== undefined ? { symbol } : {}),
        ...(coingeckoId !== undefined ? { coingeckoId } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(imageUrl !== undefined ? { imageUrl } : {}),
        clearImage,
        ...(aliases !== undefined ? { aliases: uniqueStrings(aliases) } : {}),
        ...(collections !== undefined ? { collections } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        nowMs: nowMs(deps),
    });
    if (outcome === 'not_found') throw new InvalidArgsError('Canonical asset not found');
    return { assetId, updated: true };
}

/* ------------------------------------------------------------------------- *
 * deleteCanonicalAsset
 * ------------------------------------------------------------------------- */

export async function deleteCanonicalAsset(
    deps: AdminMutationsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ assetId: string; deleted: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const assetId = requireString(obj, 'assetId').trim();
    if (!assetId) throw new InvalidArgsError('assetId is required');

    const outcome = await deps.repo.deleteCanonicalAsset({ assetId });
    if (outcome === 'not_found') throw new InvalidArgsError('Canonical asset not found');
    if (outcome === 'has_variants') {
        throw new InvalidArgsError('Cannot delete a canonical asset while variants still exist');
    }
    return { assetId, deleted: true };
}

/* ------------------------------------------------------------------------- *
 * createVariant
 * ------------------------------------------------------------------------- */

export async function createVariant(
    deps: AdminMutationsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ assetId: string; mint: string; created: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const assetId = requireString(obj, 'assetId').trim();
    const mint = requireString(obj, 'mint').trim();
    const variantId = requireString(obj, 'variantId').trim();
    if (!assetId) throw new InvalidArgsError('assetId is required');
    if (!looksLikeSolanaMintAddress(mint)) throw new InvalidArgsError('Not a valid Solana mint address');
    if (!variantId) throw new InvalidArgsError('variantId is required');

    const kind = requireEnum(obj, 'kind', VARIANT_KIND_VALUES);
    const trustTier = requireEnum(obj, 'trustTier', TRUST_TIER_VALUES);
    const tags = requireStringArray(obj, 'tags');
    const stockVariantTier = optionalNullableEnum(obj, 'stockVariantTier', STOCK_VARIANT_TIER_VALUES);
    const marketTriState = (key: string): string | null | undefined => {
        const value = optionalNullableString(obj, key);
        return value === undefined ? undefined : normalizeOptionalText(value);
    };
    const marketSymbol = marketTriState('marketSymbol');
    const marketName = marketTriState('marketName');
    const marketLogoURI = marketTriState('marketLogoURI');

    const outcome = await deps.repo.createVariant({
        assetId,
        mint,
        variantId,
        kind,
        trustTier,
        tags: uniqueStrings(tags),
        label: normalizeOptionalText(optionalNullableString(obj, 'label')),
        issuer: normalizeOptionalText(optionalNullableString(obj, 'issuer')),
        issuerUrl: normalizeOptionalText(optionalNullableString(obj, 'issuerUrl')),
        stockVariantTier: stockVariantTier ?? null,
        isActive: optionalBoolean(obj, 'isActive') ?? true,
        ...(marketSymbol !== undefined ? { marketSymbol } : {}),
        ...(marketName !== undefined ? { marketName } : {}),
        ...(marketLogoURI !== undefined ? { marketLogoURI } : {}),
        nowMs: nowMs(deps),
    });

    if (outcome.status === 'asset_not_found') throw new InvalidArgsError('Canonical asset not found');
    if (outcome.status === 'mint_exists') {
        throw new InvalidArgsError(`Mint already belongs to ${outcome.ownerAssetId}`);
    }
    if (outcome.status === 'variant_id_exists') {
        throw new InvalidArgsError('variantId already exists for this canonical asset');
    }
    return { assetId, mint, created: true };
}

/* ------------------------------------------------------------------------- *
 * updateVariant
 * ------------------------------------------------------------------------- */

export async function updateVariant(
    deps: AdminMutationsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ mint: string; updated: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const mint = requireString(obj, 'mint').trim();
    if (!mint) throw new InvalidArgsError('mint is required');

    let variantId: string | undefined;
    const rawVariantId = optionalString(obj, 'variantId');
    if (rawVariantId !== undefined) {
        variantId = rawVariantId.trim();
        if (!variantId) throw new InvalidArgsError('variantId is required');
    }

    const kind = optionalEnum(obj, 'kind', VARIANT_KIND_VALUES);
    const trustTier = optionalEnum(obj, 'trustTier', TRUST_TIER_VALUES);
    const tags = optionalStringArray(obj, 'tags');
    const stockVariantTier = optionalNullableEnum(obj, 'stockVariantTier', STOCK_VARIANT_TIER_VALUES);
    const isActive = optionalBoolean(obj, 'isActive');
    const triState = (key: string): string | null | undefined => {
        const value = optionalNullableString(obj, key);
        return value === undefined ? undefined : normalizeOptionalText(value);
    };
    const label = triState('label');
    const issuer = triState('issuer');
    const issuerUrl = triState('issuerUrl');
    const marketSymbol = triState('marketSymbol');
    const marketName = triState('marketName');
    const marketLogoURI = triState('marketLogoURI');

    const outcome = await deps.repo.updateVariant({
        mint,
        ...(variantId !== undefined ? { variantId } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(trustTier !== undefined ? { trustTier } : {}),
        ...(tags !== undefined ? { tags: uniqueStrings(tags) } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(issuer !== undefined ? { issuer } : {}),
        ...(issuerUrl !== undefined ? { issuerUrl } : {}),
        ...(stockVariantTier !== undefined ? { stockVariantTier } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        ...(marketSymbol !== undefined ? { marketSymbol } : {}),
        ...(marketName !== undefined ? { marketName } : {}),
        ...(marketLogoURI !== undefined ? { marketLogoURI } : {}),
        nowMs: nowMs(deps),
    });

    if (outcome === 'not_found') throw new InvalidArgsError('Variant not found');
    if (outcome === 'variant_id_collision') {
        throw new InvalidArgsError('variantId already exists for this canonical asset');
    }
    return { mint, updated: true };
}

/* ------------------------------------------------------------------------- *
 * deleteVariant / deactivateVariant / moveVariantToCanonical
 * ------------------------------------------------------------------------- */

export async function deleteVariant(
    deps: AdminMutationsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ mint: string; deleted: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const mint = requireString(obj, 'mint').trim();
    if (!mint) throw new InvalidArgsError('mint is required');

    const outcome = await deps.repo.deleteVariant({ mint });
    if (outcome === 'not_found') throw new InvalidArgsError('Variant not found');
    return { mint, deleted: true };
}

export async function deactivateVariant(
    deps: AdminMutationsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ mint: string; isActive: boolean; updated: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const mint = requireString(obj, 'mint').trim();
    if (!mint) throw new InvalidArgsError('mint is required');
    const isActive = optionalBoolean(obj, 'isActive') ?? false;

    const outcome = await deps.repo.deactivateVariant({ mint, isActive, nowMs: nowMs(deps) });
    if (outcome === 'not_found') throw new InvalidArgsError('Variant not found');
    return { mint, isActive, updated: true };
}

export async function moveVariantToCanonical(
    deps: AdminMutationsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ mint: string; fromAssetId: string; toAssetId: string; moved: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const mint = requireString(obj, 'mint').trim();
    const toAssetId = requireString(obj, 'assetId').trim();
    if (!mint) throw new InvalidArgsError('mint is required');
    if (!toAssetId) throw new InvalidArgsError('assetId is required');

    const outcome = await deps.repo.moveVariantToCanonical({ mint, toAssetId, nowMs: nowMs(deps) });
    if (outcome.status === 'variant_not_found') throw new InvalidArgsError('Variant not found');
    if (outcome.status === 'asset_not_found') {
        throw new InvalidArgsError('Destination canonical asset not found');
    }
    if (outcome.status === 'variant_id_collision') {
        throw new InvalidArgsError('Destination canonical already has this variantId');
    }
    if (outcome.status === 'noop') {
        return { mint, fromAssetId: outcome.fromAssetId, toAssetId, moved: false };
    }
    return { mint, fromAssetId: outcome.fromAssetId, toAssetId, moved: true };
}

/* ------------------------------------------------------------------------- *
 * removeFromCategory
 * ------------------------------------------------------------------------- */

export async function removeFromCategory(
    deps: AdminMutationsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ removed: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const slug = requireEnum(obj, 'slug', CURATED_CATEGORY_SLUGS);
    const assetId = requireString(obj, 'assetId').trim();
    if (!assetId) return { removed: false };

    const removed = await deps.repo.removeFromCategory({ slug, assetId });
    return { removed };
}


/* ------------------------------------------------------------------------- *
 * updateCollectionMeta
 * ------------------------------------------------------------------------- */

const COLLECTION_TITLE_MAX = 80;
const COLLECTION_DESCRIPTION_MAX = 300;

/**
 * Edit a curated list's public display metadata (`asset_collections.title` /
 * `.description`) — what `/api/v2/lists` and `/api/v1/assets/curated/lists`
 * serve. The DB is authoritative for these: the nightly registry seed no
 * longer refreshes them and `adminSeedAsset` only inserts them when missing.
 *
 * All seven curated slugs are editable, including `lsts`: its *membership* is
 * Sanctum-driven, but its title is ordinary display text.
 */
export async function updateCollectionMeta(
    deps: AdminMutationsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ slug: CuratedListSlug; updated: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const slug = requireEnum(obj, 'slug', CURATED_LIST_SLUGS);

    const hasTitle = obj.title !== undefined;
    const hasDescription = obj.description !== undefined;
    if (!hasTitle && !hasDescription) {
        throw new InvalidArgsError('Provide at least one of: title, description');
    }

    let title: string | undefined;
    if (hasTitle) {
        title = requireString(obj, 'title').trim();
        if (!title) throw new InvalidArgsError('title must not be empty');
        if (title.length > COLLECTION_TITLE_MAX) {
            throw new InvalidArgsError(`title must be at most ${COLLECTION_TITLE_MAX} characters`);
        }
    }

    let description: string | null | undefined;
    if (hasDescription) {
        // Empty string clears the column (there is no other way to unset it).
        description = normalizeOptionalText(optionalNullableString(obj, 'description'));
        if (description !== null && description.length > COLLECTION_DESCRIPTION_MAX) {
            throw new InvalidArgsError(`description must be at most ${COLLECTION_DESCRIPTION_MAX} characters`);
        }
    }

    await deps.repo.updateCollectionMeta({
        slug,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        nowMs: nowMs(deps),
    });
    return { slug, updated: true };
}
