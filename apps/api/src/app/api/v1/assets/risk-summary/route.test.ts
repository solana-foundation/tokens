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

type Market = { liquidity: number | null; marketCap: number | null; holder: number | null; volume24hUSD: number | null };

const DEEP_MARKET: Market = { liquidity: 12_000_000, marketCap: 900_000_000, holder: 400_000, volume24hUSD: 9_000_000 };

let snapshotByMint: Record<string, Market | null> = {};
let snapshotCalls = 0;

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
    process.env.TOKENS_PLAYGROUND_PROXY_SECRET = 'test-playground-secret';
    process.env.TOKENS_USAGE_LOG_MODE = 'off';
    resetEnvForTests();
    __resetCloudRunClientForTesting();

    snapshotByMint = {};
    snapshotCalls = 0;
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
        snapshotByMint[JUP_MINT] = DEEP_MARKET;
        for (const mint of [JUP_MINT, RAY_MINT, SOL_MINT]) {
            const body = (await (await get(`?mint=${mint}`)).json()) as Record<string, unknown>;
            expect(Object.keys(body).sort()).toEqual(Object.keys(INSUFFICIENT).sort());
        }
    });
});
