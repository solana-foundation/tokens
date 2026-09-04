/**
 * Shared helpers + row types for the admin curated-tokens handlers.
 * Semantics mirror the private helpers in `convex/adminCuratedTokens.ts`.
 */

import { getCanonicalFallbackLogoPath } from '@tokens/asset-registry';
import type { AssetCategory, StockVariantTier, VariantKind } from '@tokens/asset-registry';
import { ADMIN_ASSIGNABLE_CURATED_SLUGS, CURATED_LIST_SLUGS } from '@tokens/asset-registry/curated-lists';
import type { AdminAssignableCuratedSlug } from '@tokens/asset-registry/curated-lists';

import { InvalidArgsError } from './errors';

// Assignable slugs exclude `lsts` (Sanctum-dynamic; syncCollections would
// otherwise strip LST membership on every category edit). Hard delete may
// still purge membership from every curated collection.
export const CURATED_CATEGORY_SLUGS = ADMIN_ASSIGNABLE_CURATED_SLUGS;
export const HARD_DELETE_COLLECTION_SLUGS = CURATED_LIST_SLUGS;
export type CuratedCategorySlug = AdminAssignableCuratedSlug;

export const ASSET_ALIAS_KINDS = [
    'assetId',
    'name',
    'symbol',
    'ticker',
    'coingeckoId',
    'alias',
    'mint',
    'variantId',
    'custom',
] as const;

export const ASSET_CATEGORY_VALUES: readonly AssetCategory[] = [
    'crypto',
    'stablecoin',
    'lst',
    'rwa',
    'commodity',
    'equity',
    'etf',
    'index',
];

export const VARIANT_KIND_VALUES: readonly VariantKind[] = [
    'native',
    'wrapped',
    'bridged',
    'spot',
    'etf',
    'yield',
    'leveraged',
    'basket',
    'lst',
    'stablecoin',
    'tokenized_equity',
];

/** The trust tier stored on variants (Convex allowed 'experimental', unlike LiquidityTier). */
export type StoredTrustTier = 'tier1' | 'tier2' | 'tier3' | 'experimental';
export const TRUST_TIER_VALUES: readonly StoredTrustTier[] = ['tier1', 'tier2', 'tier3', 'experimental'];

export const STOCK_VARIANT_TIER_VALUES: readonly StockVariantTier[] = [
    'share_redeemable',
    'cash_redeemable',
    'not_redeemable',
];

/** `imageStorageId` was dropped by the Postgres migrator, so 'storage' is gone from the union. */
export type LogoSource = 'url' | 'override' | 'variant' | 'none';

export function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export function normalizeOptionalText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function uniqueStrings(values: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

export function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Port of Convex `resolveCanonicalLogoState` minus the `_storage` branch:
 * image_url → static fallback override → best-variant logo → none.
 */
export function resolveCanonicalLogoState(
    asset: { assetId: string; name: string | null; symbol: string | null; imageUrl: string | null },
    variantLogoUrl?: string | null,
): { resolvedImageUrl: string | null; logoSource: LogoSource } {
    const imageUrl = (asset.imageUrl ?? '').trim();
    if (imageUrl) return { resolvedImageUrl: imageUrl, logoSource: 'url' };

    const overrideUrl = getCanonicalFallbackLogoPath({
        assetId: asset.assetId,
        symbol: asset.symbol ?? null,
        name: asset.name ?? null,
    });
    if (overrideUrl) return { resolvedImageUrl: overrideUrl, logoSource: 'override' };

    const variantUrl = (variantLogoUrl ?? '').trim();
    if (variantUrl) return { resolvedImageUrl: variantUrl, logoSource: 'variant' };

    return { resolvedImageUrl: null, logoSource: 'none' };
}

/* ------------------------------------------------------------------------- *
 * Args validation helpers (Convex validators → InvalidArgsError).
 * ------------------------------------------------------------------------- */

export function asArgsObject(args: unknown): Record<string, unknown> {
    if (args === undefined || args === null) return {};
    if (typeof args !== 'object' || Array.isArray(args)) {
        throw new InvalidArgsError('args must be an object');
    }
    return args as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
    const value = obj[key];
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string`);
    return value;
}

export function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string`);
    return value;
}

/** Convex `v.optional(v.union(v.string(), v.null()))`: undefined = unchanged, null/'' = clear. */
export function optionalNullableString(obj: Record<string, unknown>, key: string): string | null | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string or null`);
    return value;
}

export function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new InvalidArgsError(`${key} must be a boolean`);
    return value;
}

export function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError(`${key} must be a number`);
    }
    return value;
}

export function requireStringArray(obj: Record<string, unknown>, key: string): string[] {
    const value = obj[key];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new InvalidArgsError(`${key} must be an array of strings`);
    }
    return value as string[];
}

export function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
    if (obj[key] === undefined) return undefined;
    return requireStringArray(obj, key);
}

export function requireEnum<T extends string>(
    obj: Record<string, unknown>,
    key: string,
    values: readonly T[],
): T {
    const value = obj[key];
    if (typeof value !== 'string' || !values.includes(value as T)) {
        throw new InvalidArgsError(`${key} must be one of: ${values.join(', ')}`);
    }
    return value as T;
}

export function optionalEnum<T extends string>(
    obj: Record<string, unknown>,
    key: string,
    values: readonly T[],
): T | undefined {
    if (obj[key] === undefined) return undefined;
    return requireEnum(obj, key, values);
}

/** Convex `v.optional(v.union(<enum>, v.null()))`. */
export function optionalNullableEnum<T extends string>(
    obj: Record<string, unknown>,
    key: string,
    values: readonly T[],
): T | null | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (value === null) return null;
    return requireEnum(obj, key, values);
}

export function requireCuratedSlugArray(obj: Record<string, unknown>, key: string): CuratedCategorySlug[] {
    const value = obj[key];
    if (
        !Array.isArray(value) ||
        value.some(item => typeof item !== 'string' || !CURATED_CATEGORY_SLUGS.includes(item as CuratedCategorySlug))
    ) {
        throw new InvalidArgsError(`${key} must be an array of curated category slugs`);
    }
    return value as CuratedCategorySlug[];
}

export function optionalCuratedSlugArray(
    obj: Record<string, unknown>,
    key: string,
): CuratedCategorySlug[] | undefined {
    if (obj[key] === undefined) return undefined;
    return requireCuratedSlugArray(obj, key);
}
