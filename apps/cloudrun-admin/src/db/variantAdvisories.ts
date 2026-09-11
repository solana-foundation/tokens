/**
 * Postgres implementation of `VariantAdvisoriesRepo` (see
 * handlers/variantAdvisories.ts). Each mutation is one `sql.begin`
 * transaction so the advisory row, the optional variant re-activation, and
 * the audit event land together or not at all.
 *
 * The transaction bodies are exported so tests can drive them with a
 * recording fake `tx` (same style as db/curatedTokensMutations.test.ts).
 */

import type { Sql, TransactionSql } from 'postgres';

import { isAdvisoryStatus, type AdvisoryStatus } from '@tokens/asset-registry';

import type {
    AdvisoryActor,
    SetVariantAdvisoryOutcome,
    VariantAdvisoriesRepo,
    VariantAdvisoryEventRow,
    VariantAdvisoryRow,
} from '../handlers/variantAdvisories';
import { randomId } from '../db';

type Tx = TransactionSql;

interface PgAdvisoryRow {
    mint: string;
    status: string;
    reason: string;
    url: string | null;
    set_by: string;
    set_by_email: string | null;
    set_at: string | number;
    updated_at: string | number;
}

interface PgAdvisoryEventRow {
    id: string;
    mint: string;
    action: string;
    status: string | null;
    reason: string | null;
    url: string | null;
    reactivated_variant: boolean;
    actor_clerk_user_id: string;
    actor_email: string | null;
    created_at: string | number;
}

function mapAdvisoryRow(row: PgAdvisoryRow): VariantAdvisoryRow | null {
    // CHECK constraint guarantees this today; guard so a status added to the DB
    // before the package can never break the admin list.
    if (!isAdvisoryStatus(row.status)) return null;
    return {
        mint: row.mint,
        status: row.status,
        reason: row.reason,
        url: row.url,
        setBy: row.set_by,
        setByEmail: row.set_by_email,
        setAt: Number(row.set_at),
        updatedAt: Number(row.updated_at),
    };
}

function mapEventRow(row: PgAdvisoryEventRow): VariantAdvisoryEventRow {
    return {
        id: row.id,
        mint: row.mint,
        action: row.action === 'clear' ? 'clear' : 'set',
        status: isAdvisoryStatus(row.status) ? row.status : null,
        reason: row.reason,
        url: row.url,
        reactivatedVariant: row.reactivated_variant,
        actorClerkUserId: row.actor_clerk_user_id,
        actorEmail: row.actor_email,
        createdAt: Number(row.created_at),
    };
}

export interface SetAdvisoryTxArgs {
    mint: string;
    status: AdvisoryStatus;
    reason: string;
    url: string | null;
    activateVariant: boolean;
    actor: AdvisoryActor;
    nowMs: number;
}

/** Exported for tests (recording fake `tx`). */
export async function setAdvisoryInTx(tx: Tx, args: SetAdvisoryTxArgs): Promise<SetVariantAdvisoryOutcome> {
    // Lock the variant row so a concurrent deactivate/delete cannot interleave
    // with the re-activation below. Mint is not unique in asset_variants; the
    // lowest id is the canonical row (matches getVariantByMint).
    const variants = await tx<Array<{ id: string; is_active: boolean }>>`
        SELECT id, is_active
        FROM asset_variants
        WHERE mint = ${args.mint}
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
    `;
    const variant = variants[0];
    if (!variant) return { outcome: 'variant_not_found' };

    const current = await tx<Array<{ status: string; set_at: string | number }>>`
        SELECT status, set_at
        FROM asset_variant_advisories
        WHERE mint = ${args.mint}
        FOR UPDATE
    `;
    const existing = current[0];
    // set_at answers "since when has this mint been <status>": keep it when
    // only reason/url change, reset it when the status changes.
    const setAt = existing && existing.status === args.status ? Number(existing.set_at) : args.nowMs;

    await tx`
        INSERT INTO asset_variant_advisories (mint, status, reason, url, set_by, set_by_email, set_at, updated_at)
        VALUES (
            ${args.mint}, ${args.status}, ${args.reason}, ${args.url},
            ${args.actor.clerkUserId}, ${args.actor.email}, ${setAt}, ${args.nowMs}
        )
        ON CONFLICT (mint) DO UPDATE SET
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            url = EXCLUDED.url,
            set_by = EXCLUDED.set_by,
            set_by_email = EXCLUDED.set_by_email,
            set_at = EXCLUDED.set_at,
            updated_at = EXCLUDED.updated_at
    `;

    let reactivated = false;
    if (args.activateVariant && !variant.is_active) {
        await tx`
            UPDATE asset_variants
            SET is_active = true, updated_at = ${new Date(args.nowMs)}
            WHERE id = ${variant.id}
        `;
        reactivated = true;
    }

    await tx`
        INSERT INTO asset_variant_advisory_events (
            id, mint, action, status, reason, url, reactivated_variant,
            actor_clerk_user_id, actor_email, created_at
        )
        VALUES (
            ${randomId('ave')}, ${args.mint}, 'set', ${args.status}, ${args.reason}, ${args.url}, ${reactivated},
            ${args.actor.clerkUserId}, ${args.actor.email}, ${args.nowMs}
        )
    `;

    return { outcome: 'set', reactivated };
}

export interface ClearAdvisoryTxArgs {
    mint: string;
    actor: AdvisoryActor;
    nowMs: number;
}

/** Exported for tests (recording fake `tx`). */
export async function clearAdvisoryInTx(tx: Tx, args: ClearAdvisoryTxArgs): Promise<'cleared' | 'not_found'> {
    const deleted = await tx<Array<{ mint: string }>>`
        DELETE FROM asset_variant_advisories
        WHERE mint = ${args.mint}
        RETURNING mint
    `;
    if (deleted.length === 0) return 'not_found';

    await tx`
        INSERT INTO asset_variant_advisory_events (
            id, mint, action, status, reason, url, reactivated_variant,
            actor_clerk_user_id, actor_email, created_at
        )
        VALUES (
            ${randomId('ave')}, ${args.mint}, 'clear', NULL, NULL, NULL, false,
            ${args.actor.clerkUserId}, ${args.actor.email}, ${args.nowMs}
        )
    `;
    return 'cleared';
}

export function makePostgresVariantAdvisoriesRepo(sql: Sql): VariantAdvisoriesRepo {
    return {
        async set(args) {
            return await sql.begin(tx => setAdvisoryInTx(tx, args));
        },

        async clear(args) {
            return await sql.begin(tx => clearAdvisoryInTx(tx, args));
        },

        async listActive() {
            const rows = await sql<PgAdvisoryRow[]>`
                SELECT mint, status, reason, url, set_by, set_by_email, set_at, updated_at
                FROM asset_variant_advisories
                ORDER BY updated_at DESC, mint ASC
            `;
            return rows.map(mapAdvisoryRow).filter((row): row is VariantAdvisoryRow => row !== null);
        },

        async listEventsByMint(mint, limit) {
            const rows = await sql<PgAdvisoryEventRow[]>`
                SELECT id, mint, action, status, reason, url, reactivated_variant,
                       actor_clerk_user_id, actor_email, created_at
                FROM asset_variant_advisory_events
                WHERE mint = ${mint}
                ORDER BY created_at DESC, id DESC
                LIMIT ${limit}
            `;
            return rows.map(mapEventRow);
        },
    };
}
