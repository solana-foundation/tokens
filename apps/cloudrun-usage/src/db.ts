import postgres, { type Sql } from 'postgres';

import type { PlatformAuthRepo } from './handlers/platformAuth';
import type { UsageIngestRepo } from './handlers/usageIngest';

let cached: Sql | null = null;

export function getSql(): Sql {
    if (cached) return cached;
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error('DATABASE_URL must be set');
    cached = postgres(url, {
        max: Number(process.env.PG_POOL_MAX) || 10,
        idle_timeout: Number(process.env.PG_IDLE_TIMEOUT) || 240,
        connect_timeout: Number(process.env.PG_CONNECT_TIMEOUT) || 30,
        connection: { application_name: 'cloudrun-usage' },
    });
    return cached;
}

export function randomId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function toNullableNumber(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function makePostgresUsageIngestRepo(sql: Sql): UsageIngestRepo {
    return {
        async applyIngestBuckets({ daily, endpoint, updatedAtMs }) {
            await sql.begin(async tx => {
                for (const delta of daily) {
                    await tx`
                        INSERT INTO api_request_daily_rollups (
                            id, project_id, day, total_calls, asset_calls, success_calls, sum_latency_ms, updated_at
                        )
                        VALUES (
                            ${randomId('ard')}, ${delta.projectId}, ${delta.day}::date,
                            ${delta.totalCalls}, ${delta.assetCalls}, ${delta.successCalls}, ${delta.sumLatencyMs},
                            to_timestamp(${updatedAtMs} / 1000.0)
                        )
                        ON CONFLICT (project_id, day) DO UPDATE SET
                            total_calls = api_request_daily_rollups.total_calls + EXCLUDED.total_calls,
                            asset_calls = api_request_daily_rollups.asset_calls + EXCLUDED.asset_calls,
                            success_calls = api_request_daily_rollups.success_calls + EXCLUDED.success_calls,
                            sum_latency_ms = api_request_daily_rollups.sum_latency_ms + EXCLUDED.sum_latency_ms,
                            updated_at = EXCLUDED.updated_at
                    `;
                }
                for (const delta of endpoint) {
                    // Histogram merge mirrors cloudrun-assets' applyRollupBatchAtomic:
                    // element-wise bigint addition over the two jsonb arrays.
                    await tx`
                        INSERT INTO api_request_endpoint_daily_rollups (
                            id, project_id, day, endpoint, calls, success_calls, sum_latency_ms, latency_histogram, updated_at
                        )
                        VALUES (
                            ${randomId('are')}, ${delta.projectId}, ${delta.day}::date, ${delta.endpoint},
                            ${delta.calls}, ${delta.successCalls}, ${delta.sumLatencyMs},
                            ${tx.json(delta.latencyHistogram as never)},
                            to_timestamp(${updatedAtMs} / 1000.0)
                        )
                        ON CONFLICT (project_id, day, endpoint) DO UPDATE SET
                            calls = api_request_endpoint_daily_rollups.calls + EXCLUDED.calls,
                            success_calls = api_request_endpoint_daily_rollups.success_calls + EXCLUDED.success_calls,
                            sum_latency_ms = api_request_endpoint_daily_rollups.sum_latency_ms + EXCLUDED.sum_latency_ms,
                            latency_histogram = (
                                SELECT to_jsonb(
                                    array(
                                        SELECT COALESCE((api_request_endpoint_daily_rollups.latency_histogram->>i)::bigint, 0)
                                             + COALESCE((EXCLUDED.latency_histogram->>i)::bigint, 0)
                                        FROM generate_series(
                                            0,
                                            GREATEST(
                                                jsonb_array_length(api_request_endpoint_daily_rollups.latency_histogram),
                                                jsonb_array_length(EXCLUDED.latency_histogram)
                                            ) - 1
                                        ) AS i
                                    )
                                )
                            ),
                            updated_at = EXCLUDED.updated_at
                    `;
                }
            });
        },

        async applySyncBuckets({ daily, endpoint, updatedAtMs }) {
            await sql.begin(async tx => {
                for (const total of daily) {
                    await tx`
                        INSERT INTO api_request_daily_rollups (
                            id, project_id, day, total_calls, asset_calls, success_calls, sum_latency_ms, updated_at
                        )
                        VALUES (
                            ${randomId('ard')}, ${total.projectId}, ${total.day}::date,
                            ${total.totalCalls}, ${total.assetCalls}, ${total.successCalls}, ${total.sumLatencyMs},
                            to_timestamp(${updatedAtMs} / 1000.0)
                        )
                        ON CONFLICT (project_id, day) DO UPDATE SET
                            total_calls = GREATEST(api_request_daily_rollups.total_calls, EXCLUDED.total_calls),
                            asset_calls = GREATEST(api_request_daily_rollups.asset_calls, EXCLUDED.asset_calls),
                            success_calls = GREATEST(api_request_daily_rollups.success_calls, EXCLUDED.success_calls),
                            sum_latency_ms = GREATEST(api_request_daily_rollups.sum_latency_ms, EXCLUDED.sum_latency_ms),
                            updated_at = EXCLUDED.updated_at
                    `;
                }
                for (const total of endpoint) {
                    // Same element-wise walk as the additive merge above, taking
                    // the larger bucket count instead of the sum.
                    await tx`
                        INSERT INTO api_request_endpoint_daily_rollups (
                            id, project_id, day, endpoint, calls, success_calls, sum_latency_ms, latency_histogram, updated_at
                        )
                        VALUES (
                            ${randomId('are')}, ${total.projectId}, ${total.day}::date, ${total.endpoint},
                            ${total.calls}, ${total.successCalls}, ${total.sumLatencyMs},
                            ${tx.json(total.latencyHistogram as never)},
                            to_timestamp(${updatedAtMs} / 1000.0)
                        )
                        ON CONFLICT (project_id, day, endpoint) DO UPDATE SET
                            calls = GREATEST(api_request_endpoint_daily_rollups.calls, EXCLUDED.calls),
                            success_calls = GREATEST(api_request_endpoint_daily_rollups.success_calls, EXCLUDED.success_calls),
                            sum_latency_ms = GREATEST(api_request_endpoint_daily_rollups.sum_latency_ms, EXCLUDED.sum_latency_ms),
                            latency_histogram = (
                                SELECT to_jsonb(
                                    array(
                                        SELECT GREATEST(
                                            COALESCE((api_request_endpoint_daily_rollups.latency_histogram->>i)::bigint, 0),
                                            COALESCE((EXCLUDED.latency_histogram->>i)::bigint, 0)
                                        )
                                        FROM generate_series(
                                            0,
                                            GREATEST(
                                                jsonb_array_length(api_request_endpoint_daily_rollups.latency_histogram),
                                                jsonb_array_length(EXCLUDED.latency_histogram)
                                            ) - 1
                                        ) AS i
                                    )
                                )
                            ),
                            updated_at = EXCLUDED.updated_at
                    `;
                }
            });
        },
    };
}

export function makePostgresPlatformAuthRepo(sql: Sql): PlatformAuthRepo {
    return {
        async findApiKeyByHash(keyHash) {
            const rows = await sql<
                {
                    id: string;
                    key_prefix: string;
                    project_id: string | null;
                    owner_clerk_user_id: string;
                    scopes: unknown;
                    revoked_at: string | number | null;
                }[]
            >`
                SELECT id, key_prefix, project_id, owner_clerk_user_id, scopes, revoked_at
                FROM api_keys
                WHERE key_hash = ${keyHash}
                LIMIT 1
            `;
            const row = rows[0];
            if (!row) return null;
            return {
                id: row.id,
                keyPrefix: row.key_prefix,
                projectId: row.project_id,
                ownerClerkUserId: row.owner_clerk_user_id,
                scopes: row.scopes,
                revokedAt: toNullableNumber(row.revoked_at),
            };
        },

        async findPersonalProjectId(ownerClerkUserId) {
            const rows = await sql<{ id: string }[]>`
                SELECT id
                FROM projects
                WHERE personal_clerk_user_id = ${ownerClerkUserId}
                LIMIT 1
            `;
            return rows[0]?.id ?? null;
        },

        async getProject(projectId) {
            const rows = await sql<{ limits: unknown }[]>`
                SELECT limits
                FROM projects
                WHERE id = ${projectId}
                LIMIT 1
            `;
            const row = rows[0];
            if (!row) return null;
            return { limits: row.limits };
        },

        async getApiKeyById(apiKeyId) {
            const rows = await sql<
                {
                    project_id: string | null;
                    owner_clerk_user_id: string;
                    revoked_at: string | number | null;
                    last_used_at: string | number | null;
                }[]
            >`
                SELECT project_id, owner_clerk_user_id, revoked_at, last_used_at
                FROM api_keys
                WHERE id = ${apiKeyId}
                LIMIT 1
            `;
            const row = rows[0];
            if (!row) return null;
            return {
                projectId: row.project_id,
                ownerClerkUserId: row.owner_clerk_user_id,
                revokedAt: toNullableNumber(row.revoked_at),
                lastUsedAt: toNullableNumber(row.last_used_at),
            };
        },

        async hasProjectMembership(projectId, clerkUserId) {
            const rows = await sql<{ ok: number }[]>`
                SELECT 1 AS ok
                FROM project_members
                WHERE project_id = ${projectId}
                  AND clerk_user_id = ${clerkUserId}
                LIMIT 1
            `;
            return rows.length > 0;
        },

        async insertApiRequestEvent(event) {
            await sql`
                INSERT INTO api_request_events (
                    id, project_id, api_key_id, key_prefix, method, path, endpoint,
                    status, latency_ms, error_tag, ts
                )
                VALUES (
                    ${crypto.randomUUID()},
                    ${event.projectId},
                    ${event.apiKeyId},
                    ${event.keyPrefix},
                    ${event.method},
                    ${event.path},
                    ${event.endpoint},
                    ${event.status},
                    ${event.latencyMs},
                    ${event.errorTag ?? null},
                    ${event.ts}
                )
            `;
        },

        async bumpApiKeyLastUsedAt(apiKeyId, ts) {
            await sql`
                UPDATE api_keys
                SET last_used_at = ${ts}
                WHERE id = ${apiKeyId}
            `;
        },
    };
}
