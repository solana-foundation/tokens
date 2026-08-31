import { Hono, type Context } from 'hono';
import { isValidBearerToken } from '@tokens/cloudrun-shutdown';

import type { IdentityRepo } from './handlers/clerkIdentity';
import * as dashboard from './handlers/dashboard';
import type { DashboardRepo } from './handlers/dashboard';
import { dispatchErrorResponse } from '@tokens/cloudrun-shutdown/http-errors';
import { authenticateApiKey, logApiRequest, type PlatformAuthRepo } from './handlers/platformAuth';
import * as usageDashboard from './handlers/usageDashboard';
import type { UsageDashboardRepo } from './handlers/usageDashboard';
import { ingestUsageAggregates, type UsageIngestRepo } from './handlers/usageIngest';
import { registerHookRoutes, type HookDeps } from './hooks';

export interface CallerIdentity {
    clerkUserId: string;
    projectId?: string;
    email?: string;
}

export interface ServerDeps {
    platformAuth: PlatformAuthRepo;
    usageIngest: UsageIngestRepo;
    dashboard: DashboardRepo;
    usageDashboard: UsageDashboardRepo;
    identity: IdentityRepo;
    /** Required for key reset/reveal; those handlers throw if absent. */
    apiKeyEncryptionSecret?: string;
    /** Vercel log-drain + Clerk webhook ingest (app-level auth, not bearer). */
    hooks?: HookDeps;
    authToken: string;
}

type Handler = (args: unknown, identity: CallerIdentity | null) => Promise<unknown>;

/**
 * SECURITY: trusted-on-arrival by design. This header is a base64 JSON blob
 * that this service decodes WITHOUT any cryptographic verification — the
 * caller identity is whatever the header claims. The trust model relies on:
 *
 *   1. This service never being directly reachable by end users. It must sit
 *      behind the upstream API proxy (`apps/api`), which authenticates the
 *      real user (Clerk session / API key) and populates this header itself.
 *   2. The shared bearer token (`authToken`) gating every RPC route, so only
 *      the proxy can call this service at all.
 *
 * If either invariant breaks (service exposed publicly, bearer token leaked),
 * anyone can impersonate any user by forging this header. Do not read this
 * header in any context where the request may not have come from the proxy.
 */
export const IDENTITY_HEADER = 'x-tokens-identity';

export function decodeIdentityHeader(raw: string | undefined): CallerIdentity | null {
    if (!raw) return null;
    try {
        const json = Buffer.from(raw, 'base64').toString('utf8');
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.clerkUserId !== 'string' || !obj.clerkUserId.trim()) return null;
        return {
            clerkUserId: obj.clerkUserId.trim(),
            ...(typeof obj.projectId === 'string' && obj.projectId.trim() ? { projectId: obj.projectId.trim() } : {}),
            ...(typeof obj.email === 'string' && obj.email.trim() ? { email: obj.email.trim() } : {}),
        };
    } catch {
        return null;
    }
}


export function createApp(deps: ServerDeps) {
    const app = new Hono();

    const dashDeps: dashboard.DashboardDeps = {
        repo: deps.dashboard,
        identity: deps.identity,
        ...(deps.apiKeyEncryptionSecret ? { apiKeyEncryptionSecret: deps.apiKeyEncryptionSecret } : {}),
    };
    const usageDeps: usageDashboard.UsageDashboardDeps = {
        repo: deps.usageDashboard,
        identity: deps.identity,
    };

    const queries: Record<string, Handler> = Object.create(null);
    queries.ping = async args => ({ ok: true, echo: args ?? null });
    queries.apiKeysAuthenticate = args => authenticateApiKey(deps.platformAuth, args);
    // Ops: project id→name/isPersonal lookup for the daily usage digest
    // (replaces the `convex run --inline-query` in infra/cron/usage-digest.sh).
    queries.listProjectsDigest = () => deps.dashboard.listProjectsDigest();
    // Dashboard reads (identity-scoped).
    queries.usersGetMe = (args, identity) => dashboard.usersGetMe(dashDeps, args, identity);
    queries.usersGetUserProjectLimits = (args, identity) =>
        dashboard.usersGetUserProjectLimits(dashDeps, args, identity);
    queries.usersGetProjectById = (args, identity) => dashboard.usersGetProjectById(dashDeps, args, identity);
    queries.usersGetAllProjectApiKeys = (args, identity) =>
        dashboard.usersGetAllProjectApiKeys(dashDeps, args, identity);
    queries.projectsListMine = (args, identity) => dashboard.projectsListMine(dashDeps, args, identity);
    queries.apiKeysReveal = (args, identity) => dashboard.apiKeysReveal(dashDeps, args, identity);
    queries.apiKeysGetPlaygroundAuthContext = (args, identity) =>
        dashboard.apiKeysGetPlaygroundAuthContext(dashDeps, args, identity);
    queries.usageGetProjectUsageStats = (args, identity) =>
        usageDashboard.usageGetProjectUsageStats(usageDeps, args, identity);
    queries.usageGetProjectUsageTimeSeries = (args, identity) =>
        usageDashboard.usageGetProjectUsageTimeSeries(usageDeps, args, identity);
    queries.usageGetEndpointPerformance = (args, identity) =>
        usageDashboard.usageGetEndpointPerformance(usageDeps, args, identity);

    const mutations: Record<string, Handler> = Object.create(null);
    mutations.logApiRequest = args => logApiRequest(deps.platformAuth, args);
    mutations.ingestUsageAggregates = args => ingestUsageAggregates(deps.usageIngest, args);
    // Dashboard writes (identity-scoped).
    mutations.usersUpsertMe = (args, identity) => dashboard.usersUpsertMe(dashDeps, args, identity);
    mutations.usersCreateProjectWithApiKey = (args, identity) =>
        dashboard.usersCreateProjectWithApiKey(dashDeps, args, identity);
    mutations.usersUpdateProject = (args, identity) => dashboard.usersUpdateProject(dashDeps, args, identity);
    mutations.usersDeleteProject = (args, identity) => dashboard.usersDeleteProject(dashDeps, args, identity);
    mutations.projectsGetOrCreatePersonalProject = (args, identity) =>
        dashboard.projectsGetOrCreatePersonalProject(dashDeps, args, identity);
    mutations.apiKeysRevoke = (args, identity) => dashboard.apiKeysRevoke(dashDeps, args, identity);
    mutations.apiKeysReset = (args, identity) => dashboard.apiKeysReset(dashDeps, args, identity);
    mutations.projectsSetRateLimit = args => dashboard.projectsSetRateLimit(dashDeps, args);

    app.get('/health', c => c.json({ ok: true }));

    const dispatch = (registry: Record<string, Handler>, kind: 'query' | 'mutation') => async (c: Context) => {
        if (!isValidBearerToken(c.req.header('authorization'), deps.authToken)) {
            return c.json({ error: 'unauthorized' }, 401);
        }
        const name = c.req.param('name') ?? '';
        if (!Object.hasOwn(registry, name)) {
            return c.json({ error: `unknown ${kind}: ${name}` }, 404);
        }
        const handler = registry[name]!;
        const identity = decodeIdentityHeader(c.req.header(IDENTITY_HEADER));
        const args: unknown = await c.req.json().catch(() => ({}));
        try {
            return c.json(await handler(args, identity));
        } catch (err) {
            const { body, status } = dispatchErrorResponse('cloudrun-usage', err, kind, name);
            return c.json(body, status);
        }
    };

    app.post('/query/:name', dispatch(queries, 'query'));
    app.post('/mutation/:name', dispatch(mutations, 'mutation'));

    registerHookRoutes(app, deps.hooks ?? {});

    return app;
}
