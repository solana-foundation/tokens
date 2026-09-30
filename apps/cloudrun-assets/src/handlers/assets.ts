export type AssetCategory =
    | 'crypto'
    | 'stablecoin'
    | 'lst'
    | 'rwa'
    | 'commodity'
    | 'equity'
    | 'etf'
    | 'index';

export const ASSET_CATEGORIES: readonly AssetCategory[] = [
    'crypto',
    'stablecoin',
    'lst',
    'rwa',
    'commodity',
    'equity',
    'etf',
    'index',
];

export interface AssetRow {
    id: string;
    asset_id: string;
    category: string;
    name: string | null;
    symbol: string | null;
    aliases: string[];
    coingecko_id: string | null;
    description: string | null;
    image_url: string | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface AssetAliasRow {
    alias: string;
    normalized: string;
    asset_id: string;
    priority: number;
}

export interface AssetVariantRow {
    asset_id: string;
    mint: string;
    is_active: boolean;
}

/** An admin rename: `from` is the former id (lowercased), `to` the current id. */
export interface AssetIdRenameRow {
    from: string;
    to: string;
}

export interface AssetResult {
    assetId: string;
    category: AssetCategory;
    aliases: string[];
    isActive: boolean;
    createdAt: number;
    updatedAt: number;
    name?: string;
    symbol?: string;
    coingeckoId?: string;
    description?: string;
    imageUrl?: string;
}

export interface ResolveAssetRefResult {
    assetId: string;
    resolvedBy: 'assetId' | 'alias' | 'mint';
    alias?: string;
    mint?: string;
}

export interface ResolveAssetRefForApiResult {
    assetId: string;
    ref: string;
    resolvedBy: 'assetId' | 'alias' | 'mint';
    mint: string | null;
}

export interface AssetCoinGeckoEntry {
    assetId: string;
    coingeckoId: string;
    description?: string;
}

export interface AssetsRepo {
    findByAssetId(assetId: string): Promise<AssetRow | null>;
    findByAssetIds(assetIds: readonly string[]): Promise<AssetRow[]>;
    findAliasesByNormalized(normalized: string, limit: number): Promise<AssetAliasRow[]>;
    findAliasesByFuzzy(query: string, limit: number): Promise<AssetAliasRow[]>;
    findAssetsByNameFuzzy(query: string, limit: number): Promise<AssetRow[]>;
    findAssetsBySymbolFuzzy(query: string, limit: number): Promise<AssetRow[]>;
    findVariantByMint(mint: string): Promise<AssetVariantRow | null>;
    isDeletedRef(normalizedRef: string): Promise<boolean>;
    /**
     * Admin renames as `former id (lowercased) -> current id`. Pass ids to look
     * up specific former ids; omit to list every rename (bounded).
     */
    listAssetIdRenames(normalizedAssetIds?: readonly string[]): Promise<AssetIdRenameRow[]>;
    listByCategory(category: string, includeInactive: boolean, limit: number): Promise<AssetRow[]>;
    listActiveWithCoinGecko(limit: number): Promise<AssetRow[]>;
    setDescriptionByAssetId(assetId: string, description: string | null, updatedAt: Date): Promise<boolean>;
}

export interface CallerIdentity {
    clerkUserId: string;
    projectId?: string;
    /** Clerk-verified email forwarded by the admin proxy; used by the admin allowlist. */
    email?: string;
}

export class IdentityRequiredError extends Error {
    constructor(message = 'caller identity required') {
        super(message);
        this.name = 'IdentityRequiredError';
    }
}

/** Caller identity failed an authorization check (allowlist) → 403 `unauthorized`. */
export class UnauthorizedError extends Error {
    constructor(message = 'Unauthorized') {
        super(message);
        this.name = 'UnauthorizedError';
    }
}

export function rowToResult(row: AssetRow): AssetResult {
    const result: AssetResult = {
        assetId: row.asset_id,
        category: row.category as AssetCategory,
        aliases: row.aliases,
        isActive: row.is_active,
        createdAt: row.created_at.getTime(),
        updatedAt: row.updated_at.getTime(),
    };
    if (row.name !== null) result.name = row.name;
    if (row.symbol !== null) result.symbol = row.symbol;
    if (row.coingecko_id !== null) result.coingeckoId = row.coingecko_id;
    if (row.description !== null) result.description = row.description;
    if (row.image_url !== null) result.imageUrl = row.image_url;
    return result;
}

export { InvalidArgsError } from '@tokens/cloudrun-shutdown/http-errors';
import { InvalidArgsError } from '@tokens/cloudrun-shutdown/http-errors';

function isAssetCategory(value: unknown): value is AssetCategory {
    return typeof value === 'string' && (ASSET_CATEGORIES as readonly string[]).includes(value);
}

function normalizeQuery(value: string): string {
    return value.trim().toLowerCase();
}

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function asObject(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    return args as Record<string, unknown>;
}

function readString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') {
        throw new InvalidArgsError(`${key} must be a string`);
    }
    return value;
}

function readOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
        throw new InvalidArgsError(`${key} must be a boolean`);
    }
    return value;
}

function readOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError(`${key} must be a finite number`);
    }
    return value;
}

function readOptionalCategory(args: Record<string, unknown>, key: string): AssetCategory | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (!isAssetCategory(value)) {
        throw new InvalidArgsError(`${key} must be a valid asset category`);
    }
    return value;
}

function clampLimit(value: number | undefined, defaultValue: number, max: number): number {
    return Math.min(Math.max(value ?? defaultValue, 1), max);
}

export async function getByAssetId(repo: AssetsRepo, args: unknown): Promise<AssetResult | null> {
    const a = asObject(args);
    const assetIdRaw = readString(a, 'assetId');
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;
    const assetId = assetIdRaw.trim();
    if (!assetId) return null;
    const row = (await repo.findByAssetId(assetId)) ?? (await findRenamedAsset(repo, assetId));
    if (!row) return null;
    if (!includeInactive && !row.is_active) return null;
    return rowToResult(row);
}

/**
 * An id an admin renamed keeps working: callers that still hold the former id
 * (the static registry, old links) get the asset under its current id.
 */
async function findRenamedAsset(repo: AssetsRepo, assetId: string): Promise<AssetRow | null> {
    const normalized = assetId.toLowerCase();
    const renames = await repo.listAssetIdRenames([normalized]);
    const rename = renames.find(r => r.from === normalized);
    if (!rename || rename.to === assetId) return null;
    return repo.findByAssetId(rename.to);
}

/** Every admin rename, for callers that cache the (small) map — see apps/api. */
export async function listAssetIdRenames(repo: AssetsRepo, _args: unknown): Promise<AssetIdRenameRow[]> {
    void _args;
    return repo.listAssetIdRenames();
}

async function resolveByAlias(
    repo: AssetsRepo,
    normalized: string,
    includeInactive: boolean,
): Promise<{ asset: AssetRow; alias: string } | null> {
    const aliasMatches = await repo.findAliasesByNormalized(normalized, 100);
    aliasMatches.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    const uniqueAssetIds: string[] = [];
    const seen = new Set<string>();
    for (const row of aliasMatches) {
        if (seen.has(row.asset_id)) continue;
        seen.add(row.asset_id);
        uniqueAssetIds.push(row.asset_id);
        if (uniqueAssetIds.length >= 25) break;
    }
    if (uniqueAssetIds.length === 0) return null;

    const assets = await repo.findByAssetIds(uniqueAssetIds);
    const assetById = new Map(assets.map(a => [a.asset_id, a] as const));

    for (const row of aliasMatches) {
        const asset = assetById.get(row.asset_id);
        if (!asset) continue;
        if (!includeInactive && !asset.is_active) continue;
        return { asset, alias: row.alias };
    }
    return null;
}

export async function resolveAssetRef(repo: AssetsRepo, args: unknown): Promise<ResolveAssetRefResult | null> {
    const a = asObject(args);
    const refRaw = readString(a, 'ref');
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;
    const ref = refRaw.trim();
    if (!ref) return null;

    const direct = await repo.findByAssetId(ref);
    if (direct && (includeInactive || direct.is_active)) {
        return { assetId: direct.asset_id, resolvedBy: 'assetId' };
    }

    const normalized = normalizeQuery(ref);
    if (normalized) {
        const aliasResolution = await resolveByAlias(repo, normalized, includeInactive);
        if (aliasResolution) {
            return {
                assetId: aliasResolution.asset.asset_id,
                resolvedBy: 'alias',
                alias: aliasResolution.alias,
            };
        }
    }

    if (looksLikeSolanaMintAddress(ref)) {
        const variant = await repo.findVariantByMint(ref);
        if (!variant) return null;
        if (!includeInactive && !variant.is_active) return null;
        const asset = await repo.findByAssetId(variant.asset_id);
        if (!asset) return null;
        if (!includeInactive && !asset.is_active) return null;
        return { assetId: asset.asset_id, resolvedBy: 'mint', mint: ref };
    }

    return null;
}

async function isAssetTombstoned(repo: AssetsRepo, asset: AssetRow): Promise<boolean> {
    const coingecko = asset.coingecko_id?.trim();
    const candidate = (coingecko && coingecko.length > 0 ? coingecko : asset.asset_id).trim().toLowerCase();
    if (!candidate) return false;
    return repo.isDeletedRef(candidate);
}

export async function resolveAssetRefForApi(
    repo: AssetsRepo,
    args: unknown,
): Promise<ResolveAssetRefForApiResult | null> {
    const a = asObject(args);
    const refRaw = readString(a, 'ref');
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;
    const ref = refRaw.trim();
    if (!ref) return null;

    const normalizedRef = ref.toLowerCase();
    if (await repo.isDeletedRef(normalizedRef)) return null;

    const direct = await repo.findByAssetId(ref);
    if (direct && (includeInactive || direct.is_active)) {
        if (await isAssetTombstoned(repo, direct)) return null;
        return { assetId: direct.asset_id, ref, resolvedBy: 'assetId', mint: null };
    }

    const normalized = normalizeQuery(ref);
    if (normalized) {
        const aliasMatches = await repo.findAliasesByNormalized(normalized, 100);
        aliasMatches.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

        const uniqueAssetIds: string[] = [];
        const seen = new Set<string>();
        for (const row of aliasMatches) {
            if (seen.has(row.asset_id)) continue;
            seen.add(row.asset_id);
            uniqueAssetIds.push(row.asset_id);
            if (uniqueAssetIds.length >= 25) break;
        }
        if (uniqueAssetIds.length > 0) {
            const assets = await repo.findByAssetIds(uniqueAssetIds);
            const assetById = new Map(assets.map(x => [x.asset_id, x] as const));
            for (const row of aliasMatches) {
                const asset = assetById.get(row.asset_id);
                if (!asset) continue;
                if (!includeInactive && !asset.is_active) continue;
                if (await isAssetTombstoned(repo, asset)) continue;
                return { assetId: asset.asset_id, ref, resolvedBy: 'alias', mint: null };
            }
        }
    }

    if (looksLikeSolanaMintAddress(ref)) {
        const variant = await repo.findVariantByMint(ref);
        if (!variant) return null;
        if (!includeInactive && !variant.is_active) return null;
        const asset = await repo.findByAssetId(variant.asset_id);
        if (!asset) return null;
        if (!includeInactive && !asset.is_active) return null;
        if (await isAssetTombstoned(repo, asset)) return null;
        return { assetId: asset.asset_id, ref, resolvedBy: 'mint', mint: ref };
    }

    return null;
}

export async function search(repo: AssetsRepo, args: unknown): Promise<AssetResult[]> {
    const a = asObject(args);
    const queryRaw = readString(a, 'query');
    const category = readOptionalCategory(a, 'category');
    const limitArg = readOptionalNumber(a, 'limit');
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;

    const raw = queryRaw.trim();
    if (!raw) return [];

    const limit = clampLimit(limitArg, 20, 50);

    if (looksLikeSolanaMintAddress(raw)) {
        const variant = await repo.findVariantByMint(raw);
        if (variant) {
            const asset = await repo.findByAssetId(variant.asset_id);
            if (
                asset &&
                (includeInactive || asset.is_active) &&
                (!category || asset.category === category)
            ) {
                return [rowToResult(asset)];
            }
        }
    }

    const normalized = normalizeQuery(raw);
    const seen = new Set<string>();
    const matched: AssetRow[] = [];

    const appendIfEligible = (asset: AssetRow | undefined | null): void => {
        if (!asset) return;
        if (matched.length >= limit) return;
        if (seen.has(asset.asset_id)) return;
        if (!includeInactive && !asset.is_active) return;
        if (category && asset.category !== category) return;
        seen.add(asset.asset_id);
        matched.push(asset);
    };

    if (normalized) {
        const exactAliases = await repo.findAliasesByNormalized(normalized, 200);
        exactAliases.sort((x, y) => (y.priority ?? 0) - (x.priority ?? 0));
        const exactIds: string[] = [];
        const exactSeen = new Set<string>();
        for (const alias of exactAliases) {
            if (exactSeen.has(alias.asset_id)) continue;
            exactSeen.add(alias.asset_id);
            exactIds.push(alias.asset_id);
        }
        if (exactIds.length > 0) {
            const assets = await repo.findByAssetIds(exactIds);
            const assetById = new Map(assets.map(x => [x.asset_id, x] as const));
            for (const alias of exactAliases) {
                if (matched.length >= limit) break;
                appendIfEligible(assetById.get(alias.asset_id));
            }
        }
    }

    if (matched.length < limit) {
        const fuzzyAliases = await repo.findAliasesByFuzzy(raw, limit * 4);
        fuzzyAliases.sort((x, y) => (y.priority ?? 0) - (x.priority ?? 0));
        const fuzzyIds: string[] = [];
        const fuzzySeen = new Set<string>();
        for (const alias of fuzzyAliases) {
            if (seen.has(alias.asset_id)) continue;
            if (fuzzySeen.has(alias.asset_id)) continue;
            fuzzySeen.add(alias.asset_id);
            fuzzyIds.push(alias.asset_id);
        }
        if (fuzzyIds.length > 0) {
            const assets = await repo.findByAssetIds(fuzzyIds);
            const assetById = new Map(assets.map(x => [x.asset_id, x] as const));
            for (const alias of fuzzyAliases) {
                if (matched.length >= limit) break;
                appendIfEligible(assetById.get(alias.asset_id));
            }
        }
    }

    if (matched.length < limit) {
        const symbolMatches = await repo.findAssetsBySymbolFuzzy(raw, limit * 4);
        for (const asset of symbolMatches) {
            if (matched.length >= limit) break;
            appendIfEligible(asset);
        }
    }

    if (matched.length < limit) {
        const nameMatches = await repo.findAssetsByNameFuzzy(raw, limit * 4);
        for (const asset of nameMatches) {
            if (matched.length >= limit) break;
            appendIfEligible(asset);
        }
    }

    return matched.map(rowToResult);
}

export async function listActiveWithCoinGeckoIds(
    repo: AssetsRepo,
    args: unknown,
): Promise<AssetCoinGeckoEntry[]> {
    const a = asObject(args);
    const limitArg = readOptionalNumber(a, 'limit');
    const limit = Math.min(Math.max(Math.floor(limitArg ?? 1000), 1), 5000);

    const rows = await repo.listActiveWithCoinGecko(limit);

    const out: AssetCoinGeckoEntry[] = [];
    for (const row of rows) {
        const entry: AssetCoinGeckoEntry = {
            assetId: row.asset_id,
            coingeckoId: (row.coingecko_id ?? '').trim(),
        };
        if (row.description !== null) entry.description = row.description;
        out.push(entry);
    }
    return out;
}

export async function listByCategory(repo: AssetsRepo, args: unknown): Promise<AssetResult[]> {
    const a = asObject(args);
    const categoryRaw = readString(a, 'category');
    if (!isAssetCategory(categoryRaw)) {
        throw new InvalidArgsError('category must be a valid asset category');
    }
    const limitArg = readOptionalNumber(a, 'limit');
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;
    const limit = clampLimit(limitArg, 100, 500);
    const rows = await repo.listByCategory(categoryRaw, includeInactive, limit);
    return rows.map(rowToResult);
}

export interface GetByAssetIdsEntry {
    assetId: string;
    asset: AssetResult | null;
}

export async function getByAssetIds(repo: AssetsRepo, args: unknown): Promise<GetByAssetIdsEntry[]> {
    const a = asObject(args);
    const rawList = a.assetIds;
    if (!Array.isArray(rawList)) {
        throw new InvalidArgsError('assetIds must be an array of strings');
    }
    for (const item of rawList) {
        if (typeof item !== 'string') {
            throw new InvalidArgsError('assetIds must be an array of strings');
        }
    }
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;

    const assetIds = (rawList as string[])
        .slice(0, 500)
        .map(id => id.trim())
        .filter(id => id.length > 0);

    if (assetIds.length === 0) return [];

    const rows = await repo.findByAssetIds(assetIds);
    const byId = new Map(rows.map(r => [r.asset_id, r] as const));

    return assetIds.map(assetId => {
        const row = byId.get(assetId);
        if (!row) return { assetId, asset: null };
        if (!includeInactive && !row.is_active) return { assetId, asset: null };
        return { assetId, asset: rowToResult(row) };
    });
}
