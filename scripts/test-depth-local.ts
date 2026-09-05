/* eslint-disable no-console */

/**
 * Local end-to-end test for the depth-sampling pipeline (no Cloud Run, no OIDC).
 *
 * Wires the real Titan quote client to the real cron handler against your local
 * Postgres, then reads the curves back the way the API does.
 *
 * Setup — add to apps/cloudrun-assets/.env.local:
 *   JUPITER_API_KEY=<key>                            # source=jupiter (default)
 *   TITAN_WS_URL=wss://<endpoint>/...  TITAN_API_KEY=<jwt>   # source=titan
 *
 * Usage (from repo root):
 *   bun scripts/test-depth-local.ts probe             # one quote, no writes
 *   bun scripts/test-depth-local.ts run               # sample 8 BTC mints, write curves
 *   bun scripts/test-depth-local.ts read              # stored curves + interpolated impact
 *
 * Add --source=titan to any mode to use Titan instead of Jupiter.
 * Target mints with --asset=<assetId> or --mints=<mint,mint> (default: bitcoin).
 */

import postgres from 'postgres';

import { getAsset, getVariantByMint } from '../packages/asset-registry/src/index';
import { BITCOIN_VARIANT_GROUP } from '../packages/asset-registry/src/data/token-variants';
import { interpolateImpactBps } from '../packages/asset-registry/src/primary-variant-ranking';
import { makeJupiterQuoteClient, makeTitanQuoteClient } from '../apps/cloudrun-assets/src/clients';
import {
    DEPTH_SIZE_LADDER_USD,
    DEPTH_USDC_QUOTE_MINT,
    listDepthUniverseMints,
    refreshDepthCurves,
    type DepthQuoteClient,
    type DepthQuoteSourceId,
} from '../apps/cloudrun-assets/src/handlers/crons.depth';
import { makePostgresDepthCurvesRepo, makePostgresDepthCurveReadsRepo } from '../apps/cloudrun-assets/src/db';

function loadEnvLocal(path: string): Record<string, string> {
    const out: Record<string, string> = {};
    let text = '';
    try {
        text = require('fs').readFileSync(path, 'utf8');
    } catch {
        return out;
    }
    for (const line of text.split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
    }
    return out;
}

const env = { ...loadEnvLocal('apps/cloudrun-assets/.env.local'), ...process.env } as Record<string, string>;
const args = process.argv.slice(2);
const mode = args.find(a => !a.startsWith('--')) ?? 'probe';
const sourceArg = (args.find(a => a.startsWith('--source='))?.split('=')[1] ?? 'jupiter') as DepthQuoteSourceId | 'titan';
const source: DepthQuoteSourceId = sourceArg === 'titan' ? 'titan' : 'jupiter_lite';

const titanWsUrl = (env.TITAN_WS_URL ?? '').trim();
const titanApiKey = (env.TITAN_API_KEY ?? '').trim();
const jupiterApiKey = (env.JUPITER_API_KEY ?? '').trim();
const databaseUrl = (env.DATABASE_URL ?? '').trim();

if (!databaseUrl) {
    console.error('DATABASE_URL missing (expected in apps/cloudrun-assets/.env.local)');
    process.exit(1);
}

function makeClient(): DepthQuoteClient {
    if (source === 'titan') {
        if (!titanWsUrl || !titanApiKey) {
            console.error(
                'source=titan needs TITAN_WS_URL and TITAN_API_KEY in apps/cloudrun-assets/.env.local\n' +
                    `  TITAN_WS_URL: ${titanWsUrl ? 'set' : 'MISSING'}\n  TITAN_API_KEY: ${titanApiKey ? 'set' : 'MISSING'}`,
            );
            process.exit(1);
        }
        return makeTitanQuoteClient({ wsUrl: titanWsUrl, authToken: titanApiKey });
    }
    // Jupiter: keyless lite tier works, JUPITER_API_KEY upgrades to api.jup.ag.
    return makeJupiterQuoteClient(jupiterApiKey ? { apiKey: jupiterApiKey } : {});
}

const sql = postgres(databaseUrl, { max: 4 });

/** Mints to sample: --mints=<csv> wins, then --asset=<assetId>, else bitcoin. */
function targetMints(): string[] {
    const explicit = args.find(a => a.startsWith('--mints='))?.split('=')[1];
    if (explicit) return explicit.split(',').map(m => m.trim()).filter(Boolean);

    const assetId = args.find(a => a.startsWith('--asset='))?.split('=')[1];
    if (assetId) {
        const asset = getAsset(assetId);
        if (!asset) {
            console.error(`unknown assetId: ${assetId}`);
            process.exit(1);
        }
        return asset.variants.map(v => v.mint);
    }
    return BITCOIN_VARIANT_GROUP.addresses.map(a => a.address);
}

const MINTS = targetMints();

function label(mint: string): string {
    const match = getVariantByMint(mint);
    if (!match) return `${mint.slice(0, 6)}… (not in registry)`;
    const sym = match.variant.symbol ?? match.asset.symbol ?? '?';
    return `${sym} (${match.asset.assetId}/${match.variant.kind})`;
}

async function probe() {
    console.log(`source: ${source}${source === 'jupiter_lite' ? (jupiterApiKey ? ' (pro key)' : ' (keyless lite)') : ''}`);
    const client = makeClient();
    try {
        const started = performance.now();
        const quote = await client.fetchQuote({
            inputMint: DEPTH_USDC_QUOTE_MINT,
            outputMint: MINTS[0]!,
            amount: 10_000 * 1_000_000, // $10k
        });
        const ms = Math.round(performance.now() - started);
        if (!quote) {
            console.log(`no route returned (${ms}ms) — pair untradable or endpoint rejected the request`);
            return;
        }
        console.log(`OK in ${ms}ms: in=${quote.inAmount} out=${quote.outAmount}`);
        console.log(`  implied price: ${(quote.inAmount / 1e6 / (quote.outAmount / 1e8)).toFixed(2)} USDC/BTC`);
        console.log('First-quote latency matters for cron pacing — note this number.');
    } finally {
        await client.close();
    }
}

async function run() {
    const delayMs = Number(args.find(a => a.startsWith('--delayMs='))?.split('=')[1] ?? 1200);
    console.log(`source: ${source}, delayMs: ${delayMs}`);
    const universe = listDepthUniverseMints();
    console.log(`universe: ${universe.length} mints total; sampling ${MINTS.length}:`);
    for (const m of MINTS) console.log(`  - ${label(m)}  ${m}`);
    console.log(`ladder: ${DEPTH_SIZE_LADDER_USD.map(s => `$${(s / 1000).toLocaleString()}k`).join(', ')}`);

    const client = makeClient();
    const result = await refreshDepthCurves(
        {
            quoteSource: client,
            repo: makePostgresDepthCurvesRepo(sql),
            now: () => Date.now(),
            env: () => ({ DEPTH_REFRESH_ENABLED: 'true' }) as NodeJS.ProcessEnv,
        },
        { mints: MINTS, delayMs, requireRefreshEnabled: false },
    );
    console.log('\ncron result:', JSON.stringify(result, null, 2));
}

async function read() {
    const entries = await makePostgresDepthCurveReadsRepo(sql).findLatestByMints({
        mints: MINTS,
        quoteMint: DEPTH_USDC_QUOTE_MINT,
        side: 'buy',
        source,
    });
    if (entries.length === 0) {
        console.log('no curves stored yet — run: bun scripts/test-depth-local.ts run');
        return;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const row of entries) {
        const ladder = (row.ladder as Array<{ sizeUsd: number; priceImpactBps: number | null }>) ?? [];
        const ageMin = Math.round((nowSeconds - Number(row.as_of)) / 60);
        console.log(`\n${label(row.mint)}  ${row.mint}\n  (age ${ageMin}m, points=${row.points}, failed=${row.failed_points})`);
        for (const rung of ladder) {
            console.log(`  $${(rung.sizeUsd / 1000).toLocaleString()}k -> ${rung.priceImpactBps ?? 'null'} bps`);
        }
        for (const size of [50_000, 1_000_000, 20_000_000]) {
            const interp = interpolateImpactBps(ladder, size);
            console.log(
                `  interp @$${(size / 1000).toLocaleString()}k: ` +
                    (interp ? `${interp.impactBps} bps${interp.extrapolated ? ' (extrapolated)' : ''}` : 'null'),
            );
        }
    }
}

try {
    if (mode === 'probe') await probe();
    else if (mode === 'run') await run();
    else if (mode === 'read') await read();
    else {
        console.error(`unknown mode: ${mode} (use probe | run | read)`);
        process.exit(1);
    }
} finally {
    await sql.end({ timeout: 5 });
}
