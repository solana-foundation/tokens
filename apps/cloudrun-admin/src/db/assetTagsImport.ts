/**
 * Postgres implementation of `AssetTagsImportRepo` (see handlers/assetTagsImport.ts).
 */

import type { Sql } from 'postgres';

import type { AssetTagsImportRepo, ResolvedAssetTags } from '../handlers/assetTagsImport';

interface ResolvedRow {
    requested: string;
    asset_id: string;
    region: string | null;
    industry: string | null;
    direct: boolean;
}

export function makePostgresAssetTagsImportRepo(sql: Sql): AssetTagsImportRepo {
    return {
        async resolveAssets(requestedIds) {
            const out = new Map<string, ResolvedAssetTags>();
            if (requestedIds.length === 0) return out;
            const normalizedByRequested = new Map<string, string>();
            for (const id of requestedIds) normalizedByRequested.set(id, id.trim().toLowerCase());
            const normalized = Array.from(new Set(normalizedByRequested.values()));

            // Direct matches first; then `assetId`-kind aliases whose normalized
            // form differs from the current id (the admin-rename marker — see
            // db/curatedTokensMutations.ts renameAssetId). The array is bound
            // as a plain parameter with an explicit cast: `sql.array(...)::text[]`
            // makes postgres-js emit a comma-joined string ("malformed array
            // literal") when the same statement binds it more than once.
            const rows = await sql<ResolvedRow[]>`
                SELECT lower(a.asset_id) AS requested, a.asset_id, a.region, a.industry, true AS direct
                FROM assets a
                WHERE lower(a.asset_id) = ANY(${normalized}::text[])
                UNION ALL
                SELECT al.normalized AS requested, a.asset_id, a.region, a.industry, false AS direct
                FROM asset_aliases al
                JOIN assets a ON a.asset_id = al.asset_id
                WHERE al.kind = 'assetId'
                  AND al.normalized = ANY(${normalized}::text[])
                  AND al.normalized <> lower(a.asset_id)
            `;
            const byNormalized = new Map<string, ResolvedRow>();
            for (const row of rows) {
                const existing = byNormalized.get(row.requested);
                if (!existing || (row.direct && !existing.direct)) byNormalized.set(row.requested, row);
            }
            for (const [requested, key] of normalizedByRequested) {
                const row = byNormalized.get(key);
                if (row) out.set(requested, { assetId: row.asset_id, region: row.region, industry: row.industry });
            }
            return out;
        },

        async applyTags(rows, nowMs, mode) {
            if (rows.length === 0) return 0;
            const now = new Date(nowMs);
            // `fill_empty` re-asserts the plan's precondition in the WHERE
            // clause so a concurrent hand edit wins the race.
            const overwrite = mode === 'overwrite';
            return await sql.begin(async tx => {
                let updated = 0;
                for (const row of rows) {
                    const result = await tx`
                        UPDATE assets SET
                            region = ${row.region},
                            industry = ${row.industry},
                            updated_at = ${now},
                            admin_edited_at = ${nowMs}
                        WHERE asset_id = ${row.assetId}
                          AND (${overwrite} OR (region IS NULL AND industry IS NULL))
                    `;
                    updated += result.count ?? 0;
                }
                return updated;
            });
        },

        async listUntaggedStockAssetIds() {
            const rows = await sql<Array<{ asset_id: string }>>`
                SELECT a.asset_id
                FROM asset_collection_members acm
                JOIN assets a ON a.asset_id = acm.asset_id
                WHERE acm.collection_slug = 'stocks'
                  AND a.is_active = true
                  AND a.region IS NULL
                  AND a.industry IS NULL
                ORDER BY acm.rank ASC, a.asset_id ASC
            `;
            return rows.map(row => row.asset_id);
        },
    };
}
