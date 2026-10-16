/**
 * Route-level tests for `GET /v1/assets/:assetId` (DB crypto asset with no
 * registry match) with Cloud Run stubbed at the fetch layer: the body must be
 * byte-identical with the speculative batch on and off.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { __resetSpeculativeBatchForTests } = await import('@/lib/cloudrun/speculative-batch');
const { resetEnvForTests } = await import('@/lib/env');
const { signPlaygroundProxyAuthPayload } = await import('@/effect/playground-proxy-auth');
const { GET } = await import('./route');

const ASSET_ID = 'zzqx-coin';
const MINT_A = 'ZZQX111111111111111111111111111111111111111';
const MINT_B = 'ZZQX222222222222222222222222222222222222222';
const NOW = 1_760_000_000_000;

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_ERROR = console.error;
const ENV_KEYS = [
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'TOKENS_REDIS_TARGET',
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_PLAYGROUND_PROXY_SECRET',
    'TOKENS_USAGE_LOG_MODE',
    'TOKENS_CACHE_WARM_SECRET',
    'TOKENS_SPECULATIVE_BATCH',
    'BIRDEYE_API_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ASSET_DOC = {
    assetId: ASSET_ID,
    category: 'crypto',
    aliases: ['ZZQX'],
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    name: 'Zzqx Coin',
    symbol: 'ZZQX',
};
const variant = (mint: string, variantId: string) => ({
    assetId: ASSET_ID,
    chain: 'solana',
    mint,
    variantId,
    kind: mint === MINT_A ? 'native' : 'wrapped',
    trustTier: 'tier2',
    tags: [],
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
});
// MINT_A has full display metadata; MINT_B lacks it, so the route takes the DEX fallback for it.
const market = (mint: string) =>
    mint === MINT_A
        ? {
              mint,
              source: 'birdeye',
              symbol: 'ZZQX',
              name: 'Zzqx Coin',
              decimals: 6,
              logoURI: null,
              price: 2.5,
              liquidity: 1_000_000,
              volume24hUSD: 250_000,
              marketCap: 10_000_000,
              priceChange24hPercent: 1.5,
              priceChange1hPercent: null,
              lastFetchedAt: NOW,
          }
        : null;

function respond(name: string, body: Record<string, unknown>): unknown {
    switch (name) {
        case 'listDeletedRefs':
        case 'listAssetIdRenames':
        case 'prestocksGetLatestByMints':
            return [];
        case 'getByAssetId':
            return body.assetId === ASSET_ID ? ASSET_DOC : null;
        case 'assetVariantsListByAssetIds':
            return (body.assetIds as string[]).map(assetId => ({
                assetId,
                variants:
                    assetId === ASSET_ID
                        ? [variant(MINT_A, 'zzqx-coin:mint'), variant(MINT_B, 'zzqx-coin:wrapped')]
                        : [],
            }));
        case 'variantMarketsGetLatestByMints':
            return (body.mints as string[]).map(mint => ({ mint, market: market(mint) }));
        case 'tokenMarketsGetLatestByMints':
            return (body.mints as string[]).map(mint => ({ mint, doc: null }));
        case 'variantFillQualityGetLatestByMints':
            return (body.mints as string[]).map(mint => ({ mint, fillQuality: null }));
        case 'assetMarketsGetLatestByAssetId':
            return { assetId: ASSET_ID, liquidity: 1_000_000, volume24hUSD: 250_000, lastComputedAt: NOW };
        case 'sanctumResolveRef':
            return null;
        case 'resolveAssetRefForApi':
            return body.ref === ASSET_ID ? { assetId: ASSET_ID, ref: ASSET_ID, resolvedBy: 'assetId' } : null;
        default:
            throw new Error(`unexpected cloud run call: ${name}`);
    }
}

type Entry = { name: string; args: Record<string, unknown>; result?: unknown };
let batchEntries: Entry[] | null = null;
let calls: string[] = [];
const seeded = (list: Array<{ name: string; args: Record<string, unknown> }>): Entry[] =>
    list.map(({ name, args }) => ({ name, args, result: respond(name, args) }));

beforeEach(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    process.env.TOKENS_CLOUDRUN_AUTH_TOKEN = 'tok';
    process.env.TOKENS_CLOUDRUN_ASSETS_URL = 'https://assets.example.run.app';
    process.env.TOKENS_CLOUDRUN_PRICES_URL = 'https://prices.example.run.app';
    process.env.TOKENS_CLOUDRUN_USAGE_URL = 'https://usage.example.run.app';
    process.env.TOKENS_PLAYGROUND_PROXY_SECRET = 'test-playground-secret';
    process.env.TOKENS_USAGE_LOG_MODE = 'off';
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    __resetSpeculativeBatchForTests();
    batchEntries = null;
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const match = /\/query\/([A-Za-z]+)$/.exec(url);
        if (!match) throw new Error(`unexpected fetch: ${url}`);
        const name = match[1] ?? '';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (name === 'assetsApiSpeculativeBatchForApi') {
            calls.push(name);
            return json({ entries: batchEntries ?? [] });
        }
        const result = respond(name, body);
        calls.push(`${name}:${JSON.stringify(body)}`);
        return json(result);
    }) as typeof fetch;
    console.log = () => undefined;
    console.error = () => undefined;
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
    __resetSpeculativeBatchForTests();
});

async function authHeader(): Promise<Record<string, string>> {
    const now = Date.now();
    const header = await signPlaygroundProxyAuthPayload({
        apiKeyId: 'k',
        keyPrefix: 'tk_test',
        projectId: 'p',
        ownerClerkUserId: 'u',
        scopes: ['assets:read'],
        iat: now,
        exp: now + 60_000,
    });
    return { 'x-tokens-playground-auth': header };
}

async function get(): Promise<{ status: number; body: unknown }> {
    const res = await GET(
        new Request(`https://api.example.test/api/v1/assets/${ASSET_ID}`, { headers: await authHeader() }),
        { params: Promise.resolve({ assetId: ASSET_ID }) } as never,
    );
    return { status: res.status, body: await res.json() };
}
const liveLookups = () => calls.filter(c => !c.startsWith('assetsApiSpeculativeBatchForApi'));

describe('GET /v1/assets/:assetId — speculative batch memo', () => {
    it('DB crypto asset: identical body, zero live lookups when the batch walked the same path', async () => {
        process.env.TOKENS_SPECULATIVE_BATCH = 'off';
        const off = await get();
        expect(off.status).toBe(200);
        const offCalls = liveLookups();

        calls = [];
        delete process.env.TOKENS_SPECULATIVE_BATCH;
        batchEntries = seeded([
            { name: 'listDeletedRefs', args: { refs: [ASSET_ID] } },
            { name: 'sanctumResolveRef', args: { ref: ASSET_ID } },
            { name: 'resolveAssetRefForApi', args: { ref: ASSET_ID } },
            { name: 'getByAssetId', args: { assetId: ASSET_ID } },
            { name: 'assetVariantsListByAssetIds', args: { assetIds: [ASSET_ID] } },
            { name: 'variantMarketsGetLatestByMints', args: { mints: [MINT_A, MINT_B] } },
            { name: 'tokenMarketsGetLatestByMints', args: { mints: [MINT_B] } },
            { name: 'variantFillQualityGetLatestByMints', args: { mints: [MINT_A, MINT_B] } },
            { name: 'assetMarketsGetLatestByAssetId', args: { assetId: ASSET_ID } },
        ]);
        const on = await get();
        expect(on.status).toBe(200);
        expect(on.body).toEqual(off.body);
        expect(offCalls.length).toBe(9);
        expect(liveLookups()).toEqual([]);
    });
});
