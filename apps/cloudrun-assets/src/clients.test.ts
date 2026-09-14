import { describe, expect, test } from 'bun:test';

import { makeClickhouseClient, makeWebacyDepegClient } from './clients';
import { normalizeDepegItem, normalizeStructuralHealth, tierFromOverallRisk } from './handlers/depegNormalize';

const BASE_OPTS = {
    url: 'http://clickhouse.invalid',
    username: 'u',
    password: 'p',
    database: 'default',
    solanaTradesTable: 'trades_anza_final',
    tradingApiUrl: 'https://trading-api.test/v1/query',
} as const;

describe('fetchSolanaMintSnapshots (clickhouse-api gateway)', () => {
    test('posts the tokens_summary preset and maps rows + price change', async () => {
        const calls: Array<{ url: string; body: unknown }> = [];
        const fetchImpl = (async (url: string, init: RequestInit) => {
            calls.push({ url, body: JSON.parse(String(init.body)) });
            return new Response(
                JSON.stringify({
                    data: [
                        {
                            mint: 'MintA',
                            priceUsd: 110,
                            volume1hUsd: 5,
                            volume24hUsd: 20,
                            trade1h: 2,
                            trade24h: 8,
                            uniqueTrader1h: 1,
                            uniqueTrader24h: 4,
                            price1hAgo: 100,
                            price24hAgo: 50,
                            lastTradeAtMs: 1784018908299,
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }) as unknown as typeof fetch;

        const client = makeClickhouseClient({ ...BASE_OPTS, fetchImpl });
        const out = await client.fetchSolanaMintSnapshots({
            mints: ['MintA'],
            stableMints: ['USDC'],
            asOfMs: 2_000_000,
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe('https://trading-api.test/v1/query');
        expect(calls[0]?.body).toEqual({
            name: 'tokens_summary',
            params: { mints: ['MintA'], stables: ['USDC'] },
        });
        expect(out).toHaveLength(1);
        const s = out[0]!;
        expect(s.priceUsd).toBe(110);
        expect(s.volume24hUsd).toBe(20);
        expect(s.uniqueTrader24h).toBe(4);
        expect(s.priceChange1hPercent).toBeCloseTo(10); // (110-100)/100*100
        expect(s.priceChange24hPercent).toBeCloseTo(120); // (110-50)/50*100
        expect(s.lastTradeAt).toBe(1784018908299);
        expect(s.asOf).toBe(2000); // floor(asOfMs/1000)
    });

    test('leaves price change null when a reference price is missing', async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ data: [{ mint: 'M', priceUsd: 1, price1hAgo: null }] }), {
                status: 200,
            })) as unknown as typeof fetch;
        const client = makeClickhouseClient({ ...BASE_OPTS, fetchImpl });
        const [s] = await client.fetchSolanaMintSnapshots({ mints: ['M'], stableMints: ['USDC'] });
        expect(s?.priceChange1hPercent).toBeNull();
        expect(s?.volume24hUsd).toBe(0);
        expect(s?.asOf).toBeNull();
    });

    test('throws on a non-ok gateway response', async () => {
        const fetchImpl = (async () => new Response('upstream boom', { status: 502 })) as unknown as typeof fetch;
        const client = makeClickhouseClient({ ...BASE_OPTS, fetchImpl });
        await expect(
            client.fetchSolanaMintSnapshots({ mints: ['M'], stableMints: ['USDC'] }),
        ).rejects.toThrow('clickhouse-api HTTP 502');
    });
});

describe('makeWebacyDepegClient', () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

    function json(body: unknown, status = 200): Response {
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }

    function recordingFetch(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
        const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
            calls.push({ url, init });
            return handler(url, init);
        }) as unknown as typeof fetch;
        return { fetchImpl, calls };
    }

    function page(addresses: string[]) {
        return { tokens: addresses.map(address => ({ address, risk: { overallRisk: 10, issues: [], tags: [] }, metadata: { symbol: 'X' } })) };
    }

    test('tierFromOverallRisk bands at the 25/50/70 boundaries and premium from tags', () => {
        expect(tierFromOverallRisk(0, [])).toBe('ok');
        expect(tierFromOverallRisk(24.99, [])).toBe('ok');
        expect(tierFromOverallRisk(25, [])).toBe('watch');
        expect(tierFromOverallRisk(49.99, [])).toBe('watch');
        expect(tierFromOverallRisk(50, [])).toBe('warning');
        expect(tierFromOverallRisk(69.99, [])).toBe('warning');
        expect(tierFromOverallRisk(70, [])).toBe('critical');
        expect(tierFromOverallRisk(100, [])).toBe('critical');
        expect(tierFromOverallRisk(null, [])).toBeNull();
        expect(tierFromOverallRisk(5, ['Premium'])).toBe('premium');
        expect(tierFromOverallRisk(80, ['above_peg'])).toBe('premium');
    });

    test('normalizeDepegItem is liberal in field names and does not invent a peg', () => {
        const item = normalizeDepegItem({
            token_address: USDC,
            metadata: { symbol: 'USDC' },
            risk: { overallRisk: 62.5, tags: ['depeg_watch'], deviationPct: -2.4, priceUsd: '0.976' },
        });
        expect(item).toMatchObject({ address: USDC, symbol: 'USDC', tier: 'warning', overallRisk: 62.5, deviationPct: -2.4, priceUsd: 0.976, pegUsd: null });
        expect(item!.tags).toEqual(['depeg_watch']);
        expect(normalizeDepegItem({ mint: USDT, tier: 'CRITICAL', overallRisk: 10 })!.tier).toBe('critical');
        expect(normalizeDepegItem({ symbol: 'nope' })).toBeNull();
        expect(normalizeDepegItem(null)).toBeNull();
    });

    test('normalizeStructuralHealth reads grade, score, categories (object or array, weights as percent) and counts criteria', () => {
        const out = normalizeStructuralHealth({
            composite_grade: 'B+',
            composite_score: 31.2,
            categories: [
                { key: 'asset_collateral', score: 20, weight: 30, criteria: [{ status: 'pass' }, { status: 'fail' }] },
                { name: 'Market & Liquidity', score: 15, weight: 0.25, status: 'warn' },
                { key: 'counterparty', score: 0, weight: 0, status: 'pass' },
            ],
        });
        expect(out.compositeGrade).toBe('B+');
        expect(out.compositeScore).toBe(31.2);
        expect(out.categoryScores.asset_collateral).toEqual({ score: 20, weight: 0.3, status: 'fail' });
        expect(out.categoryScores.market_liquidity).toEqual({ score: 15, weight: 0.25, status: 'warn' });
        expect(out.categoryScores.hack_exploit_history).toEqual({ score: null, weight: null, status: 'unknown' });
        expect(Object.keys(out.categoryScores).sort()).toEqual(
            ['asset_collateral', 'hack_exploit_history', 'market_liquidity', 'operational_governance', 'smart_contract'].sort(),
        );
        expect(out.failCount).toBe(1);
        expect(out.warnCount).toBe(0);
        expect(normalizeStructuralHealth({ grade: 'Z' }).compositeGrade).toBeNull();
    });

    test('unconfigured key returns {ok:false,status:0} everywhere without touching the network', async () => {
        const { fetchImpl, calls } = recordingFetch(() => json({}));
        const client = makeWebacyDepegClient({ apiKey: undefined, fetchImpl });
        expect(client.isConfigured()).toBe(false);
        expect(await client.fetchDepegToken({ chain: 'solana', address: USDC })).toEqual({
            ok: false,
            status: 0,
            message: 'WEBACY_API_KEY not configured',
        });
        expect(await client.fetchDepegList({ chain: 'solana', pageSize: 100, maxPages: 3 })).toMatchObject({ ok: false, status: 0 });
        const batch = await client.fetchStructuralHealthBatch([{ address: USDC, chain: 'solana' }]);
        expect(batch).toEqual([{ address: USDC, ok: false, status: 0, message: 'WEBACY_API_KEY not configured' }]);
        expect(calls).toHaveLength(0);
    });

    test('fetchDepegToken hits /rwa/{address}?chain=solana with the api key and normalises the item', async () => {
        const { fetchImpl, calls } = recordingFetch(() =>
            json({ address: USDC, risk: { overallRisk: 75, tags: [] }, metadata: { symbol: 'USDC' }, deviation_pct: -3.2, peg_usd: 1 }),
        );
        const client = makeWebacyDepegClient({ apiKey: 'k', baseUrl: 'https://webacy.test/', fetchImpl });
        const out = await client.fetchDepegToken({ chain: 'solana', address: USDC });
        expect(calls[0]!.url.href).toBe(`https://webacy.test/rwa/${USDC}?chain=solana`);
        expect((calls[0]!.init!.headers as Record<string, string>)['x-api-key']).toBe('k');
        expect(out).toMatchObject({ ok: true, status: 200 });
        if (out.ok) expect(out.item).toMatchObject({ address: USDC, tier: 'critical', deviationPct: -3.2, pegUsd: 1, symbol: 'USDC' });
    });

    test('fetchDepegToken reports HTTP errors and unrecognised payloads as ok:false', async () => {
        const c404 = makeWebacyDepegClient({ apiKey: 'k', fetchImpl: recordingFetch(() => json({ error: 'nope' }, 404)).fetchImpl });
        expect(await c404.fetchDepegToken({ chain: 'solana', address: USDC })).toMatchObject({ ok: false, status: 404 });
        const cJunk = makeWebacyDepegClient({ apiKey: 'k', fetchImpl: recordingFetch(() => json({ hello: 'world' })).fetchImpl });
        expect(await cJunk.fetchDepegToken({ chain: 'solana', address: USDC })).toMatchObject({ ok: false, message: 'unrecognised depeg payload' });
    });

    test('fetchDepegList stops at maxPages and reports truncation', async () => {
        const { fetchImpl, calls } = recordingFetch(url => {
            const p = Number(url.searchParams.get('page'));
            return json(page([`Mint${p}A`, `Mint${p}B`]));
        });
        const client = makeWebacyDepegClient({ apiKey: 'k', fetchImpl });
        const out = await client.fetchDepegList({ chain: 'solana', pageSize: 2, maxPages: 3 });
        expect(out).toMatchObject({ ok: true, pages: 3, truncated: true });
        if (out.ok) expect(out.items.map(i => i.address)).toEqual(['Mint1A', 'Mint1B', 'Mint2A', 'Mint2B', 'Mint3A', 'Mint3B']);
        expect(calls.map(c => c.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
        expect(calls[0]!.url.pathname).toBe('/rwa');
        expect(calls[0]!.url.searchParams.get('chain')).toBe('solana');
        expect(calls[0]!.url.searchParams.get('pageSize')).toBe('2');
    });

    test('fetchDepegList stops on an empty page', async () => {
        const { fetchImpl, calls } = recordingFetch(url => {
            const p = Number(url.searchParams.get('page'));
            return json(p === 1 ? page([USDC, USDT]) : { tokens: [] });
        });
        const client = makeWebacyDepegClient({ apiKey: 'k', fetchImpl });
        const out = await client.fetchDepegList({ chain: 'solana', pageSize: 2, maxPages: 5 });
        expect(out).toMatchObject({ ok: true, pages: 2, truncated: false });
        if (out.ok) expect(out.items).toHaveLength(2);
        expect(calls).toHaveLength(2);
    });

    test('fetchDepegList stops when the endpoint ignores `page` and repeats the first address', async () => {
        const { fetchImpl, calls } = recordingFetch(() => json(page([USDC, USDT])));
        const client = makeWebacyDepegClient({ apiKey: 'k', fetchImpl });
        const out = await client.fetchDepegList({ chain: 'solana', pageSize: 2, maxPages: 5 });
        expect(out).toMatchObject({ ok: true, pages: 2, truncated: false });
        if (out.ok) expect(out.items.map(i => i.address)).toEqual([USDC, USDT]);
        expect(calls).toHaveLength(2);
    });

    test('fetchDepegList stops on a short page and accepts a bare array envelope', async () => {
        const { fetchImpl, calls } = recordingFetch(() => json([{ address: USDC, overallRisk: 3 }]));
        const client = makeWebacyDepegClient({ apiKey: 'k', fetchImpl });
        const out = await client.fetchDepegList({ chain: 'solana', pageSize: 100, maxPages: 3 });
        expect(out).toMatchObject({ ok: true, pages: 1, truncated: false });
        expect(calls).toHaveLength(1);
    });

    test('fetchDepegList fails the poll when the first page fails, but keeps a partial list when a later page fails', async () => {
        const first = makeWebacyDepegClient({ apiKey: 'k', fetchImpl: recordingFetch(() => json({ error: 'x' }, 503)).fetchImpl });
        expect(await first.fetchDepegList({ chain: 'solana', pageSize: 2, maxPages: 3 })).toMatchObject({ ok: false, status: 503 });

        const later = makeWebacyDepegClient({
            apiKey: 'k',
            fetchImpl: recordingFetch(url => (url.searchParams.get('page') === '1' ? json(page([USDC, USDT])) : json({}, 500))).fetchImpl,
        });
        const out = await later.fetchDepegList({ chain: 'solana', pageSize: 2, maxPages: 3 });
        expect(out).toMatchObject({ ok: true, pages: 1, truncated: true });
    });

    test('fetchStructuralHealthBatch POSTs /v3/rwa/batch and maps results by address', async () => {
        const { fetchImpl, calls } = recordingFetch(() =>
            json({ results: [{ address: USDC, composite_grade: 'A' }, { address: USDT, error: 'unsupported' }] }),
        );
        const client = makeWebacyDepegClient({ apiKey: 'k', baseUrl: 'https://webacy.test', fetchImpl });
        const out = await client.fetchStructuralHealthBatch([
            { address: USDC, chain: 'solana' },
            { address: USDT, chain: 'solana' },
        ]);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url.href).toBe('https://webacy.test/v3/rwa/batch');
        expect(calls[0]!.init!.method).toBe('POST');
        expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
            addresses: [
                { address: USDC, chain: 'solana' },
                { address: USDT, chain: 'solana' },
            ],
        });
        expect(out[0]).toMatchObject({ address: USDC, ok: true, data: { address: USDC, composite_grade: 'A' } });
        expect(out[1]).toMatchObject({ address: USDT, ok: false, message: 'unsupported' });
    });

    test('fetchStructuralHealthBatch falls back to per-address GET /v3/rwa/{address} on 404', async () => {
        const { fetchImpl, calls } = recordingFetch(url => {
            if (url.pathname === '/v3/rwa/batch') return json({ message: 'not found' }, 404);
            const address = url.pathname.split('/').pop()!;
            return address === USDT ? json({ error: 'boom' }, 500) : json({ composite_grade: 'A-' });
        });
        const client = makeWebacyDepegClient({ apiKey: 'k', fetchImpl });
        const out = await client.fetchStructuralHealthBatch([
            { address: USDC, chain: 'solana' },
            { address: USDT, chain: 'solana' },
        ]);
        expect(calls.map(c => c.url.pathname)).toEqual(['/v3/rwa/batch', `/v3/rwa/${USDC}`, `/v3/rwa/${USDT}`]);
        expect(calls[1]!.url.searchParams.get('chain')).toBe('solana');
        expect(out).toEqual([
            { address: USDC, ok: true, status: 200, data: { composite_grade: 'A-' } },
            { address: USDT, ok: false, status: 500, message: '{"error":"boom"}' },
        ]);
    });

    test('fetchStructuralHealthBatch falls back when the batch body has nothing it can map', async () => {
        const { fetchImpl, calls } = recordingFetch(url =>
            url.pathname === '/v3/rwa/batch' ? json({ queued: true }) : json({ grade: 'B' }),
        );
        const client = makeWebacyDepegClient({ apiKey: 'k', fetchImpl });
        const out = await client.fetchStructuralHealthBatch([{ address: USDC, chain: 'solana' }]);
        expect(calls).toHaveLength(2);
        expect(out[0]).toMatchObject({ ok: true, data: { grade: 'B' } });
    });

    test('a 5xx on the batch route is reported per address without fanning out', async () => {
        const { fetchImpl, calls } = recordingFetch(() => json({ error: 'down' }, 503));
        const client = makeWebacyDepegClient({ apiKey: 'k', fetchImpl });
        const out = await client.fetchStructuralHealthBatch([
            { address: USDC, chain: 'solana' },
            { address: USDT, chain: 'solana' },
        ]);
        expect(calls).toHaveLength(1);
        expect(out.every(e => !e.ok && e.status === 503)).toBe(true);
    });
});
