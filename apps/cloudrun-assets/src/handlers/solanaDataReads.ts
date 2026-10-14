import { InvalidArgsError } from './assets';
import { resolveLogoUri } from './logoUrl';

// Read side of `solana_data_assets_latest` (see crons.solanaData.ts for the
// sync). Served over the cloudrun RPC as `solanaDataAssetsList` and exposed by
// apps/api as GET /api/v2/registry; tokens.xyz's /registry page reads that.
//
// Name / logo / "has token page" are resolved at read time from the platform's
// own tables (variant_markets_latest, tokens, mint_logos, asset_variants) so a
// mint the platform starts indexing later is upgraded without a re-sync; the
// row's `provider_*` columns are the Birdeye fallback for everything else.

/** One row of the page query. Meta columns repeat on every row (window-free CTE join). */
export interface SolanaDataAssetReadRow {
    mint: string | null;
    symbol: string | null;
    name: string | null;
    logo_uri: string | null;
    logo_cdn_url?: string | null;
    has_token_page: boolean | null;
    /** Active curated asset that owns the mint; null for singletons and unknown mints. */
    asset_id: string | null;
    group_name: string | null;
    category: string | null;
    asset_class: string | null;
    allium_asset_class: string | null;
    rwa_asset_class: string | null;
    allium_asset_value_usd: number | null;
    rwa_asset_value_usd: number | null;
    coingecko_market_cap_usd: number | null;
    source_rank: number | null;
    total: number;
    meta_last_synced_at: number | string | bigint | null;
    meta_source_generated_at: Date | string | null;
}

/** One asset for the detail read: the page row plus the stored upstream snapshot and provider fallback. */
export interface SolanaDataAssetDetailRow extends Omit<
    SolanaDataAssetReadRow,
    'total' | 'meta_last_synced_at' | 'meta_source_generated_at'
> {
    raw_json: string;
    source_generated_at: Date | string | null;
    last_synced_at: number | string | bigint | null;
    provider_name: string | null;
    provider_logo_uri: string | null;
    provider_fetched_at: number | string | bigint | null;
}

export interface SolanaDataAssetsListFilters {
    limit: number;
    offset: number;
    group?: string;
    category?: string;
    assetClass?: string;
}

export interface SolanaDataReadsRepo {
    /**
     * Active rows ordered by `source_rank`, with the page's total and the
     * newest sync / upstream timestamps. Always returns at least one row (meta
     * only, `mint = null`) so an out-of-range offset still reports `total`.
     */
    listActive(filters: SolanaDataAssetsListFilters): Promise<SolanaDataAssetReadRow[]>;
    /** One active row by mint with `raw_json` and the provider fallback; null when unknown or inactive. */
    findActiveByMint(mint: string): Promise<SolanaDataAssetDetailRow | null>;
}

export interface SolanaDataAssetResult {
    mint: string;
    symbol: string;
    name: string | null;
    logoURI: string | null;
    /** True when the platform knows the mint (tokens / variant_markets_latest / an active registry variant). */
    hasTokenPage: boolean;
    /** Curated tokens.xyz asset id owning the mint, or null (singleton / unknown); the API derives the public id. */
    assetId: string | null;
    group: string | null;
    category: string | null;
    assetClass: string | null;
    alliumClass: string | null;
    alliumValueUsd: number | null;
    rwaClass: string | null;
    rwaValueUsd: number | null;
    marketCapUsd: number | null;
    /** Upstream row order, 0-based. */
    rank: number;
}

export interface SolanaDataAssetsListResult {
    items: SolanaDataAssetResult[];
    total: number;
    /** Upstream `data.generatedAt` (ISO 8601) of the newest synced row; null before the first sync. */
    generatedAt: string | null;
    /** Our newest successful sync, unix ms; null before the first sync. */
    syncedAt: number | null;
}

export interface SolanaDataAssetDetailResult extends SolanaDataAssetResult {
    /** The data.solana.com row exactly as delivered (parsed `raw_json`, their snake_case keys and string numerics). */
    upstream: Record<string, unknown>;
    /** Upstream `generatedAt` (ISO 8601) of the snapshot this row came from. */
    generatedAt: string | null;
    /** Our last sync that saw the row, unix ms. */
    syncedAt: number | null;
    /** Birdeye meta-data fallback actually stored for the mint (null fields when never looked up or a miss). */
    provider: { name: string | null; logoURI: string | null; fetchedAt: number | null };
}

export const SOLANA_DATA_LIST_DEFAULT_LIMIT = 500;
export const SOLANA_DATA_LIST_MAX_LIMIT = 5000;
const FILTER_MAX_LENGTH = 80;

function toFiniteOrNull(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toEpochMs(value: number | string | bigint | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function rowToSolanaDataAssetResult(row: SolanaDataAssetReadRow): SolanaDataAssetResult | null {
    if (row.mint === null || row.symbol === null || row.source_rank === null) return null;
    return {
        mint: row.mint,
        symbol: row.symbol,
        name: row.name,
        logoURI: resolveLogoUri({ logo_uri: row.logo_uri, logo_cdn_url: row.logo_cdn_url ?? null }),
        hasTokenPage: row.has_token_page === true,
        assetId: row.asset_id?.trim() || null,
        group: row.group_name,
        category: row.category,
        assetClass: row.asset_class,
        alliumClass: row.allium_asset_class,
        alliumValueUsd: toFiniteOrNull(row.allium_asset_value_usd),
        rwaClass: row.rwa_asset_class,
        rwaValueUsd: toFiniteOrNull(row.rwa_asset_value_usd),
        marketCapUsd: toFiniteOrNull(row.coingecko_market_cap_usd),
        rank: row.source_rank,
    };
}

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function parseUpstream(rawJson: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(rawJson);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

export function rowToSolanaDataAssetDetailResult(row: SolanaDataAssetDetailRow): SolanaDataAssetDetailResult | null {
    const item = rowToSolanaDataAssetResult({
        ...row,
        total: 0,
        meta_last_synced_at: null,
        meta_source_generated_at: null,
    });
    if (!item) return null;
    return {
        ...item,
        upstream: parseUpstream(row.raw_json),
        generatedAt: toIsoOrNull(row.source_generated_at),
        syncedAt: toEpochMs(row.last_synced_at),
        provider: {
            name: row.provider_name,
            logoURI: row.provider_logo_uri,
            fetchedAt: toEpochMs(row.provider_fetched_at),
        },
    };
}

export function parseSolanaDataGetByMintArgs(args: unknown): string {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const mint = (args as { mint?: unknown }).mint;
    if (typeof mint !== 'string') throw new InvalidArgsError('mint must be a string');
    const trimmed = mint.trim();
    if (!looksLikeSolanaMintAddress(trimmed)) throw new InvalidArgsError('mint must be a base58 mint address');
    return trimmed;
}

export async function getByMint(repo: SolanaDataReadsRepo, args: unknown): Promise<SolanaDataAssetDetailResult | null> {
    const mint = parseSolanaDataGetByMintArgs(args);
    const row = await repo.findActiveByMint(mint);
    return row ? rowToSolanaDataAssetDetailResult(row) : null;
}

function readOptionalInt(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError(`${key} must be a finite number`);
    }
    return Math.floor(value);
}

function readOptionalFilter(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string`);
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.length > FILTER_MAX_LENGTH) throw new InvalidArgsError(`${key} is too long`);
    return trimmed;
}

export function parseSolanaDataListArgs(args: unknown): SolanaDataAssetsListFilters {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const record = args as Record<string, unknown>;
    const limit = Math.min(
        Math.max(readOptionalInt(record, 'limit') ?? SOLANA_DATA_LIST_DEFAULT_LIMIT, 1),
        SOLANA_DATA_LIST_MAX_LIMIT,
    );
    const offset = Math.max(readOptionalInt(record, 'offset') ?? 0, 0);
    const group = readOptionalFilter(record, 'group');
    const category = readOptionalFilter(record, 'category');
    const assetClass = readOptionalFilter(record, 'class') ?? readOptionalFilter(record, 'assetClass');
    return {
        limit,
        offset,
        ...(group !== undefined ? { group } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(assetClass !== undefined ? { assetClass } : {}),
    };
}

export async function listAssets(repo: SolanaDataReadsRepo, args: unknown): Promise<SolanaDataAssetsListResult> {
    const filters = parseSolanaDataListArgs(args);
    const rows = await repo.listActive(filters);
    const meta = rows[0];
    const items: SolanaDataAssetResult[] = [];
    for (const row of rows) {
        const item = rowToSolanaDataAssetResult(row);
        if (item) items.push(item);
    }
    return {
        items,
        total: meta ? Number(meta.total) || 0 : 0,
        generatedAt: meta ? toIsoOrNull(meta.meta_source_generated_at) : null,
        syncedAt: meta ? toEpochMs(meta.meta_last_synced_at) : null,
    };
}
