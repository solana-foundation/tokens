import { registerGracefulShutdown, wrapFetchWithShutdownGuard } from '@tokens/cloudrun-shutdown';
import { getSql, makePostgresPlatformAuthRepo, makePostgresUsageIngestRepo } from './db';
import { makePostgresDashboardRepo, makePostgresIdentityRepo } from './db/dashboard';
import { makePostgresUsageDashboardRepo } from './db/usageDashboard';
import { createApp } from './server';

const authToken = process.env.TOKENS_CLOUDRUN_AUTH_TOKEN?.trim();
if (!authToken) {
    console.error('TOKENS_CLOUDRUN_AUTH_TOKEN must be set');
    process.exit(1);
}

const apiKeyEncryptionSecret = process.env.TOKENS_API_KEY_ENCRYPTION_SECRET?.trim();
if (!apiKeyEncryptionSecret) {
    console.warn('TOKENS_API_KEY_ENCRYPTION_SECRET is not set — API key reset/reveal will be unavailable');
}

const port = Number(process.env.PORT) || 8080;
const sql = getSql();
const app = createApp({
    platformAuth: makePostgresPlatformAuthRepo(sql),
    usageIngest: makePostgresUsageIngestRepo(sql),
    dashboard: makePostgresDashboardRepo(sql),
    usageDashboard: makePostgresUsageDashboardRepo(sql),
    identity: makePostgresIdentityRepo(sql),
    ...(apiKeyEncryptionSecret ? { apiKeyEncryptionSecret } : {}),
    hooks: {
        ...(process.env.LOKI_PUSH_URL?.trim() ? { lokiPushUrl: process.env.LOKI_PUSH_URL.trim() } : {}),
        ...(process.env.LOKI_PUSH_AUTH?.trim() ? { lokiPushAuth: process.env.LOKI_PUSH_AUTH.trim() } : {}),
        ...(process.env.VERCEL_DRAIN_SECRET?.trim()
            ? { vercelDrainSecret: process.env.VERCEL_DRAIN_SECRET.trim() }
            : {}),
        ...(process.env.VERCEL_VERIFY_TOKEN?.trim()
            ? { vercelVerifyToken: process.env.VERCEL_VERIFY_TOKEN.trim() }
            : {}),
        ...(process.env.CLERK_WEBHOOK_SECRET?.trim()
            ? { clerkWebhookSecret: process.env.CLERK_WEBHOOK_SECRET.trim() }
            : {}),
        ...(process.env.TOKENS_ENV?.trim() ? { envLabel: process.env.TOKENS_ENV.trim() } : {}),
    },
    // Webacy depeg webhooks: verified + deduped here, then forwarded to the
    // assets jobs worker (see hooks.webacy.ts). Both values are deploy-time env;
    // the route still mounts without them so misconfiguration surfaces as
    // 500 / forward_failed instead of a 404 that Webacy would silently retry.
    webacyHooks: {
        sql,
        webhookSecret: process.env.WEBACY_WEBHOOK_SECRET?.trim() || undefined,
        assetsJobsUrl: process.env.TOKENS_CLOUDRUN_ASSETS_JOBS_URL?.trim() || undefined,
    },
    authToken,
});

registerGracefulShutdown({ sql, serviceName: 'cloudrun-usage' });

export default { port, fetch: wrapFetchWithShutdownGuard(app.fetch) };
