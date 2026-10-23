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

import { CHAINS, CHAIN_KINDS, EVM_NATIVE_ASSET_ADDRESS, isChainKind, type ChainKind } from '@tokens/asset-registry/chains';

import { CURATED_COLLECTION_SLUGS, CURATED_COLLECTION_SLUGS_SQL_LITERAL } from '../db';
import type {
    V2AssetsJobsRepo,
    V2CoinPlatformsRow,
    V2AssetCoinSourceRow,
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
    'coingecko_id',
    'coingecko_id_source',
] as const;
const V2_VARIANT_COLUMNS_SQL = V2_VARIANT_COLUMNS.join(', ');
const V2_VARIANT_COLUMNS_PREFIXED_SQL = V2_VARIANT_COLUMNS.map(c => `v.${c}`).join(', ');

function toStringArray(value: unknown): string[] {
    const parsed = parseJsonb(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

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

        async resolveVariantCoinIds(nowMs) {
            // One set-based UPDATE per chain: a row with no coin id, or one the
            // resolver itself wrote earlier, takes the coin whose `platforms`
            // lists its address (freshest coin row wins when CoinGecko lists two
            // coins on one contract). Admin- and derivation-sourced ids are never
            // touched. Solana addresses are case-sensitive base58; EVM ones are
            // stored lowercase here and compared through the lower() indexes.
            const out: Partial<Record<ChainKind, number>> = {};
            for (const chain of CHAIN_KINDS) {
                const platform = CHAINS[chain].providers.coingeckoPlatform;
                if (!platform) continue;
                const isEvm = CHAINS[chain].family === 'evm';
                const rows = await sql<{ address: string }[]>`
                    UPDATE v2_asset_variants v
                    SET coingecko_id = c.coin_id,
                        coingecko_id_source = 'resolved',
                        updated_at = ${new Date(nowMs)}
                    FROM (
                        SELECT DISTINCT ON (addr) addr, coin_id
                        FROM (
                            SELECT ${isEvm ? sql`lower(platforms->>${platform})` : sql`platforms->>${platform}`} AS addr,
                                   coin_id, last_synced_at
                            FROM coingecko_coins
                            WHERE coalesce(platforms->>${platform}, '') <> ''
                        ) p
                        ORDER BY addr, last_synced_at DESC, coin_id ASC
                    ) c
                    WHERE v.chain = ${chain}
                      AND v.address = c.addr
                      AND (v.coingecko_id IS NULL OR v.coingecko_id_source = 'resolved')
                      AND v.coingecko_id IS DISTINCT FROM c.coin_id
                    RETURNING v.address
                `;
                out[chain] = rows.length;
            }
            return out;
        },

        async listAssetCoinSources(maxAssets) {
            // One row per (asset, coin) the derivation should read platforms
            // for: the asset's own reference coin, plus every distinct coin its
            // active variants link to. `maxAssets` bounds the scan by asset so
            // the caller can tell a complete scan from a truncated one.
            const rows = await sql<
                {
                    asset_id: string;
                    category: string;
                    coin_id: string;
                    role: 'reference' | 'variant';
                    source_chain: string | null;
                    source_address: string | null;
                    source_kind: string | null;
                    source_tags: unknown;
                    source_label: string | null;
                    coin_known: boolean;
                    platforms: unknown;
                    detail_platforms: unknown;
                    asset_platform_id: string | null;
                    coin_symbol: string | null;
                    last_synced_at: number | string | bigint | null;
                }[]
            >`
                WITH live_assets AS (
                    SELECT a.asset_id, a.category, a.coingecko_id
                    FROM assets a
                    WHERE a.is_active = true
                      AND NOT EXISTS (
                          SELECT 1 FROM asset_deletion_tombstones dt WHERE dt.asset_id = a.asset_id
                      )
                ),
                sources AS (
                    SELECT a.asset_id, a.category, trim(a.coingecko_id) AS coin_id, 'reference' AS role,
                           NULL::text AS source_chain, NULL::text AS source_address, NULL::text AS source_kind,
                           NULL::jsonb AS source_tags, NULL::text AS source_label
                    FROM live_assets a
                    WHERE a.coingecko_id IS NOT NULL AND length(trim(a.coingecko_id)) > 0
                    UNION ALL
                    -- Parenthesized: an ORDER BY after UNION ALL would apply to the
                    -- union (where the alias v is out of scope) instead of the DISTINCT ON.
                    (
                        SELECT DISTINCT ON (v.asset_id, v.coingecko_id)
                               v.asset_id, a.category, v.coingecko_id, 'variant',
                               v.chain, v.address, v.kind, v.tags, v.label
                        FROM v2_asset_variants v
                        JOIN live_assets a ON a.asset_id = v.asset_id
                        WHERE v.is_active = true
                          AND v.coingecko_id IS NOT NULL
                          AND v.coingecko_id IS DISTINCT FROM trim(a.coingecko_id)
                        ORDER BY v.asset_id, v.coingecko_id, (v.chain = 'solana') DESC, v.address ASC
                    )
                ),
                scoped AS (
                    SELECT DISTINCT asset_id FROM sources ORDER BY asset_id ASC LIMIT ${Math.max(1, Math.floor(maxAssets))}
                )
                -- LEFT JOIN: a scoped asset whose coin id is unknown to coingecko_coins
                -- still comes back (platforms NULL, coin_known false) so the caller's
                -- count of scanned assets is the bounded selection, not the joined rows.
                SELECT s.asset_id, s.category, s.coin_id, s.role,
                       s.source_chain, s.source_address, s.source_kind, s.source_tags, s.source_label,
                       (c.coin_id IS NOT NULL) AS coin_known,
                       c.platforms,
                       c.coin->'detail_platforms' AS detail_platforms,
                       c.coin->>'asset_platform_id' AS asset_platform_id,
                       c.symbol AS coin_symbol,
                       c.last_synced_at
                FROM sources s
                JOIN scoped sc ON sc.asset_id = s.asset_id
                LEFT JOIN coingecko_coins c ON c.coin_id = s.coin_id
                ORDER BY s.asset_id ASC, (s.role = 'reference') DESC, s.coin_id ASC
            `;
            return rows.map((row): V2AssetCoinSourceRow => ({
                assetId: row.asset_id,
                category: row.category,
                coinId: row.coin_id,
                role: row.role,
                source:
                    row.role === 'variant' && row.source_chain && row.source_address && isChainKind(row.source_chain)
                        ? {
                              chain: row.source_chain,
                              address: row.source_address,
                              kind: row.source_kind ?? 'spot',
                              tags: toStringArray(row.source_tags),
                              label: row.source_label ?? null,
                          }
                        : null,
                coinKnown: row.coin_known === true,
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
                    last_synced_at: number | string | bigint | null;
                }[]
            >`
                SELECT coin_id, symbol, platforms, coin->'detail_platforms' AS detail_platforms, last_synced_at
                FROM coingecko_coins
                WHERE coin_id IN ${sql([...coinIds])}
            `;
            return rows.map((row): V2CoinPlatformsRow => ({
                coinId: row.coin_id,
                symbol: row.symbol ?? null,
                platforms: toStringRecord(row.platforms),
                decimalsByPlatform: toDecimalsRecord(row.detail_platforms),
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
                    coingecko_id, coingecko_id_source,
                    first_seen_at, last_seen_at, created_at, updated_at
                )
                VALUES (
                    ${args.chain}, ${args.address}, ${args.assetId}, ${args.variantId}, ${args.kind}, ${args.trustTier},
                    NULL, ${sql.json([...args.tags] as never)},
                    ${args.label}, NULL, NULL, ${args.decimals}, ${args.origin}, ${args.origin}, true,
                    ${args.coingeckoId}, ${args.coingeckoId === null ? null : 'derived'},
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
                    -- An admin-set coin id outranks the derivation; otherwise the
                    -- coin this row was derived from is the row's coin.
                    coingecko_id = CASE
                        WHEN v2_asset_variants.coingecko_id_source = 'admin' THEN v2_asset_variants.coingecko_id
                        ELSE coalesce(EXCLUDED.coingecko_id, v2_asset_variants.coingecko_id)
                    END,
                    coingecko_id_source = CASE
                        WHEN v2_asset_variants.coingecko_id_source = 'admin' THEN 'admin'
                        WHEN EXCLUDED.coingecko_id IS NOT NULL THEN 'derived'
                        ELSE v2_asset_variants.coingecko_id_source
                    END,
                    last_seen_at = EXCLUDED.last_seen_at,
                    updated_at = EXCLUDED.updated_at
                WHERE v2_asset_variants.origin IN ('coingecko', 'config')
                RETURNING (xmax = 0) AS inserted
            `;
            const row = rows[0];
            if (!row) return 'skipped';
            return row.inserted ? 'inserted' : 'updated';
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

        async listStaleActiveVariantsByChains(chains, cutoffs, limit) {
            if (chains.length === 0) return [];
            // One row per (chain, address) — the same address can back several
            // assets — whose market snapshot is missing or older than the cutoff.
            // Rows whose last answer from Birdeye was empty (last_empty_at at or
            // after the last successful write) use the slower `empty` cutoff so
            // dead deployments stop crowding out rows with data.
            // Stalest first so a capped batch always makes progress through the
            // tail; curated rank only breaks ties (e.g. between never-fetched rows).
            const beforeOverviewFetchedAt = cutoffs.beforeOverviewFetchedAt;
            const beforeEmptyFetchedAt = cutoffs.beforeEmptyFetchedAt ?? cutoffs.beforeOverviewFetchedAt;
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
                   OR m.overview_last_fetched_at < CASE
                        WHEN m.last_empty_at IS NOT NULL AND m.last_empty_at >= coalesce(m.last_fetched_at, 0)
                        THEN ${beforeEmptyFetchedAt}
                        ELSE ${beforeOverviewFetchedAt}
                      END
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

        async upsertVariantMarketFromBirdeye(args) {
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
            `;
            // One sample per UTC day for the 30d roll-up: Birdeye's volume24h is a
            // trailing window, so the LAST sample of a day (not the max) approximates
            // that day's volume without double counting the previous day's tail.
            if (typeof args.volume24hUSD === 'number' && Number.isFinite(args.volume24hUSD) && args.volume24hUSD >= 0) {
                await sql`
                    INSERT INTO v2_variant_volume_daily (chain, address, day, volume_24h_usd, sampled_at)
                    VALUES (
                        ${args.chain}, ${args.address},
                        (to_timestamp(${args.lastFetchedAt} / 1000.0) AT TIME ZONE 'UTC')::date,
                        ${args.volume24hUSD}, ${args.lastFetchedAt}
                    )
                    ON CONFLICT (chain, address, day) DO UPDATE SET
                        volume_24h_usd = EXCLUDED.volume_24h_usd,
                        sampled_at = EXCLUDED.sampled_at
                    WHERE EXCLUDED.sampled_at > v2_variant_volume_daily.sampled_at
                `;
            }
        },

        async rollupChainVolume30d(chains, nowMs) {
            if (chains.length === 0) return { assetsWritten: 0, rowsWritten: 0 };
            // Last 30 UTC days of daily samples, summed per (asset, chain) over the
            // asset's active variants; `volume_30d_days` = distinct days with a
            // sample so the API can tell a complete window from a partial one.
            const rows = await sql<{ asset_id: string; chain: string }[]>`
                WITH window AS (
                    SELECT ((to_timestamp(${nowMs} / 1000.0) AT TIME ZONE 'UTC')::date - 30) AS start_day
                ),
                totals AS (
                    SELECT v.asset_id, v.chain,
                           sum(d.volume_24h_usd) AS volume_30d_usd,
                           count(DISTINCT d.day)::int AS days,
                           count(DISTINCT v.address)::int AS variant_count
                    FROM v2_asset_variants v
                    JOIN assets a ON a.asset_id = v.asset_id AND a.is_active = true
                    JOIN v2_variant_volume_daily d ON d.chain = v.chain AND d.address = v.address
                    CROSS JOIN window w
                    WHERE v.is_active = true
                      AND v.chain IN ${sql([...chains])}
                      AND d.day >= w.start_day
                    GROUP BY v.asset_id, v.chain
                )
                INSERT INTO v2_asset_chain_markets_latest (
                    asset_id, chain, liquidity, volume_24h_usd, volume_30d_usd, volume_30d_days,
                    primary_address, variant_count, last_computed_at, origin
                )
                SELECT t.asset_id, t.chain, 0, 0, t.volume_30d_usd, t.days, NULL, t.variant_count, ${nowMs}, 'computed'
                FROM totals t
                ON CONFLICT (asset_id, chain) DO UPDATE SET
                    volume_30d_usd = EXCLUDED.volume_30d_usd,
                    volume_30d_days = EXCLUDED.volume_30d_days,
                    variant_count = EXCLUDED.variant_count,
                    last_computed_at = EXCLUDED.last_computed_at,
                    updated_at = now()
                WHERE v2_asset_chain_markets_latest.origin = 'computed'
                RETURNING asset_id, chain
            `;
            return { assetsWritten: new Set(rows.map(r => r.asset_id)).size, rowsWritten: rows.length };
        },

        async pruneVolumeDaily(olderThanDays, nowMs) {
            const rows = await sql<{ day: string }[]>`
                DELETE FROM v2_variant_volume_daily
                WHERE day < ((to_timestamp(${nowMs} / 1000.0) AT TIME ZONE 'UTC')::date - ${Math.max(1, Math.floor(olderThanDays))})
                RETURNING day
            `;
            return rows.length;
        },

        async touchVariantMarket(chain, address, lastFetchedAt) {
            // A touch records the attempt (overview_last_fetched_at) and that it came
            // back empty (last_empty_at); last_fetched_at stays where the last successful
            // write left it so "last successful write" remains readable from the row.
            await sql`
                INSERT INTO v2_variant_markets_latest (chain, address, source, last_fetched_at, overview_last_fetched_at, last_empty_at, origin)
                VALUES (${chain}, ${address}, 'touch', ${lastFetchedAt}, ${lastFetchedAt}, ${lastFetchedAt}, 'birdeye')
                ON CONFLICT (chain, address) DO UPDATE SET
                    overview_last_fetched_at = EXCLUDED.overview_last_fetched_at,
                    last_empty_at = EXCLUDED.last_empty_at,
                    last_fetched_at = CASE
                        WHEN v2_variant_markets_latest.source = 'touch' THEN EXCLUDED.last_fetched_at
                        ELSE v2_variant_markets_latest.last_fetched_at
                    END,
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
                SELECT asset_id, chain, liquidity, volume_24h_usd, volume_30d_usd, volume_30d_days, primary_address,
                       variant_count, last_computed_at, origin
                FROM v2_asset_chain_markets_latest
                WHERE asset_id IN ${sql([...assetIds])}
            `;
        },
    };
}

export type { ChainKind };
