/** Postgres implementation of `TokenListsAdminRepo` (see handlers/tokenListsAdmin.ts). */

import type { Sql } from 'postgres';

import type { TokenListAdminRow, TokenListsAdminRepo } from '../handlers/tokenListsAdmin';

interface PgTokenListRow {
    id: string;
    slug: string;
    owner_project_id: string;
    name: string;
    status: string;
    admin_locked_at: string | number | null;
    member_count: number;
    created_at: string | number;
    updated_at: string | number;
}

export function makePostgresTokenListsAdminRepo(sql: Sql): TokenListsAdminRepo {
    return {
        async listAll(limit, offset) {
            const rows = await sql<PgTokenListRow[]>`
                SELECT tl.id,
                       tl.slug,
                       tl.owner_project_id,
                       tl.name,
                       tl.status,
                       tl.admin_locked_at,
                       (SELECT COUNT(*)::int FROM token_list_members m WHERE m.list_id = tl.id) AS member_count,
                       (EXTRACT(EPOCH FROM tl.created_at) * 1000)::bigint AS created_at,
                       (EXTRACT(EPOCH FROM tl.updated_at) * 1000)::bigint AS updated_at
                FROM token_lists tl
                ORDER BY tl.updated_at DESC, tl.slug ASC
                LIMIT ${limit} OFFSET ${offset}
            `;
            return rows.map(
                (row): TokenListAdminRow => ({
                    id: row.id,
                    slug: row.slug,
                    ownerProjectId: row.owner_project_id,
                    name: row.name,
                    status: row.status,
                    adminLockedAt: row.admin_locked_at === null ? null : Number(row.admin_locked_at),
                    memberCount: row.member_count,
                    createdAt: Number(row.created_at),
                    updatedAt: Number(row.updated_at),
                }),
            );
        },
        async archiveBySlug(slug, nowMs) {
            // Archive + lock in one write: while admin_locked_at is set, every
            // owner mutation is refused, so the takedown cannot be reverted.
            const rows = await sql<{ id: string }[]>`
                UPDATE token_lists
                SET status = 'archived', admin_locked_at = ${nowMs}, updated_at = ${new Date(nowMs)}
                WHERE slug = ${slug}
                RETURNING id
            `;
            return rows.length > 0;
        },
        async unlockBySlug(slug, nowMs) {
            const rows = await sql<{ id: string }[]>`
                UPDATE token_lists
                SET admin_locked_at = NULL, updated_at = ${new Date(nowMs)}
                WHERE slug = ${slug} AND admin_locked_at IS NOT NULL
                RETURNING id
            `;
            return rows.length > 0;
        },
    };
}
