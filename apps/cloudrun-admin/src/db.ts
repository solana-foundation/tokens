import postgres, { type Sql } from 'postgres';

import type { CuratedListSlug } from '@tokens/asset-registry/curated-lists';

import type { AdminRepo, CategorySummary } from './handlers/curatedTokens';

let cached: Sql | null = null;

export function getSql(): Sql {
    if (cached) return cached;
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error('DATABASE_URL must be set');
    cached = postgres(url, {
        max: Number(process.env.PG_POOL_MAX) || 10,
        idle_timeout: Number(process.env.PG_IDLE_TIMEOUT) || 240,
        connect_timeout: Number(process.env.PG_CONNECT_TIMEOUT) || 30,
        connection: { application_name: 'cloudrun-admin' },
    });
    return cached;
}

export function randomId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function toNullableNumber(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

interface CategorySummaryRow {
    collection_slug: CuratedListSlug;
    title: string | null;
    description: string | null;
    count: string | number;
    last_added_asset_id: string | null;
}

export function makePostgresAdminRepo(sql: Sql): AdminRepo {
    return {
        async listCategorySummaries(slugs) {
            if (slugs.length === 0) return [];
            const rows = await sql<CategorySummaryRow[]>`
                SELECT s.slug AS collection_slug,
                       c.title AS title,
                       c.description AS description,
                       COALESCE(m.count, 0) AS count,
                       m.last_added_asset_id AS last_added_asset_id
                FROM UNNEST(${sql.array(slugs as unknown as string[])}::text[]) AS s(slug)
                LEFT JOIN asset_collections c ON c.slug = s.slug
                LEFT JOIN LATERAL (
                    SELECT COUNT(*) AS count,
                           (SELECT asset_id FROM asset_collection_members
                            WHERE collection_slug = s.slug
                            ORDER BY rank DESC LIMIT 1) AS last_added_asset_id
                    FROM asset_collection_members
                    WHERE collection_slug = s.slug
                ) m ON true
            `;
            const result: CategorySummary[] = rows.map(row => ({
                id: row.collection_slug,
                name: row.title ?? '',
                description: row.description,
                count: Number(row.count) || 0,
                lastAddedAssetId: row.last_added_asset_id,
            }));
            return result;
        },
    };
}
