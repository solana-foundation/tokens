/**
 * Run one v2 multichain worker job in-process against the local database.
 *
 *   bun run dev:run-worker-job sync-v2-solana-variants
 *   bun run dev:run-worker-job sync-v2-evm-variants '{"dryRun":true}'
 *   bun run dev:run-worker-job refresh-v2-evm-variant-markets '{"maxVariants":50}'
 *
 * The deployed `/jobs/*` route needs a Google OIDC token, so local verification
 * imports the handler directly. Reads DATABASE_URL from
 * apps/cloudrun-assets/.env.local and BIRDEYE_API_KEY (+ BIRDEYE_ORIGIN) from
 * apps/cloudrun-assets/.env.local or apps/api/.env.local.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';

import { birdeyeChains, type ChainKind } from '@tokens/asset-registry/chains';

import { makeBirdeyeClient } from '../apps/cloudrun-assets/src/clients';
import { makePostgresV2AssetsJobsRepo } from '../apps/cloudrun-assets/src/db/v2Assets';
import type { BirdeyeClient } from '../apps/cloudrun-assets/src/handlers/crons';
import { v2AssetsJobs } from '../apps/cloudrun-assets/src/handlers/crons.v2Assets';

function loadEnvFile(path: string): Record<string, string> {
    try {
        const out: Record<string, string> = {};
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
            if (!match) continue;
            const key = match[1]!;
            let value = match[2]!;
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            out[key] = value;
        }
        return out;
    } catch {
        return {};
    }
}

const root = resolve(import.meta.dir, '..');
const env = {
    ...loadEnvFile(resolve(root, 'apps/api/.env.local')),
    ...loadEnvFile(resolve(root, 'apps/cloudrun-assets/.env.local')),
    ...process.env,
};

const [jobName, rawArgs] = process.argv.slice(2);
if (!jobName || !(jobName in v2AssetsJobs)) {
    console.error(
        `usage: bun scripts/dev-run-worker-job.ts <job> ['<json args>']\njobs: ${Object.keys(v2AssetsJobs).join(', ')}`,
    );
    process.exit(2);
}
const args: unknown = rawArgs ? JSON.parse(rawArgs) : {};

const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) {
    console.error('DATABASE_URL is not set (apps/cloudrun-assets/.env.local)');
    process.exit(2);
}
const sql = postgres(databaseUrl, { max: 4 });

const birdeyeApiKey = env.BIRDEYE_API_KEY?.trim();
const birdeyeByChain: Partial<Record<ChainKind, BirdeyeClient>> = birdeyeApiKey
    ? Object.fromEntries(
          birdeyeChains().map(chain => [
              chain,
              makeBirdeyeClient({
                  apiKey: birdeyeApiKey,
                  chain,
                  ...(env.BIRDEYE_ORIGIN ? { origin: env.BIRDEYE_ORIGIN } : {}),
              }),
          ]),
      )
    : {};
if (!birdeyeApiKey) console.warn('BIRDEYE_API_KEY not set: market refresh will report noClient for every chain');

const handler = v2AssetsJobs[jobName]!;
const startedAt = Date.now();
try {
    const result = await handler(
        { repo: makePostgresV2AssetsJobsRepo(sql), birdeyeByChain, now: () => Date.now() },
        args,
    );
    console.log(JSON.stringify({ job: jobName, result, wallMs: Date.now() - startedAt }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
} finally {
    await sql.end({ timeout: 5 });
}
