import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
const { signPlaygroundProxyAuthPayload } = await import('@/effect/playground-proxy-auth');
const { GET: legacyNewsGet } = await import('../../../coingecko/news/route');
const { GET: feedGet } = await import('./route');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_ERROR = console.error;

const ENV_KEYS = [
    'COINGECKO_API_KEY',
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_PLAYGROUND_PROXY_SECRET',
    'TOKENS_USAGE_LOG_MODE',
    'TOKENS_REDIS_TARGET',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'X_BEARER_TOKEN',
    'X_API_KEY',
    'X_API_SECRET',
    'BIRDEYE_API_KEY',
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
    for (const key of ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) savedEnv[key] = value;
        else delete savedEnv[key];
        delete process.env[key];
    }

    process.env.COINGECKO_API_KEY = 'enterprise-key';
    process.env.TOKENS_CLOUDRUN_AUTH_TOKEN = 'cloudrun-token';
    process.env.TOKENS_CLOUDRUN_ASSETS_URL = 'https://assets.example.run.app';
    process.env.TOKENS_CLOUDRUN_PRICES_URL = 'https://prices.example.run.app';
    process.env.TOKENS_CLOUDRUN_USAGE_URL = 'https://usage.example.run.app';
    process.env.TOKENS_PLAYGROUND_PROXY_SECRET = 'test-playground-secret';
    process.env.TOKENS_USAGE_LOG_MODE = 'off';
    resetEnvForTests();
    __resetCloudRunClientForTesting();

    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.log = ORIGINAL_LOG;
    console.warn = ORIGINAL_WARN;
    console.error = ORIGINAL_ERROR;

    for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    resetEnvForTests();
    __resetCloudRunClientForTesting();
});

async function authHeader(): Promise<string> {
    const now = Date.now();
    return signPlaygroundProxyAuthPayload({
        apiKeyId: 'test-key',
        keyPrefix: 'tk_test',
        projectId: 'test-project',
        ownerClerkUserId: 'test-user',
        scopes: ['assets:read'],
        iat: now,
        exp: now + 60_000,
    });
}

function newsArticle() {
    return {
        title: 'Bitcoin update',
        url: 'https://example.com/bitcoin',
        image: '',
        author: 'Reporter',
        posted_at: '2026-08-15T12:00:00.000Z',
        type: 'news',
        source_name: 'Example',
        related_coin_ids: ['bitcoin'],
    };
}

async function request(
    handler: (request: Request, context: never) => Promise<Response>,
    path: string,
): Promise<Response> {
    return handler(
        new Request(`https://api.example.test${path}`, {
            headers: { 'x-tokens-playground-auth': await authHeader() },
        }),
        {} as never,
    );
}

describe('CoinGecko news route catalog boundary', () => {
    it('lets active ids reach CoinGecko in both news routes', async () => {
        let upstreamCalls = 0;
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/query/coingeckoReadsGetCoinById')) {
                return new Response(JSON.stringify({ lastSyncedAt: Date.now() }), { status: 200 });
            }
            if (url.startsWith('https://pro-api.coingecko.com/api/v3/news')) {
                upstreamCalls += 1;
                return new Response(JSON.stringify([newsArticle()]), { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const feedResponse = await request(feedGet, '/api/v1/news/feed?source=news&coin_id=bitcoin');
        const legacyResponse = await request(legacyNewsGet, '/api/coingecko/news?coin_id=bitcoin');

        expect(feedResponse.status).toBe(200);
        expect(legacyResponse.status).toBe(200);
        expect(upstreamCalls).toBe(2);
    });

    it('skips a missing internal id in both news routes without an upstream call', async () => {
        let upstreamCalls = 0;
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/query/coingeckoReadsGetCoinById')) {
                return new Response('null', { status: 200 });
            }
            if (url.startsWith('https://pro-api.coingecko.com/api/v3/news')) {
                upstreamCalls += 1;
                return new Response(JSON.stringify([newsArticle()]), { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const feedResponse = await request(feedGet, '/api/v1/news/feed?source=news&coin_id=stock-tzuc3szn');
        const legacyResponse = await request(legacyNewsGet, '/api/coingecko/news?coin_id=stock-tzuc3szn');
        const feedBody = (await feedResponse.json()) as { items: unknown[] };
        const legacyBody = (await legacyResponse.json()) as unknown[];

        expect(feedResponse.status).toBe(200);
        expect(legacyResponse.status).toBe(200);
        expect(feedBody.items).toEqual([]);
        expect(legacyBody).toEqual([]);
        expect(upstreamCalls).toBe(0);
    });

    it('returns HTTP 200 with an empty feed when catalog validation fails', async () => {
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/query/coingeckoReadsGetCoinById')) {
                return new Response('catalog unavailable', { status: 500 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const response = await request(feedGet, '/api/v1/news/feed?source=news&coin_id=bitcoin');
        const body = (await response.json()) as { items: unknown[] };

        expect(response.status).toBe(200);
        expect(body.items).toEqual([]);
    });

    it('continues to fetch global news without a catalog lookup', async () => {
        let catalogCalls = 0;
        let upstreamCalls = 0;
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/query/coingeckoReadsGetCoinById')) {
                catalogCalls += 1;
                return new Response('null', { status: 200 });
            }
            if (url.startsWith('https://pro-api.coingecko.com/api/v3/news')) {
                upstreamCalls += 1;
                return new Response(JSON.stringify([newsArticle()]), { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const response = await request(feedGet, '/api/v1/news/feed?source=news');
        const body = (await response.json()) as { items: unknown[] };

        expect(response.status).toBe(200);
        expect(body.items.length).toBe(1);
        expect(catalogCalls).toBe(0);
        expect(upstreamCalls).toBe(1);
    });
});

describe('news feed X posts', () => {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';

    it('restores token-tag cashtags to $SYMBOL in tweet titles', async () => {
        process.env.X_BEARER_TOKEN = 'x-bearer';
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.startsWith('https://api.x.com/2/users/by/username/tokens')) {
                return new Response(
                    JSON.stringify({ data: { id: '1', name: 'tokens', username: 'tokens' } }),
                    { status: 200 },
                );
            }
            if (url.startsWith('https://api.x.com/2/users/1/tweets')) {
                return new Response(
                    JSON.stringify({
                        data: [
                            {
                                id: '2103467406857499101',
                                text: `BREAKING: solana:${SOL_MINT} broke above $120, up 6% on the day.`,
                                created_at: '2026-09-25T12:51:24.000Z',
                            },
                        ],
                    }),
                    { status: 200 },
                );
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const response = await request(feedGet, '/api/v1/news/feed?source=tweets&limit=5');
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: { title: string; feed_source: string }[] };
        expect(body.items.length).toBe(1);
        expect(body.items[0]?.feed_source).toBe('x');
        expect(body.items[0]?.title).toBe('BREAKING: $SOL broke above $120, up 6% on the day.');
    });

    it('matches restored cashtags against token-page terms', async () => {
        process.env.X_BEARER_TOKEN = 'x-bearer';
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.startsWith('https://api.x.com/2/users/by/username/tokens')) {
                return new Response(
                    JSON.stringify({ data: { id: '1', name: 'tokens', username: 'tokens' } }),
                    { status: 200 },
                );
            }
            if (url.startsWith('https://api.x.com/2/users/1/tweets')) {
                return new Response(
                    JSON.stringify({
                        data: [
                            {
                                id: '1',
                                text: `solana:${SOL_MINT} broke above $120.`,
                                created_at: '2026-09-25T12:51:24.000Z',
                            },
                            { id: '2', text: 'Nothing to see here.', created_at: '2026-09-25T12:50:00.000Z' },
                        ],
                    }),
                    { status: 200 },
                );
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const response = await request(feedGet, '/api/v1/news/feed?source=tweets&symbol=SOL');
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: { title: string }[] };
        expect(body.items.map(item => item.title)).toEqual(['$SOL broke above $120.']);
    });
});

describe('news feed mint resolution', () => {
    const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

    function bonkCatalogRow(lastSyncedAt = Date.now()) {
        return {
            _id: 'row-bonk',
            _creationTime: 1_700_000_000_000,
            id: 'bonk',
            symbol: 'bonk',
            name: 'Bonk',
            platforms: { solana: BONK_MINT },
            lastSyncedAt,
        };
    }

    interface FeedMeta {
        mode: string;
        coin_id: string | null;
        coin_id_source: string | null;
        mint: string | null;
        terms: string[];
    }

    it('resolves an unregistered mint to its CoinGecko coin id and fetches coin-specific news', async () => {
        const upstreamCoinIds: (string | null)[] = [];
        let byIdCalls = 0;
        let byMintArgs: unknown = null;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url.includes('/query/coingeckoReadsGetCoinBySolanaMint')) {
                byMintArgs = JSON.parse(String(init?.body ?? 'null'));
                return new Response(JSON.stringify(bonkCatalogRow()), { status: 200 });
            }
            if (url.includes('/query/coingeckoReadsGetCoinById')) {
                byIdCalls += 1;
                return new Response(JSON.stringify(bonkCatalogRow()), { status: 200 });
            }
            if (url.startsWith('https://pro-api.coingecko.com/api/v3/news')) {
                upstreamCoinIds.push(new URL(url).searchParams.get('coin_id'));
                return new Response(JSON.stringify([{ ...newsArticle(), related_coin_ids: ['bonk'] }]), {
                    status: 200,
                });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const response = await request(feedGet, `/api/v1/news/feed?source=news&mint=${BONK_MINT}`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: unknown[]; meta: FeedMeta };

        expect(byMintArgs).toEqual({ mint: BONK_MINT });
        expect(upstreamCoinIds).toEqual(['bonk']);
        // The catalog row already carried freshness; no second lookup by coin id.
        expect(byIdCalls).toBe(0);
        expect(body.items.length).toBe(1);
        expect(body.meta.mode).toBe('token');
        expect(body.meta.coin_id).toBe('bonk');
        expect(body.meta.coin_id_source).toBe('mint');
        expect(body.meta.mint).toBe(BONK_MINT);
        // Terms dedupe case-insensitively, so 'bonk' (coin id) absorbs the 'Bonk' name.
        expect(body.meta.terms).toEqual(['bonk', BONK_MINT]);
    });

    it('falls back to the global feed when the mint is not in the CoinGecko catalog', async () => {
        const upstreamCoinIds: (string | null)[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/query/coingeckoReadsGetCoinBySolanaMint')) {
                return new Response('null', { status: 200 });
            }
            if (url.startsWith('https://pro-api.coingecko.com/api/v3/news')) {
                upstreamCoinIds.push(new URL(url).searchParams.get('coin_id'));
                return new Response(JSON.stringify([newsArticle()]), { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const response = await request(feedGet, `/api/v1/news/feed?source=news&mint=${BONK_MINT}`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: unknown[]; meta: FeedMeta };

        expect(upstreamCoinIds).toEqual([null]);
        expect(body.items.length).toBe(1);
        expect(body.meta.mode).toBe('token');
        expect(body.meta.coin_id).toBeNull();
        expect(body.meta.coin_id_source).toBeNull();
        expect(body.meta.mint).toBe(BONK_MINT);
    });

    it('falls back to the global feed when the catalog lookup fails', async () => {
        const upstreamCoinIds: (string | null)[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/query/coingeckoReadsGetCoinBySolanaMint')) {
                return new Response('catalog unavailable', { status: 500 });
            }
            if (url.startsWith('https://pro-api.coingecko.com/api/v3/news')) {
                upstreamCoinIds.push(new URL(url).searchParams.get('coin_id'));
                return new Response(JSON.stringify([newsArticle()]), { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const response = await request(feedGet, `/api/v1/news/feed?source=news&mint=${BONK_MINT}`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { meta: FeedMeta };
        expect(upstreamCoinIds).toEqual([null]);
        expect(body.meta.coin_id).toBeNull();
    });

    it('skips a stale catalog row resolved from a mint without an upstream call', async () => {
        let upstreamCalls = 0;
        const staleSyncedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/query/coingeckoReadsGetCoinBySolanaMint')) {
                return new Response(JSON.stringify(bonkCatalogRow(staleSyncedAt)), { status: 200 });
            }
            if (url.startsWith('https://pro-api.coingecko.com/api/v3/news')) {
                upstreamCalls += 1;
                return new Response(JSON.stringify([newsArticle()]), { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const response = await request(feedGet, `/api/v1/news/feed?source=news&mint=${BONK_MINT}`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: unknown[]; meta: FeedMeta };
        expect(upstreamCalls).toBe(0);
        expect(body.items).toEqual([]);
        expect(body.meta.coin_id).toBe('bonk');
        expect(body.meta.coin_id_source).toBe('mint');
    });

    it('prefers an explicit coin_id over mint and skips the mint lookup', async () => {
        let byMintCalls = 0;
        const upstreamCoinIds: (string | null)[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/query/coingeckoReadsGetCoinBySolanaMint')) {
                byMintCalls += 1;
                return new Response(JSON.stringify(bonkCatalogRow()), { status: 200 });
            }
            if (url.includes('/query/coingeckoReadsGetCoinById')) {
                return new Response(JSON.stringify({ lastSyncedAt: Date.now() }), { status: 200 });
            }
            if (url.startsWith('https://pro-api.coingecko.com/api/v3/news')) {
                upstreamCoinIds.push(new URL(url).searchParams.get('coin_id'));
                return new Response(JSON.stringify([newsArticle()]), { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const response = await request(feedGet, `/api/v1/news/feed?source=news&coin_id=bitcoin&mint=${BONK_MINT}`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { meta: FeedMeta };
        expect(byMintCalls).toBe(0);
        expect(upstreamCoinIds).toEqual(['bitcoin']);
        expect(body.meta.coin_id).toBe('bitcoin');
        expect(body.meta.coin_id_source).toBe('param');
        expect(body.meta.mint).toBe(BONK_MINT);
    });

    it('rejects a malformed mint with 400 before any lookup', async () => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            throw new Error('Unexpected fetch');
        }) as typeof fetch;

        const response = await request(feedGet, '/api/v1/news/feed?source=news&mint=not-a-mint');
        expect(response.status).toBe(400);
        expect(fetchCalls).toBe(0);
    });

    it('matches @tokens posts on the symbol resolved from the mint', async () => {
        process.env.X_BEARER_TOKEN = 'x-bearer';
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/query/coingeckoReadsGetCoinBySolanaMint')) {
                return new Response(JSON.stringify(bonkCatalogRow()), { status: 200 });
            }
            if (url.startsWith('https://api.x.com/2/users/by/username/tokens')) {
                return new Response(
                    JSON.stringify({ data: { id: '1', name: 'tokens', username: 'tokens' } }),
                    { status: 200 },
                );
            }
            if (url.startsWith('https://api.x.com/2/users/1/tweets')) {
                return new Response(
                    JSON.stringify({
                        data: [
                            { id: '1', text: '$BONK burn update: 1T tokens gone.', created_at: '2026-09-25T12:51:24.000Z' },
                            { id: '2', text: 'Nothing to see here.', created_at: '2026-09-25T12:50:00.000Z' },
                        ],
                    }),
                    { status: 200 },
                );
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }) as typeof fetch;

        const response = await request(feedGet, `/api/v1/news/feed?source=tweets&mint=${BONK_MINT}`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: { title: string }[] };
        expect(body.items.map(item => item.title)).toEqual(['$BONK burn update: 1T tokens gone.']);
    });
});
