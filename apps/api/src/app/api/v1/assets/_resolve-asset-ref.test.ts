import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import { __setAssetIdRenamesForTests, __setAssetIdRenamesLoaderForTests } from '@/lib/asset-id-renames';
import { __resetCloudRunClientForTesting } from '@/lib/cloudrun/client';
import { resetEnvForTests } from '@/lib/env';

import { __resetRegisteredOnlyForTests } from './_registered-only';
import { resolveAssetRefContext } from './_resolve-asset-ref';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TESLA_XSTOCK_MINT = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const UNKNOWN_MINT = '11111111111111111111111111111111';
const LAUNCH_COIN = '4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8';
const LEGACY_MINT_ID = 'LEGACY11111111111111111111111111111111111111';

/**
 * Cloud Run stubbed at the fetch layer. `mode` picks the DB's answer for the
 * variant lookup: a miss (default), a legacy asset whose id is the raw mint,
 * or an outage (500) to exercise the fail-open path.
 */
type StubMode = 'miss' | 'legacy-mint-id' | 'outage' | 'sanctum-outage';
let stubMode: StubMode = 'miss';
let approvedLaunchMints: string[] = [];
let launchStatus = 200;
let calls: string[] = [];
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_ERROR = console.error;
const ENV_KEYS = [
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_DELETED_REFS_MEMO',
    'TOKENS_V1_REGISTERED_ONLY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    process.env.TOKENS_CLOUDRUN_AUTH_TOKEN = 'tok';
    process.env.TOKENS_CLOUDRUN_ASSETS_URL = 'https://assets.example.run.app';
    process.env.TOKENS_CLOUDRUN_PRICES_URL = 'https://prices.example.run.app';
    process.env.TOKENS_CLOUDRUN_USAGE_URL = 'https://usage.example.run.app';
    process.env.TOKENS_DELETED_REFS_MEMO = 'off';
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    __resetRegisteredOnlyForTests();
    stubMode = 'miss';
    approvedLaunchMints = [];
    launchStatus = 200;
    calls = [];
    console.log = () => undefined;
    console.error = () => undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const name = /\/query\/([A-Za-z]+)$/.exec(String(input))?.[1] ?? '';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push(name);
        switch (name) {
            case 'listDeletedRefs':
            case 'listAssetIdRenames':
                return json([]);
            case 'assetVariantsGetByMint':
                if (stubMode === 'outage') return json({ error: 'db down' }, 500);
                if (stubMode === 'legacy-mint-id' && body.mint === LEGACY_MINT_ID) {
                    return json({
                        assetId: LEGACY_MINT_ID,
                        chain: 'solana',
                        mint: LEGACY_MINT_ID,
                        variantId: `${LEGACY_MINT_ID}:mint`,
                        kind: 'native',
                        trustTier: 'tier3',
                        tags: [],
                        isActive: true,
                    });
                }
                return json(null);
            case 'sanctumResolveRef':
                if (stubMode === 'sanctum-outage') return json({ error: 'sanctum down' }, 500);
                return json(null);
            case 'launchpadApprovedMints':
                if (launchStatus !== 200) return json({ error: 'unknown query' }, launchStatus);
                return json({ mints: (body.mints as string[]).filter(m => approvedLaunchMints.includes(m)) });
            default:
                throw new Error(`unexpected cloud run call: ${name}`);
        }
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.log = ORIGINAL_LOG;
    console.error = ORIGINAL_ERROR;
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    __resetRegisteredOnlyForTests();
});

/** Runs the resolver once and returns its failure (the test fails if it succeeded). */
async function failure(ref: string) {
    return await Effect.runPromise(Effect.flip(resolveAssetRefContext(ref)));
}

describe('resolveAssetRefContext', () => {
    it('resolves singleton-style USDC mint refs to the USD asset group', async () => {
        const result = await Effect.runPromise(resolveAssetRefContext(`solana-${USDC_MINT}`));

        expect(result.assetId).toBe('usd');
        expect(result.ref).toBe(`solana-${USDC_MINT}`);
        expect(result.resolvedBy).toBe('singletonMint');
        expect(result.mint).toBe(USDC_MINT);
    });

    it('resolves tokenized equity mints to their equity asset group', async () => {
        const result = await Effect.runPromise(resolveAssetRefContext(TESLA_XSTOCK_MINT));

        expect(result.assetId).toBe('tesla');
        expect(result.resolvedBy).toBe('mint');
        expect(result.mint).toBe(TESLA_XSTOCK_MINT);
    });

    it('rejects an unregistered mint with 404 asset_not_registered after walking every tier', async () => {
        const error = (await failure(UNKNOWN_MINT)) as {
            _tag: string;
            message: string;
            details?: Record<string, unknown>;
        };
        expect(error._tag).toBe('NotFoundError');
        expect(error.message).toBe('Asset not registered');
        expect(error.details?.code).toBe('asset_not_registered');
        expect(error.details?.mint).toBe(UNKNOWN_MINT);
        expect(String(error.details?.hint)).toContain('/v2/lists');
        expect(calls).toEqual([
            'listDeletedRefs',
            'assetVariantsGetByMint',
            'sanctumResolveRef',
            'launchpadApprovedMints',
        ]);
    });

    it('rejects an unregistered solana-<mint> ref the same way', async () => {
        const error = (await failure(`solana-${UNKNOWN_MINT}`)) as { details?: Record<string, unknown> };
        expect(error.details?.code).toBe('asset_not_registered');
    });

    it('TOKENS_V1_REGISTERED_ONLY=off keeps unknown mints as deterministic singleton assets', async () => {
        process.env.TOKENS_V1_REGISTERED_ONLY = 'off';
        const result = await Effect.runPromise(resolveAssetRefContext(UNKNOWN_MINT));

        expect(result.assetId).toBe(`solana-${UNKNOWN_MINT}`);
        expect(result.resolvedBy).toBe('singleton');
        expect(result.mint).toBe(UNKNOWN_MINT);
    });

    it('an admin-approved launch coin resolves to its per-mint page, and 404s once revoked', async () => {
        approvedLaunchMints = [LAUNCH_COIN];
        const approved = await Effect.runPromise(resolveAssetRefContext(LAUNCH_COIN));
        expect(approved.assetId).toBe(`solana-${LAUNCH_COIN}`);
        expect(approved.resolvedBy).toBe('singleton');

        approvedLaunchMints = [];
        const error = (await failure(LAUNCH_COIN)) as { details?: Record<string, unknown> };
        expect(error.details?.code).toBe('asset_not_registered');
    });

    it('a registered asset whose id is a raw mint stays a per-mint singleton', async () => {
        stubMode = 'legacy-mint-id';
        const result = await Effect.runPromise(resolveAssetRefContext(LEGACY_MINT_ID));
        expect(result.assetId).toBe(`solana-${LEGACY_MINT_ID}`);
        expect(result.resolvedBy).toBe('singleton');
        expect(calls).toEqual(['listDeletedRefs', 'assetVariantsGetByMint']);
    });

    it('fails open to the singleton when the Sanctum lookup errors (an LST may be registered only there)', async () => {
        stubMode = 'sanctum-outage';
        const result = await Effect.runPromise(resolveAssetRefContext(UNKNOWN_MINT));
        expect(result.assetId).toBe(`solana-${UNKNOWN_MINT}`);
        expect(result.resolvedBy).toBe('singleton');
    });

    it('fails open to the singleton when the variant lookup itself errors', async () => {
        stubMode = 'outage';
        const result = await Effect.runPromise(resolveAssetRefContext(UNKNOWN_MINT));
        expect(result.assetId).toBe(`solana-${UNKNOWN_MINT}`);
        expect(result.resolvedBy).toBe('singleton');
    });

    it('an older assets service without the launch tier (404) is a miss, and is not retried for a while', async () => {
        launchStatus = 404;
        const first = (await failure(UNKNOWN_MINT)) as { details?: Record<string, unknown> };
        expect(first.details?.code).toBe('asset_not_registered');
        calls = [];
        await failure(UNKNOWN_MINT);
        expect(calls).not.toContain('launchpadApprovedMints');
    });
});

describe('resolveAssetRefContext with admin-renamed assets', () => {
    afterEach(() => {
        __setAssetIdRenamesForTests(null);
        __setAssetIdRenamesLoaderForTests(null);
    });

    it('maps a registry id to the id the asset was renamed to', async () => {
        __setAssetIdRenamesForTests({ tesla: 'tesla-inc' });

        const byOldId = await Effect.runPromise(resolveAssetRefContext('tesla'));
        expect(byOldId.assetId).toBe('tesla-inc');
        expect(byOldId.ref).toBe('tesla');
        expect(byOldId.resolvedBy).toBe('registry');
    });

    it('maps registry mint matches to the renamed id as well', async () => {
        __setAssetIdRenamesForTests({ tesla: 'tesla-inc' });

        const result = await Effect.runPromise(resolveAssetRefContext(TESLA_XSTOCK_MINT));
        expect(result.assetId).toBe('tesla-inc');
        expect(result.mint).toBe(TESLA_XSTOCK_MINT);
    });

    it('leaves assets that were not renamed untouched', async () => {
        __setAssetIdRenamesForTests({ tesla: 'tesla-inc' });

        const result = await Effect.runPromise(resolveAssetRefContext('bitcoin'));
        expect(result.assetId).toBe('bitcoin');
        expect(result.resolvedBy).toBe('assetId');
    });

    it('falls back to the registry id when the rename table cannot be loaded', async () => {
        __setAssetIdRenamesLoaderForTests(() => Effect.die(new Error('assets service down')));

        const result = await Effect.runPromise(resolveAssetRefContext('tesla'));
        expect(result.assetId).toBe('tesla');
        expect(result.resolvedBy).toBe('assetId');
    });
});
