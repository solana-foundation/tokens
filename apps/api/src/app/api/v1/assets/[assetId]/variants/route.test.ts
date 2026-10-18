/**
 * Route-level tests for `GET /v1/assets/:assetId/variants` with Cloud Run
 * stubbed at the fetch layer: the body must be byte-identical with the
 * speculative batch on and off, and a correct batch leaves zero live lookups.
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
const UNKNOWN_MINT = 'UNKN111111111111111111111111111111111111111';
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
    'TOKENS_DELETED_REFS_MEMO',
    'TOKENS_V1_REGISTERED_ONLY',
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
const market = (mint: string) => ({
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
});

function respond(name: string, body: Record<string, unknown>): unknown {
    switch (name) {
        case 'listDeletedRefs':
        case 'listAssetIdRenames':
            return [];
        case 'assetVariantsGetByMint':
            return body.mint === MINT_A ? variant(MINT_A, 'zzqx-coin:mint') : null;
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
            return (body.mints as string[]).map(mint => ({ mint, market: mint === MINT_A ? market(mint) : null }));
        case 'variantFillQualityGetLatestByMints':
            return (body.mints as string[]).map(mint => ({ mint, fillQuality: null }));
        case 'tokenMarketsGetTopMarketsByMints':
            return [];
        case 'tokenMarketsGetLatestByMint':
        case 'tokensGetByAddress':
        case 'sanctumResolveRef':
            return null;
        case 'launchpadApprovedMints':
            return { mints: [] };
        case 'resolveAssetRefForApi':
            return body.ref === ASSET_ID ? { assetId: ASSET_ID, ref: ASSET_ID, resolvedBy: 'assetId' } : null;
        default:
            throw new Error(`unexpected cloud run call: ${name}`);
    }
}

type Entry = { name: string; args: Record<string, unknown>; result?: unknown };
let batchEntries: Entry[] | null = null;
let batchArgs: Record<string, unknown> | null = null;
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
    // These tests count Cloud Run calls with the batch on vs off; the
    // process-wide deleted-refs memo (its own tests cover it) would otherwise
    // absorb `listDeletedRefs` depending on which test ran first.
    process.env.TOKENS_DELETED_REFS_MEMO = 'off';
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    __resetSpeculativeBatchForTests();
    batchEntries = null;
    batchArgs = null;
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const match = /\/query\/([A-Za-z]+)$/.exec(url);
        if (!match) throw new Error(`unexpected fetch: ${url}`);
        const name = match[1] ?? '';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (name === 'assetsApiSpeculativeBatchForApi') {
            calls.push(name);
            batchArgs = body;
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

async function get(ref: string, query = ''): Promise<{ status: number; body: unknown }> {
    const res = await GET(
        new Request(`https://api.example.test/api/v1/assets/${ref}/variants${query}`, { headers: await authHeader() }),
        { params: Promise.resolve({ assetId: ref }) } as never,
    );
    return { status: res.status, body: await res.json() };
}
const liveLookups = () => calls.filter(c => !c.startsWith('assetsApiSpeculativeBatchForApi'));

async function compare(ref: string, entries: Entry[], query = '') {
    process.env.TOKENS_SPECULATIVE_BATCH = 'off';
    const off = await get(ref, query);
    const offCalls = liveLookups();
    calls = [];
    delete process.env.TOKENS_SPECULATIVE_BATCH;
    batchEntries = entries;
    const on = await get(ref, query);
    const onCalls = liveLookups();
    expect(on.status).toBe(off.status);
    expect(on.body).toEqual(off.body);
    return { offCalls, onCalls };
}

describe('GET /v1/assets/:assetId/variants — speculative batch memo', () => {
    it('DB asset, no filters: identical body, zero live lookups (fill quality via the passed-in memo)', async () => {
        const { offCalls, onCalls } = await compare(
            ASSET_ID,
            seeded([
                { name: 'listDeletedRefs', args: { refs: [ASSET_ID] } },
                { name: 'sanctumResolveRef', args: { ref: ASSET_ID } },
                { name: 'resolveAssetRefForApi', args: { ref: ASSET_ID } },
                { name: 'getByAssetId', args: { assetId: ASSET_ID } },
                { name: 'assetVariantsListByAssetIds', args: { assetIds: [ASSET_ID] } },
                { name: 'variantMarketsGetLatestByMints', args: { mints: [MINT_A, MINT_B] } },
                { name: 'variantFillQualityGetLatestByMints', args: { mints: [MINT_A, MINT_B] } },
                { name: 'tokenMarketsGetTopMarketsByMints', args: { mints: [MINT_B] } },
            ]),
        );
        expect(offCalls.length).toBe(8);
        expect(onCalls).toEqual([]);
        expect(batchArgs).toEqual({ profile: 'variants', ref: ASSET_ID, hasFilters: false });
    });

    it('with a filter the batch is asked to stop early, and the body is still identical', async () => {
        const { onCalls } = await compare(
            ASSET_ID,
            seeded([
                { name: 'listDeletedRefs', args: { refs: [ASSET_ID] } },
                { name: 'sanctumResolveRef', args: { ref: ASSET_ID } },
                { name: 'resolveAssetRefForApi', args: { ref: ASSET_ID } },
                { name: 'getByAssetId', args: { assetId: ASSET_ID } },
                { name: 'assetVariantsListByAssetIds', args: { assetIds: [ASSET_ID] } },
            ]),
            '?kind=wrapped',
        );
        expect(batchArgs).toEqual({ profile: 'variants', ref: ASSET_ID, hasFilters: true });
        // Only the filtered market/fill/top-market reads stay live.
        expect(
            onCalls.every(c =>
                /^(variantMarketsGetLatestByMints|variantFillQualityGetLatestByMints|tokenMarketsGetTopMarketsByMints):/.test(
                    c,
                ),
            ),
        ).toBe(true);
    });

    it('unregistered mint: 404 asset_not_registered, no market reads', async () => {
        const res = await get(UNKNOWN_MINT);
        expect(res.status).toBe(404);
        const body = res.body as { error: { details: Record<string, unknown> } };
        expect(body.error.details.code).toBe('asset_not_registered');
        expect(liveLookups().some(c => c.startsWith('variantMarketsGetLatestByMints'))).toBe(false);
    });

    it('unregistered mint (TOKENS_V1_REGISTERED_ONLY=off): singleton body, zero live lookups with the batch', async () => {
        process.env.TOKENS_V1_REGISTERED_ONLY = 'off';
        const { onCalls } = await compare(
            UNKNOWN_MINT,
            seeded([
                { name: 'listDeletedRefs', args: { refs: [UNKNOWN_MINT.toLowerCase()] } },
                { name: 'assetVariantsGetByMint', args: { mint: UNKNOWN_MINT } },
                { name: 'sanctumResolveRef', args: { ref: UNKNOWN_MINT } },
                { name: 'launchpadApprovedMints', args: { mints: [UNKNOWN_MINT] } },
                { name: 'variantMarketsGetLatestByMints', args: { mints: [UNKNOWN_MINT] } },
                { name: 'tokenMarketsGetLatestByMint', args: { mint: UNKNOWN_MINT } },
                { name: 'tokensGetByAddress', args: { address: UNKNOWN_MINT } },
                { name: 'variantFillQualityGetLatestByMints', args: { mints: [UNKNOWN_MINT] } },
            ]),
        );
        expect(onCalls).toEqual([]);
    });
});
