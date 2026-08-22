import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { resetEnvForTests } = await import('@/lib/env');
const { signPlaygroundProxyAuthPayload } = await import('@/effect/playground-proxy-auth');
const { GET: linksGet } = await import('./route');

const ORIGINAL_LOG = console.log;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_ERROR = console.error;

const ENV_KEYS = ['TOKENS_PLAYGROUND_PROXY_SECRET', 'TOKENS_USAGE_LOG_MODE', 'EXECUTION_LINKS_ICON_BASE_URL'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CBBTC_MINT = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';

beforeEach(() => {
    for (const key of ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) savedEnv[key] = value;
        else delete savedEnv[key];
        delete process.env[key];
    }
    process.env.TOKENS_PLAYGROUND_PROXY_SECRET = 'test-playground-secret';
    process.env.TOKENS_USAGE_LOG_MODE = 'off';
    resetEnvForTests();

    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
});

afterEach(() => {
    console.log = ORIGINAL_LOG;
    console.warn = ORIGINAL_WARN;
    console.error = ORIGINAL_ERROR;

    for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    resetEnvForTests();
});

async function authHeader(scopes: string[]): Promise<string> {
    const now = Date.now();
    return signPlaygroundProxyAuthPayload({
        apiKeyId: 'test-key',
        keyPrefix: 'tk_test',
        projectId: 'test-project',
        ownerClerkUserId: 'test-user',
        scopes,
        iat: now,
        exp: now + 60_000,
    });
}

async function request(path: string, scopes: string[] = ['execution:read']): Promise<Response> {
    return linksGet(
        new Request(`https://api.example.test${path}`, {
            headers: { 'x-tokens-playground-auth': await authHeader(scopes) },
        }),
        {} as never,
    );
}

describe('GET /api/v2/execution/links', () => {
    it('returns all venues with an absolutized icon and titan primary for a mint', async () => {
        const response = await request(`/api/v2/execution/links?mint=${CBBTC_MINT}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, max-age=3600');

        const body = await response.json();
        expect(body.buyMint).toBe(CBBTC_MINT);
        expect(body.sellMint).toBe(SOL_MINT);
        expect(body.primary).toBe('titan');
        expect(body.meta).toEqual({ kinds: ['swap'] });
        expect(body.links.map((link: { id: string }) => link.id)).toEqual([
            'titan',
            'jupiter',
            'dflow',
            'sunrise',
            'omfg',
            'kamino',
            'orca',
            'raydium',
            'byreal',
        ]);
        for (const link of body.links) {
            expect(link.kind).toBe('swap');
            expect(['aggregator', 'dex']).toContain(link.venueType);
            expect(new URL(link.url).href.length).toBeGreaterThan(0);
            if (link.iconUrl) expect(link.iconUrl.startsWith('https://')).toBe(true);
        }
        const titan = body.links.find((link: { id: string }) => link.id === 'titan');
        expect(titan.iconUrl).toBe('https://tokens.xyz/logos/popular/titan.png');
        expect(body.asset?.assetId).toBe('bitcoin');
    });

    it('sells USDC when buying SOL', async () => {
        const response = await request(`/api/v2/execution/links?mint=${SOL_MINT}`);
        const body = await response.json();
        expect(body.sellMint).toBe(USDC_MINT);
    });

    it('honors the venues filter and nulls primary when titan is excluded', async () => {
        const response = await request(`/api/v2/execution/links?mint=${CBBTC_MINT}&venues=orca,jupiter`);
        const body = await response.json();
        expect(body.links.map((link: { id: string }) => link.id)).toEqual(['jupiter', 'orca']);
        expect(body.primary).toBeNull();
    });

    it('rejects unknown venues with valid ids in the message', async () => {
        const response = await request(`/api/v2/execution/links?mint=${CBBTC_MINT}&venues=orca,uniswap`);
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error._tag).toBe('BadRequestError');
        expect(body.error.message).toContain('uniswap');
        expect(body.error.message).toContain('titan');
    });

    it('rejects unknown kinds', async () => {
        const response = await request(`/api/v2/execution/links?mint=${CBBTC_MINT}&kinds=perps`);
        expect(response.status).toBe(400);
    });

    it('requires exactly one of mint and assetId', async () => {
        const both = await request(`/api/v2/execution/links?mint=${CBBTC_MINT}&assetId=bitcoin`);
        expect(both.status).toBe(400);

        const neither = await request('/api/v2/execution/links');
        expect(neither.status).toBe(400);
    });

    it('resolves assetId to the primary variant mint', async () => {
        const response = await request('/api/v2/execution/links?assetId=bitcoin');
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.asset?.assetId).toBe('bitcoin');
        expect(typeof body.buyMint).toBe('string');
        expect(body.links.length).toBeGreaterThan(0);
    });

    it('404s for an unknown assetId', async () => {
        const response = await request('/api/v2/execution/links?assetId=not-a-real-asset');
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body.error._tag).toBe('NotFoundError');
    });

    it('rejects an invalid mint', async () => {
        const response = await request('/api/v2/execution/links?mint=not-a-mint');
        expect(response.status).toBe(400);
    });

    it('rejects a non-decimal amount', async () => {
        const response = await request(`/api/v2/execution/links?mint=${CBBTC_MINT}&amount=1,5`);
        expect(response.status).toBe(400);
    });

    it('403s without the execution:read scope', async () => {
        const response = await request(`/api/v2/execution/links?mint=${CBBTC_MINT}`, ['assets:read']);
        expect(response.status).toBe(403);
    });
});
