import { describe, expect, it } from 'bun:test';

import { encryptRawApiKey } from './apiKeyCrypto';
import type { IdentityRepo } from './clerkIdentity';
import {
    apiKeysGetPlaygroundAuthContext,
    apiKeysReset,
    apiKeysReveal,
    apiKeysRevoke,
    projectsGetOrCreatePersonalProject,
    projectsListMine,
    projectsSetRateLimit,
    usersCreateProjectWithApiKey,
    usersDeleteProject,
    usersGetAllProjectApiKeys,
    usersGetMe,
    usersGetProjectById,
    usersGetUserProjectLimits,
    usersUpdateProject,
    usersUpsertMe,
    type ApiKeyFullRow,
    type DashboardDeps,
    type DashboardRepo,
    type ProjectDoc,
    type ProjectRole,
} from './dashboard';
import { IdentityRequiredError, InvalidArgsError, UnauthorizedError } from './errors';

const SECRET = 'test-secret';
const NOW = 1_750_000_000_000;
const IDENT = { clerkUserId: 'user_1' };

const identityRepo: IdentityRepo = {
    getUserPrimaryEmail: async () => null,
    listClerkUserIdsByEmail: async () => [],
    getIdentityScoreInputs: async () => ({ memberships: 0, keys: 0, activeKeys: 0 }),
};

const PROJECT: ProjectDoc = {
    _id: 'proj_1',
    _creationTime: 1,
    name: 'Alpha',
    createdByClerkUserId: 'user_1',
    createdAt: 1,
    updatedAt: 1,
};

interface RepoState {
    membership?: { role: ProjectRole } | null;
    membershipCount?: number;
    project?: ProjectDoc | null;
    apiKey?: ApiKeyFullRow | null;
    apiKeyByHash?: ApiKeyFullRow | null;
    personalProjectId?: string | null;
    projectIdByName?: string | null;
}

function makeRepo(state: RepoState = {}) {
    const calls: Record<string, unknown[]> = {};
    const track = (name: string, args: unknown) => {
        (calls[name] ??= []).push(args);
    };
    const repo: DashboardRepo = {
        getUserByClerkId: async id => (id === 'user_1' ? { _id: 'usr_1', _creationTime: 1, clerkUserId: id, createdAt: 1, updatedAt: 1 } : null),
        upsertUser: async args => {
            track('upsertUser', args);
            return 'usr_1';
        },
        getMembership: async (...args) => {
            track('getMembership', args);
            return state.membership ?? null;
        },
        countMemberships: async () => state.membershipCount ?? 0,
        listProjectsForMember: async () => (state.project ? [{ project: state.project, role: 'owner' as const }] : []),
        getProjectDoc: async () => state.project ?? null,
        findProjectIdByCreatorAndName: async () => state.projectIdByName ?? null,
        findPersonalProjectId: async () => state.personalProjectId ?? null,
        listProjectsDigest: async () => [],
        createProjectWithOwner: async args => {
            track('createProjectWithOwner', args);
            return 'prj_new';
        },
        ensureMembership: async (...args) => track('ensureMembership', args),
        updateProject: async (...args) => track('updateProject', args),
        setProjectRateLimit: async (...args) => {
            track('setProjectRateLimit', args);
            if (!state.project) return null;
            return { id: args[0], name: 'P', limits: args[1] };
        },
        deleteProjectCascade: async (...args) => track('deleteProjectCascade', args),
        listProjectApiKeys: async () => [
            { id: 'key_a', keyPrefix: 'tok_aaaa', createdAt: 5, revokedAt: null, hasEncrypted: true },
            { id: 'key_b', keyPrefix: 'tok_bbbb', createdAt: 4, revokedAt: 99, hasEncrypted: true },
            { id: 'key_c', keyPrefix: 'tok_cccc', createdAt: 3, revokedAt: null, hasEncrypted: false },
        ],
        getApiKeyById: async () => state.apiKey ?? null,
        getApiKeyByHash: async () => state.apiKeyByHash ?? null,
        revokeApiKey: async (...args) => track('revokeApiKey', args),
        insertApiKeyRevokingActive: async args => {
            track('insertApiKeyRevokingActive', args);
            return 'key_new';
        },
    };
    return { repo, calls };
}

function makeDeps(state: RepoState = {}): { deps: DashboardDeps; calls: Record<string, unknown[]> } {
    const { repo, calls } = makeRepo(state);
    return {
        deps: { repo, identity: identityRepo, apiKeyEncryptionSecret: SECRET, now: () => NOW },
        calls,
    };
}

describe('usersGetMe', () => {
    it('requires identity', async () => {
        const { deps } = makeDeps();
        await expect(usersGetMe(deps, {}, null)).rejects.toBeInstanceOf(IdentityRequiredError);
    });

    it('uses the raw caller id (no alias resolution)', async () => {
        // identity repo would alias user_1 -> user_2, but getMe must not resolve.
        const aliasing: IdentityRepo = {
            getUserPrimaryEmail: async () => 'a@b.co',
            listClerkUserIdsByEmail: async () => ['user_2'],
            getIdentityScoreInputs: async () => ({ memberships: 0, keys: 0, activeKeys: 0 }),
        };
        const { repo } = makeRepo();
        const result = await usersGetMe({ repo, identity: aliasing }, {}, IDENT);
        expect(result?.clerkUserId).toBe('user_1');
    });
});

describe('usersUpsertMe', () => {
    it('passes trimmed email/fullName and omits empties', async () => {
        const { deps, calls } = makeDeps();
        await usersUpsertMe(deps, { email: ' a@b.co ', fullName: '  ' }, IDENT);
        expect(calls.upsertUser?.[0]).toEqual({ clerkUserId: 'user_1', primaryEmail: 'a@b.co', nowMs: NOW });
    });
});

describe('usersGetUserProjectLimits', () => {
    it('reports free-tier limits', async () => {
        const { deps } = makeDeps({ membershipCount: 2 });
        expect(await usersGetUserProjectLimits(deps, {}, IDENT)).toEqual({
            tier: 'free',
            maxProjects: 3,
            currentCount: 2,
            canCreateMore: true,
        });
    });
});

describe('usersCreateProjectWithApiKey', () => {
    it('creates a project and owner membership', async () => {
        const { deps, calls } = makeDeps({ membershipCount: 0 });
        const result = await usersCreateProjectWithApiKey(deps, { name: ' New ', description: ' d ' }, IDENT);
        expect(result).toEqual({ projectId: 'prj_new' });
        expect(calls.createProjectWithOwner?.[0]).toEqual({
            name: 'New',
            description: 'd',
            tier: 'free',
            clerkUserId: 'user_1',
            nowMs: NOW,
        });
    });

    it('enforces the project limit and name uniqueness', async () => {
        const atLimit = makeDeps({ membershipCount: 3 });
        await expect(
            usersCreateProjectWithApiKey(atLimit.deps, { name: 'X' }, IDENT),
        ).rejects.toThrow('Project limit reached');

        const dup = makeDeps({ membershipCount: 0, projectIdByName: 'prj_exists' });
        await expect(usersCreateProjectWithApiKey(dup.deps, { name: 'X' }, IDENT)).rejects.toThrow(
            'Project name already exists',
        );
    });

    it('rejects empty names', async () => {
        const { deps } = makeDeps();
        await expect(usersCreateProjectWithApiKey(deps, { name: '  ' }, IDENT)).rejects.toBeInstanceOf(
            InvalidArgsError,
        );
    });
});

describe('usersGetProjectById', () => {
    it('returns null without identity or membership; project when member', async () => {
        const noIdent = makeDeps({ project: PROJECT });
        expect(await usersGetProjectById(noIdent.deps, { projectId: 'proj_1' }, null)).toBeNull();

        const noMember = makeDeps({ project: PROJECT, membership: null });
        expect(await usersGetProjectById(noMember.deps, { projectId: 'proj_1' }, IDENT)).toBeNull();

        const member = makeDeps({ project: PROJECT, membership: { role: 'member' } });
        expect(await usersGetProjectById(member.deps, { projectId: 'proj_1' }, IDENT)).toEqual(PROJECT);
    });
});

describe('projectsSetRateLimit', () => {
    it('sets the override with a default 10s window', async () => {
        const { deps, calls } = makeDeps({ project: PROJECT });
        const res = await projectsSetRateLimit(deps, { projectId: 'proj_1', requests: 500 });
        expect(calls.setProjectRateLimit?.[0]).toEqual([
            'proj_1',
            { rateLimit: { requests: 500, windowSeconds: 10 } },
            NOW,
        ]);
        expect(res.limits).toEqual({ rateLimit: { requests: 500, windowSeconds: 10 } });
    });

    it('sets an optional sustained window with a default 60s window', async () => {
        const { deps, calls } = makeDeps({ project: PROJECT });
        await projectsSetRateLimit(deps, { projectId: 'proj_1', requests: 500, sustainedRequests: 3000 });
        expect(calls.setProjectRateLimit?.[0]).toEqual([
            'proj_1',
            {
                rateLimit: { requests: 500, windowSeconds: 10 },
                sustainedRateLimit: { requests: 3000, windowSeconds: 60 },
            },
            NOW,
        ]);
    });

    it('rejects invalid sustained values', async () => {
        const { deps } = makeDeps({ project: PROJECT });
        await expect(
            projectsSetRateLimit(deps, { projectId: 'proj_1', requests: 500, sustainedRequests: 0 }),
        ).rejects.toBeInstanceOf(InvalidArgsError);
    });

    it('clears the override', async () => {
        const { deps, calls } = makeDeps({ project: PROJECT });
        await projectsSetRateLimit(deps, { projectId: 'proj_1', clear: true });
        expect(calls.setProjectRateLimit?.[0]).toEqual(['proj_1', null, NOW]);
    });

    it('rejects invalid requests values', async () => {
        const { deps } = makeDeps({ project: PROJECT });
        for (const requests of [0, -5, 1.5, 2_000_000, '500', undefined]) {
            await expect(projectsSetRateLimit(deps, { projectId: 'proj_1', requests })).rejects.toBeInstanceOf(
                InvalidArgsError,
            );
        }
        await expect(
            projectsSetRateLimit(deps, { projectId: 'proj_1', requests: 500, windowSeconds: 0 }),
        ).rejects.toBeInstanceOf(InvalidArgsError);
    });

    it('rejects unknown projects', async () => {
        const { deps } = makeDeps({ project: null });
        await expect(projectsSetRateLimit(deps, { projectId: 'nope', requests: 500 })).rejects.toBeInstanceOf(
            InvalidArgsError,
        );
    });
});

describe('usersUpdateProject', () => {
    it('requires owner/admin role', async () => {
        const memberOnly = makeDeps({ membership: { role: 'member' } });
        await expect(
            usersUpdateProject(memberOnly.deps, { projectId: 'proj_1', name: 'X' }, IDENT),
        ).rejects.toBeInstanceOf(UnauthorizedError);

        const admin = makeDeps({ membership: { role: 'admin' } });
        expect(await usersUpdateProject(admin.deps, { projectId: 'proj_1', name: 'X' }, IDENT)).toBeNull();
        expect(admin.calls.updateProject?.[0]).toEqual(['proj_1', 'X', '', NOW]);
    });

    it('allows self-name match but rejects other project with same name', async () => {
        const self = makeDeps({ membership: { role: 'owner' }, projectIdByName: 'proj_1' });
        expect(await usersUpdateProject(self.deps, { projectId: 'proj_1', name: 'X' }, IDENT)).toBeNull();

        const other = makeDeps({ membership: { role: 'owner' }, projectIdByName: 'proj_other' });
        await expect(usersUpdateProject(other.deps, { projectId: 'proj_1', name: 'X' }, IDENT)).rejects.toThrow(
            'Project name already exists',
        );
    });
});

describe('usersDeleteProject', () => {
    it('requires owner role and cascades', async () => {
        const admin = makeDeps({ membership: { role: 'admin' } });
        await expect(usersDeleteProject(admin.deps, { projectId: 'proj_1' }, IDENT)).rejects.toBeInstanceOf(
            UnauthorizedError,
        );

        const owner = makeDeps({ membership: { role: 'owner' } });
        expect(await usersDeleteProject(owner.deps, { projectId: 'proj_1' }, IDENT)).toBeNull();
        expect(owner.calls.deleteProjectCascade?.[0]).toEqual(['proj_1']);
    });
});

describe('usersGetAllProjectApiKeys', () => {
    it('returns [] without identity or membership', async () => {
        const { deps } = makeDeps({ membership: null });
        expect(await usersGetAllProjectApiKeys(deps, { projectId: 'proj_1' }, null)).toEqual([]);
        expect(await usersGetAllProjectApiKeys(deps, { projectId: 'proj_1' }, IDENT)).toEqual([]);
    });

    it('maps rows with preview/isActive/canReveal/deactivatedAt', async () => {
        const { deps } = makeDeps({ membership: { role: 'member' } });
        const rows = await usersGetAllProjectApiKeys(deps, { projectId: 'proj_1' }, IDENT);
        expect(rows).toEqual([
            { _id: 'key_a', keyPreview: 'tok_aaaa…', createdAt: 5, isActive: true, canReveal: true },
            { _id: 'key_b', keyPreview: 'tok_bbbb…', createdAt: 4, isActive: false, canReveal: false, deactivatedAt: 99 },
            { _id: 'key_c', keyPreview: 'tok_cccc…', createdAt: 3, isActive: true, canReveal: false },
        ]);
    });
});

describe('projectsListMine / projectsGetOrCreatePersonalProject', () => {
    it('lists projects with roles', async () => {
        const { deps } = makeDeps({ project: PROJECT });
        expect(await projectsListMine(deps, {}, IDENT)).toEqual([{ project: PROJECT, role: 'owner' }]);
    });

    it('self-heals membership on an existing personal project', async () => {
        const { deps, calls } = makeDeps({ personalProjectId: 'proj_personal' });
        expect(await projectsGetOrCreatePersonalProject(deps, {}, IDENT)).toBe('proj_personal');
        expect(calls.ensureMembership?.[0]).toEqual(['proj_personal', 'user_1', 'owner', NOW]);
    });

    it('creates a personal project when none exists', async () => {
        const { deps, calls } = makeDeps({ personalProjectId: null });
        expect(await projectsGetOrCreatePersonalProject(deps, {}, IDENT)).toBe('prj_new');
        expect(calls.createProjectWithOwner?.[0]).toEqual({
            name: 'Personal',
            personal: true,
            clerkUserId: 'user_1',
            nowMs: NOW,
        });
    });
});

const ACTIVE_KEY: ApiKeyFullRow = {
    id: 'key_1',
    projectId: 'proj_1',
    ownerClerkUserId: 'user_1',
    keyPrefix: 'tok_abcd',
    revokedAt: null,
    scopes: ['assets:read'],
    encryptedRawKeyCiphertext: null,
    encryptedRawKeyIv: null,
    encryptedRawKeyVersion: null,
};

describe('apiKeysRevoke', () => {
    it('is silent for missing keys and idempotent for revoked ones', async () => {
        const missing = makeDeps({ apiKey: null });
        expect(await apiKeysRevoke(missing.deps, { apiKeyId: 'key_x' }, IDENT)).toBeNull();

        const revoked = makeDeps({ apiKey: { ...ACTIVE_KEY, revokedAt: 5 }, membership: { role: 'member' } });
        expect(await apiKeysRevoke(revoked.deps, { apiKeyId: 'key_1' }, IDENT)).toBeNull();
        expect(revoked.calls.revokeApiKey).toBeUndefined();
    });

    it('requires membership for project keys and ownership for legacy keys', async () => {
        const noMember = makeDeps({ apiKey: ACTIVE_KEY, membership: null });
        await expect(apiKeysRevoke(noMember.deps, { apiKeyId: 'key_1' }, IDENT)).rejects.toBeInstanceOf(
            UnauthorizedError,
        );

        const legacyOther = makeDeps({ apiKey: { ...ACTIVE_KEY, projectId: null, ownerClerkUserId: 'user_9' } });
        await expect(apiKeysRevoke(legacyOther.deps, { apiKeyId: 'key_1' }, IDENT)).rejects.toBeInstanceOf(
            UnauthorizedError,
        );

        const legacyMine = makeDeps({ apiKey: { ...ACTIVE_KEY, projectId: null } });
        expect(await apiKeysRevoke(legacyMine.deps, { apiKeyId: 'key_1' }, IDENT)).toBeNull();
        expect(legacyMine.calls.revokeApiKey?.[0]).toEqual(['key_1', NOW]);
    });
});

describe('apiKeysReset', () => {
    it('requires membership', async () => {
        const { deps } = makeDeps({ membership: null });
        await expect(apiKeysReset(deps, { projectId: 'proj_1' }, IDENT)).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('generates, encrypts, and inserts with one-active-key semantics', async () => {
        const { deps, calls } = makeDeps({ membership: { role: 'owner' }, project: PROJECT });
        const result = await apiKeysReset(deps, { projectId: 'proj_1' }, IDENT);
        expect(result.apiKeyId).toBe('key_new');
        expect(/^tok_[0-9a-f]{64}$/.test(result.rawKey)).toBe(true);
        expect(result.keyPreview).toBe(`${result.rawKey.slice(0, 8)}…`);

        const insert = calls.insertApiKeyRevokingActive?.[0] as {
            projectId: string;
            isPersonalProject: boolean;
            name: string;
            keyHash: string;
            scopes: string[];
        };
        expect(insert.projectId).toBe('proj_1');
        expect(insert.isPersonalProject).toBe(false);
        expect(insert.name).toBe('Primary key');
        expect(/^[0-9a-f]{64}$/.test(insert.keyHash)).toBe(true);
        expect(insert.scopes.length).toBeGreaterThan(0);
    });

    it('flags personal projects so legacy keys get revoked too', async () => {
        const { deps, calls } = makeDeps({
            membership: { role: 'owner' },
            project: { ...PROJECT, personalClerkUserId: 'user_1' },
        });
        await apiKeysReset(deps, { projectId: 'proj_1' }, IDENT);
        expect((calls.insertApiKeyRevokingActive?.[0] as { isPersonalProject: boolean }).isPersonalProject).toBe(true);
    });

    it('throws without the encryption secret', async () => {
        const { repo } = makeRepo({ membership: { role: 'owner' }, project: PROJECT });
        const deps: DashboardDeps = { repo, identity: identityRepo, now: () => NOW };
        await expect(apiKeysReset(deps, { projectId: 'proj_1' }, IDENT)).rejects.toThrow(
            'TOKENS_API_KEY_ENCRYPTION_SECRET',
        );
    });
});

describe('apiKeysReveal', () => {
    it('requires membership; maps not_found / inactive / legacy states', async () => {
        const noMember = makeDeps({ membership: null });
        await expect(apiKeysReveal(noMember.deps, { projectId: 'proj_1', apiKeyId: 'key_1' }, IDENT)).rejects.toBeInstanceOf(
            UnauthorizedError,
        );

        const notFound = makeDeps({ membership: { role: 'member' }, apiKey: null });
        expect(await apiKeysReveal(notFound.deps, { projectId: 'proj_1', apiKeyId: 'key_1' }, IDENT)).toEqual({
            status: 'unavailable',
            reason: 'not_found',
        });

        const wrongProject = makeDeps({ membership: { role: 'member' }, apiKey: { ...ACTIVE_KEY, projectId: 'proj_2' } });
        expect(await apiKeysReveal(wrongProject.deps, { projectId: 'proj_1', apiKeyId: 'key_1' }, IDENT)).toEqual({
            status: 'unavailable',
            reason: 'not_found',
        });

        const inactive = makeDeps({ membership: { role: 'member' }, apiKey: { ...ACTIVE_KEY, revokedAt: 5 } });
        expect(await apiKeysReveal(inactive.deps, { projectId: 'proj_1', apiKeyId: 'key_1' }, IDENT)).toEqual({
            status: 'unavailable',
            reason: 'inactive',
        });

        const legacy = makeDeps({ membership: { role: 'member' }, apiKey: ACTIVE_KEY });
        expect(await apiKeysReveal(legacy.deps, { projectId: 'proj_1', apiKeyId: 'key_1' }, IDENT)).toEqual({
            status: 'unavailable',
            reason: 'legacy',
        });
    });

    it('decrypts and returns the raw key', async () => {
        const encrypted = await encryptRawApiKey('tok_secret_raw', SECRET, NOW);
        const { deps } = makeDeps({
            membership: { role: 'member' },
            apiKey: {
                ...ACTIVE_KEY,
                encryptedRawKeyCiphertext: encrypted.encryptedRawKeyCiphertext,
                encryptedRawKeyIv: encrypted.encryptedRawKeyIv,
                encryptedRawKeyVersion: encrypted.encryptedRawKeyVersion,
            },
        });
        expect(await apiKeysReveal(deps, { projectId: 'proj_1', apiKeyId: 'key_1' }, IDENT)).toEqual({
            status: 'ok',
            apiKeyId: 'key_1',
            rawKey: 'tok_secret_raw',
            keyPreview: 'tok_abcd…',
        });
    });
});

describe('apiKeysGetPlaygroundAuthContext', () => {
    it('returns the auth context with normalized scopes and limits', async () => {
        const { deps } = makeDeps({
            membership: { role: 'member' },
            apiKey: ACTIVE_KEY,
            project: { ...PROJECT, limits: { quota: { requestsPerMonth: 5 } } },
        });
        expect(await apiKeysGetPlaygroundAuthContext(deps, { projectId: 'proj_1', apiKeyId: 'key_1' }, IDENT)).toEqual({
            apiKeyId: 'key_1',
            keyPrefix: 'tok_abcd',
            projectId: 'proj_1',
            ownerClerkUserId: 'user_1',
            scopes: ['assets:read'],
            limits: { quota: { requestsPerMonth: 5 } },
        });
    });

    it('returns null for revoked or cross-project keys; 403 without membership', async () => {
        const revoked = makeDeps({ membership: { role: 'member' }, apiKey: { ...ACTIVE_KEY, revokedAt: 1 }, project: PROJECT });
        expect(
            await apiKeysGetPlaygroundAuthContext(revoked.deps, { projectId: 'proj_1', apiKeyId: 'key_1' }, IDENT),
        ).toBeNull();

        const cross = makeDeps({ membership: { role: 'member' }, apiKey: { ...ACTIVE_KEY, projectId: 'proj_2' }, project: PROJECT });
        expect(
            await apiKeysGetPlaygroundAuthContext(cross.deps, { projectId: 'proj_1', apiKeyId: 'key_1' }, IDENT),
        ).toBeNull();

        const noMember = makeDeps({ membership: null });
        await expect(
            apiKeysGetPlaygroundAuthContext(noMember.deps, { projectId: 'proj_1', apiKeyId: 'key_1' }, IDENT),
        ).rejects.toBeInstanceOf(UnauthorizedError);
    });
});
