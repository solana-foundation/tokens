/**
 * Route-level tests for `GET /v1/assets/risk-summary` through the real
 * `route()` wrapper. Cloud Run is stubbed at the fetch layer so no I/O happens.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
const { signPlaygroundProxyAuthPayload } = await import('@/effect/playground-proxy-auth');
const { GET } = await import('./route');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const RAY_MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const PUMP_MINT = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
const UNKNOWN_MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S4iCNLY3QrkX6R';

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

type Market = {
    liquidity: number | null;
    marketCap: number | null;
    holder: number | null;
    volume24hUSD: number | null;
};

const DEEP_MARKET: Market = { liquidity: 12_000_000, marketCap: 900_000_000, holder: 400_000, volume24hUSD: 9_000_000 };
const THIN_MARKET: Market = { liquidity: 40_000, marketCap: 300_000, holder: 150, volume24hUSD: 2_000 };

let snapshotByMint: Record<string, Market | null> = {};
let snapshotCalls = 0;
// Provider (Birdeye token overview) responses by mint; unset means "not stubbed".
let overviewByMint: Record<string, () => Response> = {};
let overviewCalls: string[] = [];

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function overview(market: Market): Response {
    return json({
        success: true,
        data: {
            liquidity: market.liquidity,
            marketCap: market.marketCap,
            // Must never be used in place of market cap.
            fdv: 50_000_000_000,
            holder: market.holder,
            v24hUSD: market.volume24hUSD,
        },
    });
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
    resetEnvForTests();
    __resetCloudRunClientForTesting();

    snapshotByMint = {};
    snapshotCalls = 0;
    overviewByMint = {};
    overviewCalls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/query/variantMarketsGetLatestByMints')) {
            snapshotCalls += 1;
            const { mints } = JSON.parse(String(init?.body)) as { mints: string[] };
            return json(
                mints.map(mint => {
                    const market = snapshotByMint[mint] ?? null;
                    return {
                        mint,
                        assetId: null,
                        chain: null,
                        market: market && { mint, source: 'birdeye', lastFetchedAt: Date.now(), ...market },
                        executionQuality: null,
                        advisory: null,
                    };
                }),
            );
        }
        if (url.includes('/query/curatedMembershipGetSnapshot')) {
            return json({ loadedAt: Date.now(), mintsByList: {}, allMints: [], entriesByMint: {} });
        }
        if (url.startsWith('https://public-api.birdeye.so/defi/token_overview')) {
            const mint = new URL(url).searchParams.get('address') ?? '';
            overviewCalls.push(mint);
            const respond = overviewByMint[mint];
            if (respond) return respond();
        }
        // Any stray network call fails loudly instead of reaching a real service.
        throw new Error(`unexpected fetch: ${url}`);
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

async function authHeader(scopes: string[] = ['assets:read']): Promise<Record<string, string>> {
    const now = Date.now();
    const header = await signPlaygroundProxyAuthPayload({
        apiKeyId: 'k',
        keyPrefix: 'tk_test',
        projectId: 'p',
        ownerClerkUserId: 'u',
        scopes,
        iat: now,
        exp: now + 60_000,
    });
    return { 'x-tokens-playground-auth': header };
}

async function get(query: string, headers?: Record<string, string>): Promise<Response> {
    return GET(
        new Request(`https://api.example.test/api/v1/assets/risk-summary${query}`, {
            headers: headers ?? (await authHeader()),
        }),
        {} as never,
    );
}

type RiskBody = {
    score: number;
    grade: string;
    label: string;
    tone: string;
    isTrustedLaunch: boolean;
    caps: string[];
    hasInsufficientData: boolean;
    insufficientDataReason: string | null;
};

const INSUFFICIENT: RiskBody = {
    score: 0,
    grade: 'C',
    label: 'Insufficient Data',
    tone: 'risk',
    isTrustedLaunch: false,
    caps: [],
    hasInsufficientData: true,
    insufficientDataReason: 'Market snapshot not available in cache',
};

describe('GET /v1/assets/risk-summary', () => {
    it('401 without credentials', async () => {
        const res = await get(`?mint=${JUP_MINT}`, {});
        expect(res.status).toBe(401);
        expect(snapshotCalls).toBe(0);
    });

    it('403 when the key has neither assets:read nor assets:risk:read', async () => {
        const res = await get(`?mint=${JUP_MINT}`, await authHeader(['tokens:read']));
        expect(res.status).toBe(403);
    });

    it('accepts the assets:risk:read scope', async () => {
        const res = await get(`?mint=${JUP_MINT}`, await authHeader(['assets:risk:read']));
        expect(res.status).toBe(200);
    });

    it('400 when mint is missing or malformed', async () => {
        expect((await get('')).status).toBe(400);
        expect((await get('?mint=not-a-mint')).status).toBe(400);
    });

    // Regression: a mint with no snapshot used to be scored as SOL (100 / A / Established).
    it('reports a mint with no snapshot as unscored, never as grade A', async () => {
        for (const mint of [JUP_MINT, RAY_MINT, UNKNOWN_MINT]) {
            const res = await get(`?mint=${mint}`);
            expect(res.status).toBe(200);
            expect((await res.json()) as RiskBody).toEqual(INSUFFICIENT);
        }
    });

    it('accepts `address` as an alias for `mint`', async () => {
        const res = await get(`?address=${JUP_MINT}`);
        expect((await res.json()) as RiskBody).toEqual(INSUFFICIENT);
    });

    it('scores a mint from its snapshot', async () => {
        snapshotByMint[JUP_MINT] = DEEP_MARKET;
        const res = await get(`?mint=${JUP_MINT}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as RiskBody;

        expect(body.hasInsufficientData).toBe(false);
        expect(body.insufficientDataReason).toBeNull();
        expect(body.grade).toBe('A');
        expect(body.label).toBe('Established');
        expect(body.score).toBeGreaterThanOrEqual(85);
    });

    it('reports a snapshot below the data floor as unscored, with the scorer reason', async () => {
        snapshotByMint[JUP_MINT] = { liquidity: 200, marketCap: 500, holder: 12, volume24hUSD: 10 };
        const body = (await (await get(`?mint=${JUP_MINT}`)).json()) as RiskBody;

        expect(body.hasInsufficientData).toBe(true);
        expect(body.grade).toBe('C');
        expect(body.insufficientDataReason).toContain('Insufficient market data');
    });

    it('pins native SOL to 100 / A without reading a snapshot', async () => {
        const res = await get(`?mint=${SOL_MINT}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as RiskBody;

        expect(body.score).toBe(100);
        expect(body.grade).toBe('A');
        expect(body.hasInsufficientData).toBe(false);
        expect(snapshotCalls).toBe(0);
    });

    it('keeps the response to the documented fields', async () => {
        process.env.BIRDEYE_API_KEY = 'test-key';
        snapshotByMint[JUP_MINT] = DEEP_MARKET;
        overviewByMint[PUMP_MINT] = () => overview(DEEP_MARKET);
        for (const mint of [JUP_MINT, RAY_MINT, PUMP_MINT, SOL_MINT]) {
            const body = (await (await get(`?mint=${mint}`)).json()) as Record<string, unknown>;
            expect(Object.keys(body).sort()).toEqual(Object.keys(INSUFFICIENT).sort());
        }
    });

    it('is briefly cacheable by the caller', async () => {
        const res = await get(`?mint=${SOL_MINT}`);
        expect(res.headers.get('cache-control')).toBe('private, max-age=30');
    });
});

describe('GET /v1/assets/risk-summary — no snapshot, live provider read', () => {
    beforeEach(() => {
        process.env.BIRDEYE_API_KEY = 'test-key';
    });

    it('scores the mint from live provider data', async () => {
        overviewByMint[JUP_MINT] = () => overview(DEEP_MARKET);
        const res = await get(`?mint=${JUP_MINT}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as RiskBody;

        expect(body.hasInsufficientData).toBe(false);
        expect(body.insufficientDataReason).toBeNull();
        expect(body.grade).toBe('A');
        expect(overviewCalls).toEqual([JUP_MINT]);
    });

    it('scores live data exactly as it would score the same snapshot', async () => {
        overviewByMint[JUP_MINT] = () => overview(THIN_MARKET);
        snapshotByMint[RAY_MINT] = THIN_MARKET;

        const live = (await (await get(`?mint=${JUP_MINT}`)).json()) as RiskBody;
        const cached = (await (await get(`?mint=${RAY_MINT}`)).json()) as RiskBody;

        expect(live).toEqual(cached);
        expect(live.grade).not.toBe('A');
    });

    it('reads live when the snapshot carries neither liquidity nor market cap', async () => {
        snapshotByMint[JUP_MINT] = { liquidity: null, marketCap: null, holder: null, volume24hUSD: null };
        overviewByMint[JUP_MINT] = () => overview(DEEP_MARKET);
        const body = (await (await get(`?mint=${JUP_MINT}`)).json()) as RiskBody;

        expect(body.hasInsufficientData).toBe(false);
        expect(body.grade).toBe('A');
    });

    it('does not read live when the snapshot has data', async () => {
        snapshotByMint[JUP_MINT] = THIN_MARKET;
        await get(`?mint=${JUP_MINT}`);
        expect(overviewCalls).toEqual([]);
    });

    it('does not read live for native SOL', async () => {
        await get(`?mint=${SOL_MINT}`);
        expect(overviewCalls).toEqual([]);
    });

    it('reports a mint the provider does not know as unscored', async () => {
        const unknown = [
            () => json({ success: true, data: {} }),
            () => json({ success: false, message: 'Not found' }),
            () => json({ success: false }, 404),
            () => overview({ liquidity: 0, marketCap: 0, holder: 0, volume24hUSD: 0 }),
        ];
        for (const respond of unknown) {
            overviewByMint[UNKNOWN_MINT] = respond;
            const res = await get(`?mint=${UNKNOWN_MINT}`);
            expect(res.status).toBe(200);
            expect((await res.json()) as RiskBody).toEqual(INSUFFICIENT);
        }
    });

    it('reports live data below the data floor as unscored', async () => {
        overviewByMint[JUP_MINT] = () => overview({ liquidity: 200, marketCap: 500, holder: 12, volume24hUSD: 10 });
        const body = (await (await get(`?mint=${JUP_MINT}`)).json()) as RiskBody;

        expect(body.hasInsufficientData).toBe(true);
        expect(body.grade).toBe('C');
        expect(body.score).toBe(0);
    });

    // The live read is best-effort: provider trouble must never surface as an
    // error, and must never be mistaken for a good score.
    it('degrades to unscored with a 200 when the provider is down or rate limiting', async () => {
        for (const status of [500, 502, 429, 401]) {
            overviewByMint[JUP_MINT] = () => json({ success: false }, status);
            const res = await get(`?mint=${JUP_MINT}`);
            expect(res.status).toBe(200);
            expect((await res.json()) as RiskBody).toEqual(INSUFFICIENT);
        }
    });

    it('degrades to unscored when the provider returns garbage', async () => {
        overviewByMint[JUP_MINT] = () => new Response('<html>bad gateway</html>', { status: 200 });
        const res = await get(`?mint=${JUP_MINT}`);
        expect(res.status).toBe(200);
        expect((await res.json()) as RiskBody).toEqual(INSUFFICIENT);
    });

    it('degrades to unscored without calling the provider when no key is configured', async () => {
        delete process.env.BIRDEYE_API_KEY;
        overviewByMint[JUP_MINT] = () => overview(DEEP_MARKET);
        const res = await get(`?mint=${JUP_MINT}`);

        expect(res.status).toBe(200);
        expect((await res.json()) as RiskBody).toEqual(INSUFFICIENT);
        expect(overviewCalls).toEqual([]);
    });
});
