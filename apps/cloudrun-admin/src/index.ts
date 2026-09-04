import { registerGracefulShutdown, wrapFetchWithShutdownGuard } from '@tokens/cloudrun-shutdown';
import { parseAdminClerkUserIds, parseAdminEmails } from './adminAuth';
import { getSql, makePostgresAdminRepo } from './db';
import { makePostgresAdminMutationsRepo } from './db/curatedTokensMutations';
import { makePostgresAdminReadsRepo } from './db/curatedTokensReads';
import { makePostgresHardDeleteRepo } from './db/hardDelete';
import { makePostgresTokenListsAdminRepo } from './db/tokenListsAdmin';
import { makeGcsLogoSigner } from './gcs';
import { makeGoogleOidcVerifier } from './oidc';
import { createApp } from './server';

const authToken = process.env.TOKENS_CLOUDRUN_AUTH_TOKEN?.trim();
if (!authToken) {
    console.error('TOKENS_CLOUDRUN_AUTH_TOKEN must be set');
    process.exit(1);
}

const adminAllowlist = {
    clerkUserIds: parseAdminClerkUserIds(process.env.TOKENS_ADMIN_CLERK_USER_IDS),
    emails: parseAdminEmails(process.env.TOKENS_ADMIN_EMAILS),
};
if (adminAllowlist.clerkUserIds.size === 0 && adminAllowlist.emails.size === 0) {
    console.warn(
        'TOKENS_ADMIN_CLERK_USER_IDS and TOKENS_ADMIN_EMAILS are both empty — every admin endpoint will return 403',
    );
}

const gcsLogoBucket = process.env.GCS_LOGO_BUCKET?.trim();
if (!gcsLogoBucket) {
    console.warn('GCS_LOGO_BUCKET is not set — logo uploads will be unavailable');
}

// Accept WIF-minted Google ID tokens from the Vercel admin app on RPC routes
// (pinned to the invoker SA, and to this service's URL when provided).
const rpcInvokerSa = process.env.TOKENS_RPC_INVOKER_SA?.trim();
const rpcOidcAudience = process.env.TOKENS_RPC_OIDC_AUDIENCE?.trim();
const rpcVerifyOidc = rpcInvokerSa
    ? makeGoogleOidcVerifier({ invokerEmail: rpcInvokerSa, ...(rpcOidcAudience ? { audience: rpcOidcAudience } : {}) })
    : undefined;

const port = Number(process.env.PORT) || 8080;
const sql = getSql();
const app = createApp({
    repo: makePostgresAdminRepo(sql),
    reads: makePostgresAdminReadsRepo(sql),
    mutations: makePostgresAdminMutationsRepo(sql),
    hardDelete: makePostgresHardDeleteRepo(sql),
    tokenListsAdmin: makePostgresTokenListsAdminRepo(sql),
    ...(gcsLogoBucket
        ? { logoSigner: makeGcsLogoSigner(gcsLogoBucket, process.env.GCS_LOGO_PUBLIC_BASE_URL?.trim()) }
        : {}),
    adminAllowlist,
    authToken,
    ...(rpcVerifyOidc ? { rpcVerifyOidc } : {}),
    gcpLogs: {
        ...(process.env.LOKI_PUSH_URL?.trim() ? { lokiPushUrl: process.env.LOKI_PUSH_URL.trim() } : {}),
        ...(process.env.LOKI_PUSH_AUTH?.trim() ? { lokiPushAuth: process.env.LOKI_PUSH_AUTH.trim() } : {}),
        ...(process.env.GCP_LOGS_INVOKER_SA?.trim()
            ? { verifyGcpLogsOidc: makeGoogleOidcVerifier({ invokerEmail: process.env.GCP_LOGS_INVOKER_SA.trim() }) }
            : {}),
        envLabel: process.env.TOKENS_ENV?.trim() || 'prd',
    },
});

registerGracefulShutdown({ sql, serviceName: 'cloudrun-admin' });

export default { port, fetch: wrapFetchWithShutdownGuard(app.fetch) };
