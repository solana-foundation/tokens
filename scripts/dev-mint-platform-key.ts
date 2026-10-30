/**
 * Mint a local platform API key (scope `assets:read`) so apps/web can talk to
 * a local apps/api through its keyed proxy (`TOKENS_PLATFORM_API_KEY`).
 *
 *   bun scripts/dev-mint-platform-key.ts            # prints the raw key once
 *   bun scripts/dev-mint-platform-key.ts --allow-remote
 *
 * Localhost-only by default: refuses a DATABASE_URL that is not 127.0.0.1 /
 * localhost. Inserts a dev user + project + api_keys row (sha256 of the raw
 * key, which is what apps/api's platform auth looks up via cloudrun-usage).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';

function loadEnvFile(path: string): Record<string, string> {
    try {
        const out: Record<string, string> = {};
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
            if (!match) continue;
            let value = match[2]!;
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            out[match[1]!] = value;
        }
        return out;
    } catch {
        return {};
    }
}

const root = resolve(import.meta.dir, '..');
const env = { ...loadEnvFile(resolve(root, 'apps/cloudrun-assets/.env.local')), ...process.env };
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) {
    console.error('DATABASE_URL is not set (apps/cloudrun-assets/.env.local)');
    process.exit(2);
}
const host = new URL(databaseUrl).hostname;
if (!process.argv.includes('--allow-remote') && host !== 'localhost' && host !== '127.0.0.1') {
    console.error(`refusing non-local database host ${host} (pass --allow-remote to override)`);
    process.exit(2);
}

const clerkUserId = 'user_local_dev';
const projectId = 'proj_local_dev';
const rawKey = `tk_local_${randomBytes(24).toString('hex')}`;
const keyHash = createHash('sha256').update(rawKey).digest('hex');

const sql = postgres(databaseUrl, { max: 1 });
try {
    await sql`
        INSERT INTO users (id, clerk_user_id, primary_email, full_name)
        VALUES (${clerkUserId}, ${clerkUserId}, 'dev@localhost', 'Local Dev')
        ON CONFLICT DO NOTHING
    `;
    await sql`
        INSERT INTO projects (id, name, tier, created_by_clerk_user_id, personal_clerk_user_id)
        VALUES (${projectId}, 'local-dev', 'free', ${clerkUserId}, ${clerkUserId})
        ON CONFLICT DO NOTHING
    `;
    await sql`
        INSERT INTO api_keys (id, owner_clerk_user_id, project_id, name, key_prefix, key_hash, scopes, created_by_clerk_user_id)
        VALUES (${`key_local_dev_${Date.now()}`}, ${clerkUserId}, ${projectId}, 'local-dev', ${rawKey.slice(0, 8)}, ${keyHash},
                ${sql.json(['assets:read'])}, ${clerkUserId})
    `;
    console.log(`TOKENS_PLATFORM_API_KEY=${rawKey}`);
    console.log('(stored as sha256 in api_keys; this is the only time the raw key is shown)');
} finally {
    await sql.end({ timeout: 5 });
}
