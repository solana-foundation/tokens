import { Hono, type Context } from 'hono';
import { isValidBearerToken } from '@tokens/cloudrun-shutdown';

import type { AdminAllowlist } from './adminAuth';
import { parseBearer, type VerifyOidc } from './oidc';
import { registerGcpLogsRoute, type GcpLogsHookDeps } from './hooks';

import * as curatedTokens from './handlers/curatedTokens';
import type { AdminRepo } from './handlers/curatedTokens';
import * as mutationsHandlers from './handlers/curatedTokensMutations';
import type { AdminMutationsRepo } from './handlers/curatedTokensMutations';
import * as reads from './handlers/curatedTokensReads';
import type { AdminReadsRepo } from './handlers/curatedTokensReads';
import { dispatchErrorResponse } from '@tokens/cloudrun-shutdown/http-errors';
import * as hardDeleteHandlers from './handlers/hardDelete';
import type { HardDeleteRepo } from './handlers/hardDelete';
import * as tokenListsAdminHandlers from './handlers/tokenListsAdmin';
import type { TokenListsAdminRepo } from './handlers/tokenListsAdmin';
import * as logoUploadsHandlers from './handlers/logoUploads';
import type { LogoUploadSigner } from './handlers/logoUploads';

/** Clerk-session-verified caller forwarded by the Next.js proxy. */
export interface CallerIdentity {
    clerkUserId: string;
    projectId?: string;
    email?: string;
}

export interface ServerDeps {
    gcpLogs?: GcpLogsHookDeps;
    repo: AdminRepo;
    reads: AdminReadsRepo;
    mutations: AdminMutationsRepo;
    hardDelete: HardDeleteRepo;
    tokenListsAdmin: TokenListsAdminRepo;
    /** GCS signed-PUT signer for logo uploads; absent → uploads unavailable. */
    logoSigner?: LogoUploadSigner;
    /** Admin allowlist (TOKENS_ADMIN_CLERK_USER_IDS ∪ TOKENS_ADMIN_EMAILS). */
    adminAllowlist: AdminAllowlist;
    authToken: string;
    /**
     * When set, RPC routes also accept a Google OIDC ID token (audience/SA
     * pinned) as the bearer — the Vercel admin app's WIF-minted token. The
     * shared authToken stays accepted for local dev.
     */
    rpcVerifyOidc?: VerifyOidc;
}

export async function isAuthorizedRpcCaller(
    authHeader: string | undefined,
    deps: Pick<ServerDeps, 'authToken' | 'rpcVerifyOidc'>,
): Promise<boolean> {
    if (isValidBearerToken(authHeader, deps.authToken)) return true;
    if (!deps.rpcVerifyOidc) return false;
    const token = parseBearer(authHeader);
    if (!token) return false;
    try {
        await deps.rpcVerifyOidc(token);
        return true;
    } catch {
        return false;
    }
}

type Handler = (args: unknown, identity: CallerIdentity | null) => Promise<unknown>;

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

    const categoriesDeps: curatedTokens.CuratedTokensDeps = {
        repo: deps.repo,
        adminAllowlist: deps.adminAllowlist,
    };
    const readsDeps: reads.AdminReadsDeps = {
        repo: deps.reads,
        adminAllowlist: deps.adminAllowlist,
    };
    const mutationsDeps: mutationsHandlers.AdminMutationsDeps = {
        repo: deps.mutations,
        adminAllowlist: deps.adminAllowlist,
    };
    const hardDeleteDeps: hardDeleteHandlers.HardDeleteDeps = {
        repo: deps.hardDelete,
        adminAllowlist: deps.adminAllowlist,
    };
    const tokenListsAdminDeps: tokenListsAdminHandlers.TokenListsAdminDeps = {
        repo: deps.tokenListsAdmin,
        adminAllowlist: deps.adminAllowlist,
        now: () => Date.now(),
    };

    // Every handler (queries and mutations alike) calls requireAdmin(identity)
    // first — defense in depth on top of the Next.js proxy's own admin check.
    const queries: Record<string, Handler> = Object.create(null);
    queries.listCategories = (args, identity) => curatedTokens.listCategories(categoriesDeps, args, identity);
    queries.listCanonicalAssets = (args, identity) => reads.listCanonicalAssets(readsDeps, args, identity);
    queries.listVariantsByAssetIds = (args, identity) => reads.listVariantsByAssetIds(readsDeps, args, identity);
    queries.getCanonicalEditor = (args, identity) => reads.getCanonicalEditor(readsDeps, args, identity);
    queries.getVariantEditor = (args, identity) => reads.getVariantEditor(readsDeps, args, identity);
    queries.searchCanonicalAssets = (args, identity) => reads.searchCanonicalAssets(readsDeps, args, identity);
    queries.previewMint = (args, identity) => reads.previewMint(readsDeps, args, identity);
    queries.adminListTokenLists = (args, identity) =>
        tokenListsAdminHandlers.adminListTokenLists(tokenListsAdminDeps, args, identity);

    const mutations: Record<string, Handler> = Object.create(null);
    mutations.createCanonicalAsset = (args, identity) =>
        mutationsHandlers.createCanonicalAsset(mutationsDeps, args, identity);
    mutations.updateCanonicalAsset = (args, identity) =>
        mutationsHandlers.updateCanonicalAsset(mutationsDeps, args, identity);
    mutations.deleteCanonicalAsset = (args, identity) =>
        mutationsHandlers.deleteCanonicalAsset(mutationsDeps, args, identity);
    mutations.createVariant = (args, identity) => mutationsHandlers.createVariant(mutationsDeps, args, identity);
    mutations.updateVariant = (args, identity) => mutationsHandlers.updateVariant(mutationsDeps, args, identity);
    mutations.deleteVariant = (args, identity) => mutationsHandlers.deleteVariant(mutationsDeps, args, identity);
    mutations.deactivateVariant = (args, identity) =>
        mutationsHandlers.deactivateVariant(mutationsDeps, args, identity);
    mutations.moveVariantToCanonical = (args, identity) =>
        mutationsHandlers.moveVariantToCanonical(mutationsDeps, args, identity);
    mutations.removeFromCategory = (args, identity) =>
        mutationsHandlers.removeFromCategory(mutationsDeps, args, identity);
    mutations.hardDeleteAsset = (args, identity) => hardDeleteHandlers.hardDeleteAsset(hardDeleteDeps, args, identity);
    mutations.adminArchiveTokenList = (args, identity) =>
        tokenListsAdminHandlers.adminArchiveTokenList(tokenListsAdminDeps, args, identity);
    const logoUploadsDeps: logoUploadsHandlers.LogoUploadsDeps = {
        ...(deps.logoSigner ? { signer: deps.logoSigner } : {}),
        adminAllowlist: deps.adminAllowlist,
    };
    mutations.generateCanonicalLogoUploadUrl = (args, identity) =>
        logoUploadsHandlers.generateCanonicalLogoUploadUrl(logoUploadsDeps, args, identity);

    app.get('/health', c => c.json({ ok: true }));
    registerGcpLogsRoute(app, deps.gcpLogs ?? {});

    const dispatch = (registry: Record<string, Handler>, kind: 'query' | 'mutation') => async (c: Context) => {
        if (!(await isAuthorizedRpcCaller(c.req.header('authorization'), deps))) {
            return c.json({ error: 'unauthorized' }, 401);
        }
        const name = c.req.param('name') ?? '';
        if (!Object.hasOwn(registry, name)) {
            return c.json({ error: `unknown ${kind}: ${name}` }, 404);
        }
        const handler = registry[name]!;
        const identity = decodeIdentityHeader(c.req.header(IDENTITY_HEADER));
        const body = await c.req.text();
        let args: unknown = {};
        if (body.length > 0) {
            try {
                args = JSON.parse(body);
            } catch {
                return c.json({ error: 'invalid_json' }, 400);
            }
        }
        try {
            return c.json(await handler(args, identity));
        } catch (err) {
            const { body: errBody, status } = dispatchErrorResponse('cloudrun-admin', err, kind, name);
            return c.json(errBody, status);
        }
    };

    app.post('/query/:name', dispatch(queries, 'query'));
    app.post('/mutation/:name', dispatch(mutations, 'mutation'));

    return app;
}
