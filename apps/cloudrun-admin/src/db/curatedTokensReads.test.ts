/**
 * Row-mapper tests for the Postgres admin reads repo: the advisory / Webacy
 * columns are LEFT JOINed, so every mapper has to tolerate nulls, unknown
 * enum values, and bigint epochs arriving as string or bigint.
 */

import { describe, expect, it } from 'bun:test';

import type { Sql } from 'postgres';

import { PEG_TIERS, STRUCTURAL_GRADES } from '@tokens/asset-registry';

import { makePostgresAdminReadsRepo, mapPegHealth, mapStructuralHealth, mapVariantRow } from './curatedTokensReads';
import type { PgVariantWithMarketRow } from './curatedTokensReads';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function pgRow(overrides: Partial<PgVariantWithMarketRow> = {}): PgVariantWithMarketRow {
    return {
        asset_id: 'usd',
        mint: MINT,
        variant_id: 'usd:usdc',
        kind: 'native',
        trust_tier: 'tier1',
        tags: ['stablecoin'],
        label: null,
        issuer: null,
        issuer_url: null,
        stock_variant_tier: null,
        is_active: true,
        has_market: false,
        market_symbol: null,
        market_name: null,
        market_logo_uri: null,
        market_liquidity: null,
        market_last_fetched_at: null,
        advisory_status: null,
        advisory_reason: null,
        advisory_url: null,
        advisory_set_at: null,
        ...overrides,
    };
}

describe('mapPegHealth', () => {
    it('returns null when the Webacy join missed or the columns are absent (pre-0019 SELECT)', () => {
        expect(mapPegHealth(pgRow())).toBeNull();
        expect(mapPegHealth(pgRow({ peg_tier: null, peg_last_fetched_at: null }))).toBeNull();
    });

    it('returns null for an unknown tier even when the other columns are populated', () => {
        expect(
            mapPegHealth(pgRow({ peg_tier: 'severe', peg_ok: true, peg_last_fetched_at: '1750000000000' })),
        ).toBeNull();
    });

    it('coerces string and bigint epochs and numeric-string deviations', () => {
        expect(
            mapPegHealth(
                pgRow({
                    peg_tier: 'warning',
                    peg_deviation_pct: '-2.4',
                    peg_ok: true,
                    peg_last_fetched_at: '1750000000000',
                }),
            ),
        ).toEqual({ tier: 'warning', deviationPct: -2.4, ok: true, errorMessage: null, updatedAt: 1_750_000_000_000 });
        expect(
            mapPegHealth(
                pgRow({ peg_tier: 'ok', peg_deviation_pct: 0.01, peg_ok: true, peg_last_fetched_at: 1750000000001n }),
            ),
        ).toEqual({ tier: 'ok', deviationPct: 0.01, ok: true, errorMessage: null, updatedAt: 1_750_000_000_001 });
    });

    it('accepts every known tier', () => {
        for (const tier of PEG_TIERS) {
            expect(mapPegHealth(pgRow({ peg_tier: tier, peg_ok: true, peg_last_fetched_at: 1 }))?.tier).toBe(tier);
        }
    });

    it('only surfaces errorMessage when the last fetch failed, and keeps the last good tier', () => {
        const failed = mapPegHealth(
            pgRow({ peg_tier: 'critical', peg_ok: false, peg_error_message: 'HTTP 502', peg_last_fetched_at: 5 }),
        );
        expect(failed).toEqual({
            tier: 'critical',
            deviationPct: null,
            ok: false,
            errorMessage: 'HTTP 502',
            updatedAt: 5,
        });

        const healthyWithStaleMessage = mapPegHealth(
            pgRow({ peg_tier: 'ok', peg_ok: true, peg_error_message: 'old error', peg_last_fetched_at: 5 }),
        );
        expect(healthyWithStaleMessage?.errorMessage).toBeNull();
        expect(healthyWithStaleMessage?.ok).toBe(true);
    });

    it('returns null when the tier is known but the fetch timestamp is unusable', () => {
        expect(mapPegHealth(pgRow({ peg_tier: 'ok', peg_ok: true, peg_last_fetched_at: 'not-a-number' }))).toBeNull();
    });
});

describe('mapStructuralHealth', () => {
    it('returns null when the join missed, the columns are absent, or the grade is unknown', () => {
        expect(mapStructuralHealth(pgRow())).toBeNull();
        expect(mapStructuralHealth(pgRow({ sh_grade: null, sh_last_fetched_at: null }))).toBeNull();
        expect(mapStructuralHealth(pgRow({ sh_grade: 'G', sh_last_fetched_at: 1 }))).toBeNull();
        expect(mapStructuralHealth(pgRow({ sh_grade: 'b+', sh_last_fetched_at: 1 }))).toBeNull();
    });

    it('accepts all 14 letter grades and coerces the epoch', () => {
        expect(STRUCTURAL_GRADES).toHaveLength(14);
        for (const grade of STRUCTURAL_GRADES) {
            expect(mapStructuralHealth(pgRow({ sh_grade: grade, sh_last_fetched_at: '1749000000000' }))).toEqual({
                grade,
                updatedAt: 1_749_000_000_000,
            });
        }
    });
});

describe('mapVariantRow', () => {
    it('carries advisory source and defaults unknown/missing sources to admin', () => {
        const base = {
            advisory_status: 'caution',
            advisory_reason: 'Off peg',
            advisory_url: null,
            advisory_set_at: '1700000000000',
        };
        expect(mapVariantRow(pgRow({ ...base, advisory_source: 'webacy_depeg' })).advisory).toEqual({
            status: 'caution',
            reason: 'Off peg',
            url: null,
            since: 1_700_000_000_000,
            source: 'webacy_depeg',
        });
        expect(mapVariantRow(pgRow(base)).advisory?.source).toBe('admin');
        expect(mapVariantRow(pgRow({ ...base, advisory_source: 'mystery' })).advisory?.source).toBe('admin');
    });

    it('always emits pegHealth/structuralHealth (null when unmonitored)', () => {
        const plain = mapVariantRow(pgRow());
        expect(plain.advisory).toBeNull();
        expect(plain.pegHealth).toBeNull();
        expect(plain.structuralHealth).toBeNull();

        const monitored = mapVariantRow(
            pgRow({
                peg_tier: 'watch',
                peg_deviation_pct: -0.6,
                peg_ok: true,
                peg_last_fetched_at: '1750000000000',
                sh_grade: 'A-',
                sh_last_fetched_at: '1749000000000',
            }),
        );
        expect(monitored.pegHealth).toEqual({
            tier: 'watch',
            deviationPct: -0.6,
            ok: true,
            errorMessage: null,
            updatedAt: 1_750_000_000_000,
        });
        expect(monitored.structuralHealth).toEqual({ grade: 'A-', updatedAt: 1_749_000_000_000 });
    });
});

/** Recording fake `sql` that answers every query with the given rows. */
function makeFakeSql(rows: unknown[] = []): { sql: Sql; texts: string[] } {
    const texts: string[] = [];
    const render = (strings: TemplateStringsArray, values: unknown[]): string =>
        strings.reduce((acc, part, i) => {
            const value = values[i];
            const rendered =
                value && typeof value === 'object' && 'raw' in (value as object)
                    ? String((value as { raw: string }).raw)
                    : '$';
            return acc + part + (i < values.length ? rendered : '');
        }, '');
    const sql = Object.assign(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
            texts.push(render(strings, values));
            return rows;
        },
        {
            unsafe: (text: string) => ({ raw: text }),
            array: (value: unknown) => value,
        },
    ) as unknown as Sql;
    return { sql, texts };
}

describe('makePostgresAdminReadsRepo variant queries', () => {
    const expectWebacyJoins = (text: string) => {
        expect(text).toContain('adv.source AS advisory_source');
        expect(text).toContain("LEFT JOIN webacy_depeg_latest d ON d.chain = 'solana' AND d.address = v.mint");
        expect(text).toContain(
            "LEFT JOIN webacy_structural_health_latest s ON s.chain = 'solana' AND s.address = v.mint",
        );
        expect(text).toContain('d.tier AS peg_tier');
        expect(text).toContain('s.composite_grade AS sh_grade');
    };

    it('joins the advisory source and both Webacy tables in every variant query', async () => {
        const { sql, texts } = makeFakeSql([]);
        const repo = makePostgresAdminReadsRepo(sql);
        await repo.listAllVariantsWithMarkets();
        await repo.listVariantsWithMarketsByAssetIds(['usd']);
        await repo.getVariantByMint(MINT);
        expect(texts).toHaveLength(3);
        for (const text of texts) expectWebacyJoins(text);
    });

    it('maps joined rows through mapVariantRow', async () => {
        const { sql } = makeFakeSql([
            pgRow({ peg_tier: 'critical', peg_ok: true, peg_deviation_pct: -8, peg_last_fetched_at: '7' }),
        ]);
        const repo = makePostgresAdminReadsRepo(sql);
        const row = await repo.getVariantByMint(MINT);
        expect(row?.pegHealth).toEqual({
            tier: 'critical',
            deviationPct: -8,
            ok: true,
            errorMessage: null,
            updatedAt: 7,
        });
        expect(row?.structuralHealth).toBeNull();
    });
});
