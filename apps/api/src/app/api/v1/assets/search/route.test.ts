/**
 * Route-level tests for `GET /v1/assets/search` through the real `route()`
 * wrapper. Cloud Run is stubbed at the fetch layer so no I/O happens.
 *
 * The composite prefetch now returns variant-market / fill-quality rows for
 * every variant mint of the combined assets, so the route's serial gap-fill
 * has nothing left to fetch. These tests pin two things: (1) with full
 * coverage the route makes no `variantMarketsGetLatestByMints` call, and
 * (2) the body is byte-identical to the one produced when an older server
 * leaves a gap the route has to fill itself.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
const { signPlaygroundProxyAuthPayload } = await import('@/effect/playground-proxy-auth');
const { GET } = await import('./route');

// An asset that is NOT in the compiled registry, so the route's registry
// merge cannot add variants the fixture does not know about.
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
    'BIRDEYE_API_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function marketFor(mint: string, price: number) {
    return {
        mint,
        source: 'birdeye',
        symbol: mint === MINT_A ? 'ZZQX' : 'wZZQX',
        name: mint === MINT_A ? 'Zzqx Coin' : 'Wrapped Zzqx',
        decimals: 6,
        logoURI: null,
        price,
        liquidity: 1_000_000,
        volume24hUSD: 250_000,
        marketCap: 10_000_000,
        priceChange24hPercent: 1.5,
        priceChange1hPercent: null,
        lastFetchedAt: NOW,
    };
}

const MARKET_BY_MINT: Record<string, ReturnType<typeof marketFor>> = {
    [MINT_A]: marketFor(MINT_A, 2.5),
    [MINT_B]: marketFor(MINT_B, 2.49),
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

function marketRow(mint: string) {
    return { mint, market: MARKET_BY_MINT[mint] ?? null };
}

/** Prefetch payload; `coveredMints` controls which market rows the server returns. */
function prefetchFixture(coveredMints: string[]) {
    return {
        sanctumMatch: null,
        effectiveAssetQuery: 'zzqx',
        assets: [
            {
                assetId: ASSET_ID,
                category: 'crypto',
                aliases: ['ZZQX'],
                isActive: true,
                createdAt: NOW,
                updatedAt: NOW,
                name: 'Zzqx Coin',
                symbol: 'ZZQX',
            },
        ],
        tokens: [],
        variantsByTokenMint: [],
        extraAssets: [],
        variantsByAssetId: [
            { assetId: ASSET_ID, variants: [variant(MINT_A, 'zzqx-coin:mint'), variant(MINT_B, 'zzqx-coin:wrapped')] },
        ],
        variantMarkets: coveredMints.map(marketRow),
        fillQuality: coveredMints.map(mint => ({ mint, fillQuality: null })),
        assetAggregates: [],
        stockInstruments: [],
        stockPrices: [],
        coingeckoPrices: [],
        tokenMarketsDocs: [],
    };
}

let coveredMints: string[] = [];
let calls: Array<{ name: string; body: unknown }> = [];

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

    coveredMints = [];
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const match = /\/query\/([A-Za-z]+)$/.exec(url);
        if (!match) throw new Error(`unexpected fetch: ${url}`);
        const name = match[1] ?? '';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ name, body });
        switch (name) {
            case 'assetsApiSearchPrefetchForApi':
                return json(prefetchFixture(coveredMints));
            case 'variantMarketsGetLatestByMints':
                return json((body.mints as string[]).map(marketRow));
            case 'variantFillQualityGetLatestByMints':
                return json((body.mints as string[]).map(mint => ({ mint, fillQuality: null })));
            case 'tokenMarketsGetLatestByMints':
                return json((body.mints as string[]).map(mint => ({ mint, doc: null })));
            case 'listDeletedRefs':
            case 'prestocksGetLatestByMints':
            case 'listAssetIdRenames':
                return json([]);
            default:
                // Fail-open loaders (advisories, …) log and continue; anything
                // else failing loudly here means the route grew a new call.
                throw new Error(`unexpected cloud run call: ${name}`);
        }
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

async function search(): Promise<{ status: number; body: unknown; cacheControl: string | null }> {
    const res = await GET(
        new Request('https://api.example.test/api/v1/assets/search?q=zzqx&limit=20', { headers: await authHeader() }),
        {} as never,
    );
    return { status: res.status, body: await res.json(), cacheControl: res.headers.get('cache-control') };
}

describe('GET /v1/assets/search — prefetch variant-mint coverage', () => {
    it('makes no variant-market gap-fill call when the prefetch covers every variant mint', async () => {
        coveredMints = [MINT_A, MINT_B];
        const res = await search();
        expect(res.status).toBe(200);
        const names = calls.map(c => c.name);
        expect(names.filter(n => n === 'assetsApiSearchPrefetchForApi').length).toBe(1);
        expect(names).not.toContain('variantMarketsGetLatestByMints');
        expect(names).not.toContain('variantFillQualityGetLatestByMints');
        const body = res.body as {
            results: Array<{
                assetId: string;
                stats: unknown;
                primaryVariant: { mint: string; market?: unknown } | null;
            }>;
        };
        expect(body.results.map(a => a.assetId)).toEqual([ASSET_ID]);
        // Stats and the primary variant's market come from the prefetch rows.
        expect(body.results[0]?.stats).not.toBeNull();
        expect([MINT_A, MINT_B]).toContain(body.results[0]?.primaryVariant?.mint);
        expect(body.results[0]?.primaryVariant?.market).toBeDefined();
    });

    it('produces the identical body when an older server leaves a gap the route must fill', async () => {
        coveredMints = [MINT_A, MINT_B];
        const covered = await search();
        const coveredCalls = calls;

        calls = [];
        coveredMints = [MINT_A];
        const gapped = await search();
        const gappedCalls = calls;

        expect(gapped.status).toBe(covered.status);
        expect(gapped.cacheControl).toBe(covered.cacheControl);
        expect(gapped.body).toEqual(covered.body);

        // The gap path fetched exactly the missing mint, once, and the covered
        // path fetched nothing.
        const gapMarketCalls = gappedCalls.filter(c => c.name === 'variantMarketsGetLatestByMints');
        expect(gapMarketCalls.map(c => (c.body as { mints: string[] }).mints)).toEqual([[MINT_B]]);
        expect(coveredCalls.some(c => c.name === 'variantMarketsGetLatestByMints')).toBe(false);
    });
});
