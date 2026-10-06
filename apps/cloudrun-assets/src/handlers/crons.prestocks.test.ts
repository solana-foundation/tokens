import { describe, expect, test } from 'bun:test';

import { makePreStocksClient } from '../clients';
import {
    refreshPrestocksPrices,
    type PreStocksApiSnapshot,
    type PrestocksCronDeps,
    type PrestocksPriceUpsert,
} from './crons.prestocks';

const ANDURIL_MINT = 'PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB';
const KALSHI_MINT = 'PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua';

function snapshot(overrides: Partial<PreStocksApiSnapshot> = {}): PreStocksApiSnapshot {
    return {
        symbol: 'ANDURIL',
        name: 'Anduril PreStocks',
        mint: ANDURIL_MINT,
        markPriceUsd: 132.81,
        markValuationUsd: 107_948_980_944,
        tokenPriceUsd: 174.01,
        impliedValuationUsd: 141_433_261_696,
        supply: 10_227.73,
        imageUrl: 'https://www.prestocks.com/logos/anduril.png',
        externalUrl: 'https://www.prestocks.com/anduril',
        ...overrides,
    };
}

function makeDeps(overrides: Partial<PrestocksCronDeps> = {}): {
    deps: PrestocksCronDeps;
    upserts: PrestocksPriceUpsert[];
} {
    const upserts: PrestocksPriceUpsert[] = [];
    const deps: PrestocksCronDeps = {
        prestocks: { async fetchAll() { return [snapshot()]; } },
        repo: {
            async upsertLatest(row) {
                upserts.push(row);
            },
        },
        now: () => 1_786_406_400_000,
        listings: [{ mint: ANDURIL_MINT, symbol: 'ANDURIL', name: 'Anduril', assetId: 'pre-prestj4y' }],
        isRefreshEnabled: () => true,
        ...overrides,
    };
    return { deps, upserts };
}

describe('makePreStocksClient', () => {
    const andurilEntry =
        '{"name":"Anduril PreStocks","symbol":"ANDURIL","description":"Line one.\n\nLine two.",' +
        `"image":"https://www.prestocks.com/logos/anduril.png","external_url":"https://www.prestocks.com/anduril",` +
        `"contract_address":"${ANDURIL_MINT}","markPrice":132.81263967,"markValuation":107948980944,` +
        '"tokenPrice":174.00957611,"impliedValuation":141433261696,"supply":10227.733508798}';

    test('parses the listing array, tolerating raw control characters in descriptions', async () => {
        // prestocks.com has returned literal newlines inside the description
        // string, which strict JSON.parse rejects.
        const body =
            `[${andurilEntry},` +
            `{"name":"Kalshi PreStocks","symbol":"KALSHI","contract_address":"${KALSHI_MINT}",` +
            '"markPrice":939.7,"markValuation":34179254738,"tokenPrice":null,"impliedValuation":null,"supply":null}]';
        const requested: string[] = [];
        const fetchImpl = (async (input: string | URL | Request) => {
            requested.push(String(input));
            return new Response(body, { status: 200 });
        }) as unknown as typeof fetch;

        const client = makePreStocksClient({ fetchImpl });
        const out = await client.fetchAll();

        expect(requested).toEqual(['https://prestocks.com/api/prestocks']);
        expect(out).toHaveLength(2);
        expect(out[0]?.symbol).toBe('ANDURIL');
        expect(out[0]?.mint).toBe(ANDURIL_MINT);
        expect(out[0]?.markPriceUsd).toBe(132.81263967);
        expect(out[0]?.markValuationUsd).toBe(107948980944);
        expect(out[0]?.tokenPriceUsd).toBe(174.00957611);
        expect(out[0]?.impliedValuationUsd).toBe(141433261696);
        expect(out[0]?.supply).toBe(10227.733508798);
        expect(out[1]?.mint).toBe(KALSHI_MINT);
        expect(out[1]?.tokenPriceUsd).toBeNull();
        expect(out[1]?.imageUrl).toBeNull();
    });

    test('skips entries without a mint or symbol', async () => {
        const body = `[${andurilEntry},{"symbol":"NOMINT","markPrice":1},{"contract_address":"${KALSHI_MINT}"},null]`;
        const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
        const client = makePreStocksClient({ fetchImpl });
        const out = await client.fetchAll();
        expect(out.map(entry => entry.symbol)).toEqual(['ANDURIL']);
    });

    test('throws when the response is not an array', async () => {
        const fetchImpl = (async () => new Response(andurilEntry, { status: 200 })) as unknown as typeof fetch;
        const client = makePreStocksClient({ fetchImpl });
        await expect(client.fetchAll()).rejects.toThrow('PreStocks response is not an array');
    });

    test('throws on non-OK responses', async () => {
        const fetchImpl = (async () => new Response('upstream error', { status: 502 })) as unknown as typeof fetch;
        const client = makePreStocksClient({ fetchImpl });
        await expect(client.fetchAll()).rejects.toThrow('PreStocks request failed');
    });
});

describe('refreshPrestocksPrices', () => {
    test('skips everything when the refresh flag is off', async () => {
        const { deps, upserts } = makeDeps({ isRefreshEnabled: () => false });
        const out = await refreshPrestocksPrices(deps, {});
        expect(out.disabled).toBe(true);
        expect(out.processed).toBe(0);
        expect(upserts).toHaveLength(0);
    });

    test('requireRefreshEnabled: false bypasses the flag', async () => {
        const { deps, upserts } = makeDeps({ isRefreshEnabled: () => false });
        const out = await refreshPrestocksPrices(deps, { requireRefreshEnabled: false });
        expect(out.disabled).toBe(false);
        expect(out.succeeded).toBe(1);
        expect(upserts).toHaveLength(1);
    });

    test('upserts snapshots stamped with lastFetchedAt', async () => {
        const { deps, upserts } = makeDeps();
        const out = await refreshPrestocksPrices(deps, {});
        expect(out.succeeded).toBe(1);
        expect(out.failed).toBe(0);
        expect(upserts).toHaveLength(1);
        expect(upserts[0]?.mint).toBe(ANDURIL_MINT);
        expect(upserts[0]?.lastFetchedAt).toBe(1_786_406_400_000);
    });

    test('fetches the provider list once for all listings', async () => {
        let calls = 0;
        const { deps, upserts } = makeDeps({
            listings: [
                { mint: KALSHI_MINT, symbol: 'KALSHI', name: 'Kalshi', assetId: 'pre-prelwgkk' },
                { mint: ANDURIL_MINT, symbol: 'ANDURIL', name: 'Anduril', assetId: 'pre-prestj4y' },
            ],
            prestocks: {
                async fetchAll() {
                    calls += 1;
                    return [snapshot(), snapshot({ symbol: 'KALSHI', mint: KALSHI_MINT })];
                },
            },
        });
        const out = await refreshPrestocksPrices(deps, {});
        expect(calls).toBe(1);
        expect(out.succeeded).toBe(2);
        expect(upserts.map(row => row.mint)).toEqual([KALSHI_MINT, ANDURIL_MINT]);
    });

    test('does not upsert on fetch failure (keeps last snapshot)', async () => {
        const { deps, upserts } = makeDeps({
            prestocks: {
                async fetchAll() {
                    throw new Error('provider down');
                },
            },
        });
        const out = await refreshPrestocksPrices(deps, {});
        expect(out.ok).toBe(false);
        expect(out.succeeded).toBe(0);
        expect(out.failed).toBe(1);
        expect(upserts).toHaveLength(0);
    });

    test('counts a listing missing from the provider response as failed', async () => {
        const { deps, upserts } = makeDeps({
            listings: [
                { mint: KALSHI_MINT, symbol: 'KALSHI', name: 'Kalshi', assetId: 'pre-prelwgkk' },
                { mint: ANDURIL_MINT, symbol: 'ANDURIL', name: 'Anduril', assetId: 'pre-prestj4y' },
            ],
        });
        const out = await refreshPrestocksPrices(deps, {});
        expect(out.ok).toBe(true);
        expect(out.succeeded).toBe(1);
        expect(out.failed).toBe(1);
        expect(upserts.map(row => row.mint)).toEqual([ANDURIL_MINT]);
    });

    test('never writes provider entries for mints outside our listings', async () => {
        const { deps, upserts } = makeDeps({
            prestocks: {
                async fetchAll() {
                    return [snapshot(), snapshot({ symbol: 'KALSHI', mint: KALSHI_MINT })];
                },
            },
        });
        const out = await refreshPrestocksPrices(deps, {});
        expect(out.succeeded).toBe(1);
        expect(out.failed).toBe(0);
        expect(upserts.map(row => row.mint)).toEqual([ANDURIL_MINT]);
    });

    test('continues past per-listing upsert failures', async () => {
        const upserts: PrestocksPriceUpsert[] = [];
        const { deps } = makeDeps({
            listings: [
                { mint: KALSHI_MINT, symbol: 'KALSHI', name: 'Kalshi', assetId: 'pre-prelwgkk' },
                { mint: ANDURIL_MINT, symbol: 'ANDURIL', name: 'Anduril', assetId: 'pre-prestj4y' },
            ],
            prestocks: {
                async fetchAll() {
                    return [snapshot(), snapshot({ symbol: 'KALSHI', mint: KALSHI_MINT })];
                },
            },
            repo: {
                async upsertLatest(row) {
                    if (row.mint === KALSHI_MINT) throw new Error('boom');
                    upserts.push(row);
                },
            },
        });
        const out = await refreshPrestocksPrices(deps, {});
        expect(out.succeeded).toBe(1);
        expect(out.failed).toBe(1);
        expect(upserts).toHaveLength(1);
    });
});
