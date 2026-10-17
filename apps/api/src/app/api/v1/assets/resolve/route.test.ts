/**
 * Route-level tests for `GET /v1/assets/resolve` through the real `route()`
 * wrapper, with Cloud Run stubbed at the fetch layer.
 *
 * The route is unchanged by the speculative batch: it still makes every call
 * it always made, and those calls hit the request memo when the server walked
 * the same path. These tests pin that the body is byte-identical with the
 * batch on and off, and that a correct batch leaves zero live lookups.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { __resetSpeculativeBatchForTests } = await import('@/lib/cloudrun/speculative-batch');
const { resetEnvForTests } = await import('@/lib/env');
const { signPlaygroundProxyAuthPayload } = await import('@/effect/playground-proxy-auth');
const { GET } = await import('./route');

// Not in the compiled registry, so only the stubbed Cloud Run answers matter.
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

function variant(mint: string, variantId: string) {
    return {
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
    };
}

function market(mint: string) {
    return {
        mint,
        source: 'birdeye',
        symbol: mint === MINT_A ? 'ZZQX' : 'wZZQX',
        name: mint === MINT_A ? 'Zzqx Coin' : 'Wrapped Zzqx',
        decimals: 6,
        logoURI: null,
        price: mint === MINT_A ? 2.5 : 2.49,
        liquidity: mint === MINT_A ? 1_000_000 : 50_000,
        volume24hUSD: 250_000,
        marketCap: 10_000_000,
        priceChange24hPercent: 1.5,
        priceChange1hPercent: null,
        lastFetchedAt: NOW,
    };
}

/** The single-purpose handlers, answered from fixtures. */
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
            return (body.mints as string[]).map(mint => ({
                mint,
                market: mint.startsWith('ZZQX') ? market(mint) : null,
            }));
        case 'tokensGetByAddress':
        case 'stockInstrumentsGetByAssetId':
        case 'sanctumResolveRef':
            return null;
        case 'resolveAssetRefForApi':
            return body.ref === ASSET_ID ? { assetId: ASSET_ID, ref: ASSET_ID, resolvedBy: 'assetId' } : null;
        default:
            throw new Error(`unexpected cloud run call: ${name}`);
    }
}

type Entry = { name: string; args: Record<string, unknown>; result?: unknown };
/** What the server batch returns: entries computed from the same fixtures. */
let batchEntries: Entry[] | null = null;
let batchStatus = 200;
let calls: string[] = [];

function seeded(list: Array<{ name: string; args: Record<string, unknown> }>): Entry[] {
    return list.map(({ name, args }) => ({ name, args, result: respond(name, args) }));
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
    batchStatus = 200;
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const match = /\/query\/([A-Za-z]+)$/.exec(url);
        if (!match) throw new Error(`unexpected fetch: ${url}`);
        const name = match[1] ?? '';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (name === 'assetsApiSpeculativeBatchForApi') {
            calls.push(name);
            if (batchStatus !== 200) return json({ error: 'unknown query' }, batchStatus);
            return json({ entries: batchEntries ?? [] });
        }
        // Fail-open loaders (advisories) throw inside `respond`, before the
        // call is recorded; they are not "live lookups".
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

async function resolve(query: string): Promise<{ status: number; body: unknown; cacheControl: string | null }> {
    const res = await GET(
        new Request(`https://api.example.test/api/v1/assets/resolve${query}`, { headers: await authHeader() }),
        {} as never,
    );
    return { status: res.status, body: await res.json(), cacheControl: res.headers.get('cache-control') };
}

/** Live lookups only: the batch call itself is excluded. */
const liveLookups = () => calls.filter(c => !c.startsWith('assetsApiSpeculativeBatchForApi'));

async function compare(query: string, entries: Entry[]) {
    process.env.TOKENS_SPECULATIVE_BATCH = 'off';
    const off = await resolve(query);
    const offCalls = liveLookups();
    expect(off.status).toBe(200);
    expect(offCalls.length).toBeGreaterThan(0);

    calls = [];
    delete process.env.TOKENS_SPECULATIVE_BATCH;
    batchEntries = entries;
    const on = await resolve(query);
    const onCalls = liveLookups();

    expect(on.status).toBe(off.status);
    expect(on.cacheControl).toBe(off.cacheControl);
    expect(on.body).toEqual(off.body);
    expect(calls.filter(c => c === 'assetsApiSpeculativeBatchForApi').length).toBe(1);
    return { offCalls, onCalls, body: on.body };
}

describe('GET /v1/assets/resolve — speculative batch memo', () => {
    it('by mint (DB variant): identical body, zero live lookups when the batch walked the same path', async () => {
        const lc = MINT_A.toLowerCase();
        const { offCalls, onCalls } = await compare(
            `?mint=${MINT_A}`,
            seeded([
                { name: 'listDeletedRefs', args: { refs: [lc] } },
                { name: 'assetVariantsGetByMint', args: { mint: MINT_A } },
                { name: 'getByAssetId', args: { assetId: ASSET_ID } },
                { name: 'variantMarketsGetLatestByMints', args: { mints: [MINT_A] } },
            ]),
        );
        expect(offCalls.length).toBe(4);
        expect(onCalls).toEqual([]);
    });

    it('by ref (DB asset via resolveAssetRefForApi): identical body, zero live lookups', async () => {
        const { offCalls, onCalls } = await compare(
            `?ref=${ASSET_ID}`,
            seeded([
                { name: 'listDeletedRefs', args: { refs: [ASSET_ID] } },
                { name: 'sanctumResolveRef', args: { ref: ASSET_ID } },
                { name: 'resolveAssetRefForApi', args: { ref: ASSET_ID } },
                { name: 'getByAssetId', args: { assetId: ASSET_ID } },
                { name: 'assetVariantsListByAssetIds', args: { assetIds: [ASSET_ID] } },
                { name: 'variantMarketsGetLatestByMints', args: { mints: [MINT_A, MINT_B] } },
            ]),
        );
        expect(offCalls.length).toBe(6);
        expect(onCalls).toEqual([]);
    });

    it('by mint (unknown → singleton): identical body, zero live lookups', async () => {
        const { onCalls } = await compare(
            `?mint=${UNKNOWN_MINT}`,
            seeded([
                { name: 'listDeletedRefs', args: { refs: [UNKNOWN_MINT.toLowerCase()] } },
                { name: 'assetVariantsGetByMint', args: { mint: UNKNOWN_MINT } },
                { name: 'variantMarketsGetLatestByMints', args: { mints: [UNKNOWN_MINT] } },
                { name: 'tokensGetByAddress', args: { address: UNKNOWN_MINT } },
            ]),
        );
        expect(onCalls).toEqual([]);
    });

    it('an entry with different args is a miss: identical body, that lookup goes live', async () => {
        const { onCalls } = await compare(
            `?mint=${MINT_A}`,
            seeded([
                { name: 'listDeletedRefs', args: { refs: [MINT_A.toLowerCase()] } },
                { name: 'assetVariantsGetByMint', args: { mint: MINT_A } },
                { name: 'getByAssetId', args: { assetId: ASSET_ID } },
                // Wrong mint list: the route asks for [MINT_A].
                { name: 'variantMarketsGetLatestByMints', args: { mints: [MINT_B] } },
            ]),
        );
        expect(onCalls).toEqual([`variantMarketsGetLatestByMints:${JSON.stringify({ mints: [MINT_A] })}`]);
    });

    it('a non-allowlisted entry is ignored', async () => {
        const { onCalls } = await compare(`?mint=${MINT_A}`, [
            { name: 'assetsApiLoadAssetBaseForApi', args: { assetId: ASSET_ID }, result: { bogus: true } },
        ]);
        expect(onCalls.length).toBe(4);
    });

    it('an older server (404) is remembered: identical body, and the next request skips the batch', async () => {
        process.env.TOKENS_SPECULATIVE_BATCH = 'off';
        const off = await resolve(`?mint=${MINT_A}`);

        delete process.env.TOKENS_SPECULATIVE_BATCH;
        batchStatus = 404;
        calls = [];
        const on = await resolve(`?mint=${MINT_A}`);
        expect(on.body).toEqual(off.body);
        expect(calls.filter(c => c === 'assetsApiSpeculativeBatchForApi').length).toBe(1);
        expect(liveLookups().length).toBe(4);

        calls = [];
        const again = await resolve(`?mint=${MINT_A}`);
        expect(again.body).toEqual(off.body);
        expect(calls.filter(c => c === 'assetsApiSpeculativeBatchForApi').length).toBe(0);
    });
});
