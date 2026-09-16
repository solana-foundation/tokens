/**
 * Postgres implementation of `HardDeleteRepo` (see handlers/hardDelete.ts).
 *
 * One transaction that mirrors Convex `hardDeleteAsset`'s cascade, plus the
 * PG-only cache tables (`variant_fill_quality_latest`, `asset_variant_views`).
 * Postgres deletes candles in bulk, so there is no Convex-style delete budget.
 */

import type { Sql } from 'postgres';

import { buildDeletionTombstoneRows, type HardDeleteCounters, type HardDeleteRepo } from '../handlers/hardDelete';
import { HARD_DELETE_COLLECTION_SLUGS, uniqueStrings } from '../handlers/shared';
import { randomId } from '../db';

export function makePostgresHardDeleteRepo(sql: Sql): HardDeleteRepo {
    return {
        async hardDeleteAsset({ assetId, nowMs }) {
            return await sql.begin(async (tx): Promise<HardDeleteCounters | null> => {
                const assetRows = await tx<
                    Array<{
                        name: string | null;
                        symbol: string | null;
                        coingecko_id: string | null;
                        aliases: unknown;
                    }>
                >`
                    SELECT name, symbol, coingecko_id, aliases
                    FROM assets WHERE asset_id = ${assetId}
                    LIMIT 1
                    FOR UPDATE
                `;
                const asset = assetRows[0];
                if (!asset) return null;

                const variantRows = await tx<Array<{ mint: string }>>`
                    SELECT mint FROM asset_variants WHERE asset_id = ${assetId}
                `;
                const mints = uniqueStrings(variantRows.map(row => row.mint));
                const mintsArray = sql.array(mints); // empty => '{}'::text[], ANY() matches nothing

                const aliasRows = await tx<Array<{ alias: string }>>`
                    SELECT alias FROM asset_aliases WHERE asset_id = ${assetId}
                `;

                const coingeckoId = asset.coingecko_id?.trim() || null;

                // 1. Tombstones (INSERT … SELECT … WHERE NOT EXISTS on normalized_ref).
                const tombstoneRows = buildDeletionTombstoneRows({
                    assetId,
                    name: asset.name,
                    symbol: asset.symbol,
                    coingeckoId: asset.coingecko_id,
                    assetAliases: Array.isArray(asset.aliases) ? (asset.aliases as string[]) : [],
                    aliasRowAliases: aliasRows.map(row => row.alias),
                    mints,
                });
                let tombstonesCreated = 0;
                if (tombstoneRows.length > 0) {
                    const payload = tombstoneRows.map(row => ({
                        id: randomId('adt'),
                        normalized_ref: row.normalizedRef,
                        ref: row.ref,
                        kind: row.kind,
                    }));
                    const inserted = await tx`
                        INSERT INTO asset_deletion_tombstones (id, asset_id, normalized_ref, ref, kind, created_at)
                        SELECT r.id, ${assetId}, r.normalized_ref, r.ref, r.kind, ${new Date(nowMs)}
                        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
                             AS r(id text, normalized_ref text, ref text, kind text)
                        WHERE NOT EXISTS (
                            SELECT 1 FROM asset_deletion_tombstones t WHERE t.normalized_ref = r.normalized_ref
                        )
                        RETURNING id
                    `;
                    tombstonesCreated = inserted.length;
                }

                // 2. Memberships (includes 'lsts' on top of the six curated slugs).
                const memberships = await tx`
                    DELETE FROM asset_collection_members
                    WHERE asset_id = ${assetId}
                      AND collection_slug = ANY(${sql.array(HARD_DELETE_COLLECTION_SLUGS as unknown as string[])}::text[])
                `;

                // 3. Aliases (all kinds).
                const aliases = await tx`DELETE FROM asset_aliases WHERE asset_id = ${assetId}`;

                // 4. Aggregated asset market row.
                const assetMarket = await tx`DELETE FROM asset_markets_latest WHERE asset_id = ${assetId}`;

                // 5. Per-mint caches.
                const variantMarkets = await tx`DELETE FROM variant_markets_latest WHERE mint = ANY(${mintsArray}::text[])`;
                const tokenMarkets = await tx`DELETE FROM token_markets_latest WHERE mint = ANY(${mintsArray}::text[])`;
                const tokenDocs = await tx`DELETE FROM tokens WHERE address = ANY(${mintsArray}::text[])`;
                const summaries = await tx`
                    DELETE FROM token_description_summaries WHERE address = ANY(${mintsArray}::text[])
                `;
                const assetRisk = await tx`
                    DELETE FROM asset_risk_latest
                    WHERE mint = ANY(${mintsArray}::text[]) AND asset_id = ${assetId}
                `;
                const webacyToken = await tx`
                    DELETE FROM webacy_token_latest WHERE chain = 'solana' AND address = ANY(${mintsArray}::text[])
                `;
                const webacyTrading = await tx`
                    DELETE FROM webacy_trading_lite_latest WHERE chain = 'solana' AND address = ANY(${mintsArray}::text[])
                `;
                const webacyHolders = await tx`
                    DELETE FROM webacy_holder_analysis_latest WHERE chain = 'solana' AND address = ANY(${mintsArray}::text[])
                `;
                // Stablecoin depeg / structural-health snapshots (0019). Tier and
                // structural history is per-mint provider data, not audit; the
                // advisory events table is the audit trail and is kept.
                const webacyDepeg = await tx`
                    DELETE FROM webacy_depeg_latest WHERE chain = 'solana' AND address = ANY(${mintsArray}::text[])
                `;
                const webacyDepegEvents = await tx`
                    DELETE FROM webacy_depeg_tier_events WHERE chain = 'solana' AND address = ANY(${mintsArray}::text[])
                `;
                const webacyStructural = await tx`
                    DELETE FROM webacy_structural_health_latest WHERE chain = 'solana' AND address = ANY(${mintsArray}::text[])
                `;
                const webacyStructuralDaily = await tx`
                    DELETE FROM webacy_structural_health_daily WHERE chain = 'solana' AND address = ANY(${mintsArray}::text[])
                `;
                const ohlcv = await tx`DELETE FROM ohlcv_candles WHERE address = ANY(${mintsArray}::text[])`;

                // 6. CoinGecko caches (only when the asset had a coingecko id).
                let coingeckoPricesDeleted = 0;
                let coingeckoTickersDeleted = 0;
                let coingeckoOhlcvDeleted = 0;
                if (coingeckoId) {
                    const prices = await tx`DELETE FROM coingecko_prices_latest WHERE coin_id = ${coingeckoId}`;
                    const tickers = await tx`DELETE FROM coingecko_coin_tickers_latest WHERE coin_id = ${coingeckoId}`;
                    const candles = await tx`DELETE FROM coingecko_ohlcv_candles WHERE coin_id = ${coingeckoId}`;
                    coingeckoPricesDeleted = prices.count;
                    coingeckoTickersDeleted = tickers.count;
                    coingeckoOhlcvDeleted = candles.count;
                }

                // 7. RWA.xyz caches: delete token rows, then provider assets with
                //    no remaining token rows.
                const rwaProviderIdRows = await tx<Array<{ asset_id: number }>>`
                    SELECT DISTINCT asset_id FROM rwa_xyz_tokens_latest
                    WHERE network_slug = 'solana' AND address = ANY(${mintsArray}::text[]) AND asset_id IS NOT NULL
                `;
                const rwaTokens = await tx`
                    DELETE FROM rwa_xyz_tokens_latest
                    WHERE network_slug = 'solana' AND address = ANY(${mintsArray}::text[])
                `;
                const rwaProviderIds = rwaProviderIdRows
                    .map(row => Number(row.asset_id))
                    .filter(id => Number.isFinite(id));
                let rwaAssetCacheDeleted = 0;
                if (rwaProviderIds.length > 0) {
                    const rwaAssets = await tx`
                        DELETE FROM rwa_xyz_assets_latest a
                        WHERE a.asset_id = ANY(${sql.array(rwaProviderIds)}::integer[])
                          AND NOT EXISTS (
                              SELECT 1 FROM rwa_xyz_tokens_latest t WHERE t.asset_id = a.asset_id
                          )
                    `;
                    rwaAssetCacheDeleted = rwaAssets.count;
                }

                // 8. PG-only caches (no Convex counterpart / counter).
                await tx`DELETE FROM variant_fill_quality_latest WHERE mint = ANY(${mintsArray}::text[])`;
                await tx`DELETE FROM asset_variant_views WHERE asset_id = ${assetId}`;

                // 9. Variants + the canonical asset row itself.
                const variants = await tx`DELETE FROM asset_variants WHERE asset_id = ${assetId}`;
                await tx`DELETE FROM assets WHERE asset_id = ${assetId}`;

                return {
                    membershipsDeleted: memberships.count,
                    aliasesDeleted: aliases.count,
                    variantsDeleted: variants.count,
                    variantMarketsDeleted: variantMarkets.count,
                    tokenMarketsDeleted: tokenMarkets.count,
                    tokenDocsDeleted: tokenDocs.count,
                    tokenDescriptionSummariesDeleted: summaries.count,
                    assetRiskDeleted: assetRisk.count,
                    ohlcvDeleted: ohlcv.count,
                    webacyDeleted:
                        webacyToken.count +
                        webacyTrading.count +
                        webacyHolders.count +
                        webacyDepeg.count +
                        webacyDepegEvents.count +
                        webacyStructural.count +
                        webacyStructuralDaily.count,
                    rwaTokenCacheDeleted: rwaTokens.count,
                    rwaAssetCacheDeleted,
                    assetMarketDeleted: assetMarket.count,
                    coingeckoPricesDeleted,
                    coingeckoTickersDeleted,
                    coingeckoOhlcvDeleted,
                    tombstonesCreated,
                };
            });
        },
    };
}
