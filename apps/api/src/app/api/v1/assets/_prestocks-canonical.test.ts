import { describe, expect, it } from 'bun:test';

import type { PrestocksPriceResult } from '@/lib/cloudrun/prestocksReads';

import { buildPreStocksCanonicalMarket, freshPreStocksByMint, selectPreStocksMints } from './_prestocks-canonical';

const ANDURIL_MINT = 'PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB';
const FIGURE_AI_MINT = 'PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd';
const TESSERA_OPENAI_MINT = 'oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ';
const NOW = 1_791_300_000_000;

function row(mint: string, overrides: Partial<PrestocksPriceResult> = {}): PrestocksPriceResult {
    return {
        mint,
        symbol: 'ANDURIL',
        name: 'Anduril PreStocks',
        markPriceUsd: 132.76,
        markValuationUsd: 107_906_188_229,
        tokenPriceUsd: 136.35,
        impliedValuationUsd: null,
        supply: null,
        lastFetchedAt: NOW - 60_000,
        source: 'prestocks',
        ...overrides,
    };
}

describe('selectPreStocksMints', () => {
    it('keeps only PreStocks mints, deduped, including admin-created listings', () => {
        expect(selectPreStocksMints([TESSERA_OPENAI_MINT, ANDURIL_MINT, FIGURE_AI_MINT, ANDURIL_MINT])).toEqual([
            ANDURIL_MINT,
            FIGURE_AI_MINT,
        ]);
    });
});

describe('freshPreStocksByMint', () => {
    it('drops missing snapshots and feeds older than 24h', () => {
        const byMint = freshPreStocksByMint(
            [
                { mint: ANDURIL_MINT, snapshot: row(ANDURIL_MINT) },
                { mint: FIGURE_AI_MINT, snapshot: row(FIGURE_AI_MINT, { lastFetchedAt: NOW - 25 * 60 * 60_000 }) },
                { mint: TESSERA_OPENAI_MINT, snapshot: null },
            ],
            NOW,
        );
        expect([...byMint.keys()]).toEqual([ANDURIL_MINT]);
        expect(byMint.get(ANDURIL_MINT)?.markPriceUsd).toBe(132.76);
    });
});

describe('buildPreStocksCanonicalMarket', () => {
    const preStocksByMint = freshPreStocksByMint([{ mint: ANDURIL_MINT, snapshot: row(ANDURIL_MINT) }], NOW);

    it('reports the implied company valuation as marketCap, from our on-chain price', () => {
        const market = buildPreStocksCanonicalMarket({
            variantMints: [TESSERA_OPENAI_MINT, ANDURIL_MINT],
            preStocksByMint,
            onChainPriceUsd: mint => (mint === ANDURIL_MINT ? 174.01 : 999),
        });
        expect(market?.source).toBe('prestocks');
        expect(market?.mint).toBe(ANDURIL_MINT);
        expect(market?.price).toBe(174.01);
        expect(market?.marketCap).toBeCloseTo((107_906_188_229 * 174.01) / 132.76, 0);
        expect(market?.impliedValuationUsd).toBe(market?.marketCap ?? null);
        expect(market?.premiumToMarkPercent).toBeCloseTo((174.01 / 132.76 - 1) * 100, 6);
        expect(market?.asOf).toBe(NOW - 60_000);
    });

    it('falls back to the provider token price when we have no on-chain price', () => {
        const market = buildPreStocksCanonicalMarket({
            variantMints: [ANDURIL_MINT],
            preStocksByMint,
            onChainPriceUsd: () => undefined,
        });
        expect(market?.price).toBe(136.35);
        expect(market?.marketCap).toBeCloseTo((107_906_188_229 * 136.35) / 132.76, 0);
    });

    it('returns null when no variant has a fresh PreStocks reference', () => {
        expect(
            buildPreStocksCanonicalMarket({
                variantMints: [TESSERA_OPENAI_MINT, FIGURE_AI_MINT],
                preStocksByMint,
                onChainPriceUsd: () => 1,
            }),
        ).toBeNull();
    });
});
