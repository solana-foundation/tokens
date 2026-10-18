import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import { __resetCloudRunClientForTesting } from '@/lib/cloudrun/client';
import { resetEnvForTests } from '@/lib/env';

import { getVariantByMint } from '@tokens/asset-registry';

import { __resetRegisteredOnlyForTests } from '../../v1/assets/_registered-only';
import { toRegistryItems } from './_shared';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // compiled registry (usd)
const DB_OWNED = 'DBOWNED1111111111111111111111111111111111111';
const MINT_ID_ASSET = 'M1NTD111111111111111111111111111111111111111'; // base58-shaped
const LAUNCH = 'LAUNCH11111111111111111111111111111111111111';
const INDEX_ONLY = 'INDEXONLY11111111111111111111111111111111111';
const UNKNOWN = 'UNKNOWN1111111111111111111111111111111111111';
const TESLA_XSTOCK = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'; // compiled registry (tesla)
let deletedRefs: string[] = [];

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_DELETED_REFS_MEMO',
] as const;
const savedEnv: Record<string, string | undefined> = {};
let calls: Array<{ name: string; body: Record<string, unknown> }> = [];

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Row = Parameters<typeof toRegistryItems>[0][number];
function row(mint: string, overrides: Partial<Row> = {}): Row {
    return {
        mint,
        symbol: 'X',
        name: null,
        logoURI: null,
        hasTokenPage: true,
        assetId: null,
        group: null,
        category: null,
        assetClass: null,
        alliumClass: null,
        alliumValueUsd: null,
        rwaClass: null,
        rwaValueUsd: null,
        marketCapUsd: null,
        rank: 0,
        ...overrides,
    } as Row;
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
    calls = [];
    deletedRefs = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const name = /\/query\/([A-Za-z]+)$/.exec(String(input))?.[1] ?? '';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ name, body });
        switch (name) {
            case 'assetVariantsListByMints':
                return json((body.mints as string[]).map(mint => ({ mint, variant: null })));
            case 'listDeletedRefs':
                return json(deletedRefs);
            case 'sanctumListActive':
                return json([]);
            case 'launchpadApprovedMints':
                return json({ mints: (body.mints as string[]).filter(m => m === LAUNCH) });
            default:
                throw new Error(`unexpected cloud run call: ${name}`);
        }
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    __resetRegisteredOnlyForTests();
});

describe('toRegistryItems: assetId / hasTokenPage follow the same registration tiers as v1', () => {
    it('places each row by DB asset, compiled registry, or a batched later-tier check; unknown mints get no page', async () => {
        const items = await Effect.runPromise(
            toRegistryItems([
                row(DB_OWNED, { assetId: 'tesla' }),
                row(MINT_ID_ASSET, { assetId: MINT_ID_ASSET }),
                row(USDC),
                row(LAUNCH),
                row(INDEX_ONLY),
                row(UNKNOWN, { hasTokenPage: false }),
            ]),
        );
        expect(items.map(i => [i.mint, i.assetId, i.hasTokenPage])).toEqual([
            [DB_OWNED, 'tesla', true],
            [MINT_ID_ASSET, `solana-${MINT_ID_ASSET}`, true],
            [USDC, 'usd', true],
            [LAUNCH, `solana-${LAUNCH}`, true],
            [INDEX_ONLY, null, false],
            [UNKNOWN, null, false],
        ]);
        // Only the rows the platform knows but tiers 1-2 did not place reach Cloud Run, in one batch.
        const launch = calls.filter(c => c.name === 'launchpadApprovedMints');
        expect(launch.map(c => c.body)).toEqual([{ mints: [LAUNCH, INDEX_ONLY] }]);
    });

    it('a compiled-registry asset an admin removed gets no page (tombstone), unless a later tier still registers it', async () => {
        // Tombstones are keyed the way classifyMint keys them: coingeckoId, else assetId.
        const tesla = getVariantByMint(TESLA_XSTOCK)!.asset;
        deletedRefs = [(tesla.coingeckoId ?? tesla.assetId).toLowerCase()];
        const items = await Effect.runPromise(toRegistryItems([row(TESLA_XSTOCK), row(USDC)]));
        expect(items.map(i => [i.mint, i.assetId, i.hasTokenPage])).toEqual([
            [TESLA_XSTOCK, null, false],
            [USDC, 'usd', true],
        ]);
    });

    it('registry matches cost one memoised tombstone lookup and no other Cloud Run call', async () => {
        const items = await Effect.runPromise(toRegistryItems([row(DB_OWNED, { assetId: 'tesla' }), row(USDC)]));
        expect(items.every(i => i.hasTokenPage)).toBe(true);
        expect(calls.map(c => c.name)).toEqual(['listDeletedRefs']);
    });
});
