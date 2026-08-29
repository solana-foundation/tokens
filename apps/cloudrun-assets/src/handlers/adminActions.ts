/**
 * Admin curated-token actions, ported from `convex/adminCuratedTokensActions.ts`
 * plus the pieces of `convex/adminCuratedTokens.ts` / `convex/assetsSeedMutations.ts`
 * they called (`getCanonicalEditor`, `listVariantsByAssetId`,
 * `createVariantFromCheckedPreview`, `findCategoryForAssetId`,
 * `getNextCategoryRank`, `upsertAssetCollection[Member]`, `clearDeletedRefs`,
 * `refreshAssetMarket`).
 *
 * Semantics notes vs Convex:
 * - Auth: `requireAdmin` reads the injected admin allowlist
 *   (`TOKENS_ADMIN_CLERK_USER_IDS` ∪ `TOKENS_ADMIN_EMAILS`) and maps to 401
 *   (no identity) / 403 (not allowlisted) instead of Convex's generic
 *   `Error('Unauthorized')`.
 * - User-facing validation/conflict errors are thrown as `InvalidArgsError` so
 *   the dispatcher returns the message with a 400 instead of an opaque 500
 *   (`handler_error` drops the message). The messages themselves mirror Convex.
 * - Where Convex used `ctx.scheduler.runAfter(0, ...)` for chart warms, these
 *   handlers AWAIT the refresh job handlers in-process via `Promise.allSettled`
 *   (Cloud Run throttles CPU after the response). Warm failures are logged and
 *   swallowed — in Convex a successfully *enqueued* job already counted as
 *   "scheduled".
 * - `createVariantFromCheckedPreview` raced between check and insert in Convex
 *   too; here a unique violation on (asset_id, variant_id) retries with the
 *   next `-N` suffix before giving up with the Convex error message.
 */

import { getVariantByMint } from '@tokens/asset-registry';
import { CURATED_LIST_FALLBACK_NAMES } from '@tokens/asset-registry/curated-lists';

import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import { InvalidArgsError, type CallerIdentity } from './assets';
import {
    refreshCuratedOhlcv,
    type AssetAggregateUpsert,
    type BirdeyeOverview,
    type CronDeps,
    type VariantMarketUpsertFromBirdeye,
} from './crons';
import { refreshCuratedTokenMarkets, type MiscCronDeps } from './crons.misc';
import type { SeedRepo } from './crons.seed';

/* ============================================================================
   Types
   ============================================================================ */

export const CURATED_CATEGORY_SLUGS = ['majors', 'currencies', 'rwas', 'etfs', 'metals', 'stocks'] as const;
export type CuratedCategorySlug = (typeof CURATED_CATEGORY_SLUGS)[number];

type AssetCategory = 'crypto' | 'stablecoin' | 'lst' | 'rwa' | 'commodity' | 'equity' | 'etf' | 'index';

const VARIANT_KINDS = [
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
] as const;
type VariantKind = (typeof VARIANT_KINDS)[number];

const TRUST_TIERS = ['tier1', 'tier2', 'tier3', 'experimental'] as const;
type TrustTier = (typeof TRUST_TIERS)[number];

const STOCK_VARIANT_TIERS = ['share_redeemable', 'cash_redeemable', 'not_redeemable'] as const;
type StockVariantTier = (typeof STOCK_VARIANT_TIERS)[number];

export interface BirdeyeExtensions {
    coingeckoId?: string;
    website?: string;
    twitter?: string;
    discord?: string;
    telegram?: string;
    description?: string;
    github?: string;
}

export interface CheckedVariantWrite {
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
}

export interface CheckedMarketWrite {
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
    extensions: BirdeyeExtensions | null;
    lastFetchedAt: number;
}

export interface CheckedVariantPreview {
    assetId: string;
    mint: string;
    checkedAt: number;
    conflict:
        | { type: 'same_canonical'; assetId: string; variantId: string }
        | { type: 'other_canonical'; assetId: string; variantId: string }
        | null;
    variantWrite: CheckedVariantWrite;
    marketWrite: CheckedMarketWrite;
}

/* ============================================================================
   Repo
   ============================================================================ */

export interface AdminAssetRow {
    assetId: string;
    category: string;
}

export interface AdminVariantIdentityRow {
    assetId: string;
    variantId: string;
}

export interface AdminVariantInsert {
    assetId: string;
    chain: 'solana';
    mint: string;
    variantId: string;
    kind: string;
    trustTier: string;
    stockVariantTier?: string;
    tags: string[];
    label?: string;
    isActive: boolean;
}

/** Thrown by `createVariantWithMarket` when the mint is already attached to a canonical. */
export class MintConflictError extends Error {
    readonly assetId: string;
    constructor(assetId: string) {
        super(`Mint already belongs to ${assetId}`);
        this.name = 'MintConflictError';
        this.assetId = assetId;
    }
}

/** Thrown by `createVariantWithMarket` on a unique violation of (asset_id, variant_id). */
export class VariantIdConflictError extends Error {
    constructor() {
        super('variantId already exists for this canonical asset');
        this.name = 'VariantIdConflictError';
    }
}

export interface AdminActionsRepo {
    findAssetByAssetId(assetId: string): Promise<AdminAssetRow | null>;
    /** All collection memberships for the asset (any slug, active or not). */
    listCollectionSlugsForAssetId(assetId: string): Promise<string[]>;
    /** Any variant row for the mint, including inactive ones. */
    findVariantByMint(mint: string): Promise<AdminVariantIdentityRow | null>;
    listVariantIdsByAssetId(assetId: string): Promise<string[]>;
    /**
     * Transactionally INSERTs the variant (plain insert, no upsert) and upserts
     * `variant_markets_latest`. Throws `MintConflictError` when the mint is
     * already attached and `VariantIdConflictError` on a (asset_id, variant_id)
     * unique violation.
     */
    createVariantWithMarket(variant: AdminVariantInsert, market: VariantMarketUpsertFromBirdeye): Promise<void>;
    /** Port of `getNextCategoryRank`: max(rank)+1 for the collection (or 0). */
    getNextCategoryRank(slug: string): Promise<number>;
    /** Port of `assetsSeedMutations.upsertAssetCollectionMember` (keyed on slug+assetId). */
    upsertAssetCollectionMember(args: { collectionSlug: string; assetId: string; rank: number }): Promise<void>;
    /** INSERT the collection row iff the slug is missing; never rewrites admin-owned title/description. */
    ensureAssetCollection(slug: string, title: string): Promise<void>;
    /** Port of `assetDeletionTombstones.clearDeletedRefs`; takes normalized refs, returns rows deleted. */
    clearDeletedRefs(normalizedRefs: readonly string[]): Promise<number>;
}

export interface AdminActionsDeps {
    adminAllowlist: AdminAllowlist;
    repo: AdminActionsRepo;
    seedRepo: SeedRepo;
    cron: CronDeps;
    misc: MiscCronDeps;
    now: () => number;
}

/* ============================================================================
   Small helpers (ports of the Convex helpers of the same names)
   ============================================================================ */

export function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

function singletonAssetIdForMint(mint: string): string {
    return `solana-${mint.trim()}`;
}

function kindForCategory(category: AssetCategory): VariantKind {
    switch (category) {
        case 'equity':
            return 'tokenized_equity';
        case 'etf':
            return 'etf';
        case 'stablecoin':
            return 'stablecoin';
        case 'lst':
            return 'lst';
        default:
            return 'wrapped';
    }
}

function categoryForSlug(slug: CuratedCategorySlug): AssetCategory {
    switch (slug) {
        case 'currencies':
            return 'stablecoin';
        case 'rwas':
            return 'rwa';
        case 'etfs':
            return 'etf';
        case 'metals':
            return 'commodity';
        case 'stocks':
            return 'equity';
        case 'majors':
        default:
            return 'crypto';
    }
}

function kindForSlug(slug: CuratedCategorySlug): VariantKind {
    switch (slug) {
        case 'currencies':
            return 'stablecoin';
        case 'etfs':
            return 'etf';
        case 'stocks':
            return 'tokenized_equity';
        default:
            return 'wrapped';
    }
}

export function variantIdSuffix(value: string): string {
    const suffix = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return suffix || 'mint';
}

function uniqueStrings(values: readonly string[]): string[] {
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

function isCuratedCategorySlug(value: string): value is CuratedCategorySlug {
    return (CURATED_CATEGORY_SLUGS as readonly string[]).includes(value);
}

/** Port of `availableVariantIdForAsset` on top of a pre-fetched id set. */
export function availableVariantId(
    existingIds: ReadonlySet<string>,
    assetId: string,
    preferredSuffixes: readonly string[],
): string {
    const candidates = uniqueStrings(preferredSuffixes.map(suffix => `${assetId}:${variantIdSuffix(suffix)}`));

    for (const candidate of candidates) {
        if (!existingIds.has(candidate)) return candidate;
    }

    const base = candidates[0] ?? `${assetId}:mint`;
    for (let i = 2; i < 1000; i += 1) {
        const candidate = `${base}-${i}`;
        if (!existingIds.has(candidate)) return candidate;
    }

    throw new InvalidArgsError('Could not find an available variantId for this canonical asset');
}

export function cleanTokenName(name: string | undefined): string {
    if (!name) return 'Unknown';
    return (
        name
            // xStocks
            .replace(/\s*xStock\s*$/i, '')
            // Bridge/origin markers in parens
            .replace(/\s*\(\s*(wormhole|bridged|wrapped|omnibridge|coinbase|ondo\s+tokenized)\s*\)\s*/gi, ' ')
            // Remove (mSOL) and similar LST markers
            .replace(/\s*\(\s*mSOL\s*\)\s*/gi, ' ')
            // Wrapped variants
            .replace(/^\s*coinbase\s+wrapped\s+/i, '')
            .replace(/^\s*wrapped\s+/i, '')
            .replace(/\s+wrapped\s+/gi, ' ')
            .replace(/\s+wrapped\s*$/i, '')
            // LST suffixes
            .replace(/\s+staked\s+sol(?=\s*(\(|$))/i, '')
            // Normalize whitespace
            .replace(/\s{2,}/g, ' ')
            .trim() || 'Unknown'
    );
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function sanitizeBirdeyeExtensions(value: unknown): BirdeyeExtensions | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const obj = value as Record<string, unknown>;

    const out: Record<string, string> = {};
    const set = (key: string) => {
        const v = asNonEmptyString(obj[key]);
        if (v) out[key] = v;
    };

    set('coingeckoId');
    set('website');
    set('twitter');
    set('discord');
    set('telegram');
    set('description');
    set('github');

    return Object.keys(out).length > 0 ? (out as BirdeyeExtensions) : undefined;
}

interface NormalizedOverview {
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
    price?: number;
    priceChange24hPercent?: number;
    priceChange1hPercent?: number;
    volume24hUSD?: number;
    liquidity?: number;
    marketCap?: number;
    fdv?: number;
    holder?: number;
    totalSupply?: number;
    circulatingSupply?: number;
    lastTradeHumanTime?: string;
    extensions?: BirdeyeExtensions;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Port of `normalizeBirdeyeOverviewForDb`. */
export function normalizeBirdeyeOverviewForDb(overview: BirdeyeOverview): NormalizedOverview {
    const symbol = typeof overview.symbol === 'string' ? overview.symbol.trim() : '';
    const rawName = typeof overview.name === 'string' ? overview.name.trim() : '';
    const name = cleanTokenName(rawName);
    const decimals =
        typeof overview.decimals === 'number' && Number.isFinite(overview.decimals) ? overview.decimals : 9;

    if (!symbol) throw new InvalidArgsError('Missing symbol from Birdeye');
    if (!name || name === 'Unknown') throw new InvalidArgsError('Missing name from Birdeye');

    const extensions = sanitizeBirdeyeExtensions(overview.extensions);
    const logoURI = typeof overview.logoURI === 'string' ? overview.logoURI.trim() : '';
    const lastTradeHumanTime =
        typeof overview.lastTradeHumanTime === 'string' ? overview.lastTradeHumanTime.trim() : '';

    return {
        symbol,
        name,
        decimals,
        ...(logoURI ? { logoURI } : {}),
        ...(finiteNumber(overview.price) !== undefined ? { price: finiteNumber(overview.price) } : {}),
        ...(finiteNumber(overview.priceChange24hPercent) !== undefined
            ? { priceChange24hPercent: finiteNumber(overview.priceChange24hPercent) }
            : {}),
        ...(finiteNumber(overview.priceChange1hPercent) !== undefined
            ? { priceChange1hPercent: finiteNumber(overview.priceChange1hPercent) }
            : {}),
        ...(finiteNumber(overview.v24hUSD) !== undefined ? { volume24hUSD: finiteNumber(overview.v24hUSD) } : {}),
        ...(finiteNumber(overview.liquidity) !== undefined ? { liquidity: finiteNumber(overview.liquidity) } : {}),
        ...(finiteNumber(overview.marketCap) !== undefined ? { marketCap: finiteNumber(overview.marketCap) } : {}),
        ...(finiteNumber(overview.fdv) !== undefined ? { fdv: finiteNumber(overview.fdv) } : {}),
        ...(finiteNumber(overview.holder) !== undefined ? { holder: finiteNumber(overview.holder) } : {}),
        ...(finiteNumber(overview.totalSupply) !== undefined
            ? { totalSupply: finiteNumber(overview.totalSupply) }
            : {}),
        ...(finiteNumber(overview.circulatingSupply) !== undefined
            ? { circulatingSupply: finiteNumber(overview.circulatingSupply) }
            : {}),
        ...(lastTradeHumanTime ? { lastTradeHumanTime } : {}),
        ...(extensions ? { extensions } : {}),
    };
}

async function fetchBirdeyeTokenOverview(deps: AdminActionsDeps, mint: string): Promise<BirdeyeOverview> {
    const overview = await deps.cron.birdeye.fetchTokenOverview(mint);
    if (!overview) throw new InvalidArgsError('Birdeye token_overview failed');
    return overview;
}

function normalizedOverviewToUpsert(
    mint: string,
    normalized: NormalizedOverview,
    lastFetchedAt: number,
): VariantMarketUpsertFromBirdeye {
    return {
        mint,
        symbol: normalized.symbol,
        name: normalized.name,
        decimals: normalized.decimals,
        ...(normalized.logoURI !== undefined ? { logoURI: normalized.logoURI } : {}),
        ...(normalized.price !== undefined ? { price: normalized.price } : {}),
        ...(normalized.priceChange24hPercent !== undefined
            ? { priceChange24hPercent: normalized.priceChange24hPercent }
            : {}),
        ...(normalized.priceChange1hPercent !== undefined
            ? { priceChange1hPercent: normalized.priceChange1hPercent }
            : {}),
        ...(normalized.volume24hUSD !== undefined ? { volume24hUSD: normalized.volume24hUSD } : {}),
        ...(normalized.liquidity !== undefined ? { liquidity: normalized.liquidity } : {}),
        ...(normalized.marketCap !== undefined ? { marketCap: normalized.marketCap } : {}),
        ...(normalized.fdv !== undefined ? { fdv: normalized.fdv } : {}),
        ...(normalized.holder !== undefined ? { holder: normalized.holder } : {}),
        ...(normalized.totalSupply !== undefined ? { totalSupply: normalized.totalSupply } : {}),
        ...(normalized.circulatingSupply !== undefined ? { circulatingSupply: normalized.circulatingSupply } : {}),
        ...(normalized.lastTradeHumanTime !== undefined
            ? { lastTradeHumanTime: normalized.lastTradeHumanTime }
            : {}),
        ...(normalized.extensions ? { extensions: normalized.extensions as Record<string, string> } : {}),
        lastFetchedAt,
    };
}

function marketWriteToUpsert(market: CheckedMarketWrite): VariantMarketUpsertFromBirdeye {
    const mint = market.mint.trim();
    const logoURI = market.logoURI ? market.logoURI.trim() : '';
    const lastTradeHumanTime = market.lastTradeHumanTime ? market.lastTradeHumanTime.trim() : '';
    const extensions = sanitizeBirdeyeExtensions(market.extensions);
    return {
        mint,
        symbol: market.symbol.trim(),
        name: market.name.trim(),
        decimals: market.decimals,
        ...(logoURI ? { logoURI } : {}),
        ...(market.price !== null ? { price: market.price } : {}),
        ...(market.priceChange24hPercent !== null ? { priceChange24hPercent: market.priceChange24hPercent } : {}),
        ...(market.priceChange1hPercent !== null ? { priceChange1hPercent: market.priceChange1hPercent } : {}),
        ...(market.volume24hUSD !== null ? { volume24hUSD: market.volume24hUSD } : {}),
        ...(market.liquidity !== null ? { liquidity: market.liquidity } : {}),
        ...(market.marketCap !== null ? { marketCap: market.marketCap } : {}),
        ...(market.fdv !== null ? { fdv: market.fdv } : {}),
        ...(market.holder !== null ? { holder: market.holder } : {}),
        ...(market.totalSupply !== null ? { totalSupply: market.totalSupply } : {}),
        ...(market.circulatingSupply !== null ? { circulatingSupply: market.circulatingSupply } : {}),
        ...(lastTradeHumanTime ? { lastTradeHumanTime } : {}),
        ...(extensions ? { extensions: extensions as Record<string, string> } : {}),
        lastFetchedAt: market.lastFetchedAt,
    };
}

/* ============================================================================
   Args parsing
   ============================================================================ */

function asObject(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidArgsError('args must be an object');
    return raw as Record<string, unknown>;
}

function readRequiredString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string`);
    return value;
}

function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string`);
    return value;
}

function readRequiredNumber(args: Record<string, unknown>, key: string): number {
    const value = args[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError(`${key} must be a finite number`);
    }
    return value;
}

function readNullableNumber(args: Record<string, unknown>, key: string): number | null {
    const value = args[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError(`${key} must be a finite number or null`);
    }
    return value;
}

function readNullableString(args: Record<string, unknown>, key: string): string | null {
    const value = args[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string or null`);
    return value;
}

function readStringArray(args: Record<string, unknown>, key: string): string[] {
    const value = args[key];
    if (!Array.isArray(value)) throw new InvalidArgsError(`${key} must be an array of strings`);
    for (const item of value) {
        if (typeof item !== 'string') throw new InvalidArgsError(`${key} must be an array of strings`);
    }
    return value as string[];
}

function readEnum<T extends string>(
    args: Record<string, unknown>,
    key: string,
    values: readonly T[],
): T {
    const value = args[key];
    if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
        throw new InvalidArgsError(`${key} must be one of: ${values.join(',')}`);
    }
    return value as T;
}

function parseVariantWrite(raw: unknown): CheckedVariantWrite {
    const args = asObject(raw);
    const stockVariantTier = args.stockVariantTier;
    if (
        stockVariantTier !== undefined &&
        (typeof stockVariantTier !== 'string' ||
            !(STOCK_VARIANT_TIERS as readonly string[]).includes(stockVariantTier))
    ) {
        throw new InvalidArgsError(`variantWrite.stockVariantTier must be one of: ${STOCK_VARIANT_TIERS.join(',')}`);
    }
    if (args.chain !== 'solana') throw new InvalidArgsError('variantWrite.chain must be "solana"');
    if (typeof args.isActive !== 'boolean') throw new InvalidArgsError('variantWrite.isActive must be a boolean');
    return {
        assetId: readRequiredString(args, 'assetId'),
        chain: 'solana',
        mint: readRequiredString(args, 'mint'),
        variantId: readRequiredString(args, 'variantId'),
        kind: readEnum(args, 'kind', VARIANT_KINDS),
        trustTier: readEnum(args, 'trustTier', TRUST_TIERS),
        ...(stockVariantTier !== undefined ? { stockVariantTier: stockVariantTier as StockVariantTier } : {}),
        tags: readStringArray(args, 'tags'),
        label: readNullableString(args, 'label'),
        isActive: args.isActive,
    };
}

function parseMarketWrite(raw: unknown): CheckedMarketWrite {
    const args = asObject(raw);
    if (args.source !== 'birdeye') throw new InvalidArgsError('Only Birdeye market writes are supported');
    return {
        mint: readRequiredString(args, 'mint'),
        source: 'birdeye',
        symbol: readRequiredString(args, 'symbol'),
        name: readRequiredString(args, 'name'),
        decimals: readRequiredNumber(args, 'decimals'),
        logoURI: readNullableString(args, 'logoURI'),
        price: readNullableNumber(args, 'price'),
        priceChange24hPercent: readNullableNumber(args, 'priceChange24hPercent'),
        priceChange1hPercent: readNullableNumber(args, 'priceChange1hPercent'),
        volume24hUSD: readNullableNumber(args, 'volume24hUSD'),
        liquidity: readNullableNumber(args, 'liquidity'),
        marketCap: readNullableNumber(args, 'marketCap'),
        fdv: readNullableNumber(args, 'fdv'),
        holder: readNullableNumber(args, 'holder'),
        totalSupply: readNullableNumber(args, 'totalSupply'),
        circulatingSupply: readNullableNumber(args, 'circulatingSupply'),
        lastTradeHumanTime: readNullableString(args, 'lastTradeHumanTime'),
        extensions: sanitizeBirdeyeExtensions(args.extensions) ?? null,
        lastFetchedAt: readRequiredNumber(args, 'lastFetchedAt'),
    };
}

function parseCheckedPreview(raw: unknown): CheckedVariantPreview {
    if (raw === undefined || raw === null) throw new InvalidArgsError('checkedPreview is required');
    const args = asObject(raw);
    let conflict: CheckedVariantPreview['conflict'] = null;
    if (args.conflict !== null && args.conflict !== undefined) {
        const c = asObject(args.conflict);
        const type = c.type;
        if (type !== 'same_canonical' && type !== 'other_canonical') {
            throw new InvalidArgsError('checkedPreview.conflict.type is invalid');
        }
        conflict = {
            type,
            assetId: readRequiredString(c, 'assetId'),
            variantId: readRequiredString(c, 'variantId'),
        };
    }
    return {
        assetId: readRequiredString(args, 'assetId'),
        mint: readRequiredString(args, 'mint'),
        checkedAt: readRequiredNumber(args, 'checkedAt'),
        conflict,
        variantWrite: parseVariantWrite(args.variantWrite),
        marketWrite: parseMarketWrite(args.marketWrite),
    };
}

interface CheckedVariantOverrides {
    label?: string | null;
    trustTier?: TrustTier;
    stockVariantTier?: StockVariantTier | null;
    tags?: string[];
}

function parseOverrides(raw: unknown): CheckedVariantOverrides {
    const args = asObject(raw);
    const out: CheckedVariantOverrides = {};
    if ('label' in args && args.label !== undefined) out.label = readNullableString(args, 'label');
    if (args.trustTier !== undefined) out.trustTier = readEnum(args, 'trustTier', TRUST_TIERS);
    if ('stockVariantTier' in args && args.stockVariantTier !== undefined) {
        if (args.stockVariantTier === null) {
            out.stockVariantTier = null;
        } else {
            out.stockVariantTier = readEnum(args, 'stockVariantTier', STOCK_VARIANT_TIERS);
        }
    }
    if (args.tags !== undefined) out.tags = readStringArray(args, 'tags');
    return out;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/* ============================================================================
   Chart warms (port of `scheduleChartWarm`, awaited in-process)
   ============================================================================ */

export const POST_SEED_OHLCV_WARMS = [
    { interval: '15m' as const, days: 1 },
    { interval: '1H' as const, days: 90 },
    { interval: '4H' as const, days: 365 },
    { interval: '1D' as const, days: 365 },
];

function listScheduledChartWarmJobs(): string[] {
    return ['markets', ...POST_SEED_OHLCV_WARMS.map(({ interval }) => `ohlcv:${interval}`)];
}

async function awaitChartWarm(deps: AdminActionsDeps, mint: string): Promise<string[]> {
    const names = listScheduledChartWarmJobs();
    const results = await Promise.allSettled([
        refreshCuratedTokenMarkets(deps.misc, {
            mints: [mint],
            priorityCount: 0,
            maxMints: 1,
            minAgeMs: 0,
            concurrency: 1,
            delayMs: 0,
            maxMarketsPerMint: 20,
            selectionWindowMs: 60_000,
        }),
        ...POST_SEED_OHLCV_WARMS.map(({ interval, days }) =>
            refreshCuratedOhlcv(deps.cron, {
                mints: [mint],
                interval,
                days,
                priorityCount: 0,
                maxMints: 1,
                concurrency: 1,
                delayMs: 0,
                selectionWindowMs: 60_000,
            }),
        ),
    ]);
    results.forEach((result, i) => {
        if (result.status === 'rejected') {
            const reason = result.reason;
            console.error(
                `[adminActions] chart warm ${names[i]} failed for mint=${mint}`,
                reason instanceof Error ? reason.message : String(reason),
            );
        }
    });
    return names;
}

/* ============================================================================
   Single-asset aggregate rollup (port of `assetMarketRefresh.refreshAssetMarket`,
   using the same math as `refreshCuratedAssetMarkets` in crons.ts)
   ============================================================================ */

function isSpotLikeKind(kind: string): boolean {
    return (
        kind === 'native' ||
        kind === 'wrapped' ||
        kind === 'bridged' ||
        kind === 'spot' ||
        kind === 'stablecoin' ||
        kind === 'lst' ||
        kind === 'tokenized_equity' ||
        kind === 'basket'
    );
}

function trustTierRank(tier: string): number {
    if (tier === 'tier1') return 3;
    if (tier === 'tier2') return 2;
    return 1;
}

function toFiniteNonNegativeNumber(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return value >= 0 ? value : 0;
}

export async function refreshAssetAggregate(cron: CronDeps, assetId: string): Promise<void> {
    const now = cron.now();
    const rollup = await cron.repo.listVariantsForRollup([assetId]);
    const variants = rollup[0]?.variants ?? [];
    const spotLike = variants.filter(v => isSpotLikeKind(v.kind));
    const effective = spotLike.length > 0 ? spotLike : variants;
    const mints = effective.map(v => v.mint);

    const fromSeconds = Math.floor((now - 30 * 24 * 60 * 60_000) / 1000);
    const toSeconds = Math.floor(now / 1000);
    const volume30dByMint = await cron.repo.sumDailyOhlcvVolumeByAddresses(mints, fromSeconds, toSeconds);
    const mintRank = cron.curated.getCuratedMintRank();

    let liquidity = 0;
    let volume24hUSD = 0;
    let volume30dUSD = 0;
    let hasVolume30d = false;
    let minVariantLastFetchedAt: number | null = null;
    let maxVariantLastFetchedAt: number | null = null;

    for (const v of effective) {
        liquidity += toFiniteNonNegativeNumber(v.liquidity);
        volume24hUSD += toFiniteNonNegativeNumber(v.volume24hUSD);
        const v30 = volume30dByMint.get(v.mint) ?? null;
        if (v30 !== null) {
            hasVolume30d = true;
            volume30dUSD += toFiniteNonNegativeNumber(v30);
        }
        const last = v.lastFetchedAt ?? null;
        if (last !== null) {
            minVariantLastFetchedAt =
                minVariantLastFetchedAt === null ? last : Math.min(minVariantLastFetchedAt, last);
            maxVariantLastFetchedAt =
                maxVariantLastFetchedAt === null ? last : Math.max(maxVariantLastFetchedAt, last);
        }
    }

    let primaryMint: string | undefined;
    if (effective.length > 0) {
        let best = effective[0]!;
        for (let i = 1; i < effective.length; i++) {
            const cand = effective[i]!;
            const liqDelta = toFiniteNonNegativeNumber(cand.liquidity) - toFiniteNonNegativeNumber(best.liquidity);
            if (liqDelta !== 0) {
                if (liqDelta > 0) best = cand;
                continue;
            }
            const trustDelta = trustTierRank(cand.trustTier) - trustTierRank(best.trustTier);
            if (trustDelta !== 0) {
                if (trustDelta > 0) best = cand;
                continue;
            }
            const volDelta =
                toFiniteNonNegativeNumber(cand.volume24hUSD) - toFiniteNonNegativeNumber(best.volume24hUSD);
            if (volDelta !== 0) {
                if (volDelta > 0) best = cand;
                continue;
            }
            const candRank = mintRank.get(cand.mint) ?? Number.POSITIVE_INFINITY;
            const bestRank = mintRank.get(best.mint) ?? Number.POSITIVE_INFINITY;
            if (candRank < bestRank) best = cand;
        }
        primaryMint = best.mint;
    }

    const upsert: AssetAggregateUpsert = {
        assetId,
        liquidity: toFiniteNonNegativeNumber(liquidity),
        volume24hUSD: toFiniteNonNegativeNumber(volume24hUSD),
        volume30dUSD: hasVolume30d ? toFiniteNonNegativeNumber(volume30dUSD) : null,
        lastComputedAt: now,
    };
    if (primaryMint) upsert.primaryMint = primaryMint;
    if (minVariantLastFetchedAt !== null) upsert.minVariantLastFetchedAt = minVariantLastFetchedAt;
    if (maxVariantLastFetchedAt !== null) upsert.maxVariantLastFetchedAt = maxVariantLastFetchedAt;

    await cron.repo.upsertAssetAggregate(upsert);
}

/** Aggregate refresh is best-effort here: the periodic rollup cron self-heals. */
async function runBestEffort(label: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        console.error(`[adminActions] ${label} failed`, err);
    }
}

/* ============================================================================
   Handlers
   ============================================================================ */

/** Port of `checkVariantMintForCanonical`: preview only, no DB writes. */
export async function adminCheckVariantMintForCanonical(
    deps: AdminActionsDeps,
    rawArgs: unknown,
    identity: CallerIdentity | null,
): Promise<CheckedVariantPreview> {
    requireAdmin(deps.adminAllowlist, identity);

    const args = asObject(rawArgs);
    const assetId = readRequiredString(args, 'assetId').trim();
    const mint = readRequiredString(args, 'mint').trim();
    if (!assetId) throw new InvalidArgsError('assetId is required');
    if (!looksLikeSolanaMintAddress(mint)) throw new InvalidArgsError('Not a valid Solana mint address');

    const asset = await deps.repo.findAssetByAssetId(assetId);
    if (!asset) throw new InvalidArgsError('Canonical asset not found');

    const existingVariant = await deps.repo.findVariantByMint(mint);
    const conflict =
        existingVariant && existingVariant.assetId === assetId
            ? ({
                  type: 'same_canonical' as const,
                  assetId: existingVariant.assetId,
                  variantId: existingVariant.variantId,
              } as const)
            : existingVariant
              ? ({
                    type: 'other_canonical' as const,
                    assetId: existingVariant.assetId,
                    variantId: existingVariant.variantId,
                } as const)
              : null;

    const overview = await fetchBirdeyeTokenOverview(deps, mint);
    const normalized = normalizeBirdeyeOverviewForDb(overview);
    const checkedAt = deps.now();
    const category = asset.category as AssetCategory;
    const collections = (await deps.repo.listCollectionSlugsForAssetId(assetId)).filter(isCuratedCategorySlug);
    const tags = uniqueStrings([
        `category:${category}`,
        ...collections.map(collection => `curated:${collection}`),
    ]);
    const registryMatch = getVariantByMint(mint);
    const existingIds = new Set(await deps.repo.listVariantIdsByAssetId(assetId));
    const variantId = availableVariantId(existingIds, assetId, [
        mint.slice(0, 8),
        normalized.symbol,
        normalized.name,
        'mint',
    ]);

    return {
        assetId,
        mint,
        checkedAt,
        conflict,
        variantWrite: {
            assetId,
            chain: 'solana',
            mint,
            variantId,
            kind: kindForCategory(category),
            trustTier: 'tier3',
            ...(registryMatch?.variant.stockVariantTier
                ? { stockVariantTier: registryMatch.variant.stockVariantTier }
                : {}),
            tags,
            label: normalized.symbol,
            isActive: true,
        },
        marketWrite: {
            mint,
            source: 'birdeye',
            symbol: normalized.symbol,
            name: normalized.name,
            decimals: normalized.decimals,
            logoURI: normalized.logoURI ?? null,
            price: normalized.price ?? null,
            priceChange24hPercent: normalized.priceChange24hPercent ?? null,
            priceChange1hPercent: normalized.priceChange1hPercent ?? null,
            volume24hUSD: normalized.volume24hUSD ?? null,
            liquidity: normalized.liquidity ?? null,
            marketCap: normalized.marketCap ?? null,
            fdv: normalized.fdv ?? null,
            holder: normalized.holder ?? null,
            totalSupply: normalized.totalSupply ?? null,
            circulatingSupply: normalized.circulatingSupply ?? null,
            lastTradeHumanTime: normalized.lastTradeHumanTime ?? null,
            extensions: normalized.extensions ?? null,
            lastFetchedAt: checkedAt,
        },
    };
}

const MAX_VARIANT_ID_RETRIES = 5;

/** Port of `addCheckedVariant` + `createVariantFromCheckedPreview`. */
export async function adminAddCheckedVariant(
    deps: AdminActionsDeps,
    rawArgs: unknown,
    identity: CallerIdentity | null,
): Promise<{ assetId: string; mint: string; variantId: string; scheduled: string[] }> {
    requireAdmin(deps.adminAllowlist, identity);

    const args = asObject(rawArgs);
    const preview = parseCheckedPreview(args.checkedPreview);
    const overrides = parseOverrides(args.overrides);

    if (preview.conflict) {
        throw new InvalidArgsError(
            preview.conflict.type === 'same_canonical'
                ? 'This mint is already attached to this canonical.'
                : `This mint already belongs to ${preview.conflict.assetId}. Use Move variant to reassign it.`,
        );
    }

    const assetId = preview.variantWrite.assetId.trim();
    const mint = preview.variantWrite.mint.trim();
    let variantId = preview.variantWrite.variantId.trim();
    if (!assetId) throw new InvalidArgsError('assetId is required');
    if (!looksLikeSolanaMintAddress(mint)) throw new InvalidArgsError('Not a valid Solana mint address');
    if (!variantId) throw new InvalidArgsError('variantId is required');
    if (preview.marketWrite.mint.trim() !== mint) {
        throw new InvalidArgsError('Checked market mint does not match variant mint');
    }

    const asset = await deps.repo.findAssetByAssetId(assetId);
    if (!asset) throw new InvalidArgsError('Canonical asset not found');

    const existingByMint = await deps.repo.findVariantByMint(mint);
    if (existingByMint) throw new InvalidArgsError(`Mint already belongs to ${existingByMint.assetId}`);

    const label =
        overrides.label !== undefined
            ? normalizeOptionalText(overrides.label)
            : normalizeOptionalText(preview.variantWrite.label);
    const tags = uniqueStrings(overrides.tags ?? preview.variantWrite.tags);
    const stockVariantTier =
        overrides.stockVariantTier !== undefined
            ? overrides.stockVariantTier
            : (preview.variantWrite.stockVariantTier ?? null);
    const trustTier = overrides.trustTier ?? preview.variantWrite.trustTier;

    const market = marketWriteToUpsert(preview.marketWrite);

    for (let attempt = 0; ; attempt += 1) {
        try {
            await deps.repo.createVariantWithMarket(
                {
                    assetId,
                    chain: 'solana',
                    mint,
                    variantId,
                    kind: preview.variantWrite.kind,
                    trustTier,
                    ...(stockVariantTier ? { stockVariantTier } : {}),
                    tags,
                    ...(label ? { label } : {}),
                    isActive: true,
                },
                market,
            );
            break;
        } catch (err) {
            if (err instanceof MintConflictError) throw new InvalidArgsError(err.message);
            if (err instanceof VariantIdConflictError) {
                if (attempt >= MAX_VARIANT_ID_RETRIES) {
                    throw new InvalidArgsError('variantId already exists for this canonical asset');
                }
                const existingIds = new Set(await deps.repo.listVariantIdsByAssetId(assetId));
                existingIds.add(variantId);
                const suffix =
                    variantId.startsWith(`${assetId}:`) ? variantId.slice(assetId.length + 1) : variantId;
                variantId = availableVariantId(existingIds, assetId, [suffix]);
                continue;
            }
            throw err;
        }
    }

    await runBestEffort('assetAggregate', () => refreshAssetAggregate(deps.cron, assetId));
    const scheduled = await awaitChartWarm(deps, mint);

    return { assetId, mint, variantId, scheduled };
}

/** Port of `adminSeedAsset`: flexible single-asset seed used by the admin dialog. */
export async function adminSeedAsset(
    deps: AdminActionsDeps,
    rawArgs: unknown,
    identity: CallerIdentity | null,
): Promise<{
    assetId: string;
    mint: string;
    slug?: CuratedCategorySlug;
    rank?: number;
    seededAt: number;
}> {
    requireAdmin(deps.adminAllowlist, identity);

    const args = asObject(rawArgs);
    const mint = readRequiredString(args, 'mint').trim();
    const assetIdArg = readOptionalString(args, 'assetId');
    const slugArg = args.slug;
    if (slugArg !== undefined && (typeof slugArg !== 'string' || !isCuratedCategorySlug(slugArg))) {
        throw new InvalidArgsError(`slug must be one of: ${CURATED_CATEGORY_SLUGS.join(',')}`);
    }
    const slug = slugArg as CuratedCategorySlug | undefined;
    if (!looksLikeSolanaMintAddress(mint)) throw new InvalidArgsError('Not a valid Solana mint address');

    const existingVariant = await deps.repo.findVariantByMint(mint);
    const registryMatch = getVariantByMint(mint);

    const assetId =
        (assetIdArg ?? '').trim() ||
        (existingVariant?.assetId ?? '').trim() ||
        (registryMatch?.asset.assetId ?? '').trim() ||
        singletonAssetIdForMint(mint);

    if (slug) {
        // Membership is additive and multi-list (e.g. USO sits in both stocks
        // and the oil commodity view); no one-category-per-asset restriction.
        await deps.repo.ensureAssetCollection(slug, CURATED_LIST_FALLBACK_NAMES[slug]);
    }

    const category: AssetCategory =
        (registryMatch?.asset.category as AssetCategory | undefined) ?? (slug ? categoryForSlug(slug) : 'crypto');
    const name = (registryMatch?.asset.name ?? '').trim() || undefined;
    const symbol = (registryMatch?.asset.symbol ?? '').trim() || undefined;
    const coingeckoId = (registryMatch?.asset.coingeckoId ?? '').trim() || undefined;
    const aliases = uniqueStrings([assetId, mint, ...(registryMatch?.asset.aliases ?? [])]);

    const variant = registryMatch?.variant ?? null;
    const variantId = (variant?.variantId ?? '').trim() || `${assetId}:mint`;
    const variantKind: VariantKind =
        (variant?.kind as VariantKind | undefined) ?? (slug ? kindForSlug(slug) : 'wrapped');
    const trustTier = (variant?.trustTier as TrustTier | undefined) ?? 'tier3';
    const tags = uniqueStrings([...(variant?.tags ?? []), ...(slug ? [`curated:${slug}`] : ['seeded:admin'])]);
    const issuer = (variant?.issuer ?? '').trim() || undefined;
    const issuerUrl = (variant?.issuerUrl ?? '').trim() || undefined;
    const label = (variant?.label ?? '').trim() || undefined;
    const stockVariantTier = variant?.stockVariantTier;

    await deps.seedRepo.withTransaction(async tx => {
        await tx.upsertCanonicalAsset({
            assetId,
            category,
            aliases,
            ...(name ? { name } : {}),
            ...(symbol ? { symbol } : {}),
            ...(coingeckoId ? { coingeckoId } : {}),
            isActive: true,
        });
        await tx.upsertCanonicalAssetVariant({
            assetId,
            chain: 'solana',
            mint,
            variantId,
            kind: variantKind,
            trustTier: trustTier as Exclude<TrustTier, 'experimental'>,
            tags,
            ...(issuer ? { issuer } : {}),
            ...(issuerUrl ? { issuerUrl } : {}),
            ...(label ? { label } : {}),
            ...(stockVariantTier ? { stockVariantTier } : {}),
            isActive: true,
        });
    });

    // Port of `clearDeletionTombstonesForAsset` (refs normalized here since the
    // repo takes normalized refs, matching the Convex mutation's normalization).
    const tombstoneRefs = uniqueStrings(
        [
            assetId,
            mint,
            singletonAssetIdForMint(mint),
            ...aliases,
            ...(name ? [name] : []),
            ...(symbol ? [symbol] : []),
            ...(coingeckoId ? [coingeckoId] : []),
        ].map(ref => ref.trim().toLowerCase()),
    );
    await deps.repo.clearDeletedRefs(tombstoneRefs);

    const overview = await fetchBirdeyeTokenOverview(deps, mint);
    const now = deps.now();
    const normalized = normalizeBirdeyeOverviewForDb(overview);
    await deps.cron.repo.upsertVariantMarketFromBirdeye(normalizedOverviewToUpsert(mint, normalized, now));

    await runBestEffort('assetAggregate', () => refreshAssetAggregate(deps.cron, assetId));

    const aliasEntries: Array<{
        alias: string;
        kind: 'assetId' | 'name' | 'symbol' | 'coingeckoId' | 'alias' | 'mint' | 'variantId' | 'custom';
        priority: number;
    }> = [
        { alias: assetId, kind: 'assetId', priority: 1000 },
        { alias: normalized.name, kind: 'name', priority: 900 },
        { alias: normalized.symbol, kind: 'symbol', priority: 800 },
        { alias: mint, kind: 'mint', priority: 500 },
        { alias: variantId, kind: 'variantId', priority: 475 },
    ];
    const extCoingeckoId = normalized.extensions?.coingeckoId ?? coingeckoId;
    if (extCoingeckoId) aliasEntries.push({ alias: extCoingeckoId, kind: 'coingeckoId', priority: 700 });
    for (const a of aliases) aliasEntries.push({ alias: a, kind: 'alias', priority: 600 });

    const seenAliases = new Set<string>();
    for (const entry of aliasEntries) {
        const trimmed = entry.alias.trim();
        const aliasNormalized = trimmed.toLowerCase();
        if (!aliasNormalized) continue;
        const key = `${entry.kind}:${aliasNormalized}`;
        if (seenAliases.has(key)) continue;
        seenAliases.add(key);

        await deps.seedRepo.upsertCanonicalAssetAlias({
            assetId,
            normalized: aliasNormalized,
            alias: trimmed,
            kind: entry.kind,
            priority: entry.priority,
        });
    }

    let rank: number | undefined;
    if (slug) {
        rank = await deps.repo.getNextCategoryRank(slug);
        await deps.repo.upsertAssetCollectionMember({ collectionSlug: slug, assetId, rank });
    }

    await awaitChartWarm(deps, mint);

    return {
        assetId,
        mint,
        ...(slug ? { slug } : {}),
        ...(rank !== undefined ? { rank } : {}),
        seededAt: now,
    };
}

/** Port of `refreshChartData`. */
export async function adminRefreshChartData(
    deps: AdminActionsDeps,
    rawArgs: unknown,
    identity: CallerIdentity | null,
): Promise<{ mint: string; scheduled: string[] }> {
    requireAdmin(deps.adminAllowlist, identity);

    const args = asObject(rawArgs);
    const mint = readRequiredString(args, 'mint').trim();
    if (!looksLikeSolanaMintAddress(mint)) throw new InvalidArgsError('Not a valid Solana mint address');

    const variant = await deps.repo.findVariantByMint(mint);
    if (!variant) throw new InvalidArgsError('Mint is not seeded yet');

    const scheduled = await awaitChartWarm(deps, mint);

    return { mint, scheduled };
}
