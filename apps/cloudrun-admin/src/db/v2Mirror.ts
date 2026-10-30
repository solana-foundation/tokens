/**
 * Per-row v2 (multichain) writes that keep `v2_asset_variants` /
 * `v2_variant_markets_latest` consistent with a v1 Solana edit inside the
 * SAME transaction, so the tokens.xyz asset page (which reads only v2) sees
 * an admin change at once instead of on the next `sync-v2-solana-variants`
 * tick (every 5 min in prd). The statements are single-row copies of the
 * worker's set-based mirror (apps/cloudrun-assets/src/db/v2Assets.ts) and
 * use the same guards: only `origin = 'solana_v1'` rows are ever touched, and
 * an upsert never rolls `last_seen_at` backwards, so an overlapping cron tick
 * and an admin write cannot clobber each other.
 *
 * The column lists are deliberately duplicated rather than imported across
 * apps (the two Cloud Run services share no DB package); keep them in step
 * with `MARKET_METRIC_COLUMNS` and the variants INSERT in the worker.
 *
 * EVM rows are never mirrored (they are v2-native); see the EVM branches in
 * `curatedTokensMutations.ts` for how admin edits adopt them.
 */

import type { TransactionSql } from 'postgres';

type Tx = TransactionSql;

/**
 * Advisory lock shared with the worker's set-based mirror
 * (apps/cloudrun-assets/src/db/v2Assets.ts `V2_SOLANA_MIRROR_LOCK_KEY`; keep
 * the two literals equal). Held for the rest of the admin transaction, so a
 * cron tick cannot snapshot v1 between our v1 write and our commit, and we
 * cannot stamp a row while the cron is mid-copy.
 */
export const V2_SOLANA_MIRROR_LOCK_KEY = 830_033;

/** Take the mirror lock for the rest of `tx` (re-entrant within the transaction). */
export async function lockSolanaMirror(tx: Tx): Promise<void> {
    await tx`SELECT pg_advisory_xact_lock(${V2_SOLANA_MIRROR_LOCK_KEY})`;
}

/** Metric columns shared by variant_markets_latest and v2_variant_markets_latest (same names, same types). */
export const V2_MARKET_METRIC_COLUMNS = [
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

const MARKET_COLUMNS_SQL = V2_MARKET_METRIC_COLUMNS.join(', ');
const MARKET_COLUMNS_PREFIXED_SQL = V2_MARKET_METRIC_COLUMNS.map(c => `vml.${c}`).join(', ');
const MARKET_COLUMNS_EXCLUDED_SQL = V2_MARKET_METRIC_COLUMNS.map(c => `${c} = EXCLUDED.${c}`).join(', ');

/**
 * Copy one v1 Solana variant (and, when present, its market row) into v2.
 * Idempotent: a second call is a no-op update. Returns `'mirrored'` when a v2
 * row was inserted or updated, `'skipped'` when v1 has no such row (or a
 * non-mirror row owns the key).
 *
 * `last_seen_at` is stamped from the database clock once the mirror lock is
 * held (never below `nowMs`), so it is always later than any cron tick that
 * ran before us and the timestamp guard cannot reject this write.
 */
export async function mirrorSolanaVariantRow(
    tx: Tx,
    args: { assetId: string; mint: string; nowMs: number },
): Promise<'mirrored' | 'skipped'> {
    await lockSolanaMirror(tx);
    // A v1 variant whose mint was replaced keeps its variant_id, so a stale
    // mirror row still holding that id on another address (left by a delete
    // that predates this mirror; the cron only deactivates unseen rows, it
    // never removes them) would trip the (asset_id, variant_id) unique index
    // and roll back the v1 edit. Single-row port of the worker mirror's
    // `replaced` DELETE: drop such rows when v1 no longer has them.
    await tx`
        DELETE FROM v2_asset_variants v
        WHERE v.origin = 'solana_v1'
          AND v.chain = 'solana'
          AND v.asset_id = ${args.assetId}
          AND v.address <> ${args.mint}
          AND EXISTS (
              SELECT 1 FROM asset_variants av
              WHERE av.chain = 'solana' AND av.asset_id = v.asset_id AND av.mint = ${args.mint}
                AND av.variant_id = v.variant_id
          )
          AND NOT EXISTS (
              SELECT 1 FROM asset_variants av
              WHERE av.chain = 'solana' AND av.asset_id = v.asset_id AND av.mint = v.address
          )
    `;
    const rows = await tx<Array<{ address: string }>>`
        INSERT INTO v2_asset_variants (
            chain, address, asset_id, variant_id, kind, trust_tier, stock_variant_tier, tags,
            label, issuer, issuer_url, decimals, origin, source, is_active,
            first_seen_at, last_seen_at, created_at, updated_at
        )
        SELECT 'solana', av.mint, av.asset_id, av.variant_id, av.kind, av.trust_tier, av.stock_variant_tier,
               coalesce(av.tags, '[]'::jsonb), av.label, av.issuer, av.issuer_url, vml.decimals,
               'solana_v1', av.source, av.is_active,
               stamp.ms, stamp.ms, now(), now()
        FROM (
            SELECT * FROM asset_variants
            WHERE chain = 'solana' AND asset_id = ${args.assetId} AND mint = ${args.mint}
            ORDER BY is_active DESC, id ASC
            LIMIT 1
        ) av
        LEFT JOIN variant_markets_latest vml ON vml.mint = av.mint
        CROSS JOIN (
            SELECT GREATEST(${args.nowMs}::bigint, (extract(epoch FROM clock_timestamp()) * 1000)::bigint) AS ms
        ) stamp
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
        RETURNING address
    `;
    if (rows.length === 0) return 'skipped';
    await mirrorSolanaMarketRow(tx, args.mint);
    return 'mirrored';
}

/** Copy the v1 market row for one mint into v2 (no-op when v1 has none). */
export async function mirrorSolanaMarketRow(tx: Tx, mint: string): Promise<number> {
    const rows = await tx<Array<{ address: string }>>`
        INSERT INTO v2_variant_markets_latest (chain, address, ${tx.unsafe(MARKET_COLUMNS_SQL)}, origin)
        SELECT 'solana', vml.mint, ${tx.unsafe(MARKET_COLUMNS_PREFIXED_SQL)}, 'solana_v1'
        FROM variant_markets_latest vml
        WHERE vml.mint = ${mint}
        ON CONFLICT (chain, address) DO UPDATE SET
            ${tx.unsafe(MARKET_COLUMNS_EXCLUDED_SQL)},
            updated_at = now()
        WHERE v2_variant_markets_latest.origin = 'solana_v1'
        RETURNING address
    `;
    return rows.length;
}

/**
 * Drop the mirror row for a v1 variant that was deleted. Its market row is
 * left in place (keyed by address, unreachable once nothing references it;
 * the worker's mirror follows the same convention).
 */
export async function deleteSolanaVariantRow(tx: Tx, args: { assetId: string; mint: string }): Promise<number> {
    // Under the mirror lock: a cron copy whose snapshot still had the v1 row
    // would otherwise re-insert it right after our delete commits.
    await lockSolanaMirror(tx);
    const rows = await tx<Array<{ address: string }>>`
        DELETE FROM v2_asset_variants
        WHERE chain = 'solana' AND address = ${args.mint} AND asset_id = ${args.assetId}
          AND origin = 'solana_v1'
        RETURNING address
    `;
    return rows.length;
}

/** Re-home a mirrored Solana variant after `moveVariantToCanonical`. */
export async function moveSolanaVariantRow(
    tx: Tx,
    args: { mint: string; fromAssetId: string; toAssetId: string; nowMs: number },
): Promise<void> {
    await deleteSolanaVariantRow(tx, { assetId: args.fromAssetId, mint: args.mint });
    await mirrorSolanaVariantRow(tx, { assetId: args.toAssetId, mint: args.mint, nowMs: args.nowMs });
}

/**
 * Follow an asset-id rename on the v2 tables (ALL origins: derived and
 * admin EVM rows belong to the asset too). Rows already keyed by `to` are
 * orphans (the caller has verified no asset owns `to`) and are cleared first
 * so the primary keys cannot collide.
 */
export async function renameV2AssetId(tx: Tx, args: { from: string; to: string }): Promise<void> {
    await tx`DELETE FROM v2_asset_variants WHERE asset_id = ${args.to}`;
    await tx`DELETE FROM v2_asset_chain_markets_latest WHERE asset_id = ${args.to}`;
    await tx`UPDATE v2_asset_variants SET asset_id = ${args.to}, updated_at = now() WHERE asset_id = ${args.from}`;
    await tx`
        UPDATE v2_asset_chain_markets_latest SET asset_id = ${args.to}, updated_at = now()
        WHERE asset_id = ${args.from}
    `;
}

/** Remove every v2 row an asset owns (all origins); used by soft and hard delete. */
export async function deleteV2AssetRows(tx: Tx, assetId: string): Promise<{ variantsDeleted: number }> {
    const variants = await tx<Array<{ address: string }>>`
        DELETE FROM v2_asset_variants WHERE asset_id = ${assetId} RETURNING address
    `;
    await tx`DELETE FROM v2_asset_chain_markets_latest WHERE asset_id = ${assetId}`;
    return { variantsDeleted: variants.length };
}

/**
 * Hard-delete cascade for v2: the asset's variant + rollup rows (all
 * origins) and the mirrored Solana market rows for `mints` that no other
 * asset still references.
 */
export async function hardDeleteV2(
    tx: Tx,
    args: { assetId: string; mints: readonly string[] },
): Promise<{ variantsDeleted: number; marketsDeleted: number }> {
    const { variantsDeleted } = await deleteV2AssetRows(tx, args.assetId);
    let marketsDeleted = 0;
    if (args.mints.length > 0) {
        const markets = await tx<Array<{ address: string }>>`
            DELETE FROM v2_variant_markets_latest m
            WHERE m.chain = 'solana' AND m.origin = 'solana_v1'
              AND m.address = ANY(${tx.array([...args.mints])}::text[])
              AND NOT EXISTS (
                  SELECT 1 FROM v2_asset_variants v WHERE v.chain = 'solana' AND v.address = m.address
              )
            RETURNING address
        `;
        marketsDeleted = markets.length;
    }
    return { variantsDeleted, marketsDeleted };
}
