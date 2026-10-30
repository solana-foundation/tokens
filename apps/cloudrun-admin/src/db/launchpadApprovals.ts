/**
 * Postgres implementation of `LaunchpadApprovalsRepo` (see
 * handlers/launchpadApprovals.ts). Each mutation is one `sql.begin`
 * transaction so the approval row and the audit event land together.
 *
 * The transaction bodies are exported so tests can drive them with a
 * recording fake `tx` (same style as db/variantAdvisories.test.ts).
 */

import type { Sql, TransactionSql } from 'postgres';

import type {
    Launchpad,
    LaunchpadApprovalActor,
    LaunchpadApprovalSnapshot,
    LaunchpadApprovalsRepo,
    LaunchpadCandidateRow,
} from '../handlers/launchpadApprovals';
import { randomId, toNullableNumber } from '../db';
import { resolveCanonicalLogoState } from '../handlers/shared';

type Tx = TransactionSql;

interface PgCandidateRow {
    launchpad: string;
    mint: string;
    synced: boolean;
    is_active: boolean | null;
    quote_mint: string | null;
    quote_symbol: string | null;
    symbol: string | null;
    name: string | null;
    logo_uri: string | null;
    market_cap_usd: string | number | null;
    volume_24h_usd: string | number | null;
    launched_at: string | number | null;
    last_synced_at: string | number | null;
    quote_asset_id: string | null;
    quote_asset_name: string | null;
    quote_asset_symbol: string | null;
    quote_asset_image_url: string | null;
    approval_note: string | null;
    approved_by: string | null;
    approved_by_email: string | null;
    approved_at: string | number | null;
    approval_updated_at: string | number | null;
}

function mapCandidateRow(row: PgCandidateRow): LaunchpadCandidateRow {
    return {
        launchpad: row.launchpad,
        mint: row.mint,
        synced: row.synced,
        isActive: row.is_active === true,
        quoteMint: row.quote_mint,
        quoteSymbol: row.quote_symbol,
        symbol: row.symbol,
        name: row.name,
        logoURI: row.logo_uri,
        marketCapUsd: toNullableNumber(row.market_cap_usd),
        volume24hUsd: toNullableNumber(row.volume_24h_usd),
        launchedAt: toNullableNumber(row.launched_at),
        lastSyncedAt: toNullableNumber(row.last_synced_at),
        quoteAsset: row.quote_asset_id
            ? {
                  assetId: row.quote_asset_id,
                  name: row.quote_asset_name,
                  symbol: row.quote_asset_symbol,
                  imageUrl: resolveCanonicalLogoState({
                      assetId: row.quote_asset_id,
                      name: row.quote_asset_name,
                      symbol: row.quote_asset_symbol,
                      imageUrl: row.quote_asset_image_url,
                  }).resolvedImageUrl,
              }
            : null,
        approval:
            row.approved_by !== null && row.approved_at !== null
                ? {
                      note: row.approval_note,
                      approvedBy: row.approved_by,
                      approvedByEmail: row.approved_by_email,
                      approvedAt: Number(row.approved_at),
                      updatedAt: Number(row.approval_updated_at ?? row.approved_at),
                  }
                : null,
    };
}

export interface ApproveTxArgs {
    launchpad: Launchpad;
    mint: string;
    note: string | null;
    snapshot: LaunchpadApprovalSnapshot;
    actor: LaunchpadApprovalActor;
    nowMs: number;
}

/** Exported for tests (recording fake `tx`). */
export async function approveInTx(tx: Tx, args: ApproveTxArgs): Promise<{ created: boolean; approvedAt: number }> {
    // approved_at answers "since when is this coin approved": never touched on
    // re-approve; actor / updated_at refresh, and a new note replaces the old one
    // (re-approving without a note keeps the existing one).
    const rows = await tx<Array<{ approved_at: string | number }>>`
        INSERT INTO launchpad_mint_approvals (
            launchpad, mint, note, quote_mint, symbol, name, logo_uri,
            approved_by, approved_by_email, approved_at, updated_at
        )
        VALUES (
            ${args.launchpad}, ${args.mint}, ${args.note},
            ${args.snapshot.quoteMint}, ${args.snapshot.symbol}, ${args.snapshot.name}, ${args.snapshot.logoURI},
            ${args.actor.clerkUserId}, ${args.actor.email}, ${args.nowMs}, ${args.nowMs}
        )
        ON CONFLICT (launchpad, mint) DO UPDATE SET
            note = COALESCE(EXCLUDED.note, launchpad_mint_approvals.note),
            quote_mint = COALESCE(EXCLUDED.quote_mint, launchpad_mint_approvals.quote_mint),
            symbol = COALESCE(EXCLUDED.symbol, launchpad_mint_approvals.symbol),
            name = COALESCE(EXCLUDED.name, launchpad_mint_approvals.name),
            logo_uri = COALESCE(EXCLUDED.logo_uri, launchpad_mint_approvals.logo_uri),
            approved_by = EXCLUDED.approved_by,
            approved_by_email = EXCLUDED.approved_by_email,
            updated_at = EXCLUDED.updated_at
        RETURNING approved_at
    `;
    const approvedAt = Number(rows[0]?.approved_at ?? args.nowMs);

    await tx`
        INSERT INTO launchpad_mint_approval_events (
            id, launchpad, mint, action, note, actor_clerk_user_id, actor_email, created_at
        )
        VALUES (
            ${randomId('lma')}, ${args.launchpad}, ${args.mint}, 'approve', ${args.note},
            ${args.actor.clerkUserId}, ${args.actor.email}, ${args.nowMs}
        )
    `;

    return { created: approvedAt === args.nowMs, approvedAt };
}

export interface RevokeTxArgs {
    launchpad: Launchpad;
    mint: string;
    actor: LaunchpadApprovalActor;
    nowMs: number;
}

/** Exported for tests (recording fake `tx`). */
export async function revokeInTx(tx: Tx, args: RevokeTxArgs): Promise<'revoked' | 'not_found'> {
    const deleted = await tx<Array<{ mint: string }>>`
        DELETE FROM launchpad_mint_approvals
        WHERE launchpad = ${args.launchpad} AND mint = ${args.mint}
        RETURNING mint
    `;
    if (deleted.length === 0) return 'not_found';

    await tx`
        INSERT INTO launchpad_mint_approval_events (
            id, launchpad, mint, action, note, actor_clerk_user_id, actor_email, created_at
        )
        VALUES (
            ${randomId('lma')}, ${args.launchpad}, ${args.mint}, 'revoke', NULL,
            ${args.actor.clerkUserId}, ${args.actor.email}, ${args.nowMs}
        )
    `;
    return 'revoked';
}

export function makePostgresLaunchpadApprovalsRepo(sql: Sql): LaunchpadApprovalsRepo {
    return {
        async approve(args) {
            return await sql.begin(tx => approveInTx(tx, args));
        },

        async revoke(args) {
            return await sql.begin(tx => revokeInTx(tx, args));
        },

        async listCandidates({ launchpad, approvedOnly, limit }) {
            // FULL OUTER JOIN so an approval without a synced row (approved by
            // address, not yet picked up by the sync) still shows in the table.
            const rows = await sql<PgCandidateRow[]>`
                SELECT COALESCE(l.launchpad, a.launchpad) AS launchpad,
                       COALESCE(l.mint, a.mint)           AS mint,
                       (l.mint IS NOT NULL)               AS synced,
                       l.is_active,
                       COALESCE(l.quote_mint, a.quote_mint) AS quote_mint,
                       l.quote_symbol,
                       COALESCE(l.symbol, a.symbol)         AS symbol,
                       COALESCE(l.name, a.name)             AS name,
                       COALESCE(l.logo_uri, a.logo_uri)     AS logo_uri,
                       l.market_cap_usd, l.volume_24h_usd, l.launched_at, l.last_synced_at,
                       qa.asset_id   AS quote_asset_id,
                       qa.name       AS quote_asset_name,
                       qa.symbol     AS quote_asset_symbol,
                       qa.image_url  AS quote_asset_image_url,
                       a.note        AS approval_note,
                       a.approved_by, a.approved_by_email, a.approved_at,
                       a.updated_at  AS approval_updated_at
                FROM launchpad_tokens_latest l
                FULL OUTER JOIN launchpad_mint_approvals a
                    ON a.launchpad = l.launchpad AND a.mint = l.mint
                -- Canonical asset that owns the quote mint (mint is not unique in
                -- asset_variants; the lowest id is canonical, as in setAdvisoryInTx).
                LEFT JOIN LATERAL (
                    SELECT ca.asset_id, ca.name, ca.symbol, ca.image_url
                    FROM asset_variants av
                    JOIN assets ca ON ca.asset_id = av.asset_id
                    WHERE av.mint = COALESCE(l.quote_mint, a.quote_mint) AND av.is_active = true
                    ORDER BY av.id ASC
                    LIMIT 1
                ) qa ON true
                WHERE COALESCE(l.launchpad, a.launchpad) = ${launchpad}
                  ${approvedOnly ? sql`AND a.mint IS NOT NULL` : sql``}
                ORDER BY (a.mint IS NOT NULL) DESC,
                         l.volume_24h_usd DESC NULLS LAST,
                         COALESCE(l.mint, a.mint) ASC
                LIMIT ${limit}
            `;
            return rows.map(mapCandidateRow);
        },
    };
}
