/**
 * Query-shape tests for the peg guard repo with a recording fake `sql`
 * (same style as db/depeg.test.ts and cloudrun-admin's curatedTokensReads.test).
 */

import { describe, expect, it } from 'bun:test';

import type { Sql } from 'postgres';

import { makePostgresPegGuardRepo, type PegGuardLatestRow, type PegGuardTierEventRow } from './pegGuard';

interface RecordedQuery {
    text: string;
    params: unknown[];
}

type Responder = (query: RecordedQuery) => unknown[];

function makeFakeSql(respond: Responder = () => []): { sql: Sql; queries: RecordedQuery[] } {
    const queries: RecordedQuery[] = [];
    const sql = Object.assign(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const query = { text: strings.join('$'), params: values };
            queries.push(query);
            return respond(query);
        },
        {
            array: (value: unknown) => value,
            json: (value: unknown) => value,
        },
    ) as unknown as Sql;
    return { sql, queries };
}

const NOW = 1_789_000_000_000;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function latestRow(overrides: Partial<PegGuardLatestRow> = {}): PegGuardLatestRow {
    return {
        chain: 'solana',
        address: USDC,
        symbol: 'USDC',
        pegCurrency: 'USD',
        pegUsd: 1,
        priceUsd: 0.9995,
        liquidityUsd: 12_000_000,
        deviationPct: -0.05,
        tier: 'ok',
        prevTier: null,
        tierSinceAt: NOW - 60_000,
        badSinceAt: null,
        observations: 2,
        ok: true,
        errorMessage: null,
        priceSource: 'birdeye_multi_price',
        priceUpdatedAt: NOW - 5_000,
        lastFetchedAt: NOW,
        lastOkAt: NOW,
        ...overrides,
    };
}

describe('makePostgresPegGuardRepo', () => {
    it('upsertLatest keeps the previous last_ok_at on a failed evaluation (COALESCE) and ids rows pgl_*', async () => {
        const { sql, queries } = makeFakeSql();
        const repo = makePostgresPegGuardRepo(sql);
        await repo.upsertLatest([latestRow({ ok: false, errorMessage: 'thin_liquidity', lastOkAt: null })]);
        expect(queries).toHaveLength(1);
        const q = queries[0]!;
        expect(q.text).toContain('INSERT INTO peg_guard_latest');
        expect(q.text).toContain('ON CONFLICT (chain, address) DO UPDATE SET');
        expect(q.text).toContain('last_ok_at = COALESCE(EXCLUDED.last_ok_at, peg_guard_latest.last_ok_at)');
        expect(String(q.params[0])).toMatch(/^pgl_/);
        expect(q.params).toContain('thin_liquidity');
        expect(q.params[q.params.length - 1]).toBeNull();
    });

    it('upsertLatest writes one statement per row and updates every observation column', async () => {
        const { sql, queries } = makeFakeSql();
        const repo = makePostgresPegGuardRepo(sql);
        await repo.upsertLatest([latestRow(), latestRow({ address: 'other', tier: 'warning' })]);
        expect(queries).toHaveLength(2);
        for (const column of [
            'tier = EXCLUDED.tier',
            'prev_tier = EXCLUDED.prev_tier',
            'bad_since_at = EXCLUDED.bad_since_at',
            'ok = EXCLUDED.ok',
            'error_message = EXCLUDED.error_message',
            'price_source = EXCLUDED.price_source',
            'price_updated_at = EXCLUDED.price_updated_at',
            'liquidity_usd = EXCLUDED.liquidity_usd',
        ]) {
            expect(queries[0]!.text).toContain(column);
        }
        expect(queries[1]!.params).toContain('warning');
    });

    it('insertTierEvents ids rows pgte_* and stores liquidity and the trigger source', async () => {
        const { sql, queries } = makeFakeSql();
        const repo = makePostgresPegGuardRepo(sql);
        const event: PegGuardTierEventRow = {
            chain: 'solana',
            address: USDC,
            oldTier: 'ok',
            newTier: 'warning',
            deviationPct: -1.5,
            priceUsd: 0.985,
            pegUsd: 1,
            liquidityUsd: 2_000_000,
            source: 'manual',
            observedAt: NOW,
        };
        await repo.insertTierEvents([event]);
        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain('INSERT INTO peg_guard_tier_events');
        expect(queries[0]!.text).toContain('liquidity_usd');
        expect(String(queries[0]!.params[0])).toMatch(/^pgte_/);
        expect(queries[0]!.params).toContain('manual');
        expect(queries[0]!.params).toContain(2_000_000);
    });

    it('listLatest maps numeric strings and bigints back to numbers and drops unknown tiers', async () => {
        const { sql, queries } = makeFakeSql(() => [
            {
                chain: 'solana',
                address: USDC,
                symbol: 'USDC',
                peg_currency: 'USD',
                peg_usd: '1',
                price_usd: '0.9995',
                liquidity_usd: 12000000n,
                deviation_pct: '-0.05',
                tier: 'ok',
                prev_tier: 'bogus',
                tier_since_at: String(NOW - 60_000),
                bad_since_at: null,
                observations: '2',
                ok: true,
                error_message: null,
                price_source: 'birdeye_multi_price',
                price_updated_at: NOW - 5_000,
                last_fetched_at: BigInt(NOW),
                last_ok_at: BigInt(NOW),
            },
        ]);
        const repo = makePostgresPegGuardRepo(sql);
        const rows = await repo.listLatest('solana');
        expect(queries[0]!.text).toContain('FROM peg_guard_latest');
        expect(queries[0]!.params).toEqual(['solana']);
        expect(rows).toEqual([latestRow()]);
    });

    it('listCurrencyVariants picks the canonical variant per mint with the token symbol', async () => {
        const { sql, queries } = makeFakeSql(() => [
            { mint: USDC, asset_id: 'usd', variant_id: 'usd:usdc', kind: 'native', is_active: true, symbol: 'USDC' },
        ]);
        const repo = makePostgresPegGuardRepo(sql);
        const out = await repo.listCurrencyVariants([USDC]);
        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain('SELECT DISTINCT ON (v.mint)');
        expect(queries[0]!.text).toContain("v.chain = 'solana'");
        expect(queries[0]!.text).toContain('COALESCE(t.symbol, a.symbol) AS symbol');
        expect(queries[0]!.text).toContain('ORDER BY v.mint, v.id ASC');
        expect(queries[0]!.params).toEqual([[USDC]]);
        expect(out.get(USDC)).toEqual({
            assetId: 'usd',
            variantId: 'usd:usdc',
            symbol: 'USDC',
            kind: 'native',
            isActive: true,
        });
    });

    it('listCurrencyVariants and listVariantMarketFallback skip the query for an empty target list', async () => {
        const { sql, queries } = makeFakeSql();
        const repo = makePostgresPegGuardRepo(sql);
        expect((await repo.listCurrencyVariants([])).size).toBe(0);
        expect((await repo.listVariantMarketFallback([])).size).toBe(0);
        expect(queries).toHaveLength(0);
    });

    it('listVariantMarketFallback reads price, liquidity and last_fetched_at from variant_markets_latest', async () => {
        const { sql, queries } = makeFakeSql(() => [
            { mint: USDC, price: '0.998', liquidity: null, last_fetched_at: String(NOW - 120_000) },
        ]);
        const repo = makePostgresPegGuardRepo(sql);
        const out = await repo.listVariantMarketFallback([USDC]);
        expect(queries[0]!.text).toContain('FROM variant_markets_latest');
        expect(out.get(USDC)).toEqual({ price: 0.998, liquidity: null, lastFetchedAt: NOW - 120_000 });
    });
});
