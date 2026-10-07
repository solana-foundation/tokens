import { bearerTokenCandidates, registerGracefulShutdown, wrapFetchWithShutdownGuard } from '@tokens/cloudrun-shutdown';
import { getSql, makePostgresPlatformAuthRepo, makePostgresUsageIngestRepo } from './db';
import { makePostgresDashboardRepo, makePostgresIdentityRepo } from './db/dashboard';
import { makePostgresUsageDashboardRepo } from './db/usageDashboard';
import { makeLimitsRedis } from './redis';
import { createApp } from './server';

const authToken = process.env.TOKENS_CLOUDRUN_AUTH_TOKEN?.trim();
if (!authToken) {
    console.error('TOKENS_CLOUDRUN_AUTH_TOKEN must be set');
    process.exit(1);
}

// Signed x-tokens-identity verification. Mode table (secret = signing secret,
// flag = TOKENS_IDENTITY_ACCEPT_UNSIGNED):
//   secret set,   flag off → signed only (target state)
//   secret set,   flag on  → signed + legacy (rollout window)
//   secret unset, flag on  → legacy only (pre-rollout)
//   secret unset, flag off → misconfigured; refuse to start so the previous
//                            revision keeps serving.
const identitySigningSecret = process.env.TOKENS_IDENTITY_SIGNING_SECRET?.trim();
const identitySigningSecretPrevious = process.env.TOKENS_IDENTITY_SIGNING_SECRET_PREVIOUS?.trim();
const acceptUnsignedIdentity = process.env.TOKENS_IDENTITY_ACCEPT_UNSIGNED?.trim() === 'true';
if (!identitySigningSecret && !acceptUnsignedIdentity) {
    console.error(
        'TOKENS_IDENTITY_SIGNING_SECRET must be set (or TOKENS_IDENTITY_ACCEPT_UNSIGNED=true during rollout)',
    );
    process.exit(1);
}
if (!identitySigningSecret) {
    console.warn('TOKENS_IDENTITY_SIGNING_SECRET is not set — accepting legacy unsigned identity headers only');
} else if (acceptUnsignedIdentity) {
    console.warn('TOKENS_IDENTITY_ACCEPT_UNSIGNED=true — legacy unsigned identity headers are still accepted');
}

const apiKeyEncryptionSecret = process.env.TOKENS_API_KEY_ENCRYPTION_SECRET?.trim();
const apiKeyEncryptionSecretPrevious = process.env.TOKENS_API_KEY_ENCRYPTION_SECRET_PREVIOUS?.trim();
if (!apiKeyEncryptionSecret) {
    console.warn('TOKENS_API_KEY_ENCRYPTION_SECRET is not set — API key reset/reveal will be unavailable');
}
if (apiKeyEncryptionSecretPrevious || identitySigningSecretPrevious || process.env.TOKENS_CLOUDRUN_AUTH_TOKEN_PREVIOUS?.trim()) {
    console.warn('secret rotation in progress — *_PREVIOUS values are accepted; remove them once the rotation completes');
}

const port = Number(process.env.PORT) || 8080;
const sql = getSql();
const redisHost = process.env.REDIS_HOST?.trim();
const redisPort = Number(process.env.REDIS_PORT?.trim() || 6379);
if (!redisHost) {
    console.warn('REDIS_HOST is not set — limitsEnforce will be unavailable (API falls open)');
}
const app = createApp({
    platformAuth: makePostgresPlatformAuthRepo(sql),
    usageIngest: makePostgresUsageIngestRepo(sql),
    dashboard: makePostgresDashboardRepo(sql),
    usageDashboard: makePostgresUsageDashboardRepo(sql),
    identity: makePostgresIdentityRepo(sql),
    ...(apiKeyEncryptionSecret ? { apiKeyEncryptionSecret } : {}),
    ...(apiKeyEncryptionSecretPrevious ? { apiKeyEncryptionSecretPrevious } : {}),
    ...(redisHost ? { limitsRedis: makeLimitsRedis({ host: redisHost, port: redisPort }) } : {}),
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
    authToken: bearerTokenCandidates(authToken, process.env.TOKENS_CLOUDRUN_AUTH_TOKEN_PREVIOUS),
    ...(identitySigningSecret ? { identitySigningSecret } : {}),
    ...(identitySigningSecretPrevious ? { identitySigningSecretPrevious } : {}),
    ...(acceptUnsignedIdentity ? { acceptUnsignedIdentity } : {}),
});

registerGracefulShutdown({ sql, serviceName: 'cloudrun-usage' });

export default { port, fetch: wrapFetchWithShutdownGuard(app.fetch) };
