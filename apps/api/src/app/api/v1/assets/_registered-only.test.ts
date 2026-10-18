import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import { __resetCloudRunClientForTesting } from '@/lib/cloudrun/client';
import { resetEnvForTests } from '@/lib/env';

import { __resetRegisteredOnlyForTests, partitionRegisteredMints, v1RegisteredOnlyEnabled } from './_registered-only';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // compiled registry
const DB_MINT = 'DBMINT11111111111111111111111111111111111111';
const LST_MINT = 'LSTMINT1111111111111111111111111111111111111';
const LAUNCH = 'LAUNCH11111111111111111111111111111111111111';
const UNREG = 'UNREG111111111111111111111111111111111111111';

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_DELETED_REFS_MEMO',
    'TOKENS_V1_REGISTERED_ONLY',
] as const;
const savedEnv: Record<string, string | undefined> = {};
let calls: Array<{ name: string; body: Record<string, unknown> }> = [];
let variantsStatus = 200;
let sanctumStatus = 200;

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
    calls = [];
    variantsStatus = 200;
    sanctumStatus = 200;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const name = /\/query\/([A-Za-z]+)$/.exec(String(input))?.[1] ?? '';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ name, body });
        switch (name) {
            case 'assetVariantsListByMints':
                if (variantsStatus !== 200) return json({ error: 'down' }, variantsStatus);
                return json(
                    (body.mints as string[]).map(mint => ({
                        mint,
                        variant:
                            mint === DB_MINT
                                ? {
                                      assetId: 'db-asset',
                                      chain: 'solana',
                                      mint,
                                      variantId: 'db:1',
                                      kind: 'native',
                                      trustTier: 'tier2',
                                      tags: [],
                                      isActive: true,
                                  }
                                : null,
                    })),
                );
            case 'listDeletedRefs':
                return json([]);
            case 'sanctumListActive':
                if (sanctumStatus !== 200) return json({ error: 'down' }, sanctumStatus);
                return json([{ mint: LST_MINT, symbol: 'lstSOL', name: 'LST', sourceRank: 1 }]);
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

describe('v1RegisteredOnlyEnabled', () => {
    it('is on unless the flag is exactly off', () => {
        delete process.env.TOKENS_V1_REGISTERED_ONLY;
        expect(v1RegisteredOnlyEnabled()).toBe(true);
        process.env.TOKENS_V1_REGISTERED_ONLY = 'true';
        expect(v1RegisteredOnlyEnabled()).toBe(true);
        process.env.TOKENS_V1_REGISTERED_ONLY = ' OFF ';
        expect(v1RegisteredOnlyEnabled()).toBe(false);
    });
});

describe('partitionRegisteredMints', () => {
    it('walks DB → registry → Sanctum → launches, each only for what is still unresolved, keeping input order', async () => {
        const out = await Effect.runPromise(partitionRegisteredMints([UNREG, LAUNCH, USDC, LST_MINT, DB_MINT]));
        expect(out.registered).toEqual([LAUNCH, USDC, LST_MINT, DB_MINT]);
        expect(out.unregistered).toEqual([UNREG]);
        const names = calls.map(c => c.name);
        expect(names).toEqual([
            'assetVariantsListByMints',
            'listDeletedRefs',
            'sanctumListActive',
            'launchpadApprovedMints',
        ]);
        // Only the mints the earlier tiers missed reach the launch tier.
        expect(calls.find(c => c.name === 'launchpadApprovedMints')?.body.mints).toEqual([UNREG, LAUNCH]);
    });

    it('stops after the DB tier when it resolves everything', async () => {
        const out = await Effect.runPromise(partitionRegisteredMints([DB_MINT]));
        expect(out).toEqual({ registered: [DB_MINT], unregistered: [] });
        expect(calls.map(c => c.name)).toEqual(['assetVariantsListByMints']);
    });

    it('chunks the DB lookup at 250 mints', async () => {
        const many = Array.from({ length: 251 }, (_, i) => `M${String(i).padStart(43, '1')}`.slice(0, 44));
        await Effect.runPromise(partitionRegisteredMints(many));
        const sizes = calls
            .filter(c => c.name === 'assetVariantsListByMints')
            .map(c => (c.body.mints as string[]).length);
        expect(sizes).toEqual([250, 1]);
    });

    it('fails open (everything registered) when the DB lookup errors', async () => {
        variantsStatus = 500;
        const out = await Effect.runPromise(partitionRegisteredMints([UNREG, DB_MINT]));
        expect(out).toEqual({ registered: [UNREG, DB_MINT], unregistered: [] });
    });

    it('fails open (everything registered) when the Sanctum list read errors', async () => {
        sanctumStatus = 500;
        const out = await Effect.runPromise(partitionRegisteredMints([UNREG, LST_MINT]));
        expect(out).toEqual({ registered: [UNREG, LST_MINT], unregistered: [] });
        expect(calls.map(c => c.name)).not.toContain('launchpadApprovedMints');
    });

    it('returns empty partitions for no input without any call', async () => {
        expect(await Effect.runPromise(partitionRegisteredMints([]))).toEqual({ registered: [], unregistered: [] });
        expect(calls).toEqual([]);
    });
});
