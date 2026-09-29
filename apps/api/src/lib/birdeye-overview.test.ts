import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import { fetchProviderMarketOverview, normalizeProviderOverview } from './birdeye-overview';

const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

const FULL_PAYLOAD = {
    success: true,
    data: {
        address: JUP_MINT,
        symbol: 'JUP',
        name: 'Jupiter',
        price: 0.37,
        liquidity: 11_000_000,
        marketCap: 1_200_000_000,
        fdv: 2_600_000_000,
        holder: 850_000,
        v24hUSD: 14_500_000,
    },
};

describe('normalizeProviderOverview', () => {
    it('maps the scoring fields', () => {
        expect(normalizeProviderOverview(FULL_PAYLOAD)).toEqual({
            liquidity: 11_000_000,
            marketCap: 1_200_000_000,
            holder: 850_000,
            volume24hUSD: 14_500_000,
        });
    });

    it('does not fall back to fdv for market cap', () => {
        const overview = normalizeProviderOverview({
            success: true,
            data: { liquidity: 50_000, fdv: 9_000_000 },
        });
        expect(overview).toEqual({ liquidity: 50_000, marketCap: null, holder: null, volume24hUSD: null });
    });

    it('keeps an overview that has only one of liquidity / market cap', () => {
        expect(normalizeProviderOverview({ success: true, data: { marketCap: 2_000_000 } })?.marketCap).toBe(2_000_000);
        expect(normalizeProviderOverview({ success: true, data: { liquidity: 2_000, marketCap: 0 } })?.liquidity).toBe(
            2_000,
        );
    });

    it('treats an empty or unsuccessful payload as a miss', () => {
        const misses: unknown[] = [
            null,
            undefined,
            'nope',
            {},
            { success: false },
            { success: false, data: FULL_PAYLOAD.data },
            { success: true },
            { success: true, data: null },
            { success: true, data: {} },
            { success: true, data: { liquidity: 0, marketCap: 0, holder: 0, v24hUSD: 0 } },
            { success: true, data: { liquidity: null, marketCap: null } },
            { success: true, data: { liquidity: '11000000', marketCap: Number.NaN } },
            { success: true, data: { liquidity: -5, marketCap: -1 } },
        ];
        for (const payload of misses) expect(normalizeProviderOverview(payload)).toBeNull();
    });
});

describe('fetchProviderMarketOverview', () => {
    const ORIGINAL_FETCH = globalThis.fetch;
    const ORIGINAL_LOG = console.log;
    const ORIGINAL_KEY = process.env.BIRDEYE_API_KEY;

    let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    function stubFetch(respond: () => Response | Promise<Response>): void {
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(input), init });
            return respond();
        }) as typeof fetch;
    }

    function json(body: unknown, status = 200): Response {
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }

    function run(mint: string, options?: { deadlineMs?: number }) {
        return Effect.runPromise(
            fetchProviderMarketOverview(mint, options).pipe(
                Effect.map(overview => ({ ok: true as const, overview })),
                Effect.catch(error => Effect.succeed({ ok: false as const, error: error as { _tag?: string } })),
            ),
        );
    }

    beforeEach(() => {
        calls = [];
        process.env.BIRDEYE_API_KEY = 'test-key';
        console.log = () => undefined;
    });

    afterEach(() => {
        globalThis.fetch = ORIGINAL_FETCH;
        console.log = ORIGINAL_LOG;
        if (ORIGINAL_KEY === undefined) delete process.env.BIRDEYE_API_KEY;
        else process.env.BIRDEYE_API_KEY = ORIGINAL_KEY;
    });

    it('reads the token overview for the mint, uncached', async () => {
        stubFetch(() => json(FULL_PAYLOAD));
        const result = await run(JUP_MINT);

        expect(result).toEqual({
            ok: true,
            overview: { liquidity: 11_000_000, marketCap: 1_200_000_000, holder: 850_000, volume24hUSD: 14_500_000 },
        });
        expect(calls.length).toBe(1);
        expect(calls[0]!.url).toBe(`https://public-api.birdeye.so/defi/token_overview?address=${JUP_MINT}`);
        expect(calls[0]!.init?.cache).toBe('no-store');
        expect((calls[0]!.init?.headers as Record<string, string>)['X-API-KEY']).toBe('test-key');
    });

    it('resolves null for a mint the provider does not know', async () => {
        for (const respond of [
            () => json({ success: true, data: {} }),
            () => json({ success: false, message: 'Not found' }),
            () => json({ success: false }, 404),
            () => json({ success: false, message: 'address is invalid format' }, 400),
        ]) {
            stubFetch(respond);
            expect(await run(JUP_MINT)).toEqual({ ok: true, overview: null });
        }
    });

    it('fails on a provider outage, after one retry', async () => {
        stubFetch(() => json({ success: false }, 500));
        const result = await run(JUP_MINT);

        expect(result.ok).toBe(false);
        expect(!result.ok && result.error._tag).toBe('UpstreamHttpError');
        expect(calls.length).toBe(2);
    });

    it('fails when the provider rate limits', async () => {
        stubFetch(() => json({ success: false }, 429));
        const result = await run(JUP_MINT);
        expect(!result.ok && result.error._tag).toBe('RateLimitedError');
    });

    it('fails on a rejected key rather than reporting the token as unknown', async () => {
        for (const status of [401, 403]) {
            stubFetch(() => json({ success: false }, status));
            const result = await run(JUP_MINT);
            expect(!result.ok && result.error._tag).toBe('UpstreamHttpError');
        }
    });

    it('fails without calling the provider when the key is not configured', async () => {
        delete process.env.BIRDEYE_API_KEY;
        stubFetch(() => json(FULL_PAYLOAD));
        const result = await run(JUP_MINT);

        expect(!result.ok && result.error._tag).toBe('MissingEnvError');
        expect(calls.length).toBe(0);
    });

    it('gives up on a provider that never answers', async () => {
        globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (signal?.aborted) return reject(new Error('aborted'));
                signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })) as typeof fetch;

        const started = Date.now();
        const result = await run(JUP_MINT, { deadlineMs: 50 });

        expect(!result.ok && result.error._tag).toBe('FetchFailedError');
        expect(Date.now() - started).toBeLessThan(1_500);
    });
});
