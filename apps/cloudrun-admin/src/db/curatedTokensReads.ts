/**
 * Postgres implementation of `AdminReadsRepo` (see handlers/curatedTokensReads.ts).
 *
 * Notes:
 * - `ORDER BY ... COLLATE "C"` mirrors Convex's byte-ordered `by_assetId` index.
 * - bigint columns (last_fetched_at) come back as strings from postgres-js and
 *   are converted to epoch-ms numbers here.
 */

import type { Sql } from 'postgres';

import {
    isAdvisorySource,
    isAdvisoryStatus,
    isPegReferenceKind,
    isPegTier,
    isStructuralGrade,
} from '@tokens/asset-registry';
import type { StockVariantTier, VariantAdvisory, VariantKind } from '@tokens/asset-registry';

import type {
    AdminReadsRepo,
    AssetRow,
    SearchAssetRow,
    VariantMarketRow,
    VariantPegHealthRow,
    VariantStructuralHealthRow,
    VariantWithMarketRow,
} from '../handlers/curatedTokensReads';
import type { CuratedCategorySlug, StoredTrustTier } from '../handlers/shared';
import { toNullableNumber } from '../db';

interface PgAssetRow {
    asset_id: string;
    category: string;
    name: string | null;
    symbol: string | null;
    coingecko_id: string | null;
    description: string | null;
    image_url: string | null;
    is_active: boolean;
}

function mapAssetRow(row: PgAssetRow): AssetRow {
    return {
        assetId: row.asset_id,
        category: row.category,
        name: row.name,
        symbol: row.symbol,
        coingeckoId: row.coingecko_id,
        description: row.description,
        imageUrl: row.image_url,
        isActive: row.is_active,
    };
}

/** Unix-ms bigint columns arrive as string (postgres-js default) or bigint; NaN reads as null. */
function toEpochMs(value: string | number | bigint | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return Number(value);
    return toNullableNumber(value);
}

/**
 * Webacy "covers" a mint while its last successful observation is younger
 * than this; otherwise the in-house peg guard row (`pg_*`) is shown. Mirrors
 * `WEBACY_PEG_COVERAGE_MS` in cloudrun-assets so admin and the token page
 * agree on which observer is live.
 */
export const WEBACY_PEG_COVERAGE_MS = 9 * 60 * 60_000;

/**
 * One variant row LEFT JOINed to its market, active advisory, latest Webacy
 * depeg observation (`peg_*`), latest peg guard observation (`pg_*`, migration
 * 0020) and structural grade (`sh_*`). The observer columns are null for every
 * non-stablecoin mint; `mapPegHealth` / `mapStructuralHealth` also treat
 * unknown tiers/grades as "unmonitored".
 */
export interface PgVariantWithMarketRow {
    asset_id: string;
    mint: string;
    variant_id: string;
    kind: string;
    trust_tier: string;
    tags: unknown;
    label: string | null;
    issuer: string | null;
    issuer_url: string | null;
    stock_variant_tier: string | null;
    is_active: boolean;
    has_market: boolean | null;
    market_symbol: string | null;
    market_name: string | null;
    market_logo_uri: string | null;
    market_liquidity: number | null;
    market_last_fetched_at: string | number | null;
    advisory_status: string | null;
    advisory_reason: string | null;
    advisory_url: string | null;
    advisory_set_at: string | number | null;
    advisory_source?: string | null;
    peg_tier?: string | null;
    peg_deviation_pct?: number | string | null;
    peg_ok?: boolean | null;
    peg_error_message?: string | null;
    peg_last_fetched_at?: string | number | bigint | null;
    peg_last_ok_at?: string | number | bigint | null;
    pg_tier?: string | null;
    /** Absent on SELECTs that predate peg guard phase 2. */
    pg_peg_currency?: string | null;
    pg_reference_kind?: string | null;
    pg_deviation_pct?: number | string | null;
    pg_ok?: boolean | null;
    pg_error_message?: string | null;
    pg_last_fetched_at?: string | number | bigint | null;
    pg_last_ok_at?: string | number | bigint | null;
    sh_grade?: string | null;
    sh_last_fetched_at?: string | number | bigint | null;
}

function mapAdvisory(row: PgVariantWithMarketRow): VariantAdvisory | null {
    if (!isAdvisoryStatus(row.advisory_status)) return null;
    return {
        status: row.advisory_status,
        reason: row.advisory_reason ?? '',
        url: row.advisory_url,
        since: toNullableNumber(row.advisory_set_at) ?? 0,
        // Pre-0019 rows and unknown values read as human-authored.
        source: isAdvisorySource(row.advisory_source) ? row.advisory_source : 'admin',
    };
}

type PegHealthColumns = Pick<
    PgVariantWithMarketRow,
    | 'peg_tier'
    | 'peg_deviation_pct'
    | 'peg_ok'
    | 'peg_error_message'
    | 'peg_last_fetched_at'
    | 'peg_last_ok_at'
    | 'pg_tier'
    | 'pg_peg_currency'
    | 'pg_reference_kind'
    | 'pg_deviation_pct'
    | 'pg_ok'
    | 'pg_error_message'
    | 'pg_last_fetched_at'
    | 'pg_last_ok_at'
>;

/** Upper-cased ISO 4217 code, or null for blanks. */
function toPegCurrency(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const code = value.trim().toUpperCase();
    return code.length > 0 ? code : null;
}

function mapWebacyPegHealth(row: PegHealthColumns): VariantPegHealthRow | null {
    if (!isPegTier(row.peg_tier)) return null;
    const updatedAt = toEpochMs(row.peg_last_fetched_at);
    if (updatedAt === null) return null;
    const ok = row.peg_ok !== false;
    return {
        provider: 'webacy',
        // Webacy's monitor judges every mint against a fixed peg unit and the
        // SELECT does not parse its payload, so the currency is unknown here.
        pegCurrency: null,
        referenceKind: 'fixed',
        tier: row.peg_tier,
        deviationPct: toNullableNumber(row.peg_deviation_pct),
        ok,
        errorMessage: ok ? null : (row.peg_error_message ?? null),
        updatedAt,
    };
}

function mapPegGuardPegHealth(row: PegHealthColumns): VariantPegHealthRow | null {
    if (!isPegTier(row.pg_tier)) return null;
    const updatedAt = toEpochMs(row.pg_last_fetched_at);
    if (updatedAt === null) return null;
    const ok = row.pg_ok !== false;
    return {
        provider: 'tokens',
        pegCurrency: toPegCurrency(row.pg_peg_currency),
        referenceKind: isPegReferenceKind(row.pg_reference_kind) ? row.pg_reference_kind : null,
        tier: row.pg_tier,
        deviationPct: toNullableNumber(row.pg_deviation_pct),
        ok,
        errorMessage: ok ? null : (row.pg_error_message ?? null),
        updatedAt,
    };
}

/** Same rule as the worker: healthy row, known tier, last success within 9h. */
function webacyCoversRow(row: PegHealthColumns, nowMs: number): boolean {
    if (row.peg_ok === false || !isPegTier(row.peg_tier)) return false;
    const lastOkAt = toEpochMs(row.peg_last_ok_at) ?? toEpochMs(row.peg_last_fetched_at);
    if (lastOkAt === null) return false;
    return nowMs - lastOkAt <= WEBACY_PEG_COVERAGE_MS;
}

/**
 * Compact depeg status for the admin row. Webacy while it covers the mint,
 * else the peg guard row, else the stale/failing Webacy row (last good tier
 * with `ok: false` + `errorMessage` so the UI can say the poll is failing).
 * Null unless one observer has rated the mint with a known tier.
 */
export function mapPegHealth(row: PegHealthColumns, nowMs: number = Date.now()): VariantPegHealthRow | null {
    const webacy = mapWebacyPegHealth(row);
    if (webacy && webacyCoversRow(row, nowMs)) return webacy;
    return mapPegGuardPegHealth(row) ?? webacy;
}

/** Null unless the latest structural-health row carries one of the 13 letter grades. */
export function mapStructuralHealth(
    row: Pick<PgVariantWithMarketRow, 'sh_grade' | 'sh_last_fetched_at'>,
): VariantStructuralHealthRow | null {
    if (!isStructuralGrade(row.sh_grade)) return null;
    const updatedAt = toEpochMs(row.sh_last_fetched_at);
    if (updatedAt === null) return null;
    return { grade: row.sh_grade, updatedAt };
}

export function mapVariantRow(row: PgVariantWithMarketRow, nowMs: number = Date.now()): VariantWithMarketRow {
    return {
        assetId: row.asset_id,
        mint: row.mint,
        variantId: row.variant_id,
        kind: row.kind as VariantKind,
        trustTier: row.trust_tier as StoredTrustTier,
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
        label: row.label,
        issuer: row.issuer,
        issuerUrl: row.issuer_url,
        stockVariantTier: (row.stock_variant_tier as StockVariantTier | null) ?? null,
        isActive: row.is_active,
        market: row.has_market
            ? {
                  symbol: row.market_symbol,
                  name: row.market_name,
                  logoURI: row.market_logo_uri,
                  liquidity: toNullableNumber(row.market_liquidity),
                  lastFetchedAt: toNullableNumber(row.market_last_fetched_at),
              }
            : null,
        advisory: mapAdvisory(row),
        pegHealth: mapPegHealth(row, nowMs),
        structuralHealth: mapStructuralHealth(row),
    };
}

const VARIANT_MARKET_SELECT = `
    v.asset_id, v.mint, v.variant_id, v.kind, v.trust_tier, v.tags,
    v.label, v.issuer, v.issuer_url, v.stock_variant_tier, v.is_active,
    (m.mint IS NOT NULL) AS has_market,
    m.symbol AS market_symbol,
    m.name AS market_name,
    m.logo_uri AS market_logo_uri,
    m.liquidity AS market_liquidity,
    m.last_fetched_at AS market_last_fetched_at,
    adv.status AS advisory_status,
    adv.reason AS advisory_reason,
    adv.url AS advisory_url,
    adv.set_at AS advisory_set_at,
    adv.source AS advisory_source,
    d.tier AS peg_tier,
    d.deviation_pct AS peg_deviation_pct,
    d.ok AS peg_ok,
    d.error_message AS peg_error_message,
    d.last_fetched_at AS peg_last_fetched_at,
    d.last_ok_at AS peg_last_ok_at,
    g.tier AS pg_tier,
    g.peg_currency AS pg_peg_currency,
    g.reference_kind AS pg_reference_kind,
    g.deviation_pct AS pg_deviation_pct,
    g.ok AS pg_ok,
    g.error_message AS pg_error_message,
    g.last_fetched_at AS pg_last_fetched_at,
    g.last_ok_at AS pg_last_ok_at,
    s.composite_grade AS sh_grade,
    s.last_fetched_at AS sh_last_fetched_at
`;

/**
 * Joins paired with VARIANT_MARKET_SELECT. The Webacy tables (migration 0019)
 * and peg_guard_latest (0020) key on chain 'solana' (the depeg API's slug;
 * the older webacy_*_latest caches use 'sol').
 */
const VARIANT_MARKET_JOINS = `
    LEFT JOIN variant_markets_latest m ON m.mint = v.mint
    LEFT JOIN asset_variant_advisories adv ON adv.mint = v.mint
    LEFT JOIN webacy_depeg_latest d ON d.chain = 'solana' AND d.address = v.mint
    LEFT JOIN peg_guard_latest g ON g.chain = 'solana' AND g.address = v.mint
    LEFT JOIN webacy_structural_health_latest s ON s.chain = 'solana' AND s.address = v.mint
`;

interface PgMarketRow {
    symbol: string | null;
    name: string | null;
    logo_uri: string | null;
    liquidity: number | null;
    last_fetched_at: string | number | null;
}

function mapMarketRow(row: PgMarketRow): VariantMarketRow {
    return {
        symbol: row.symbol,
        name: row.name,
        logoURI: row.logo_uri,
        liquidity: toNullableNumber(row.liquidity),
        lastFetchedAt: toNullableNumber(row.last_fetched_at),
    };
}

/** Escape LIKE wildcards so the search behaves like a literal `includes()`. */
function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

export function makePostgresAdminReadsRepo(sql: Sql): AdminReadsRepo {
    return {
        async listAssets({ includeInactive, limit }) {
            const rows = await sql<PgAssetRow[]>`
                SELECT asset_id, category, name, symbol, coingecko_id, description, image_url, is_active
                FROM (
                    SELECT * FROM assets ORDER BY asset_id COLLATE "C" ASC LIMIT ${limit}
                ) a
                WHERE ${includeInactive} OR a.is_active
                ORDER BY asset_id COLLATE "C" ASC
            `;
            return rows.map(mapAssetRow);
        },

        async listAllVariantsWithMarkets() {
            const rows = await sql<PgVariantWithMarketRow[]>`
                SELECT ${sql.unsafe(VARIANT_MARKET_SELECT)}
                FROM asset_variants v
                ${sql.unsafe(VARIANT_MARKET_JOINS)}
                ORDER BY v.asset_id COLLATE "C" ASC,
                         v.is_active DESC,
                         COALESCE(m.liquidity, 0) DESC,
                         v.mint COLLATE "C" ASC
            `;
            const nowMs = Date.now();
            return rows.map(row => mapVariantRow(row, nowMs));
        },

        async listVariantsWithMarketsByAssetIds(assetIds) {
            if (assetIds.length === 0) return [];
            const rows = await sql<PgVariantWithMarketRow[]>`
                SELECT ${sql.unsafe(VARIANT_MARKET_SELECT)}
                FROM asset_variants v
                ${sql.unsafe(VARIANT_MARKET_JOINS)}
                WHERE v.asset_id = ANY(${sql.array(assetIds as string[])}::text[])
                ORDER BY v.asset_id COLLATE "C" ASC,
                         v.is_active DESC,
                         COALESCE(m.liquidity, 0) DESC,
                         v.mint COLLATE "C" ASC
            `;
            const nowMs = Date.now();
            return rows.map(row => mapVariantRow(row, nowMs));
        },

        async listCustomAliases() {
            const rows = await sql<Array<{ asset_id: string; alias: string }>>`
                SELECT asset_id, alias
                FROM asset_aliases
                WHERE kind = 'custom'
                ORDER BY created_at ASC, id ASC
            `;
            return rows.map(row => ({ assetId: row.asset_id, alias: row.alias }));
        },

        async listCustomAliasesByAssetId(assetId) {
            const rows = await sql<Array<{ alias: string }>>`
                SELECT alias
                FROM asset_aliases
                WHERE asset_id = ${assetId} AND kind = 'custom'
                ORDER BY created_at ASC, id ASC
            `;
            return rows.map(row => row.alias);
        },

        async listCollectionMembers(slugs) {
            if (slugs.length === 0) return [];
            const rows = await sql<Array<{ collection_slug: CuratedCategorySlug; asset_id: string }>>`
                SELECT collection_slug, asset_id
                FROM asset_collection_members
                WHERE collection_slug = ANY(${sql.array(slugs as unknown as string[])}::text[])
                ORDER BY collection_slug ASC, rank ASC
            `;
            return rows.map(row => ({ slug: row.collection_slug, assetId: row.asset_id }));
        },

        async getAssetByAssetId(assetId) {
            const rows = await sql<PgAssetRow[]>`
                SELECT asset_id, category, name, symbol, coingecko_id, description, image_url, is_active
                FROM assets
                WHERE asset_id = ${assetId}
                LIMIT 1
            `;
            return rows[0] ? mapAssetRow(rows[0]) : null;
        },

        async getVariantByMint(mint) {
            const rows = await sql<PgVariantWithMarketRow[]>`
                SELECT ${sql.unsafe(VARIANT_MARKET_SELECT)}
                FROM asset_variants v
                ${sql.unsafe(VARIANT_MARKET_JOINS)}
                WHERE v.mint = ${mint}
                ORDER BY v.id ASC
                LIMIT 1
            `;
            return rows[0] ? mapVariantRow(rows[0]) : null;
        },

        async getMarketByMint(mint) {
            const rows = await sql<PgMarketRow[]>`
                SELECT symbol, name, logo_uri, liquidity, last_fetched_at
                FROM variant_markets_latest
                WHERE mint = ${mint}
                LIMIT 1
            `;
            return rows[0] ? mapMarketRow(rows[0]) : null;
        },

        async searchAssets({ query, limit, scanLimit }) {
            const pattern = `%${escapeLikePattern(query)}%`;
            const rows = await sql<
                Array<{ asset_id: string; name: string | null; symbol: string | null; category: string }>
            >`
                SELECT asset_id, name, symbol, category
                FROM (
                    SELECT * FROM assets ORDER BY asset_id COLLATE "C" ASC LIMIT ${scanLimit}
                ) a
                WHERE ${query} = ''
                   OR (a.asset_id || ' ' || coalesce(a.name, '') || ' ' || coalesce(a.symbol, '') || ' ' || coalesce(a.coingecko_id, ''))
                      ILIKE ${pattern}
                ORDER BY asset_id COLLATE "C" ASC
                LIMIT ${limit}
            `;
            const result: SearchAssetRow[] = rows.map(row => ({
                assetId: row.asset_id,
                name: row.name,
                symbol: row.symbol,
                category: row.category,
            }));
            return result;
        },
    };
}
