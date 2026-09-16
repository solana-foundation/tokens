/**
 * Row-mapper tests for the Postgres admin reads repo: the advisory / Webacy
 * columns are LEFT JOINed, so every mapper has to tolerate nulls, unknown
 * enum values, and bigint epochs arriving as string or bigint.
 */

import { describe, expect, it } from 'bun:test';

import type { Sql } from 'postgres';

import { PEG_TIERS, STRUCTURAL_GRADES } from '@tokens/asset-registry';

import {
    WEBACY_PEG_COVERAGE_MS,
    makePostgresAdminReadsRepo,
    mapPegHealth,
    mapStructuralHealth,
    mapVariantRow,
} from './curatedTokensReads';
import type { PgVariantWithMarketRow } from './curatedTokensReads';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Fixed clock for the 9h Webacy coverage rule; the fixtures' fetch epochs all fall inside the window. */
const NOW = 1_750_000_000_000 + 60 * 60_000;

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
        expect(mapPegHealth(pgRow(), NOW)).toBeNull();
        expect(mapPegHealth(pgRow({ peg_tier: null, peg_last_fetched_at: null }), NOW)).toBeNull();
    });

    it('returns null for an unknown tier even when the other columns are populated', () => {
        expect(
            mapPegHealth(pgRow({ peg_tier: 'severe', peg_ok: true, peg_last_fetched_at: '1750000000000' }), NOW),
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
                NOW,
            ),
        ).toEqual({
            provider: 'webacy',
            tier: 'warning',
            deviationPct: -2.4,
            ok: true,
            errorMessage: null,
            updatedAt: 1_750_000_000_000,
        });
        expect(
            mapPegHealth(
                pgRow({ peg_tier: 'ok', peg_deviation_pct: 0.01, peg_ok: true, peg_last_fetched_at: 1750000000001n }),
                NOW,
            ),
        ).toEqual({
            provider: 'webacy',
            tier: 'ok',
            deviationPct: 0.01,
            ok: true,
            errorMessage: null,
            updatedAt: 1_750_000_000_001,
        });
    });

    it('accepts every known tier', () => {
        for (const tier of PEG_TIERS) {
            expect(mapPegHealth(pgRow({ peg_tier: tier, peg_ok: true, peg_last_fetched_at: 1 }), 1)?.tier).toBe(tier);
        }
    });

    it('only surfaces errorMessage when the last fetch failed, and keeps the last good tier', () => {
        const failed = mapPegHealth(
            pgRow({ peg_tier: 'critical', peg_ok: false, peg_error_message: 'HTTP 502', peg_last_fetched_at: 5 }),
            5,
        );
        expect(failed).toEqual({
            provider: 'webacy',
            tier: 'critical',
            deviationPct: null,
            ok: false,
            errorMessage: 'HTTP 502',
            updatedAt: 5,
        });

        const healthyWithStaleMessage = mapPegHealth(
            pgRow({ peg_tier: 'ok', peg_ok: true, peg_error_message: 'old error', peg_last_fetched_at: 5 }),
            5,
        );
        expect(healthyWithStaleMessage?.errorMessage).toBeNull();
        expect(healthyWithStaleMessage?.ok).toBe(true);
    });

    it('returns null when the tier is known but the fetch timestamp is unusable', () => {
        expect(
            mapPegHealth(pgRow({ peg_tier: 'ok', peg_ok: true, peg_last_fetched_at: 'not-a-number' }), NOW),
        ).toBeNull();
    });

    describe('observer preference', () => {
        const pegGuard: Partial<PgVariantWithMarketRow> = {
            pg_tier: 'warning',
            pg_deviation_pct: '-1.8',
            pg_ok: true,
            pg_error_message: null,
            pg_last_fetched_at: NOW - 5 * 60_000,
            pg_last_ok_at: NOW - 5 * 60_000,
        };
        const webacyFresh: Partial<PgVariantWithMarketRow> = {
            peg_tier: 'ok',
            peg_deviation_pct: -0.02,
            peg_ok: true,
            peg_last_fetched_at: NOW - 60 * 60_000,
            peg_last_ok_at: NOW - 60 * 60_000,
        };

        it('serves Webacy while its last success is within 9h, even with a peg guard row', () => {
            const read = mapPegHealth(pgRow({ ...webacyFresh, ...pegGuard }), NOW);
            expect(read?.provider).toBe('webacy');
            expect(read?.tier).toBe('ok');
            const atBound = mapPegHealth(
                pgRow({ ...webacyFresh, ...pegGuard, peg_last_ok_at: NOW - WEBACY_PEG_COVERAGE_MS }),
                NOW,
            );
            expect(atBound?.provider).toBe('webacy');
        });

        it('falls through to the peg guard when Webacy is older than 9h, failing, or tierless', () => {
            const stale = mapPegHealth(
                pgRow({
                    ...webacyFresh,
                    ...pegGuard,
                    peg_last_ok_at: NOW - 10 * 60 * 60_000,
                    peg_last_fetched_at: NOW - 10 * 60 * 60_000,
                }),
                NOW,
            );
            expect(stale).toEqual({
                provider: 'tokens',
                tier: 'warning',
                deviationPct: -1.8,
                ok: true,
                errorMessage: null,
                updatedAt: NOW - 5 * 60_000,
            });
            expect(mapPegHealth(pgRow({ ...webacyFresh, ...pegGuard, peg_ok: false }), NOW)?.provider).toBe('tokens');
            expect(mapPegHealth(pgRow({ ...pegGuard }), NOW)?.provider).toBe('tokens');
        });

        it('uses peg_last_fetched_at as the coverage clock when peg_last_ok_at is absent (pre-0020 SELECT)', () => {
            const legacy = pgRow({ peg_tier: 'ok', peg_ok: true, peg_last_fetched_at: NOW - 60 * 60_000, ...pegGuard });
            expect(mapPegHealth(legacy, NOW)?.provider).toBe('webacy');
        });

        it('keeps a stale or failing Webacy row when no peg guard row exists', () => {
            const read = mapPegHealth(pgRow({ ...webacyFresh, peg_last_ok_at: NOW - 10 * 60 * 60_000 }), NOW);
            expect(read?.provider).toBe('webacy');
            expect(read?.tier).toBe('ok');
        });

        it('surfaces a failing peg guard poll with its last good tier', () => {
            const read = mapPegHealth(
                pgRow({ ...pegGuard, pg_ok: false, pg_error_message: 'thin_liquidity', pg_last_fetched_at: NOW }),
                NOW,
            );
            expect(read).toEqual({
                provider: 'tokens',
                tier: 'warning',
                deviationPct: -1.8,
                ok: false,
                errorMessage: 'thin_liquidity',
                updatedAt: NOW,
            });
        });
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
            NOW,
        );
        expect(monitored.pegHealth).toEqual({
            provider: 'webacy',
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
        expect(text).toContain("LEFT JOIN peg_guard_latest g ON g.chain = 'solana' AND g.address = v.mint");
        expect(text).toContain(
            "LEFT JOIN webacy_structural_health_latest s ON s.chain = 'solana' AND s.address = v.mint",
        );
        expect(text).toContain('d.tier AS peg_tier');
        expect(text).toContain('d.last_ok_at AS peg_last_ok_at');
        expect(text).toContain('g.tier AS pg_tier');
        expect(text).toContain('g.last_ok_at AS pg_last_ok_at');
        expect(text).toContain('s.composite_grade AS sh_grade');
    };

    it('joins the advisory source, both Webacy tables and the peg guard in every variant query', async () => {
        const { sql, texts } = makeFakeSql([]);
        const repo = makePostgresAdminReadsRepo(sql);
        await repo.listAllVariantsWithMarkets();
        await repo.listVariantsWithMarketsByAssetIds(['usd']);
        await repo.getVariantByMint(MINT);
        expect(texts).toHaveLength(3);
        for (const text of texts) expectWebacyJoins(text);
    });

    it('maps joined rows through mapVariantRow', async () => {
        const fetchedAt = Date.now() - 60_000;
        const { sql } = makeFakeSql([
            pgRow({
                peg_tier: 'critical',
                peg_ok: true,
                peg_deviation_pct: -8,
                peg_last_fetched_at: String(fetchedAt),
            }),
        ]);
        const repo = makePostgresAdminReadsRepo(sql);
        const row = await repo.getVariantByMint(MINT);
        expect(row?.pegHealth).toEqual({
            provider: 'webacy',
            tier: 'critical',
            deviationPct: -8,
            ok: true,
            errorMessage: null,
            updatedAt: fetchedAt,
        });
        expect(row?.structuralHealth).toBeNull();
    });

    it('serves the peg guard row for mints Webacy does not cover', async () => {
        const fetchedAt = Date.now() - 60_000;
        const { sql } = makeFakeSql([
            pgRow({ pg_tier: 'watch', pg_ok: true, pg_deviation_pct: -0.7, pg_last_fetched_at: String(fetchedAt) }),
        ]);
        const repo = makePostgresAdminReadsRepo(sql);
        const row = await repo.getVariantByMint(MINT);
        expect(row?.pegHealth?.provider).toBe('tokens');
        expect(row?.pegHealth?.tier).toBe('watch');
    });
});
