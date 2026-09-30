/**
 * Query-shape tests for the peg guard repo with a recording fake `sql`
 * (same style as db/depeg.test.ts and cloudrun-admin's curatedTokensReads.test).
 */

import { describe, expect, it } from 'bun:test';

import type { Sql } from 'postgres';

import {
    makePostgresPegGuardRepo,
    type FxRateRow,
    type PegGuardLatestRow,
    type PegGuardTierEventRow,
} from './pegGuard';

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
        referenceKind: 'fixed',
        referenceUsd: null,
        referenceUpdatedAt: null,
        lastFetchedAt: NOW,
        lastOkAt: NOW,
        ...overrides,
    };
}

function fxRow(overrides: Partial<FxRateRow> = {}): FxRateRow {
    return {
        currency: 'EUR',
        usdPerUnit: 1.1556,
        source: 'coingecko_usd_coin',
        providerUpdatedAt: NOW - 30_000,
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

    it('upsertLatest COALESCEs the reference columns so an unresolved run keeps the high-water mark', async () => {
        const { sql, queries } = makeFakeSql();
        const repo = makePostgresPegGuardRepo(sql);
        await repo.upsertLatest([
            latestRow({
                ok: false,
                errorMessage: 'no_reference',
                referenceKind: 'high_water',
                referenceUsd: null,
                referenceUpdatedAt: null,
                lastOkAt: null,
            }),
        ]);
        const q = queries[0]!;
        expect(q.text).toContain('reference_kind = COALESCE(EXCLUDED.reference_kind, peg_guard_latest.reference_kind)');
        expect(q.text).toContain('reference_usd = COALESCE(EXCLUDED.reference_usd, peg_guard_latest.reference_usd)');
        expect(q.text).toContain(
            'reference_updated_at = COALESCE(EXCLUDED.reference_updated_at, peg_guard_latest.reference_updated_at)',
        );
        expect(q.text).not.toContain('reference_usd = EXCLUDED.reference_usd');
        expect(q.params).toContain('high_water');
        expect(q.params).toContain('no_reference');
    });

    it('upsertLatest writes reference_usd and reference_updated_at in column order', async () => {
        const { sql, queries } = makeFakeSql();
        const repo = makePostgresPegGuardRepo(sql);
        await repo.upsertLatest([
            latestRow({ referenceKind: 'high_water', referenceUsd: 1.14, referenceUpdatedAt: NOW - 60_000 }),
        ]);
        const q = queries[0]!;
        expect(q.text).toContain('reference_kind, reference_usd, reference_updated_at');
        const kindIndex = q.params.indexOf('high_water');
        expect(kindIndex).toBeGreaterThan(0);
        expect(q.params[kindIndex + 1]).toBe(1.14);
        expect(q.params[kindIndex + 2]).toBe(NOW - 60_000);
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
            referenceKind: 'fx',
            source: 'manual',
            observedAt: NOW,
        };
        await repo.insertTierEvents([event]);
        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain('INSERT INTO peg_guard_tier_events');
        expect(queries[0]!.text).toContain('liquidity_usd');
        expect(queries[0]!.text).toContain('reference_kind');
        expect(String(queries[0]!.params[0])).toMatch(/^pgte_/);
        expect(queries[0]!.params).toContain('manual');
        expect(queries[0]!.params).toContain(2_000_000);
        expect(queries[0]!.params).toContain('fx');
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
                reference_kind: 'fixed',
                reference_usd: null,
                reference_updated_at: null,
                last_fetched_at: BigInt(NOW),
                last_ok_at: BigInt(NOW),
            },
        ]);
        const repo = makePostgresPegGuardRepo(sql);
        const rows = await repo.listLatest('solana');
        expect(queries[0]!.text).toContain('FROM peg_guard_latest');
        expect(queries[0]!.text).toContain('reference_kind, reference_usd, reference_updated_at');
        expect(queries[0]!.params).toEqual(['solana']);
        expect(rows).toEqual([latestRow()]);
    });

    it('listLatest maps the high-water reference columns and drops an unknown reference kind', async () => {
        const { sql } = makeFakeSql(() => [
            {
                chain: 'solana',
                address: USDC,
                symbol: 'USDY',
                peg_currency: 'USD',
                peg_usd: '1.14',
                price_usd: '1.14',
                liquidity_usd: '900000',
                deviation_pct: '0',
                tier: 'ok',
                prev_tier: null,
                tier_since_at: NOW,
                bad_since_at: null,
                observations: 1,
                ok: true,
                error_message: null,
                price_source: 'birdeye_multi_price',
                price_updated_at: NOW - 5_000,
                reference_kind: 'high_water',
                reference_usd: '1.14',
                reference_updated_at: String(NOW - 60_000),
                last_fetched_at: NOW,
                last_ok_at: NOW,
            },
            {
                chain: 'solana',
                address: 'other',
                symbol: null,
                peg_currency: null,
                peg_usd: null,
                price_usd: null,
                liquidity_usd: null,
                deviation_pct: null,
                tier: null,
                prev_tier: null,
                tier_since_at: null,
                bad_since_at: null,
                observations: 0,
                ok: false,
                error_message: 'unsupported_peg',
                price_source: null,
                price_updated_at: null,
                reference_kind: 'bogus',
                reference_usd: null,
                reference_updated_at: null,
                last_fetched_at: NOW,
                last_ok_at: null,
            },
        ]);
        const repo = makePostgresPegGuardRepo(sql);
        const rows = await repo.listLatest('solana');
        expect(rows[0]).toMatchObject({
            referenceKind: 'high_water',
            referenceUsd: 1.14,
            referenceUpdatedAt: NOW - 60_000,
            pegUsd: 1.14,
        });
        expect(rows[1]).toMatchObject({ referenceKind: null, referenceUsd: null, referenceUpdatedAt: null });
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

    it('upsertFxRates writes one statement per currency and COALESCEs last_ok_at', async () => {
        const { sql, queries } = makeFakeSql();
        const repo = makePostgresPegGuardRepo(sql);
        await repo.upsertFxRates([fxRow(), fxRow({ currency: 'GBP', usdPerUnit: 1.33, lastOkAt: null })]);
        expect(queries).toHaveLength(2);
        const q = queries[0]!;
        expect(q.text).toContain('INSERT INTO peg_fx_rates_latest');
        expect(q.text).toContain('ON CONFLICT (currency) DO UPDATE SET');
        expect(q.text).toContain('usd_per_unit = EXCLUDED.usd_per_unit');
        expect(q.text).toContain('source = EXCLUDED.source');
        expect(q.text).toContain('provider_updated_at = EXCLUDED.provider_updated_at');
        expect(q.text).toContain('last_fetched_at = EXCLUDED.last_fetched_at');
        expect(q.text).toContain('last_ok_at = COALESCE(EXCLUDED.last_ok_at, peg_fx_rates_latest.last_ok_at)');
        expect(q.params).toEqual(['EUR', 1.1556, 'coingecko_usd_coin', NOW - 30_000, NOW, NOW]);
        expect(queries[1]!.params).toEqual(['GBP', 1.33, 'coingecko_usd_coin', NOW - 30_000, NOW, null]);
    });

    it('upsertFxRates with no rows issues no query', async () => {
        const { sql, queries } = makeFakeSql();
        await makePostgresPegGuardRepo(sql).upsertFxRates([]);
        expect(queries).toHaveLength(0);
    });

    it('listFxRates maps numeric strings and bigints and drops rows with an unknown source or bad rate', async () => {
        const { sql, queries } = makeFakeSql(() => [
            {
                currency: 'EUR',
                usd_per_unit: '1.1556',
                source: 'coingecko_usd_coin',
                provider_updated_at: String(NOW - 30_000),
                last_fetched_at: BigInt(NOW),
                last_ok_at: BigInt(NOW),
            },
            {
                currency: 'GBP',
                usd_per_unit: 1.33,
                source: 'coingecko_tether',
                provider_updated_at: null,
                last_fetched_at: NOW - 7_200_000,
                last_ok_at: NOW - 7_200_000,
            },
            {
                currency: 'JPY',
                usd_per_unit: 0.0067,
                source: 'some_other_feed',
                provider_updated_at: null,
                last_fetched_at: NOW,
                last_ok_at: NOW,
            },
            {
                currency: 'CHF',
                usd_per_unit: '0',
                source: 'coingecko_usd_coin',
                provider_updated_at: null,
                last_fetched_at: NOW,
                last_ok_at: NOW,
            },
        ]);
        const repo = makePostgresPegGuardRepo(sql);
        const rows = await repo.listFxRates();
        expect(queries[0]!.text).toContain('FROM peg_fx_rates_latest');
        expect(queries[0]!.params).toEqual([]);
        expect(rows).toEqual([
            fxRow(),
            {
                currency: 'GBP',
                usdPerUnit: 1.33,
                source: 'coingecko_tether',
                providerUpdatedAt: null,
                lastFetchedAt: NOW - 7_200_000,
                lastOkAt: NOW - 7_200_000,
            },
        ]);
    });
});
