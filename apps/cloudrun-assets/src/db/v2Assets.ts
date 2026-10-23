/**
 * Postgres implementation of the v2 multichain repos (migration 0033):
 * `V2AssetsJobsRepo` (handlers/crons.v2Assets.ts) and `V2AssetsReadsRepo`
 * (handlers/v2AssetsReads.ts).
 *
 * The Solana mirror statements are deliberately set-based and idempotent:
 * one INSERT ... SELECT per table with `ON CONFLICT ... DO UPDATE ... WHERE`
 * guards so an overlapping run can never roll a row backwards, and so only
 * rows v1 actually changed are rewritten. The mirror reads v1 tables by their
 * 0004/0006 column names only; the local dev DB may carry extra columns from
 * the unmerged cross-chain branch, which is why `asset_variants.chain =
 * 'solana'` is pinned explicitly.
 */

import type { Sql } from 'postgres';

import { EVM_NATIVE_ASSET_ADDRESS, isChainKind, type ChainKind } from '@tokens/asset-registry/chains';

import { CURATED_COLLECTION_SLUGS, CURATED_COLLECTION_SLUGS_SQL_LITERAL } from '../db';
import type {
    V2AdminVariantUpsert,
    V2AssetsJobsRepo,
    V2CoinPlatformsRow,
    V2DerivationAssetRow,
    V2DerivedVariantRow,
    V2VariantKeyRef,
} from '../handlers/crons.v2Assets';
import type {
    V2AssetsReadsRepo,
    V2ChainRollupDbRow,
    V2ChainSummaryDbRow,
    V2MarketDbRow,
    V2VariantDbRow,
    V2VariantKey,
} from '../handlers/v2AssetsReads';

/** Metric columns shared by variant_markets_latest and v2_variant_markets_latest (same names, same types). */
const MARKET_METRIC_COLUMNS = [
    'source',
    'metrics_source',
    'birdeye_metrics',
    'rwa_metrics',
    'clickhouse_metrics',
    'symbol',
    'name',
    'decimals',
    'logo_uri',
    'price',
    'liquidity',
    'volume_5m_usd',
    'volume_15m_usd',
    'volume_1h_usd',
    'volume_6h_usd',
    'volume_24h_usd',
    'trade_5m',
    'trade_15m',
    'trade_1h',
    'trade_6h',
    'trade_24h',
    'unique_wallet_5m',
    'unique_wallet_1h',
    'unique_wallet_24h',
    'market_cap',
    'fdv',
    'price_change_24h_percent',
    'price_change_1h_percent',
    'holder',
    'total_supply',
    'circulating_supply',
    'last_trade_human_time',
    'extensions',
    'as_of',
    'last_trade_at',
    'last_fetched_at',
    'overview_last_fetched_at',
] as const;

const MARKET_METRIC_COLUMNS_SQL = MARKET_METRIC_COLUMNS.join(', ');
const MARKET_METRIC_COLUMNS_PREFIXED_SQL = MARKET_METRIC_COLUMNS.map(c => `vml.${c}`).join(', ');
const MARKET_METRIC_COLUMNS_EXCLUDED_SQL = MARKET_METRIC_COLUMNS.map(c => `${c} = EXCLUDED.${c}`).join(', ');

/** Columns the v2 reads select from v2_variant_markets_latest (address doubles as `mint` for the shared snapshot builder). */
const V2_VARIANT_COLUMNS = [
    'chain',
    'address',
    'asset_id',
    'variant_id',
    'kind',
    'trust_tier',
    'stock_variant_tier',
    'tags',
    'label',
    'issuer',
    'issuer_url',
    'decimals',
    'origin',
    'source',
    'is_active',
] as const;
const V2_VARIANT_COLUMNS_SQL = V2_VARIANT_COLUMNS.join(', ');
const V2_VARIANT_COLUMNS_PREFIXED_SQL = V2_VARIANT_COLUMNS.map(c => `v.${c}`).join(', ');

/**
 * Advisory lock serializing the Solana → v2 mirror with cloudrun-admin's
 * per-row mirror (apps/cloudrun-admin/src/db/v2Mirror.ts uses the same key).
 * Without it a cron tick whose INSERT … SELECT snapshot predates an admin
 * commit could stamp stale v1 values with a newer `last_seen_at` and the
 * admin's own mirror row would then be rejected by the timestamp guard.
 */
export const V2_SOLANA_MIRROR_LOCK_KEY = 830_033;

function parseJsonb(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function toStringRecord(value: unknown): Record<string, string> {
    const raw = parseJsonb(value);
    const out: Record<string, string> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof v === 'string') out[key] = v;
        }
    }
    return out;
}

/** `detail_platforms` → platform id → decimals (only finite, non-negative integers). */
function toDecimalsRecord(value: unknown): Record<string, number> {
    const raw = parseJsonb(value);
    const out: Record<string, number> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
            const place = v && typeof v === 'object' ? (v as { decimal_place?: unknown }).decimal_place : undefined;
            if (typeof place === 'number' && Number.isFinite(place) && place >= 0) out[key] = Math.floor(place);
        }
    }
    return out;
}

function toEpochMsOrNull(value: number | string | bigint | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'bigint' ? Number(value) : Number(value);
    return Number.isFinite(n) ? n : null;
}

export function makePostgresV2AssetsJobsRepo(sql: Sql): V2AssetsJobsRepo {
    return {
        async mirrorSolanaVariants(nowMs) {
            return await sql.begin(async tx => {
                // Serialize with cloudrun-admin's in-transaction mirror so the
                // SELECT below never snapshots v1 mid-admin-write.
                await tx`SELECT pg_advisory_xact_lock(${V2_SOLANA_MIRROR_LOCK_KEY})`;
                // A v1 variant whose mint was replaced keeps its variant_id, so the
                // fresh (asset, new mint) row would collide with the stale mirror
                // row on the (asset_id, variant_id) unique index and fail the whole
                // INSERT. Drop mirror rows v1 no longer has when v1 now carries
                // their variant_id on another mint. (Their market rows stay: keyed
                // by mint, they are unreachable once no variant references them.)
                const replaced = await tx<{ address: string }[]>`
                    DELETE FROM v2_asset_variants v
                    WHERE v.origin = 'solana_v1'
                      AND v.chain = 'solana'
                      AND NOT EXISTS (
                          SELECT 1 FROM asset_variants av
                          WHERE av.chain = 'solana' AND av.asset_id = v.asset_id AND av.mint = v.address
                      )
                      AND EXISTS (
                          SELECT 1 FROM asset_variants av
                          WHERE av.chain = 'solana' AND av.asset_id = v.asset_id
                            AND av.variant_id = v.variant_id AND av.mint <> v.address
                      )
                    RETURNING v.address
                `;
                // DISTINCT ON guards against a (asset_id, mint) pair appearing twice
                // in v1 (nothing enforces that there); the active row wins.
                const rows = await tx<{ inserted: boolean }[]>`
                INSERT INTO v2_asset_variants (
                    chain, address, asset_id, variant_id, kind, trust_tier, stock_variant_tier, tags,
                    label, issuer, issuer_url, decimals, origin, source, is_active,
                    first_seen_at, last_seen_at, created_at, updated_at
                )
                SELECT 'solana', av.mint, av.asset_id, av.variant_id, av.kind, av.trust_tier, av.stock_variant_tier,
                       coalesce(av.tags, '[]'::jsonb), av.label, av.issuer, av.issuer_url, vml.decimals,
                       'solana_v1', av.source, av.is_active,
                       ${nowMs}, ${nowMs}, now(), now()
                FROM (
                    SELECT DISTINCT ON (asset_id, mint) *
                    FROM asset_variants
                    WHERE chain = 'solana'
                    ORDER BY asset_id, mint, is_active DESC, id ASC
                ) av
                LEFT JOIN variant_markets_latest vml ON vml.mint = av.mint
                ON CONFLICT (chain, address, asset_id) DO UPDATE SET
                    variant_id = EXCLUDED.variant_id,
                    kind = EXCLUDED.kind,
                    trust_tier = EXCLUDED.trust_tier,
                    stock_variant_tier = EXCLUDED.stock_variant_tier,
                    tags = EXCLUDED.tags,
                    label = EXCLUDED.label,
                    issuer = EXCLUDED.issuer,
                    issuer_url = EXCLUDED.issuer_url,
                    decimals = coalesce(EXCLUDED.decimals, v2_asset_variants.decimals),
                    source = EXCLUDED.source,
                    is_active = EXCLUDED.is_active,
                    last_seen_at = EXCLUDED.last_seen_at,
                    updated_at = now()
                WHERE v2_asset_variants.origin = 'solana_v1'
                  AND EXCLUDED.last_seen_at >= v2_asset_variants.last_seen_at
                RETURNING (xmax = 0) AS inserted
            `;
                let inserted = 0;
                for (const row of rows) if (row.inserted) inserted += 1;
                return { inserted, updated: rows.length - inserted, replaced: replaced.length };
            });
        },

        async deactivateUnseenSolanaVariants(seenBeforeMs, nowMs) {
            const rows = await sql<{ address: string }[]>`
                UPDATE v2_asset_variants
                SET is_active = false, updated_at = ${new Date(nowMs)}
                WHERE origin = 'solana_v1'
                  AND is_active = true
                  AND last_seen_at < ${seenBeforeMs}
                RETURNING address
            `;
            return rows.length;
        },

        async mirrorSolanaMarkets() {
            const rows = await sql<{ address: string }[]>`
                INSERT INTO v2_variant_markets_latest (chain, address, ${sql.unsafe(MARKET_METRIC_COLUMNS_SQL)}, origin)
                SELECT 'solana', vml.mint, ${sql.unsafe(MARKET_METRIC_COLUMNS_PREFIXED_SQL)}, 'solana_v1'
                FROM variant_markets_latest vml
                WHERE vml.mint NOT LIKE '0x%'
                  AND EXISTS (
                      SELECT 1 FROM v2_asset_variants v
                      WHERE v.chain = 'solana' AND v.address = vml.mint
                  )
                ON CONFLICT (chain, address) DO UPDATE SET
                    ${sql.unsafe(MARKET_METRIC_COLUMNS_EXCLUDED_SQL)},
                    updated_at = now()
                WHERE v2_variant_markets_latest.origin = 'solana_v1'
                  AND (
                      v2_variant_markets_latest.last_fetched_at IS DISTINCT FROM EXCLUDED.last_fetched_at
                      OR v2_variant_markets_latest.overview_last_fetched_at IS DISTINCT FROM EXCLUDED.overview_last_fetched_at
                  )
                RETURNING address
            `;
            return rows.length;
        },

        async mirrorSolanaRollups() {
            const rows = await sql<{ asset_id: string }[]>`
                INSERT INTO v2_asset_chain_markets_latest (
                    asset_id, chain, liquidity, volume_24h_usd, volume_30d_usd, primary_address,
                    variant_count, last_computed_at, origin
                )
                SELECT aml.asset_id, 'solana', aml.liquidity, aml.volume_24h_usd, aml.volume_30d_usd, aml.primary_mint,
                       (
                           SELECT count(*)::int FROM v2_asset_variants v
                           WHERE v.asset_id = aml.asset_id AND v.chain = 'solana' AND v.is_active = true
                       ),
                       aml.last_computed_at, 'solana_v1'
                FROM asset_markets_latest aml
                ON CONFLICT (asset_id, chain) DO UPDATE SET
                    liquidity = EXCLUDED.liquidity,
                    volume_24h_usd = EXCLUDED.volume_24h_usd,
                    volume_30d_usd = EXCLUDED.volume_30d_usd,
                    primary_address = EXCLUDED.primary_address,
                    variant_count = EXCLUDED.variant_count,
                    last_computed_at = EXCLUDED.last_computed_at,
                    updated_at = now()
                WHERE v2_asset_chain_markets_latest.origin = 'solana_v1'
                  AND (
                      v2_asset_chain_markets_latest.last_computed_at IS DISTINCT FROM EXCLUDED.last_computed_at
                      OR v2_asset_chain_markets_latest.variant_count IS DISTINCT FROM EXCLUDED.variant_count
                  )
                RETURNING asset_id
            `;
            return rows.length;
        },

        async listAssetsWithCoinPlatforms(limit) {
            const rows = await sql<
                {
                    asset_id: string;
                    category: string;
                    coingecko_id: string;
                    platforms: unknown;
                    detail_platforms: unknown;
                    asset_platform_id: string | null;
                    coin_symbol: string | null;
                    last_synced_at: number | string | bigint | null;
                }[]
            >`
                SELECT a.asset_id, a.category, a.coingecko_id,
                       c.platforms,
                       c.coin->'detail_platforms' AS detail_platforms,
                       c.coin->>'asset_platform_id' AS asset_platform_id,
                       c.symbol AS coin_symbol,
                       c.last_synced_at
                FROM assets a
                JOIN coingecko_coins c ON c.coin_id = a.coingecko_id
                WHERE a.is_active = true
                  AND a.coingecko_id IS NOT NULL
                  AND length(trim(a.coingecko_id)) > 0
                  AND NOT EXISTS (
                      SELECT 1 FROM asset_deletion_tombstones dt WHERE dt.asset_id = a.asset_id
                  )
                ORDER BY a.asset_id ASC
                LIMIT ${Math.max(1, Math.floor(limit))}
            `;
            return rows.map((row): V2DerivationAssetRow => ({
                assetId: row.asset_id,
                category: row.category,
                coingeckoId: row.coingecko_id,
                platforms: toStringRecord(row.platforms),
                decimalsByPlatform: toDecimalsRecord(row.detail_platforms),
                assetPlatformId: row.asset_platform_id ?? null,
                coinSymbol: row.coin_symbol ?? null,
                coinLastSyncedAt: toEpochMsOrNull(row.last_synced_at),
            }));
        },

        async listActiveAssets() {
            const rows = await sql<{ asset_id: string; category: string }[]>`
                SELECT a.asset_id, a.category
                FROM assets a
                WHERE a.is_active = true
                  AND NOT EXISTS (
                      SELECT 1 FROM asset_deletion_tombstones dt WHERE dt.asset_id = a.asset_id
                  )
                ORDER BY a.asset_id ASC
            `;
            return rows.map(row => ({ assetId: row.asset_id, category: row.category }));
        },

        async findCoinPlatformsByCoinIds(coinIds) {
            if (coinIds.length === 0) return [];
            const rows = await sql<
                {
                    coin_id: string;
                    symbol: string | null;
                    platforms: unknown;
                    detail_platforms: unknown;
                    asset_platform_id: string | null;
                    last_synced_at: number | string | bigint | null;
                }[]
            >`
                SELECT coin_id, symbol, platforms,
                       coin->'detail_platforms' AS detail_platforms,
                       coin->>'asset_platform_id' AS asset_platform_id,
                       last_synced_at
                FROM coingecko_coins
                WHERE coin_id IN ${sql([...coinIds])}
            `;
            return rows.map((row): V2CoinPlatformsRow => ({
                coinId: row.coin_id,
                symbol: row.symbol ?? null,
                platforms: toStringRecord(row.platforms),
                decimalsByPlatform: toDecimalsRecord(row.detail_platforms),
                assetPlatformId: row.asset_platform_id ?? null,
                coinLastSyncedAt: toEpochMsOrNull(row.last_synced_at),
            }));
        },

        async listDerivedVariants(chains) {
            if (chains.length === 0) return [];
            const rows = await sql<
                { chain: string; address: string; asset_id: string; variant_id: string; is_active: boolean }[]
            >`
                SELECT chain, address, asset_id, variant_id, is_active
                FROM v2_asset_variants
                WHERE origin IN ('coingecko', 'config')
                  AND chain IN ${sql([...chains])}
            `;
            return rows.flatMap((row): V2DerivedVariantRow[] =>
                isChainKind(row.chain)
                    ? [
                          {
                              chain: row.chain,
                              address: row.address,
                              assetId: row.asset_id,
                              variantId: row.variant_id,
                              isActive: row.is_active,
                          },
                      ]
                    : [],
            );
        },

        async upsertDerivedVariant(args) {
            const now = new Date(args.nowMs);
            const rows = await sql<{ inserted: boolean }[]>`
                INSERT INTO v2_asset_variants (
                    chain, address, asset_id, variant_id, kind, trust_tier, stock_variant_tier, tags,
                    label, issuer, issuer_url, decimals, origin, source, is_active,
                    first_seen_at, last_seen_at, created_at, updated_at
                )
                VALUES (
                    ${args.chain}, ${args.address}, ${args.assetId}, ${args.variantId}, ${args.kind}, ${args.trustTier},
                    NULL, ${sql.json([...args.tags] as never)},
                    ${args.label}, NULL, NULL, ${args.decimals}, ${args.origin}, ${args.origin}, true,
                    ${args.nowMs}, ${args.nowMs}, ${now}, ${now}
                )
                ON CONFLICT (chain, address, asset_id) DO UPDATE SET
                    variant_id = EXCLUDED.variant_id,
                    kind = EXCLUDED.kind,
                    label = coalesce(EXCLUDED.label, v2_asset_variants.label),
                    tags = EXCLUDED.tags,
                    decimals = coalesce(EXCLUDED.decimals, v2_asset_variants.decimals),
                    origin = EXCLUDED.origin,
                    source = EXCLUDED.source,
                    is_active = true,
                    last_seen_at = EXCLUDED.last_seen_at,
                    updated_at = EXCLUDED.updated_at
                WHERE v2_asset_variants.origin IN ('coingecko', 'config')
                RETURNING (xmax = 0) AS inserted
            `;
            const row = rows[0];
            if (!row) return 'skipped';
            return row.inserted ? 'inserted' : 'updated';
        },

        async upsertAdminVariant(args: V2AdminVariantUpsert) {
            const now = new Date(args.nowMs);
            // `prev` reads the pre-statement snapshot, so it still sees the
            // row the INSERT is about to update: that is how "adopted" is told
            // apart from a plain update of an admin row.
            const rows = await sql<{ inserted: boolean; prev_origin: string | null }[]>`
                WITH prev AS (
                    SELECT origin FROM v2_asset_variants
                    WHERE chain = ${args.chain} AND address = ${args.address} AND asset_id = ${args.assetId}
                ), upserted AS (
                    INSERT INTO v2_asset_variants (
                        chain, address, asset_id, variant_id, kind, trust_tier, stock_variant_tier, tags,
                        label, issuer, issuer_url, decimals, origin, source, is_active,
                        first_seen_at, last_seen_at, created_at, updated_at
                    )
                    VALUES (
                        ${args.chain}, ${args.address}, ${args.assetId}, ${args.variantId}, ${args.kind}, ${args.trustTier},
                        ${args.stockVariantTier}, ${sql.json([...args.tags] as never)},
                        ${args.label}, NULL, NULL, ${args.decimals}, 'admin', 'admin', true,
                        ${args.nowMs}, ${args.nowMs}, ${now}, ${now}
                    )
                    ON CONFLICT (chain, address, asset_id) DO UPDATE SET
                        kind = EXCLUDED.kind,
                        trust_tier = EXCLUDED.trust_tier,
                        stock_variant_tier = EXCLUDED.stock_variant_tier,
                        tags = EXCLUDED.tags,
                        label = coalesce(EXCLUDED.label, v2_asset_variants.label),
                        decimals = coalesce(EXCLUDED.decimals, v2_asset_variants.decimals),
                        origin = 'admin',
                        source = 'admin',
                        is_active = true,
                        last_seen_at = EXCLUDED.last_seen_at,
                        updated_at = EXCLUDED.updated_at
                    WHERE v2_asset_variants.origin IN ('coingecko', 'config', 'admin')
                    RETURNING (xmax = 0) AS inserted
                )
                SELECT u.inserted, (SELECT origin FROM prev) AS prev_origin FROM upserted u
            `;
            const row = rows[0];
            if (!row) throw new Error(`v2 variant ${args.chain}:${args.address} on ${args.assetId} is owned by another origin`);
            if (row.inserted) return 'inserted';
            return row.prev_origin === 'admin' ? 'updated' : 'adopted';
        },

        async deactivateDerivedVariants(keys, nowMs) {
            if (keys.length === 0) return 0;
            const rows = await sql<{ address: string }[]>`
                UPDATE v2_asset_variants v
                SET is_active = false, updated_at = ${new Date(nowMs)}
                FROM jsonb_to_recordset(${sql.json(keys.map(k => ({ chain: k.chain, address: k.address, asset_id: k.assetId })) as never)})
                    AS k(chain text, address text, asset_id text)
                WHERE v.chain = k.chain AND v.address = k.address AND v.asset_id = k.asset_id
                  AND v.origin IN ('coingecko', 'config')
                  AND v.is_active = true
                RETURNING v.address
            `;
            return rows.length;
        },

        async listStaleActiveVariantsByChains(chains, beforeOverviewFetchedAt, limit) {
            if (chains.length === 0) return [];
            // One row per (chain, address) — the same address can back several
            // assets — whose market snapshot is missing or older than the cutoff.
            // Stalest first so a capped batch always makes progress through the
            // tail; curated rank only breaks ties (e.g. between never-fetched rows).
            const rows = await sql<{ chain: string; address: string }[]>`
                WITH candidates AS (
                    SELECT v.chain, v.address,
                           MIN(acm.slug_rank) AS slug_rank,
                           MIN(acm.rank) AS rank
                    FROM v2_asset_variants v
                    JOIN assets a ON a.asset_id = v.asset_id AND a.is_active = true
                    LEFT JOIN (
                        SELECT asset_id,
                               MIN(array_position(${sql.unsafe(CURATED_COLLECTION_SLUGS_SQL_LITERAL)}, collection_slug)) AS slug_rank,
                               MIN(rank) AS rank
                        FROM asset_collection_members
                        WHERE collection_slug IN ${sql(CURATED_COLLECTION_SLUGS)}
                        GROUP BY asset_id
                    ) acm ON acm.asset_id = v.asset_id
                    WHERE v.is_active = true
                      AND v.chain IN ${sql([...chains])}
                      -- Native coins (EIP-7528) are not tokens: Birdeye answers them with
                      -- the wrapped token's identity and made-up liquidity. The wrapped
                      -- variant carries the coin's market instead.
                      AND v.address <> ${EVM_NATIVE_ASSET_ADDRESS}
                      AND NOT EXISTS (
                          SELECT 1 FROM asset_deletion_tombstones dt WHERE dt.asset_id = v.asset_id
                      )
                    GROUP BY v.chain, v.address
                )
                SELECT c.chain, c.address
                FROM candidates c
                LEFT JOIN v2_variant_markets_latest m ON m.chain = c.chain AND m.address = c.address
                WHERE m.overview_last_fetched_at IS NULL
                   OR m.overview_last_fetched_at < ${beforeOverviewFetchedAt}
                ORDER BY m.overview_last_fetched_at ASC NULLS FIRST,
                         c.slug_rank ASC NULLS LAST,
                         c.rank ASC NULLS LAST,
                         c.chain ASC, c.address ASC
                LIMIT ${Math.min(Math.max(limit, 1), 1000)}
            `;
            return rows.flatMap((row): V2VariantKeyRef[] =>
                isChainKind(row.chain) ? [{ chain: row.chain, address: row.address }] : [],
            );
        },

        async upsertVariantMarketFromBirdeye(args, options) {
            // `onlyIfNewer`: an admin preview snapshot must not replace a fresher
            // row the refresh cron wrote while the dialog was open.
            const onlyIfNewer = options?.onlyIfNewer === true;
            const birdeyeJson = {
                source: 'birdeye',
                symbol: args.symbol,
                name: args.name,
                ...(args.decimals !== null ? { decimals: args.decimals } : {}),
                ...(args.logoURI ? { logoURI: args.logoURI } : {}),
                ...(args.price !== undefined ? { price: args.price } : {}),
                ...(args.priceChange24hPercent !== undefined
                    ? { priceChange24hPercent: args.priceChange24hPercent }
                    : {}),
                ...(args.priceChange1hPercent !== undefined ? { priceChange1hPercent: args.priceChange1hPercent } : {}),
                ...(args.volume1hUSD !== undefined ? { volume1hUSD: args.volume1hUSD } : {}),
                ...(args.volume24hUSD !== undefined ? { volume24hUSD: args.volume24hUSD } : {}),
                ...(args.trade1h !== undefined ? { trade1h: args.trade1h } : {}),
                ...(args.trade24h !== undefined ? { trade24h: args.trade24h } : {}),
                ...(args.uniqueWallet1h !== undefined ? { uniqueWallet1h: args.uniqueWallet1h } : {}),
                ...(args.uniqueWallet24h !== undefined ? { uniqueWallet24h: args.uniqueWallet24h } : {}),
                ...(args.liquidity !== undefined ? { liquidity: args.liquidity } : {}),
                ...(args.marketCap !== undefined ? { marketCap: args.marketCap } : {}),
                ...(args.fdv !== undefined ? { fdv: args.fdv } : {}),
                ...(args.holder !== undefined ? { holder: args.holder } : {}),
                ...(args.totalSupply !== undefined ? { totalSupply: args.totalSupply } : {}),
                ...(args.circulatingSupply !== undefined ? { circulatingSupply: args.circulatingSupply } : {}),
                ...(args.lastTradeHumanTime !== undefined ? { lastTradeHumanTime: args.lastTradeHumanTime } : {}),
                ...(args.lastTradeAt !== undefined ? { lastTradeAt: args.lastTradeAt } : {}),
                ...(args.extensions !== undefined ? { extensions: args.extensions } : {}),
                lastFetchedAt: args.lastFetchedAt,
            };
            await sql`
                INSERT INTO v2_variant_markets_latest (
                    chain, address, source, metrics_source,
                    birdeye_metrics,
                    symbol, name, decimals, logo_uri,
                    price, liquidity,
                    volume_1h_usd, volume_24h_usd,
                    trade_1h, trade_24h,
                    unique_wallet_1h, unique_wallet_24h,
                    market_cap, fdv,
                    price_change_24h_percent, price_change_1h_percent,
                    holder, total_supply, circulating_supply,
                    last_trade_human_time, extensions,
                    last_trade_at, last_fetched_at, overview_last_fetched_at,
                    origin
                )
                VALUES (
                    ${args.chain}, ${args.address}, 'birdeye', 'birdeye',
                    ${sql.json(birdeyeJson)},
                    ${args.symbol}, ${args.name}, ${args.decimals}, ${args.logoURI ?? null},
                    ${args.price ?? null}, ${args.liquidity ?? null},
                    ${args.volume1hUSD ?? null}, ${args.volume24hUSD ?? null},
                    ${args.trade1h ?? null}, ${args.trade24h ?? null},
                    ${args.uniqueWallet1h ?? null}, ${args.uniqueWallet24h ?? null},
                    ${args.marketCap ?? null}, ${args.fdv ?? null},
                    ${args.priceChange24hPercent ?? null}, ${args.priceChange1hPercent ?? null},
                    ${args.holder ?? null}, ${args.totalSupply ?? null}, ${args.circulatingSupply ?? null},
                    ${args.lastTradeHumanTime ?? null},
                    ${args.extensions ? sql.json(args.extensions) : null},
                    ${args.lastTradeAt ?? null}, ${args.lastFetchedAt}, ${args.lastFetchedAt},
                    'birdeye'
                )
                ON CONFLICT (chain, address) DO UPDATE SET
                    source = EXCLUDED.source,
                    metrics_source = EXCLUDED.metrics_source,
                    birdeye_metrics = EXCLUDED.birdeye_metrics,
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    decimals = coalesce(EXCLUDED.decimals, v2_variant_markets_latest.decimals),
                    logo_uri = EXCLUDED.logo_uri,
                    price = EXCLUDED.price,
                    liquidity = EXCLUDED.liquidity,
                    volume_1h_usd = EXCLUDED.volume_1h_usd,
                    volume_24h_usd = EXCLUDED.volume_24h_usd,
                    trade_1h = EXCLUDED.trade_1h,
                    trade_24h = EXCLUDED.trade_24h,
                    unique_wallet_1h = EXCLUDED.unique_wallet_1h,
                    unique_wallet_24h = EXCLUDED.unique_wallet_24h,
                    market_cap = EXCLUDED.market_cap,
                    fdv = EXCLUDED.fdv,
                    price_change_24h_percent = EXCLUDED.price_change_24h_percent,
                    price_change_1h_percent = EXCLUDED.price_change_1h_percent,
                    holder = EXCLUDED.holder,
                    total_supply = EXCLUDED.total_supply,
                    circulating_supply = EXCLUDED.circulating_supply,
                    last_trade_human_time = EXCLUDED.last_trade_human_time,
                    extensions = EXCLUDED.extensions,
                    last_trade_at = EXCLUDED.last_trade_at,
                    last_fetched_at = EXCLUDED.last_fetched_at,
                    overview_last_fetched_at = EXCLUDED.overview_last_fetched_at,
                    origin = EXCLUDED.origin,
                    updated_at = now()
                WHERE v2_variant_markets_latest.origin = 'birdeye'
                  AND (${!onlyIfNewer} OR v2_variant_markets_latest.last_fetched_at <= EXCLUDED.last_fetched_at)
            `;
        },

        async touchVariantMarket(chain, address, lastFetchedAt) {
            await sql`
                INSERT INTO v2_variant_markets_latest (chain, address, source, last_fetched_at, overview_last_fetched_at, origin)
                VALUES (${chain}, ${address}, 'touch', ${lastFetchedAt}, ${lastFetchedAt}, 'birdeye')
                ON CONFLICT (chain, address) DO UPDATE SET
                    last_fetched_at = EXCLUDED.last_fetched_at,
                    overview_last_fetched_at = EXCLUDED.overview_last_fetched_at,
                    updated_at = now()
                WHERE v2_variant_markets_latest.origin = 'birdeye'
            `;
        },

        async setVariantDecimalsIfNull(chain, address, decimals) {
            await sql`
                UPDATE v2_asset_variants
                SET decimals = ${decimals}, updated_at = now()
                WHERE chain = ${chain} AND address = ${address} AND decimals IS NULL
            `;
        },
    };
}

function keysRecordset(sql: Sql, keys: readonly V2VariantKey[]) {
    return sql`jsonb_to_recordset(${sql.json(keys.map(k => ({ chain: k.chain, address: k.address })) as never)}) AS k(chain text, address text)`;
}

export function makePostgresV2AssetsReadsRepo(sql: Sql): V2AssetsReadsRepo {
    return {
        async chainSummary() {
            return sql<V2ChainSummaryDbRow[]>`
                SELECT v.chain,
                       count(*) FILTER (WHERE v.is_active)::int AS active_variants,
                       count(DISTINCT v.asset_id) FILTER (WHERE v.is_active)::int AS asset_count,
                       count(DISTINCT m.address) FILTER (WHERE v.is_active AND m.source <> 'touch')::int AS with_markets,
                       max(m.overview_last_fetched_at) AS max_market_fetched_at
                FROM v2_asset_variants v
                LEFT JOIN v2_variant_markets_latest m ON m.chain = v.chain AND m.address = v.address
                GROUP BY v.chain
            `;
        },

        async findVariantsByAssetIds(assetIds, options) {
            if (assetIds.length === 0) return [];
            const chainFilter = options.chain ? sql`AND chain = ${options.chain}` : sql``;
            const activeFilter = options.includeInactive ? sql`` : sql`AND is_active = true`;
            return sql<V2VariantDbRow[]>`
                SELECT ${sql.unsafe(V2_VARIANT_COLUMNS_SQL)}
                FROM v2_asset_variants
                WHERE asset_id IN ${sql([...assetIds])}
                ${chainFilter}
                ${activeFilter}
                ORDER BY asset_id ASC, chain ASC, address ASC
            `;
        },

        async findVariantsByKey(chain, address) {
            // Canonical owner first: the earliest-registered asset, then by id
            // (mirrors v1's "lowest asset_variants.id wins" for shared mints).
            return sql<V2VariantDbRow[]>`
                SELECT ${sql.unsafe(V2_VARIANT_COLUMNS_SQL)}
                FROM v2_asset_variants
                WHERE chain = ${chain} AND address = ${address}
                ORDER BY is_active DESC, created_at ASC, asset_id ASC
            `;
        },

        async findVariantsByKeys(keys) {
            if (keys.length === 0) return [];
            return sql<V2VariantDbRow[]>`
                SELECT ${sql.unsafe(V2_VARIANT_COLUMNS_PREFIXED_SQL)}
                FROM v2_asset_variants v
                JOIN ${keysRecordset(sql, keys)} ON k.chain = v.chain AND k.address = v.address
                ORDER BY v.chain ASC, v.address ASC, v.is_active DESC, v.created_at ASC, v.asset_id ASC
            `;
        },

        async findMarketsByKeys(keys) {
            if (keys.length === 0) return [];
            const rows = await sql<V2MarketDbRow[]>`
                SELECT m.chain, m.address, m.address AS mint, m.origin,
                       ${sql.unsafe(MARKET_METRIC_COLUMNS.map(c => `m.${c}`).join(', '))},
                       CASE WHEN m.chain = 'solana'
                            THEN (SELECT ml.logo_cdn_url FROM mint_logos ml WHERE ml.mint = m.address)
                            ELSE NULL END AS logo_cdn_url
                FROM v2_variant_markets_latest m
                JOIN ${keysRecordset(sql, keys)} ON k.chain = m.chain AND k.address = m.address
            `;
            return rows;
        },

        async findRollupsByAssetIds(assetIds) {
            if (assetIds.length === 0) return [];
            return sql<V2ChainRollupDbRow[]>`
                SELECT asset_id, chain, liquidity, volume_24h_usd, volume_30d_usd, primary_address,
                       variant_count, last_computed_at
                FROM v2_asset_chain_markets_latest
                WHERE asset_id IN ${sql([...assetIds])}
            `;
        },
    };
}

export type { ChainKind };
