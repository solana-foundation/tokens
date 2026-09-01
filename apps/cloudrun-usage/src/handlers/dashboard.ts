/**
 * Dashboard user/project/api-key handlers.
 *
 * Ports of `convex/users.ts`, `convex/projects.ts`, and the key
 * reset/reveal/playground paths of `convex/apiKeys.ts` + `convex/apiKeyActions.ts`.
 * Return shapes are field-for-field identical to the Convex validators
 * (including `_id` field names, epoch-ms timestamps, and OMITTED — not null —
 * optional keys) so the apps/app client does not change shape across backends.
 *
 * Authorization: Convex used `ctx.auth.getUserIdentity()`; here every
 * user-context handler requires the Clerk-session-verified caller from the
 * `x-tokens-identity` header and enforces membership/role checks in SQL
 * against it (never trusting `args.projectId`).
 */

import {
    decryptRawApiKey,
    encryptRawApiKey,
    generateRawApiKey,
    keyPrefixFromRawKey,
    sha256Hex,
    type EncryptedRawApiKey,
} from './apiKeyCrypto';
import { resolveEffectiveClerkUserId, type IdentityRepo } from './clerkIdentity';
import { IdentityRequiredError, InvalidArgsError, UnauthorizedError } from './errors';
import { normalizeScopes } from './platformAuth';
import type { CallerIdentity } from '../server';

export type ProjectRole = 'owner' | 'admin' | 'member';
export type ProjectTier = 'free' | 'pro' | 'enterprise';

export interface UserDoc {
    _id: string;
    _creationTime: number;
    clerkUserId: string;
    primaryEmail?: string;
    fullName?: string;
    createdAt: number;
    updatedAt: number;
}

export interface ProjectDoc {
    _id: string;
    _creationTime: number;
    name: string;
    description?: string;
    tier?: ProjectTier;
    createdByClerkUserId: string;
    personalClerkUserId?: string;
    limits?: unknown;
    createdAt: number;
    updatedAt: number;
}

export interface ProjectApiKeyRow {
    id: string;
    keyPrefix: string;
    createdAt: number;
    revokedAt: number | null;
    hasEncrypted: boolean;
}

export interface ApiKeyFullRow {
    id: string;
    projectId: string | null;
    ownerClerkUserId: string;
    keyPrefix: string;
    revokedAt: number | null;
    scopes: unknown;
    encryptedRawKeyCiphertext: string | null;
    encryptedRawKeyIv: string | null;
    encryptedRawKeyVersion: number | null;
}

export interface DashboardRepo {
    getUserByClerkId(clerkUserId: string): Promise<UserDoc | null>;
    upsertUser(args: {
        clerkUserId: string;
        primaryEmail?: string;
        fullName?: string;
        nowMs: number;
    }): Promise<string>;

    getMembership(projectId: string, clerkUserId: string): Promise<{ role: ProjectRole } | null>;
    countMemberships(clerkUserId: string): Promise<number>;
    listProjectsForMember(clerkUserId: string): Promise<Array<{ project: ProjectDoc; role: ProjectRole }>>;

    getProjectDoc(projectId: string): Promise<ProjectDoc | null>;
    findProjectIdByCreatorAndName(clerkUserId: string, name: string): Promise<string | null>;
    findPersonalProjectId(clerkUserId: string): Promise<string | null>;
    /** Transaction: insert project + owner membership. Returns projectId. */
    createProjectWithOwner(args: {
        name: string;
        description?: string;
        tier?: ProjectTier;
        personal?: boolean;
        clerkUserId: string;
        nowMs: number;
    }): Promise<string>;
    /** Insert membership if missing (idempotent). */
    ensureMembership(projectId: string, clerkUserId: string, role: ProjectRole, nowMs: number): Promise<void>;
    updateProject(projectId: string, name: string, description: string, nowMs: number): Promise<void>;
    setProjectRateLimit(
        projectId: string,
        rateLimit: {
            rateLimit: { requests: number; windowSeconds: number };
            sustainedRateLimit?: { requests: number; windowSeconds: number };
        } | null,
        nowMs: number,
    ): Promise<{ id: string; name: string; limits: unknown } | null>;
    /** Transaction: delete api keys + project (memberships cascade). */
    deleteProjectCascade(projectId: string): Promise<void>;

    /** Ops digest lookup: all projects as {id, name, isPersonal}. */
    listProjectsDigest(): Promise<Array<{ id: string; name: string; isPersonal: boolean }>>;

    listProjectApiKeys(projectId: string, limit: number): Promise<ProjectApiKeyRow[]>;
    getApiKeyById(apiKeyId: string): Promise<ApiKeyFullRow | null>;
    getApiKeyByHash(keyHash: string): Promise<ApiKeyFullRow | null>;
    revokeApiKey(apiKeyId: string, nowMs: number): Promise<void>;
    /**
     * Transaction implementing `apiKeys.create`'s one-active-key semantics:
     * revoke all active keys in the project (+ legacy owner keys with no
     * project when the target is the owner's personal project), then insert.
     * Returns the new key id.
     */
    insertApiKeyRevokingActive(args: {
        projectId: string;
        isPersonalProject: boolean;
        ownerClerkUserId: string;
        name: string;
        keyPrefix: string;
        keyHash: string;
        encrypted: EncryptedRawApiKey;
        scopes: string[];
        nowMs: number;
    }): Promise<string>;
}

export interface DashboardDeps {
    repo: DashboardRepo;
    identity: IdentityRepo;
    /** Required for key reset/reveal; may be absent in minimal deployments. */
    apiKeyEncryptionSecret?: string;
    now?: () => number;
}

const MAX_PROJECT_KEYS = 200;

function now(deps: DashboardDeps): number {
    return (deps.now ?? Date.now)();
}

function requireIdentity(identity: CallerIdentity | null): CallerIdentity {
    if (!identity) throw new IdentityRequiredError();
    return identity;
}

async function resolveCaller(deps: DashboardDeps, identity: CallerIdentity): Promise<string> {
    return resolveEffectiveClerkUserId(deps.identity, identity.clerkUserId, identity.email ?? null);
}

function requireObject(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null) throw new InvalidArgsError('args must be an object');
    return args as Record<string, unknown>;
}

function requireString(a: Record<string, unknown>, field: string): string {
    const value = a[field];
    if (typeof value !== 'string') throw new InvalidArgsError(`${field} must be a string`);
    return value;
}

function optionalString(a: Record<string, unknown>, field: string): string | undefined {
    const value = a[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new InvalidArgsError(`${field} must be a string`);
    return value;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function getEncryptionSecret(deps: DashboardDeps): string {
    const secret = (deps.apiKeyEncryptionSecret ?? '').trim();
    if (!secret) throw new Error('TOKENS_API_KEY_ENCRYPTION_SECRET is required to encrypt API keys');
    return secret;
}

function getMaxProjectsForTier(tier: ProjectTier): number {
    switch (tier) {
        case 'pro':
            return 20;
        case 'enterprise':
            return 200;
        case 'free':
        default:
            return 3;
    }
}

// ---------------------------------------------------------------------------
// users.*
// ---------------------------------------------------------------------------

/** Port of `users.getMe`. NOTE: uses the raw caller id, NOT alias resolution. */
export async function usersGetMe(
    deps: DashboardDeps,
    _args: unknown,
    identity: CallerIdentity | null,
): Promise<UserDoc | null> {
    const caller = requireIdentity(identity);
    return deps.repo.getUserByClerkId(caller.clerkUserId);
}

/** Port of `users.upsertMe`. The proxy passes `email`/`fullName` from the Clerk session. */
export async function usersUpsertMe(
    deps: DashboardDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<string> {
    const caller = requireIdentity(identity);
    const a = requireObject(args ?? {});
    const clerkUserId = await resolveCaller(deps, caller);
    const primaryEmail = trimmedOrUndefined(optionalString(a, 'email') ?? caller.email);
    const fullName = trimmedOrUndefined(optionalString(a, 'fullName'));
    return deps.repo.upsertUser({
        clerkUserId,
        ...(primaryEmail ? { primaryEmail } : {}),
        ...(fullName ? { fullName } : {}),
        nowMs: now(deps),
    });
}

/** Port of `users.getUserProjectLimits`. */
export async function usersGetUserProjectLimits(
    deps: DashboardDeps,
    _args: unknown,
    identity: CallerIdentity | null,
): Promise<{ tier: ProjectTier; maxProjects: number; currentCount: number; canCreateMore: boolean }> {
    const caller = requireIdentity(identity);
    const clerkUserId = await resolveCaller(deps, caller);

    // No billing integration yet; default to free tier.
    const tier: ProjectTier = 'free';
    const maxProjects = getMaxProjectsForTier(tier);
    const currentCount = await deps.repo.countMemberships(clerkUserId);

    return { tier, maxProjects, currentCount, canCreateMore: currentCount < maxProjects };
}

/** Port of `users.createProjectWithApiKey` → `users._createProject`. */
export async function usersCreateProjectWithApiKey(
    deps: DashboardDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ projectId: string }> {
    const caller = requireIdentity(identity);
    const a = requireObject(args);
    const clerkUserId = await resolveCaller(deps, caller);

    const name = requireString(a, 'name').trim();
    if (!name) throw new InvalidArgsError('Project name is required');
    const description = trimmedOrUndefined(optionalString(a, 'description'));

    const tier: ProjectTier = 'free';
    const maxProjects = getMaxProjectsForTier(tier);

    const currentCount = await deps.repo.countMemberships(clerkUserId);
    if (currentCount >= maxProjects) throw new InvalidArgsError('Project limit reached');

    const existingByName = await deps.repo.findProjectIdByCreatorAndName(clerkUserId, name);
    if (existingByName) throw new InvalidArgsError('Project name already exists');

    const projectId = await deps.repo.createProjectWithOwner({
        name,
        ...(description ? { description } : {}),
        tier,
        clerkUserId,
        nowMs: now(deps),
    });
    return { projectId };
}

/** Port of `users.getProjectById` — null (not error) when unauthenticated or not a member. */
export async function usersGetProjectById(
    deps: DashboardDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<ProjectDoc | null> {
    if (!identity) return null;
    const a = requireObject(args);
    const projectId = requireString(a, 'projectId');
    const clerkUserId = await resolveCaller(deps, identity);

    const membership = await deps.repo.getMembership(projectId, clerkUserId);
    if (!membership) return null;

    return deps.repo.getProjectDoc(projectId);
}

/** Port of `users.updateProject` — requires owner/admin role. */
export async function usersUpdateProject(
    deps: DashboardDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<null> {
    const caller = requireIdentity(identity);
    const a = requireObject(args);
    const projectId = requireString(a, 'projectId');
    const clerkUserId = await resolveCaller(deps, caller);

    const membership = await deps.repo.getMembership(projectId, clerkUserId);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        throw new UnauthorizedError();
    }

    const name = requireString(a, 'name').trim();
    if (!name) throw new InvalidArgsError('Project name is required');
    const description = optionalString(a, 'description')?.trim() ?? '';

    const existingByName = await deps.repo.findProjectIdByCreatorAndName(clerkUserId, name);
    if (existingByName && existingByName !== projectId) {
        throw new InvalidArgsError('Project name already exists');
    }

    await deps.repo.updateProject(projectId, name, description, now(deps));
    return null;
}

function readWindow(
    a: Record<string, unknown>,
    requestsField: string,
    windowField: string,
    defaultWindowSeconds: number,
): { requests: number; windowSeconds: number } {
    const requests = a[requestsField];
    if (typeof requests !== 'number' || !Number.isInteger(requests) || requests < 1 || requests > 1_000_000) {
        throw new InvalidArgsError(`${requestsField} must be an integer between 1 and 1000000`);
    }
    const windowSeconds = a[windowField] ?? defaultWindowSeconds;
    if (
        typeof windowSeconds !== 'number' ||
        !Number.isInteger(windowSeconds) ||
        windowSeconds < 1 ||
        windowSeconds > 86_400
    ) {
        throw new InvalidArgsError(`${windowField} must be an integer between 1 and 86400`);
    }
    return { requests, windowSeconds };
}

export async function projectsSetRateLimit(
    deps: DashboardDeps,
    args: unknown,
): Promise<{ id: string; name: string; limits: unknown }> {
    const a = requireObject(args);
    const projectId = requireString(a, 'projectId');

    let limits: {
        rateLimit: { requests: number; windowSeconds: number };
        sustainedRateLimit?: { requests: number; windowSeconds: number };
    } | null = null;
    if (a.clear !== true) {
        limits = { rateLimit: readWindow(a, 'requests', 'windowSeconds', 10) };
        if (a.sustainedRequests !== undefined) {
            limits.sustainedRateLimit = readWindow(a, 'sustainedRequests', 'sustainedWindowSeconds', 60);
        }
    }

    const updated = await deps.repo.setProjectRateLimit(projectId, limits, now(deps));
    if (!updated) throw new InvalidArgsError(`Unknown project: ${projectId}`);
    return updated;
}

/** Port of `users.deleteProject` — requires owner role; cascades keys + memberships. */
export async function usersDeleteProject(
    deps: DashboardDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<null> {
    const caller = requireIdentity(identity);
    const a = requireObject(args);
    const projectId = requireString(a, 'projectId');
    const clerkUserId = await resolveCaller(deps, caller);

    const membership = await deps.repo.getMembership(projectId, clerkUserId);
    if (!membership || membership.role !== 'owner') throw new UnauthorizedError();

    await deps.repo.deleteProjectCascade(projectId);
    return null;
}

export interface ProjectApiKeyView {
    _id: string;
    keyPreview: string;
    createdAt: number;
    isActive: boolean;
    canReveal: boolean;
    deactivatedAt?: number;
}

/** Port of `users.getAllProjectApiKeys` — [] (not error) when unauthenticated or not a member. */
export async function usersGetAllProjectApiKeys(
    deps: DashboardDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<ProjectApiKeyView[]> {
    if (!identity) return [];
    const a = requireObject(args);
    const projectId = requireString(a, 'projectId');
    const clerkUserId = await resolveCaller(deps, identity);

    const membership = await deps.repo.getMembership(projectId, clerkUserId);
    if (!membership) return [];

    const keys = await deps.repo.listProjectApiKeys(projectId, MAX_PROJECT_KEYS);
    return keys.map(key => ({
        _id: key.id,
        keyPreview: `${key.keyPrefix}…`,
        createdAt: key.createdAt,
        isActive: key.revokedAt === null,
        canReveal: key.revokedAt === null && key.hasEncrypted,
        ...(key.revokedAt !== null ? { deactivatedAt: key.revokedAt } : {}),
    }));
}

// ---------------------------------------------------------------------------
// projects.*
// ---------------------------------------------------------------------------

/** Port of `projects.listMine`. */
export async function projectsListMine(
    deps: DashboardDeps,
    _args: unknown,
    identity: CallerIdentity | null,
): Promise<Array<{ project: ProjectDoc; role: ProjectRole }>> {
    const caller = requireIdentity(identity);
    const clerkUserId = await resolveCaller(deps, caller);
    return deps.repo.listProjectsForMember(clerkUserId);
}

/** Port of `projects.getOrCreatePersonalProject`. */
export async function projectsGetOrCreatePersonalProject(
    deps: DashboardDeps,
    _args: unknown,
    identity: CallerIdentity | null,
): Promise<string> {
    const caller = requireIdentity(identity);
    const clerkUserId = await resolveCaller(deps, caller);
    const nowMs = now(deps);

    const existing = await deps.repo.findPersonalProjectId(clerkUserId);
    if (existing) {
        await deps.repo.ensureMembership(existing, clerkUserId, 'owner', nowMs);
        return existing;
    }

    return deps.repo.createProjectWithOwner({
        name: 'Personal',
        personal: true,
        clerkUserId,
        nowMs,
    });
}

// ---------------------------------------------------------------------------
// apiKeys.* / apiKeyActions.*
// ---------------------------------------------------------------------------

/** Port of `apiKeys.revoke` (used by `users.deleteApiKey`). Idempotent, silent on missing key. */
export async function apiKeysRevoke(
    deps: DashboardDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<null> {
    const caller = requireIdentity(identity);
    const a = requireObject(args);
    const apiKeyId = requireString(a, 'apiKeyId');
    const ownerClerkUserId = await resolveCaller(deps, caller);

    const existing = await deps.repo.getApiKeyById(apiKeyId);
    if (!existing) return null;

    if (existing.projectId !== null) {
        const membership = await deps.repo.getMembership(existing.projectId, ownerClerkUserId);
        if (!membership) throw new UnauthorizedError();
    } else if (existing.ownerClerkUserId !== ownerClerkUserId) {
        throw new UnauthorizedError();
    }
    if (existing.revokedAt !== null) return null;

    await deps.repo.revokeApiKey(apiKeyId, now(deps));
    return null;
}

/** Port of `apiKeyActions.resetApiKey` + `apiKeys.create` (single transaction on the write). */
export async function apiKeysReset(
    deps: DashboardDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ apiKeyId: string; rawKey: string; keyPreview: string }> {
    const caller = requireIdentity(identity);
    const a = requireObject(args);
    const projectId = requireString(a, 'projectId');
    const ownerClerkUserId = await resolveCaller(deps, caller);

    const membership = await deps.repo.getMembership(projectId, ownerClerkUserId);
    if (!membership) throw new UnauthorizedError();

    const rawKey = generateRawApiKey();
    const keyPrefix = keyPrefixFromRawKey(rawKey);
    const keyHash = await sha256Hex(rawKey);
    const encrypted = await encryptRawApiKey(rawKey, getEncryptionSecret(deps), now(deps));

    // Freshly-generated 256-bit keys make hash collisions practically impossible,
    // but mirror the Convex `create` checks (and the unique index backstops races).
    const existing = await deps.repo.getApiKeyByHash(keyHash);
    if (existing) {
        if (existing.ownerClerkUserId !== ownerClerkUserId) throw new InvalidArgsError('API key already exists');
        if (existing.revokedAt !== null) throw new InvalidArgsError('API key has been revoked');
        if (existing.projectId !== null && existing.projectId !== projectId) {
            throw new InvalidArgsError('API key already exists in another project');
        }
        return { apiKeyId: existing.id, rawKey, keyPreview: `${keyPrefix}…` };
    }

    const project = await deps.repo.getProjectDoc(projectId);
    const isPersonalProject = project?.personalClerkUserId === ownerClerkUserId;

    const apiKeyId = await deps.repo.insertApiKeyRevokingActive({
        projectId,
        isPersonalProject,
        ownerClerkUserId,
        name: 'Primary key',
        keyPrefix,
        keyHash,
        encrypted,
        scopes: normalizeScopes(undefined),
        nowMs: now(deps),
    });

    return { apiKeyId, rawKey, keyPreview: `${keyPrefix}…` };
}

export type ApiKeyRevealResult =
    | { status: 'ok'; apiKeyId: string; rawKey: string; keyPreview: string }
    | { status: 'unavailable'; reason: 'legacy' | 'inactive' | 'not_found' };

/** Port of `apiKeyActions.revealApiKey` + `apiKeys.getEncryptedKeyForReveal`. */
export async function apiKeysReveal(
    deps: DashboardDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<ApiKeyRevealResult> {
    const caller = requireIdentity(identity);
    const a = requireObject(args);
    const projectId = requireString(a, 'projectId');
    const apiKeyId = requireString(a, 'apiKeyId');
    const clerkUserId = await resolveCaller(deps, caller);

    const membership = await deps.repo.getMembership(projectId, clerkUserId);
    if (!membership) throw new UnauthorizedError();

    const key = await deps.repo.getApiKeyById(apiKeyId);
    if (!key || key.projectId !== projectId) return { status: 'unavailable', reason: 'not_found' };
    if (key.revokedAt !== null) return { status: 'unavailable', reason: 'inactive' };
    if (!key.encryptedRawKeyCiphertext || !key.encryptedRawKeyIv || key.encryptedRawKeyVersion === null) {
        return { status: 'unavailable', reason: 'legacy' };
    }

    const rawKey = await decryptRawApiKey(
        {
            ciphertext: key.encryptedRawKeyCiphertext,
            iv: key.encryptedRawKeyIv,
            version: key.encryptedRawKeyVersion,
        },
        getEncryptionSecret(deps),
    );

    return { status: 'ok', apiKeyId: key.id, rawKey, keyPreview: `${key.keyPrefix}…` };
}

export interface PlaygroundAuthContext {
    apiKeyId: string;
    keyPrefix: string;
    projectId: string;
    ownerClerkUserId: string;
    scopes: string[];
    limits?: unknown;
}

/** Port of `apiKeys.getPlaygroundAuthContextForServer` (identity replaces the shared secret). */
export async function apiKeysGetPlaygroundAuthContext(
    deps: DashboardDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<PlaygroundAuthContext | null> {
    const caller = requireIdentity(identity);
    const a = requireObject(args);
    const projectId = requireString(a, 'projectId');
    const apiKeyId = requireString(a, 'apiKeyId');
    const clerkUserId = await resolveCaller(deps, caller);

    const membership = await deps.repo.getMembership(projectId, clerkUserId);
    if (!membership) throw new UnauthorizedError();

    const key = await deps.repo.getApiKeyById(apiKeyId);
    if (!key) return null;
    if (key.projectId !== projectId) return null;
    if (key.revokedAt !== null) return null;

    const project = await deps.repo.getProjectDoc(projectId);
    if (!project) return null;

    return {
        apiKeyId: key.id,
        keyPrefix: key.keyPrefix,
        projectId,
        ownerClerkUserId: key.ownerClerkUserId,
        scopes: normalizeScopes(Array.isArray(key.scopes) ? (key.scopes as string[]) : undefined),
        ...(project.limits !== undefined && project.limits !== null ? { limits: project.limits } : {}),
    };
}
