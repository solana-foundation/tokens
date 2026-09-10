/**
 * Platform API-key auth + request logging.
 *
 * Postgres ports of `convex/apiKeys.ts:authenticate` and
 * `convex/auth.ts:logApiRequest`. Semantics are kept 1:1 with the Convex
 * source-of-truth implementations so `apps/api` can branch between backends
 * without behavioral drift:
 *
 * - `authenticate`: resolve an active key by SHA-256 hash, fall back to the
 *   owner's personal project when the key has no explicit project, and return
 *   the auth context (scopes normalized, legacy keys get default scopes).
 * - `logApiRequest`: best-effort usage event insert with the same ownership
 *   checks, latency clamping, and `last_used_at` dedup window.
 */

import { InvalidArgsError } from './errors';

/** Mirrors `LAST_USED_DEDUP_MS` in convex/auth.ts. */
export const LAST_USED_DEDUP_MS = 10 * 1000;

/**
 * Default scopes for keys with NULL/empty `api_keys.scopes`. Historically
 * mirrored the retired Convex backend; Cloud SQL is now the source of truth.
 * Adding a scope here only affects NULL-scope keys — rows with materialized
 * scope arrays need a backfill migration (see 0014_execution_read_scope.sql).
 */
export const DEFAULT_LEGACY_SCOPES: string[] = [
    'assets:read',
    'assets:profile:read',
    'assets:risk:read',
    'assets:ohlcv:read',
    'assets:markets:read',
    'execution:read',
];

export interface ApiKeyByHashRow {
    id: string;
    keyPrefix: string;
    projectId: string | null;
    ownerClerkUserId: string;
    /** Raw jsonb payload from `api_keys.scopes` (expected: string[] | null). */
    scopes: unknown;
    revokedAt: number | null;
}

export interface ApiKeyByIdRow {
    projectId: string | null;
    ownerClerkUserId: string;
    revokedAt: number | null;
    lastUsedAt: number | null;
}

export interface ProjectRow {
    /** Raw jsonb payload from `projects.limits`. */
    limits: unknown;
}

export interface ApiRequestEventInsert {
    projectId: string;
    apiKeyId: string;
    keyPrefix: string;
    method: string;
    path: string;
    endpoint: string;
    status: number;
    latencyMs: number;
    errorTag?: string;
    ts: number;
}

export interface PlatformAuthRepo {
    findApiKeyByHash(keyHash: string): Promise<ApiKeyByHashRow | null>;
    findPersonalProjectId(ownerClerkUserId: string): Promise<string | null>;
    getProject(projectId: string): Promise<ProjectRow | null>;
    getApiKeyById(apiKeyId: string): Promise<ApiKeyByIdRow | null>;
    hasProjectMembership(projectId: string, clerkUserId: string): Promise<boolean>;
    insertApiRequestEvent(event: ApiRequestEventInsert): Promise<void>;
    bumpApiKeyLastUsedAt(apiKeyId: string, ts: number): Promise<void>;
}

export interface ApiKeyAuthContext {
    apiKeyId: string;
    keyPrefix: string;
    projectId: string;
    ownerClerkUserId: string;
    scopes: string[];
    limits?: unknown;
}

function normalizeKeyHash(value: string): string {
    return value.trim().toLowerCase();
}

function looksLikeSha256Hex(value: string): boolean {
    return /^[a-f0-9]{64}$/.test(value);
}

export function normalizeScopes(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : DEFAULT_LEGACY_SCOPES;
    const unique = new Set<string>();

    for (const scope of raw) {
        if (typeof scope !== 'string') continue;
        const trimmed = scope.trim();
        if (!trimmed) continue;
        unique.add(trimmed);
    }

    const scopes = Array.from(unique);
    return scopes.length > 0 ? scopes : DEFAULT_LEGACY_SCOPES;
}

function requireObject(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    return args as Record<string, unknown>;
}

function requireString(a: Record<string, unknown>, field: string): string {
    const value = a[field];
    if (typeof value !== 'string') throw new InvalidArgsError(`${field} must be a string`);
    return value;
}

function requireFiniteNumber(a: Record<string, unknown>, field: string): number {
    const value = a[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError(`${field} must be a finite number`);
    }
    return value;
}

/** Port of `convex/apiKeys.ts:authenticate`. Returns the auth context or null. */
export async function authenticateApiKey(
    repo: PlatformAuthRepo,
    args: unknown,
): Promise<ApiKeyAuthContext | null> {
    const a = requireObject(args);
    const keyHash = normalizeKeyHash(requireString(a, 'keyHash'));
    if (!looksLikeSha256Hex(keyHash)) return null;

    const key = await repo.findApiKeyByHash(keyHash);
    if (!key) return null;
    if (key.revokedAt !== null) return null;

    const projectId = key.projectId ?? (await repo.findPersonalProjectId(key.ownerClerkUserId));
    if (!projectId) return null;

    const project = await repo.getProject(projectId);
    if (!project) return null;

    return {
        apiKeyId: key.id,
        keyPrefix: key.keyPrefix,
        projectId,
        ownerClerkUserId: key.ownerClerkUserId,
        scopes: normalizeScopes(key.scopes),
        ...(project.limits !== null && project.limits !== undefined ? { limits: project.limits } : {}),
    };
}

/**
 * Port of `convex/auth.ts:logApiRequest`. Inserts a usage event and bumps
 * `api_keys.last_used_at` (deduped to one write per {@link LAST_USED_DEDUP_MS}).
 * Silently no-ops (returns null) when the key/project checks fail — matching
 * Convex, where usage logging is best-effort and never errors the request.
 */
export async function logApiRequest(repo: PlatformAuthRepo, args: unknown): Promise<null> {
    const a = requireObject(args);
    const argProjectId = requireString(a, 'projectId');
    const apiKeyId = requireString(a, 'apiKeyId');
    const keyPrefix = requireString(a, 'keyPrefix');
    const method = requireString(a, 'method');
    const path = requireString(a, 'path');
    const endpoint = requireString(a, 'endpoint');
    const status = requireFiniteNumber(a, 'status');
    const latencyMs = requireFiniteNumber(a, 'latencyMs');
    const ts = requireFiniteNumber(a, 'ts');
    if (a.errorTag !== undefined && typeof a.errorTag !== 'string') {
        throw new InvalidArgsError('errorTag must be a string');
    }
    const errorTag = a.errorTag as string | undefined;

    const key = await repo.getApiKeyById(apiKeyId);
    if (!key) return null;
    if (key.revokedAt !== null) return null;

    if (key.projectId !== null && key.projectId !== argProjectId) {
        return null;
    }

    let projectId = key.projectId ?? argProjectId;
    if (key.projectId === null) {
        const isMember = await repo.hasProjectMembership(argProjectId, key.ownerClerkUserId);
        if (!isMember) return null;
        projectId = argProjectId;
    }

    await repo.insertApiRequestEvent({
        projectId,
        apiKeyId,
        keyPrefix,
        method,
        path,
        endpoint,
        status,
        latencyMs: Math.max(0, Math.floor(latencyMs)),
        ...(errorTag ? { errorTag } : {}),
        ts: Math.floor(ts),
    });

    const lastUsedAt = key.lastUsedAt ?? 0;
    if (ts - lastUsedAt >= LAST_USED_DEDUP_MS) {
        await repo.bumpApiKeyLastUsedAt(apiKeyId, Math.floor(ts));
    }

    return null;
}
