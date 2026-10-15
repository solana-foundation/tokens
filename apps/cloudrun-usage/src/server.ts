import { Hono, type Context } from 'hono';
import { isValidBearerToken } from '@tokens/cloudrun-shutdown';
import {
    IDENTITY_HEADER,
    isSignedIdentityHeader,
    verifyIdentityToken,
    type IdentityVerifyFailure,
} from '@tokens/cloudrun-shutdown/identity';

import type { IdentityRepo } from './handlers/clerkIdentity';
import * as dashboard from './handlers/dashboard';
import type { DashboardRepo } from './handlers/dashboard';
import { dispatchErrorResponse } from '@tokens/cloudrun-shutdown/http-errors';
import { limitsEnforce } from './handlers/limits';
import { authenticateApiKey, logApiRequest, type PlatformAuthRepo } from './handlers/platformAuth';
import type { LimitsRedis } from './redis';
import * as usageDashboard from './handlers/usageDashboard';
import type { UsageDashboardRepo } from './handlers/usageDashboard';
import { ingestUsageAggregates, syncUsageAggregates, type UsageIngestRepo } from './handlers/usageIngest';
import { registerHookRoutes, type HookDeps } from './hooks';
import { registerWebacyHookRoutes, type WebacyHookDeps } from './hooks.webacy';

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
    /** Previous encryption secret: reveal falls back to it; `apiKeysReencrypt` migrates rows off it. */
    apiKeyEncryptionSecretPrevious?: string;
    limitsRedis?: LimitsRedis;
    /** Vercel log-drain + Clerk webhook ingest (app-level auth, not bearer). */
    hooks?: HookDeps;
    /** Webacy DEPEG_TIER_CHANGE webhook receiver (HMAC auth, not bearer). Unregistered when absent. */
    webacyHooks?: WebacyHookDeps;
    /** Current shared bearer, or [current, previous] during a rotation. */
    authToken: string | readonly string[];
    /**
     * HMAC key for the signed `x-tokens-identity` token. When unset, signed
     * headers are rejected (never verified against an empty secret).
     */
    identitySigningSecret?: string;
    /** Previous signing secret, accepted alongside the current one during rotation. */
    identitySigningSecretPrevious?: string;
    /**
     * Transitional: also accept the legacy unsigned base64 identity header.
     * Must be false once every caller signs. See `decodeIdentityHeader`.
     */
    acceptUnsignedIdentity?: boolean;
}

type Handler = (args: unknown, identity: CallerIdentity | null) => Promise<unknown>;

/**
 * SECURITY: caller identity.
 *
 * Every RPC is gated by the shared bearer token (`authToken`). User-scoped
 * handlers additionally need to know *which* Clerk user the call acts as; that
 * arrives in the `x-tokens-identity` header as a signed token
 * (`@tokens/cloudrun-shutdown/identity`): HMAC-SHA256 over the claims plus the
 * RPC kind, function name, body hash, and a 60 s validity window, keyed by
 * `identitySigningSecret`. A leaked bearer token alone therefore cannot
 * impersonate a user; a leaked signing secret alone cannot call any RPC.
 *
 * Residual: an exact copy of a captured token replays against the same RPC
 * with the same body for up to 60 s. Queries are idempotent; `apiKeysReset`
 * would mint one extra key that the next reset revokes.
 *
 * `decodeIdentityHeader` is the LEGACY unsigned decoder (base64 JSON, no
 * integrity check). It is only consulted while `acceptUnsignedIdentity` is on
 * during the signed-token rollout and is removed afterwards.
 */
export { IDENTITY_HEADER };

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


export type IdentityRejectReason = IdentityVerifyFailure | 'unsigned' | 'signing_not_configured';

type ResolvedIdentity = { ok: true; identity: CallerIdentity | null } | { ok: false; reason: IdentityRejectReason };

function parseJsonBody(rawBody: string): unknown {
    if (!rawBody.trim()) return {};
    try {
        return JSON.parse(rawBody);
    } catch {
        return {};
    }
}

export function createApp(deps: ServerDeps) {
    const app = new Hono();

    /**
     * Absent header → anonymous (handlers that need identity throw
     * `identity_required`). Present header → must verify, regardless of
     * whether the target handler reads it (fail closed).
     */
    const resolveIdentity = async (
        raw: string | undefined,
        binding: { kind: 'query' | 'mutation'; fn: string; body: string },
    ): Promise<ResolvedIdentity> => {
        if (!raw) return { ok: true, identity: null };
        if (isSignedIdentityHeader(raw)) {
            if (!deps.identitySigningSecret) return { ok: false, reason: 'signing_not_configured' };
            let result = await verifyIdentityToken(raw, binding, deps.identitySigningSecret);
            if (!result.ok && result.reason === 'bad_signature' && deps.identitySigningSecretPrevious) {
                result = await verifyIdentityToken(raw, binding, deps.identitySigningSecretPrevious);
            }
            return result.ok ? { ok: true, identity: result.identity } : { ok: false, reason: result.reason };
        }
        if (!deps.acceptUnsignedIdentity) return { ok: false, reason: 'unsigned' };
        const legacy = decodeIdentityHeader(raw);
        return legacy ? { ok: true, identity: legacy } : { ok: false, reason: 'malformed' };
    };

    const dashDeps: dashboard.DashboardDeps = {
        repo: deps.dashboard,
        identity: deps.identity,
        ...(deps.apiKeyEncryptionSecret ? { apiKeyEncryptionSecret: deps.apiKeyEncryptionSecret } : {}),
        ...(deps.apiKeyEncryptionSecretPrevious
            ? { apiKeyEncryptionSecretPrevious: deps.apiKeyEncryptionSecretPrevious }
            : {}),
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
    mutations.limitsEnforce = args => {
        const redis = deps.limitsRedis;
        if (!redis) throw new Error('limitsEnforce: REDIS_HOST not configured');
        return limitsEnforce({ redis }, args);
    };
    mutations.ingestUsageAggregates = args => ingestUsageAggregates(deps.usageIngest, args);
    mutations.syncUsageAggregates = args => syncUsageAggregates(deps.usageIngest, args);
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
    // Ops: encryption-secret rotation (bearer-gated, explicit confirm). See
    // docs/security/secret-rotation.md.
    mutations.apiKeysReencrypt = args => dashboard.apiKeysReencrypt(dashDeps, args);

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
        // Read the body as text first: the identity token is bound to the exact
        // bytes the caller signed, so hashing a re-serialisation would not do.
        const rawBody = await c.req.text().catch(() => '');
        const resolved = await resolveIdentity(c.req.header(IDENTITY_HEADER), { kind, fn: name, body: rawBody });
        if (!resolved.ok) {
            console.warn('[cloudrun-usage] identity_invalid', { kind, name, reason: resolved.reason });
            return c.json({ error: 'identity_invalid', reason: resolved.reason }, 401);
        }
        const identity = resolved.identity;
        const args: unknown = parseJsonBody(rawBody);
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
    if (deps.webacyHooks) registerWebacyHookRoutes(app, deps.webacyHooks);

    return app;
}
