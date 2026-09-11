/**
 * Postgres implementation of `AdminReadsRepo` (see handlers/curatedTokensReads.ts).
 *
 * Notes:
 * - `ORDER BY ... COLLATE "C"` mirrors Convex's byte-ordered `by_assetId` index.
 * - bigint columns (last_fetched_at) come back as strings from postgres-js and
 *   are converted to epoch-ms numbers here.
 */

import type { Sql } from 'postgres';

import { isAdvisoryStatus } from '@tokens/asset-registry';
import type { StockVariantTier, VariantAdvisory, VariantKind } from '@tokens/asset-registry';

import type {
    AdminReadsRepo,
    AssetRow,
    SearchAssetRow,
    VariantMarketRow,
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

interface PgVariantWithMarketRow {
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
}

function mapAdvisory(row: PgVariantWithMarketRow): VariantAdvisory | null {
    if (!isAdvisoryStatus(row.advisory_status)) return null;
    return {
        status: row.advisory_status,
        reason: row.advisory_reason ?? '',
        url: row.advisory_url,
        since: toNullableNumber(row.advisory_set_at) ?? 0,
    };
}

function mapVariantRow(row: PgVariantWithMarketRow): VariantWithMarketRow {
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
    adv.set_at AS advisory_set_at
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
                LEFT JOIN variant_markets_latest m ON m.mint = v.mint
                LEFT JOIN asset_variant_advisories adv ON adv.mint = v.mint
                ORDER BY v.asset_id COLLATE "C" ASC,
                         v.is_active DESC,
                         COALESCE(m.liquidity, 0) DESC,
                         v.mint COLLATE "C" ASC
            `;
            return rows.map(mapVariantRow);
        },

        async listVariantsWithMarketsByAssetIds(assetIds) {
            if (assetIds.length === 0) return [];
            const rows = await sql<PgVariantWithMarketRow[]>`
                SELECT ${sql.unsafe(VARIANT_MARKET_SELECT)}
                FROM asset_variants v
                LEFT JOIN variant_markets_latest m ON m.mint = v.mint
                LEFT JOIN asset_variant_advisories adv ON adv.mint = v.mint
                WHERE v.asset_id = ANY(${sql.array(assetIds as string[])}::text[])
                ORDER BY v.asset_id COLLATE "C" ASC,
                         v.is_active DESC,
                         COALESCE(m.liquidity, 0) DESC,
                         v.mint COLLATE "C" ASC
            `;
            return rows.map(mapVariantRow);
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
                LEFT JOIN variant_markets_latest m ON m.mint = v.mint
                LEFT JOIN asset_variant_advisories adv ON adv.mint = v.mint
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
