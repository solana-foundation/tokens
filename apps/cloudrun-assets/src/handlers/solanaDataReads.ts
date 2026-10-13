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
}

export interface SolanaDataAssetResult {
    mint: string;
    symbol: string;
    name: string | null;
    logoURI: string | null;
    /** True when the platform knows the mint (tokens / variant_markets_latest / an active registry variant). */
    hasTokenPage: boolean;
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
