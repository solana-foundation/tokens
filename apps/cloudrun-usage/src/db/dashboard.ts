import type { Sql } from 'postgres';

import type { IdentityRepo } from '../handlers/clerkIdentity';
import type {
    ApiKeyFullRow,
    DashboardRepo,
    ProjectDoc,
    ProjectRole,
    ProjectTier,
    UserDoc,
} from '../handlers/dashboard';
import { randomId } from '../db';

function toEpochMs(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function toNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

interface ProjectSqlRow {
    id: string;
    name: string;
    description: string | null;
    tier: string | null;
    created_by_clerk_user_id: string;
    personal_clerk_user_id: string | null;
    limits: unknown;
    created_at: Date;
    updated_at: Date;
}

const PROJECT_COLUMNS = [
    'id',
    'name',
    'description',
    'tier',
    'created_by_clerk_user_id',
    'personal_clerk_user_id',
    'limits',
    'created_at',
    'updated_at',
] as const;

function toProjectDoc(row: ProjectSqlRow): ProjectDoc {
    const createdAt = toEpochMs(row.created_at);
    return {
        _id: row.id,
        _creationTime: createdAt,
        name: row.name,
        ...(row.description !== null ? { description: row.description } : {}),
        ...(row.tier !== null ? { tier: row.tier as ProjectTier } : {}),
        createdByClerkUserId: row.created_by_clerk_user_id,
        ...(row.personal_clerk_user_id !== null ? { personalClerkUserId: row.personal_clerk_user_id } : {}),
        ...(row.limits !== null && row.limits !== undefined ? { limits: row.limits } : {}),
        createdAt,
        updatedAt: toEpochMs(row.updated_at),
    };
}

export function makePostgresIdentityRepo(sql: Sql): IdentityRepo {
    return {
        async getUserPrimaryEmail(clerkUserId) {
            const rows = await sql<{ primary_email: string | null }[]>`
                SELECT primary_email FROM users WHERE clerk_user_id = ${clerkUserId} LIMIT 1
            `;
            return rows[0]?.primary_email ?? null;
        },

        async listClerkUserIdsByEmail(email) {
            const rows = await sql<{ clerk_user_id: string }[]>`
                SELECT DISTINCT clerk_user_id FROM users WHERE lower(primary_email) = ${email}
            `;
            return rows.map(r => r.clerk_user_id);
        },

        async getIdentityScoreInputs(clerkUserId) {
            const rows = await sql<{ memberships: string; keys: string; active_keys: string }[]>`
                SELECT
                    (SELECT count(*) FROM project_members WHERE clerk_user_id = ${clerkUserId}) AS memberships,
                    (SELECT count(*) FROM api_keys WHERE owner_clerk_user_id = ${clerkUserId}) AS keys,
                    (SELECT count(*) FROM api_keys WHERE owner_clerk_user_id = ${clerkUserId} AND revoked_at IS NULL) AS active_keys
            `;
            const row = rows[0];
            return {
                memberships: Number(row?.memberships ?? 0),
                keys: Number(row?.keys ?? 0),
                activeKeys: Number(row?.active_keys ?? 0),
            };
        },
    };
}

export function makePostgresDashboardRepo(sql: Sql): DashboardRepo {
    async function getProjectDoc(projectId: string): Promise<ProjectDoc | null> {
        const rows = await sql<ProjectSqlRow[]>`
            SELECT ${sql(PROJECT_COLUMNS as unknown as string[])} FROM projects WHERE id = ${projectId} LIMIT 1
        `;
        const row = rows[0];
        return row ? toProjectDoc(row) : null;
    }

    return {
        async getUserByClerkId(clerkUserId): Promise<UserDoc | null> {
            const rows = await sql<
                {
                    id: string;
                    clerk_user_id: string;
                    primary_email: string | null;
                    full_name: string | null;
                    created_at: Date;
                    updated_at: Date;
                }[]
            >`
                SELECT id, clerk_user_id, primary_email, full_name, created_at, updated_at
                FROM users
                WHERE clerk_user_id = ${clerkUserId}
                LIMIT 1
            `;
            const row = rows[0];
            if (!row) return null;
            const createdAt = toEpochMs(row.created_at);
            return {
                _id: row.id,
                _creationTime: createdAt,
                clerkUserId: row.clerk_user_id,
                ...(row.primary_email !== null ? { primaryEmail: row.primary_email } : {}),
                ...(row.full_name !== null ? { fullName: row.full_name } : {}),
                createdAt,
                updatedAt: toEpochMs(row.updated_at),
            };
        },

        async upsertUser({ clerkUserId, primaryEmail, fullName, nowMs }) {
            return sql.begin(async tx => {
                const existing = await tx<{ id: string; primary_email: string | null; full_name: string | null }[]>`
                    SELECT id, primary_email, full_name FROM users WHERE clerk_user_id = ${clerkUserId} LIMIT 1
                `;
                const row = existing[0];
                if (!row) {
                    const id = randomId('usr');
                    await tx`
                        INSERT INTO users (id, clerk_user_id, primary_email, full_name, created_at, updated_at)
                        VALUES (
                            ${id}, ${clerkUserId}, ${primaryEmail ?? null}, ${fullName ?? null},
                            to_timestamp(${nowMs} / 1000.0), to_timestamp(${nowMs} / 1000.0)
                        )
                    `;
                    return id;
                }

                await tx`
                    UPDATE users
                    SET primary_email = COALESCE(${primaryEmail ?? null}, primary_email),
                        full_name = COALESCE(${fullName ?? null}, full_name),
                        updated_at = to_timestamp(${nowMs} / 1000.0)
                    WHERE id = ${row.id}
                `;
                return row.id;
            });
        },

        async getMembership(projectId, clerkUserId) {
            const rows = await sql<{ role: string }[]>`
                SELECT role FROM project_members
                WHERE project_id = ${projectId} AND clerk_user_id = ${clerkUserId}
                LIMIT 1
            `;
            const row = rows[0];
            return row ? { role: row.role as ProjectRole } : null;
        },

        async countMemberships(clerkUserId) {
            const rows = await sql<{ count: string }[]>`
                SELECT count(*) AS count FROM project_members WHERE clerk_user_id = ${clerkUserId}
            `;
            return Number(rows[0]?.count ?? 0);
        },

        async listProjectsForMember(clerkUserId) {
            const rows = await sql<Array<ProjectSqlRow & { role: string }>>`
                SELECT p.id, p.name, p.description, p.tier, p.created_by_clerk_user_id,
                       p.personal_clerk_user_id, p.limits, p.created_at, p.updated_at,
                       m.role
                FROM project_members m
                JOIN projects p ON p.id = m.project_id
                WHERE m.clerk_user_id = ${clerkUserId}
                ORDER BY p.created_at ASC
            `;
            return rows.map(row => ({ project: toProjectDoc(row), role: row.role as ProjectRole }));
        },

        getProjectDoc,

        async findProjectIdByCreatorAndName(clerkUserId, name) {
            const rows = await sql<{ id: string }[]>`
                SELECT id FROM projects
                WHERE created_by_clerk_user_id = ${clerkUserId} AND name = ${name}
                LIMIT 1
            `;
            return rows[0]?.id ?? null;
        },

        async findPersonalProjectId(clerkUserId) {
            const rows = await sql<{ id: string }[]>`
                SELECT id FROM projects WHERE personal_clerk_user_id = ${clerkUserId} LIMIT 1
            `;
            return rows[0]?.id ?? null;
        },

        async createProjectWithOwner({ name, description, tier, personal, clerkUserId, nowMs }) {
            return sql.begin(async tx => {
                const projectId = randomId('prj');
                await tx`
                    INSERT INTO projects (
                        id, name, description, tier, created_by_clerk_user_id, personal_clerk_user_id,
                        created_at, updated_at
                    )
                    VALUES (
                        ${projectId}, ${name}, ${description ?? null}, ${tier ?? null}, ${clerkUserId},
                        ${personal ? clerkUserId : null},
                        to_timestamp(${nowMs} / 1000.0), to_timestamp(${nowMs} / 1000.0)
                    )
                `;
                await tx`
                    INSERT INTO project_members (id, project_id, clerk_user_id, role, created_at, updated_at)
                    VALUES (
                        ${randomId('pmb')}, ${projectId}, ${clerkUserId}, 'owner',
                        to_timestamp(${nowMs} / 1000.0), to_timestamp(${nowMs} / 1000.0)
                    )
                `;
                return projectId;
            });
        },

        async ensureMembership(projectId, clerkUserId, role, nowMs) {
            await sql`
                INSERT INTO project_members (id, project_id, clerk_user_id, role, created_at, updated_at)
                VALUES (
                    ${randomId('pmb')}, ${projectId}, ${clerkUserId}, ${role},
                    to_timestamp(${nowMs} / 1000.0), to_timestamp(${nowMs} / 1000.0)
                )
                ON CONFLICT (project_id, clerk_user_id) DO NOTHING
            `;
        },

        async updateProject(projectId, name, description, nowMs) {
            await sql`
                UPDATE projects
                SET name = ${name}, description = ${description}, updated_at = to_timestamp(${nowMs} / 1000.0)
                WHERE id = ${projectId}
            `;
        },

        async setProjectRateLimit(projectId, rateLimit, nowMs) {
            const rows = await sql<{ id: string; name: string; limits: unknown }[]>`
                UPDATE projects
                SET limits = ${
                    rateLimit === null
                        ? sql`NULLIF(COALESCE(limits, '{}'::jsonb) - 'rateLimit', '{}'::jsonb)`
                        : sql`COALESCE(limits, '{}'::jsonb) || jsonb_build_object(
                              'rateLimit', jsonb_build_object(
                                  'requests', ${rateLimit.requests}::int,
                                  'windowSeconds', ${rateLimit.windowSeconds}::int
                              )
                          )`
                },
                    updated_at = to_timestamp(${nowMs} / 1000.0)
                WHERE id = ${projectId}
                RETURNING id, name, limits
            `;
            const row = rows[0];
            return row ? { id: row.id, name: row.name, limits: row.limits } : null;
        },

        async deleteProjectCascade(projectId) {
            await sql.begin(async tx => {
                await tx`DELETE FROM api_keys WHERE project_id = ${projectId}`;
                // project_members cascade via FK ON DELETE CASCADE.
                await tx`DELETE FROM projects WHERE id = ${projectId}`;
            });
        },

        async listProjectsDigest() {
            const rows = await sql<{ id: string; name: string; is_personal: boolean }[]>`
                SELECT id, name,
                       (personal_clerk_user_id IS NOT NULL
                        AND personal_clerk_user_id = created_by_clerk_user_id) AS is_personal
                FROM projects
            `;
            return rows.map(row => ({ id: row.id, name: row.name, isPersonal: row.is_personal }));
        },

        async listProjectApiKeys(projectId, limit) {
            const rows = await sql<
                {
                    id: string;
                    key_prefix: string;
                    created_at: Date;
                    revoked_at: string | number | null;
                    has_encrypted: boolean;
                }[]
            >`
                SELECT id, key_prefix, created_at, revoked_at,
                       (encrypted_raw_key_ciphertext IS NOT NULL
                        AND encrypted_raw_key_iv IS NOT NULL
                        AND encrypted_raw_key_version IS NOT NULL) AS has_encrypted
                FROM api_keys
                WHERE project_id = ${projectId}
                ORDER BY created_at DESC
                LIMIT ${limit}
            `;
            return rows.map(row => ({
                id: row.id,
                keyPrefix: row.key_prefix,
                createdAt: toEpochMs(row.created_at),
                revokedAt: toNullableNumber(row.revoked_at),
                hasEncrypted: row.has_encrypted,
            }));
        },

        async getApiKeyById(apiKeyId) {
            const rows = await sql<
                {
                    id: string;
                    project_id: string | null;
                    owner_clerk_user_id: string;
                    key_prefix: string;
                    revoked_at: string | number | null;
                    scopes: unknown;
                    encrypted_raw_key_ciphertext: string | null;
                    encrypted_raw_key_iv: string | null;
                    encrypted_raw_key_version: number | null;
                }[]
            >`
                SELECT id, project_id, owner_clerk_user_id, key_prefix, revoked_at, scopes,
                       encrypted_raw_key_ciphertext, encrypted_raw_key_iv, encrypted_raw_key_version
                FROM api_keys
                WHERE id = ${apiKeyId}
                LIMIT 1
            `;
            return rows[0] ? toApiKeyFullRow(rows[0]) : null;
        },

        async getApiKeyByHash(keyHash) {
            const rows = await sql<
                {
                    id: string;
                    project_id: string | null;
                    owner_clerk_user_id: string;
                    key_prefix: string;
                    revoked_at: string | number | null;
                    scopes: unknown;
                    encrypted_raw_key_ciphertext: string | null;
                    encrypted_raw_key_iv: string | null;
                    encrypted_raw_key_version: number | null;
                }[]
            >`
                SELECT id, project_id, owner_clerk_user_id, key_prefix, revoked_at, scopes,
                       encrypted_raw_key_ciphertext, encrypted_raw_key_iv, encrypted_raw_key_version
                FROM api_keys
                WHERE key_hash = ${keyHash}
                LIMIT 1
            `;
            return rows[0] ? toApiKeyFullRow(rows[0]) : null;
        },

        async revokeApiKey(apiKeyId, nowMs) {
            await sql`
                UPDATE api_keys SET revoked_at = ${nowMs} WHERE id = ${apiKeyId}
            `;
        },

        async insertApiKeyRevokingActive({
            projectId,
            isPersonalProject,
            ownerClerkUserId,
            name,
            keyPrefix,
            keyHash,
            encrypted,
            scopes,
            nowMs,
        }) {
            return sql.begin(async tx => {
                await tx`
                    UPDATE api_keys SET revoked_at = ${nowMs}
                    WHERE project_id = ${projectId} AND revoked_at IS NULL
                `;
                if (isPersonalProject) {
                    // Legacy support: older "personal" keys may not have project_id set.
                    await tx`
                        UPDATE api_keys SET revoked_at = ${nowMs}
                        WHERE owner_clerk_user_id = ${ownerClerkUserId}
                          AND project_id IS NULL
                          AND revoked_at IS NULL
                    `;
                }
                const id = randomId('key');
                await tx`
                    INSERT INTO api_keys (
                        id, owner_clerk_user_id, project_id, name, key_prefix, key_hash,
                        encrypted_raw_key_ciphertext, encrypted_raw_key_iv,
                        encrypted_raw_key_version, encrypted_raw_key_created_at,
                        scopes, created_by_clerk_user_id, created_at
                    )
                    VALUES (
                        ${id}, ${ownerClerkUserId}, ${projectId}, ${name}, ${keyPrefix}, ${keyHash},
                        ${encrypted.encryptedRawKeyCiphertext}, ${encrypted.encryptedRawKeyIv},
                        ${encrypted.encryptedRawKeyVersion}, ${encrypted.encryptedRawKeyCreatedAt},
                        ${tx.json(scopes as never)}, ${ownerClerkUserId}, to_timestamp(${nowMs} / 1000.0)
                    )
                `;
                return id;
            });
        },
    };
}

function toApiKeyFullRow(row: {
    id: string;
    project_id: string | null;
    owner_clerk_user_id: string;
    key_prefix: string;
    revoked_at: string | number | null;
    scopes: unknown;
    encrypted_raw_key_ciphertext: string | null;
    encrypted_raw_key_iv: string | null;
    encrypted_raw_key_version: number | null;
}): ApiKeyFullRow {
    return {
        id: row.id,
        projectId: row.project_id,
        ownerClerkUserId: row.owner_clerk_user_id,
        keyPrefix: row.key_prefix,
        revokedAt: toNullableNumber(row.revoked_at),
        scopes: row.scopes,
        encryptedRawKeyCiphertext: row.encrypted_raw_key_ciphertext,
        encryptedRawKeyIv: row.encrypted_raw_key_iv,
        encryptedRawKeyVersion: row.encrypted_raw_key_version !== null ? Number(row.encrypted_raw_key_version) : null,
    };
}
