/**
 * Postgres implementation of `DepegRepo` (handlers/crons.depeg.ts): the
 * Webacy depeg / structural-health caches from migration 0019 and the
 * system-owned advisory write.
 *
 * The advisory transaction bodies are exported so tests can drive them with a
 * recording fake `tx` (same style as cloudrun-admin's variantAdvisories.test).
 * The system write is deliberately narrower than the admin one: it only ever
 * writes `caution`, never re-activates a variant, and never touches a row a
 * human owns (`managed_by_system = false`).
 */

import type { Sql, TransactionSql } from 'postgres';

import {
    SYSTEM_ACTOR_BY_SOURCE,
    isAdvisorySource,
    isAdvisoryStatus,
    isPegTier,
    isStructuralGrade,
    type PegTier,
    type SystemAdvisorySource,
} from '@tokens/asset-registry';

import { randomId } from '../db';
import type {
    ClearSystemAdvisoryOutcome,
    DepegLatestRow,
    DepegRepo,
    DepegTrigger,
    SetSystemAdvisoryOutcome,
    StructuralHealthLatestRow,
} from '../handlers/crons.depeg';
import type { ReconcilerAdvisory } from '../handlers/depegReconciler';

type Tx = TransactionSql;

function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'bigint' ? Number(value) : Number(value);
    return Number.isFinite(n) ? n : null;
}

function toTier(value: unknown): PegTier | null {
    return isPegTier(value) ? value : null;
}

function toTrigger(value: unknown): DepegTrigger | null {
    return value === 'webhook' || value === 'sweep' || value === 'manual' ? value : null;
}

function toStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out = value.filter((v): v is string => typeof v === 'string');
    return out.length > 0 ? out : null;
}

function parseJsonb(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

interface PgDepegLatestRow {
    chain: string;
    address: string;
    ok: boolean;
    status: number;
    symbol: string | null;
    tier: string | null;
    overall_risk: number | string | null;
    deviation_pct: number | string | null;
    price_usd: number | string | null;
    peg_usd: number | string | null;
    tags: unknown;
    prev_tier: string | null;
    tier_since_at: number | string | bigint | null;
    bad_since_at: number | string | bigint | null;
    observations: number | string;
    in_registry: boolean;
    last_seen_in_list_at: number | string | bigint | null;
    last_source: string | null;
    payload_json: string | null;
    error_message: string | null;
    last_fetched_at: number | string | bigint;
    last_ok_at: number | string | bigint | null;
}

function mapDepegLatest(row: PgDepegLatestRow): DepegLatestRow {
    return {
        chain: row.chain,
        address: row.address,
        ok: row.ok,
        status: Number(row.status),
        symbol: row.symbol,
        tier: toTier(row.tier),
        overallRisk: toNumberOrNull(row.overall_risk),
        deviationPct: toNumberOrNull(row.deviation_pct),
        priceUsd: toNumberOrNull(row.price_usd),
        pegUsd: toNumberOrNull(row.peg_usd),
        tags: toStringArray(parseJsonb(row.tags)),
        prevTier: toTier(row.prev_tier),
        tierSinceAt: toNumberOrNull(row.tier_since_at),
        badSinceAt: toNumberOrNull(row.bad_since_at),
        observations: toNumberOrNull(row.observations) ?? 0,
        inRegistry: row.in_registry === true,
        lastSeenInListAt: toNumberOrNull(row.last_seen_in_list_at),
        lastSource: toTrigger(row.last_source),
        payloadJson: row.payload_json,
        errorMessage: row.error_message,
        lastFetchedAt: toNumberOrNull(row.last_fetched_at) ?? 0,
        lastOkAt: toNumberOrNull(row.last_ok_at),
    };
}

interface PgStructuralLatestRow {
    chain: string;
    address: string;
    ok: boolean;
    status: number;
    composite_grade: string | null;
    composite_score: number | string | null;
    category_scores: unknown;
    criteria_fail_count: number | string | null;
    criteria_warn_count: number | string | null;
    payload_json: string | null;
    error_message: string | null;
    last_fetched_at: number | string | bigint;
    last_ok_at: number | string | bigint | null;
}

function mapStructuralLatest(row: PgStructuralLatestRow): StructuralHealthLatestRow {
    const categories = parseJsonb(row.category_scores);
    return {
        chain: row.chain,
        address: row.address,
        ok: row.ok,
        status: Number(row.status),
        compositeGrade: isStructuralGrade(row.composite_grade) ? row.composite_grade : null,
        compositeScore: toNumberOrNull(row.composite_score),
        categoryScores:
            categories && typeof categories === 'object' && !Array.isArray(categories)
                ? (categories as StructuralHealthLatestRow['categoryScores'])
                : null,
        criteriaFailCount: toNumberOrNull(row.criteria_fail_count),
        criteriaWarnCount: toNumberOrNull(row.criteria_warn_count),
        payloadJson: row.payload_json,
        errorMessage: row.error_message,
        lastFetchedAt: toNumberOrNull(row.last_fetched_at) ?? 0,
        lastOkAt: toNumberOrNull(row.last_ok_at),
    };
}

export interface SetSystemAdvisoryTxArgs {
    mint: string;
    reason: string;
    nowMs: number;
    /** Which automated observer is writing; gates the ON CONFLICT so observers never overwrite each other. */
    source: SystemAdvisorySource;
}

/** Exported for tests (recording fake `tx`). */
export async function setSystemAdvisoryInTx(tx: Tx, args: SetSystemAdvisoryTxArgs): Promise<SetSystemAdvisoryOutcome> {
    // Only active variants get an automated caution; lock the canonical row so
    // a concurrent admin deactivate cannot interleave (mint is not unique).
    const variants = await tx<Array<{ id: string }>>`
        SELECT id
        FROM asset_variants
        WHERE mint = ${args.mint} AND is_active = true
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
    `;
    if (!variants[0]) return 'variant_not_found';

    const current = await tx<
        Array<{
            status: string;
            reason: string;
            source: string | null;
            managed_by_system: boolean | null;
            set_at: string | number;
        }>
    >`
        SELECT status, reason, source, managed_by_system, set_at
        FROM asset_variant_advisories
        WHERE mint = ${args.mint}
        FOR UPDATE
    `;
    const existing = current[0];
    // Hands-off rule: a human-authored (or human-edited) row is never touched.
    if (existing && existing.managed_by_system !== true) return 'skipped_human_owned';
    // Each observer owns only the rows it set.
    if (existing && existing.source !== args.source) return 'skipped_other_system_owner';
    if (existing && existing.reason === args.reason) return 'unchanged';

    const actor = SYSTEM_ACTOR_BY_SOURCE[args.source];
    const setAt = existing ? Number(existing.set_at) : args.nowMs;
    await tx`
        INSERT INTO asset_variant_advisories (
            mint, status, reason, url, set_by, set_by_email, set_at, updated_at, source, managed_by_system
        )
        VALUES (
            ${args.mint}, 'caution', ${args.reason}, NULL, ${actor}, NULL,
            ${setAt}, ${args.nowMs}, ${args.source}, true
        )
        ON CONFLICT (mint) DO UPDATE SET
            reason = EXCLUDED.reason,
            url = EXCLUDED.url,
            updated_at = EXCLUDED.updated_at,
            set_by = EXCLUDED.set_by,
            set_by_email = NULL,
            source = EXCLUDED.source,
            managed_by_system = true
        WHERE asset_variant_advisories.managed_by_system = true
          AND asset_variant_advisories.source = ${args.source}
    `;

    await tx`
        INSERT INTO asset_variant_advisory_events (
            id, mint, action, status, reason, url, reactivated_variant,
            actor_clerk_user_id, actor_email, created_at, source
        )
        VALUES (
            ${randomId('ave')}, ${args.mint}, 'set', 'caution', ${args.reason}, NULL, false,
            ${actor}, NULL, ${args.nowMs}, ${args.source}
        )
    `;
    return existing ? 'updated' : 'set';
}

export interface ClearSystemAdvisoryTxArgs {
    mint: string;
    /** Why the automation cleared (e.g. "Webacy tier ok for 6h"); stored as the event reason. */
    note: string;
    nowMs: number;
    source: SystemAdvisorySource;
}

/** Exported for tests (recording fake `tx`). */
export async function clearSystemAdvisoryInTx(
    tx: Tx,
    args: ClearSystemAdvisoryTxArgs,
): Promise<ClearSystemAdvisoryOutcome> {
    const deleted = await tx<Array<{ mint: string }>>`
        DELETE FROM asset_variant_advisories
        WHERE mint = ${args.mint} AND managed_by_system = true AND source = ${args.source}
        RETURNING mint
    `;
    if (deleted.length === 0) {
        const exists = await tx<Array<{ mint: string; managed_by_system: boolean | null; source: string | null }>>`
            SELECT mint, managed_by_system, source FROM asset_variant_advisories WHERE mint = ${args.mint}
        `;
        const row = exists[0];
        if (!row) return 'not_found';
        return row.managed_by_system === true ? 'skipped_other_system_owner' : 'skipped_not_system';
    }
    await tx`
        INSERT INTO asset_variant_advisory_events (
            id, mint, action, status, reason, url, reactivated_variant,
            actor_clerk_user_id, actor_email, created_at, source
        )
        VALUES (
            ${randomId('ave')}, ${args.mint}, 'clear', NULL, ${args.note}, NULL, false,
            ${SYSTEM_ACTOR_BY_SOURCE[args.source]}, NULL, ${args.nowMs}, ${args.source}
        )
    `;
    return 'cleared';
}

export function makePostgresDepegRepo(sql: Sql): DepegRepo {
    return {
        async listDepegLatest(chain) {
            const rows = await sql<PgDepegLatestRow[]>`
                SELECT chain, address, ok, status, symbol, tier, overall_risk, deviation_pct, price_usd, peg_usd,
                       tags, prev_tier, tier_since_at, bad_since_at, observations, in_registry,
                       last_seen_in_list_at, last_source, payload_json, error_message, last_fetched_at, last_ok_at
                FROM webacy_depeg_latest
                WHERE chain = ${chain}
            `;
            return rows.map(mapDepegLatest);
        },

        async upsertDepegLatest(rows) {
            for (const row of rows) {
                await sql`
                    INSERT INTO webacy_depeg_latest (
                        id, chain, address, ok, status, symbol, tier, overall_risk, deviation_pct, price_usd, peg_usd,
                        tags, prev_tier, tier_since_at, bad_since_at, observations, in_registry,
                        last_seen_in_list_at, last_source, payload_json, error_message, last_fetched_at, last_ok_at
                    )
                    VALUES (
                        ${randomId('wdl')}, ${row.chain}, ${row.address}, ${row.ok}, ${row.status}, ${row.symbol},
                        ${row.tier}, ${row.overallRisk}, ${row.deviationPct}, ${row.priceUsd}, ${row.pegUsd},
                        ${row.tags ? sql.json(row.tags) : null}, ${row.prevTier}, ${row.tierSinceAt}, ${row.badSinceAt},
                        ${row.observations}, ${row.inRegistry}, ${row.lastSeenInListAt}, ${row.lastSource},
                        ${row.payloadJson}, ${row.errorMessage}, ${row.lastFetchedAt}, ${row.lastOkAt}
                    )
                    ON CONFLICT (chain, address) DO UPDATE SET
                        ok = EXCLUDED.ok,
                        status = EXCLUDED.status,
                        symbol = EXCLUDED.symbol,
                        tier = EXCLUDED.tier,
                        overall_risk = EXCLUDED.overall_risk,
                        deviation_pct = EXCLUDED.deviation_pct,
                        price_usd = EXCLUDED.price_usd,
                        peg_usd = EXCLUDED.peg_usd,
                        tags = EXCLUDED.tags,
                        prev_tier = EXCLUDED.prev_tier,
                        tier_since_at = EXCLUDED.tier_since_at,
                        bad_since_at = EXCLUDED.bad_since_at,
                        observations = EXCLUDED.observations,
                        in_registry = EXCLUDED.in_registry,
                        last_seen_in_list_at = EXCLUDED.last_seen_in_list_at,
                        last_source = EXCLUDED.last_source,
                        payload_json = EXCLUDED.payload_json,
                        error_message = EXCLUDED.error_message,
                        last_fetched_at = EXCLUDED.last_fetched_at,
                        -- A failed fetch (NULL last_ok_at) must not erase the last success.
                        last_ok_at = COALESCE(EXCLUDED.last_ok_at, webacy_depeg_latest.last_ok_at)
                `;
            }
        },

        async insertDepegTierEvents(rows) {
            for (const row of rows) {
                await sql`
                    INSERT INTO webacy_depeg_tier_events (
                        id, chain, address, old_tier, new_tier, overall_risk, deviation_pct, price_usd, peg_usd,
                        source, webhook_event_id, observed_at
                    )
                    VALUES (
                        ${randomId('wdte')}, ${row.chain}, ${row.address}, ${row.oldTier}, ${row.newTier},
                        ${row.overallRisk}, ${row.deviationPct}, ${row.priceUsd}, ${row.pegUsd},
                        ${row.source}, ${row.webhookEventId}, ${row.observedAt}
                    )
                `;
            }
        },

        async listActiveSolanaVariantMints(mints) {
            const out = new Map<string, { assetId: string; symbol: string | null }>();
            if (mints.length === 0) return out;
            // Lowest variant id is the canonical row for a mint (matches the admin
            // advisory path); the symbol comes from the parent asset.
            const rows = await sql<Array<{ mint: string; asset_id: string; symbol: string | null }>>`
                SELECT DISTINCT ON (v.mint) v.mint, v.asset_id, a.symbol
                FROM asset_variants v
                LEFT JOIN assets a ON a.asset_id = v.asset_id
                WHERE v.chain = 'solana'
                  AND v.is_active = true
                  AND v.mint = ANY(${sql.array([...mints])}::text[])
                ORDER BY v.mint, v.id ASC
            `;
            for (const row of rows) out.set(row.mint, { assetId: row.asset_id, symbol: row.symbol });
            return out;
        },

        async listAdvisoriesForReconcile(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<
                Array<{
                    mint: string;
                    status: string;
                    reason: string;
                    source: string | null;
                    managed_by_system: boolean | null;
                    set_at: string | number;
                    updated_at: string | number;
                }>
            >`
                SELECT mint, status, reason, source, managed_by_system, set_at, updated_at
                FROM asset_variant_advisories
                WHERE mint = ANY(${sql.array([...mints])}::text[])
            `;
            const out: ReconcilerAdvisory[] = [];
            for (const row of rows) {
                if (!isAdvisoryStatus(row.status)) continue;
                out.push({
                    mint: row.mint,
                    status: row.status,
                    reason: row.reason,
                    source: isAdvisorySource(row.source) ? row.source : 'admin',
                    managedBySystem: row.managed_by_system === true,
                    setAt: Number(row.set_at),
                    updatedAt: Number(row.updated_at),
                });
            }
            return out;
        },

        async listLastAdminClearAtByMints(mints) {
            const out = new Map<string, number>();
            if (mints.length === 0) return out;
            const rows = await sql<Array<{ mint: string; last_clear_at: string | number | bigint }>>`
                SELECT mint, MAX(created_at) AS last_clear_at
                FROM asset_variant_advisory_events
                WHERE action = 'clear' AND source = 'admin'
                  AND mint = ANY(${sql.array([...mints])}::text[])
                GROUP BY mint
            `;
            for (const row of rows) {
                const at = toNumberOrNull(row.last_clear_at);
                if (at !== null) out.set(row.mint, at);
            }
            return out;
        },

        async setSystemAdvisory(args) {
            return await sql.begin(tx => setSystemAdvisoryInTx(tx, args));
        },

        async clearSystemAdvisory(args) {
            return await sql.begin(tx => clearSystemAdvisoryInTx(tx, args));
        },

        async upsertStructuralHealthLatest(rows) {
            for (const row of rows) {
                await sql`
                    INSERT INTO webacy_structural_health_latest (
                        id, chain, address, ok, status, composite_grade, composite_score, category_scores,
                        criteria_fail_count, criteria_warn_count, payload_json, error_message, last_fetched_at, last_ok_at
                    )
                    VALUES (
                        ${randomId('wsh')}, ${row.chain}, ${row.address}, ${row.ok}, ${row.status},
                        ${row.compositeGrade}, ${row.compositeScore},
                        ${row.categoryScores ? sql.json(row.categoryScores) : null},
                        ${row.criteriaFailCount}, ${row.criteriaWarnCount}, ${row.payloadJson}, ${row.errorMessage},
                        ${row.lastFetchedAt}, ${row.lastOkAt}
                    )
                    ON CONFLICT (chain, address) DO UPDATE SET
                        ok = EXCLUDED.ok,
                        status = EXCLUDED.status,
                        composite_grade = EXCLUDED.composite_grade,
                        composite_score = EXCLUDED.composite_score,
                        category_scores = EXCLUDED.category_scores,
                        criteria_fail_count = EXCLUDED.criteria_fail_count,
                        criteria_warn_count = EXCLUDED.criteria_warn_count,
                        payload_json = EXCLUDED.payload_json,
                        error_message = EXCLUDED.error_message,
                        last_fetched_at = EXCLUDED.last_fetched_at,
                        last_ok_at = COALESCE(EXCLUDED.last_ok_at, webacy_structural_health_latest.last_ok_at)
                `;
            }
        },

        async upsertStructuralHealthDaily(rows) {
            for (const row of rows) {
                await sql`
                    INSERT INTO webacy_structural_health_daily (
                        chain, address, day, composite_grade, composite_score, category_scores, recorded_at
                    )
                    VALUES (
                        ${row.chain}, ${row.address}, ${row.day}::date, ${row.compositeGrade}, ${row.compositeScore},
                        ${row.categoryScores ? sql.json(row.categoryScores) : null}, ${row.recordedAt}
                    )
                    ON CONFLICT (chain, address, day) DO UPDATE SET
                        composite_grade = EXCLUDED.composite_grade,
                        composite_score = EXCLUDED.composite_score,
                        category_scores = EXCLUDED.category_scores,
                        recorded_at = EXCLUDED.recorded_at
                `;
            }
        },

        async listStructuralHealthLatest(chain) {
            const rows = await sql<PgStructuralLatestRow[]>`
                SELECT chain, address, ok, status, composite_grade, composite_score, category_scores,
                       criteria_fail_count, criteria_warn_count, payload_json, error_message, last_fetched_at, last_ok_at
                FROM webacy_structural_health_latest
                WHERE chain = ${chain}
            `;
            return rows.map(mapStructuralLatest);
        },

        async listStructuralTargets() {
            const rows = await sql<Array<{ address: string }>>`
                SELECT address
                FROM webacy_depeg_latest
                WHERE chain = 'solana' AND in_registry = true
                ORDER BY address ASC
            `;
            return rows.map(r => r.address);
        },
    };
}
