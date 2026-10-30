import { describe, expect, it } from 'bun:test';

import {
    computeEdge,
    formatRawAmount,
    rankQuotes,
    summarizeComparison,
    type SummarizableEntry,
} from './comparison';

const USDC_1M = '1000000000000'; // $1M at 6 decimals

describe('rankQuotes', () => {
    it('sorts best-first so index 1 is the runner-up', () => {
        const ranked = rankQuotes([
            { provider: 'jupiter' as const, outAmountRaw: '100' },
            { provider: 'titan' as const, outAmountRaw: '105' },
        ]);
        expect(ranked.map(q => q.provider)).toEqual(['titan', 'jupiter']);
    });

    it('breaks ties in provider order so Jupiter keeps the win', () => {
        const ranked = rankQuotes([
            { provider: 'titan' as const, outAmountRaw: '100' },
            { provider: 'jupiter' as const, outAmountRaw: '100' },
        ]);
        expect(ranked[0]!.provider).toBe('jupiter');
    });

    it('ranks correctly past Number.MAX_SAFE_INTEGER', () => {
        // Differ only in the last digit, beyond float precision.
        const ranked = rankQuotes([
            { provider: 'jupiter' as const, outAmountRaw: '9007199254740993' },
            { provider: 'titan' as const, outAmountRaw: '9007199254740994' },
        ]);
        expect(ranked[0]!.provider).toBe('titan');
    });
});

describe('computeEdge', () => {
    it('is null with fewer than two quotes — not zero', () => {
        expect(
            computeEdge({
                ranked: [{ provider: 'jupiter', outAmountRaw: '100' }],
                outputDecimals: 8,
                side: 'buy',
                requestRawAmount: USDC_1M,
            }),
        ).toBeNull();
    });

    it('reports zero bps for a genuine tie', () => {
        const edge = computeEdge({
            ranked: [
                { provider: 'jupiter', outAmountRaw: '1000' },
                { provider: 'titan', outAmountRaw: '1000' },
            ],
            outputDecimals: 8,
            side: 'buy',
            requestRawAmount: USDC_1M,
        });
        expect(edge?.bps).toBe(0);
        expect(edge?.outAmountDiffRaw).toBe('0');
        expect(edge?.usd).toBe(0);
    });

    it('computes gain over the runner-up in bps', () => {
        // 1% better output => ~100bps.
        const edge = computeEdge({
            ranked: [
                { provider: 'titan', outAmountRaw: '10100' },
                { provider: 'jupiter', outAmountRaw: '10000' },
            ],
            outputDecimals: 8,
            side: 'buy',
            requestRawAmount: USDC_1M,
        });
        expect(edge?.runnerUp).toBe('jupiter');
        expect(edge?.bps).toBe(100);
        expect(edge?.outAmountDiffRaw).toBe('100');
        // Notional-fraction basis: 1 - 10000/10100 ≈ 0.990099% of $1M.
        expect(edge?.usd).toBeCloseTo(9900.99, 1);
    });

    it('values a sell edge directly in USDC', () => {
        const edge = computeEdge({
            ranked: [
                { provider: 'titan', outAmountRaw: '1000500000' },
                { provider: 'jupiter', outAmountRaw: '1000000000' },
            ],
            outputDecimals: 6,
            side: 'sell',
            requestRawAmount: '100000000',
        });
        // Output is USDC: the 500000 raw surplus is $0.50.
        expect(edge?.usd).toBe(0.5);
        expect(edge?.outAmountDiff).toBe('0.5');
    });

    it('keeps precision on 18-decimal amounts', () => {
        const edge = computeEdge({
            ranked: [
                { provider: 'titan', outAmountRaw: '1000000000000000001' },
                { provider: 'jupiter', outAmountRaw: '1000000000000000000' },
            ],
            outputDecimals: 18,
            side: 'buy',
            requestRawAmount: USDC_1M,
        });
        // A 1-wei difference survives; Number() would have rounded it away.
        expect(edge?.outAmountDiffRaw).toBe('1');
        expect(edge?.bps).toBe(0);
    });
});

describe('summarizeComparison', () => {
    function entry(over: Partial<SummarizableEntry> = {}): SummarizableEntry {
        return {
            request: { unit: 'usd', amount: '1000000' },
            availableProviders: ['jupiter', 'titan'],
            unavailableProviders: [],
            winner: 'titan',
            edgeBps: 10,
            ...over,
        };
    }

    it('does not count uncontested sizes as wins', () => {
        const { providerStats, summary } = summarizeComparison({
            providers: ['jupiter', 'titan'],
            entries: [
                entry({ availableProviders: ['jupiter'], unavailableProviders: ['titan'], winner: 'jupiter', edgeBps: null }),
            ],
        });
        expect(providerStats.jupiter.wins).toBe(0);
        expect(providerStats.jupiter.soleQuotes).toBe(1);
        expect(summary.comparableEntries).toBe(0);
        expect(summary.bestProviderReason).toBe('only_provider');
        expect(summary.bestProvider).toBe('jupiter');
    });

    it('excludes uncontested sizes from the aggregates', () => {
        const { summary } = summarizeComparison({
            providers: ['jupiter', 'titan'],
            entries: [
                entry({ edgeBps: 20 }),
                entry({ availableProviders: ['titan'], unavailableProviders: ['jupiter'], edgeBps: null }),
            ],
        });
        // Only the contested entry informs the median.
        expect(summary.comparableEntries).toBe(1);
        expect(summary.medianEdgeBps).toBe(20);
        expect(summary.meanEdgeBps).toBe(20);
    });

    it('prefers most wins and reports where the biggest edge was', () => {
        const { providerStats, summary } = summarizeComparison({
            providers: ['jupiter', 'titan'],
            entries: [
                entry({ request: { unit: 'usd', amount: '10000' }, edgeBps: 5 }),
                entry({ request: { unit: 'usd', amount: '1000000' }, edgeBps: 31 }),
                entry({ winner: 'jupiter', edgeBps: 2 }),
            ],
        });
        expect(providerStats.titan.wins).toBe(2);
        expect(providerStats.jupiter.wins).toBe(1);
        expect(summary.bestProvider).toBe('titan');
        expect(summary.bestProviderReason).toBe('most_wins');
        expect(summary.maxEdgeBps).toBe(31);
        expect(summary.maxEdgeAt).toEqual({ unit: 'usd', amount: '1000000' });
    });

    it('falls back to aggregate edge, then declares a tie', () => {
        const byEdge = summarizeComparison({
            providers: ['jupiter', 'titan'],
            entries: [entry({ winner: 'titan', edgeBps: 30 }), entry({ winner: 'jupiter', edgeBps: 5 })],
        });
        expect(byEdge.summary.bestProviderReason).toBe('aggregate_edge');
        expect(byEdge.summary.bestProvider).toBe('titan');

        const tied = summarizeComparison({
            providers: ['jupiter', 'titan'],
            entries: [entry({ winner: 'titan', edgeBps: 7 }), entry({ winner: 'jupiter', edgeBps: 7 })],
        });
        expect(tied.summary.bestProviderReason).toBe('tie');
        expect(tied.summary.bestProvider).toBeNull();
    });

    it('zeroes stats for providers that were not queried', () => {
        const { providerStats } = summarizeComparison({
            providers: ['jupiter'],
            entries: [entry({ availableProviders: ['jupiter'], winner: 'jupiter', edgeBps: null })],
        });
        expect(providerStats.titan).toEqual({
            quoted: 0,
            unavailable: 0,
            wins: 0,
            soleQuotes: 0,
            meanEdgeBps: null,
            medianEdgeBps: null,
        });
    });
});

describe('formatRawAmount', () => {
    it('formats without precision loss and trims trailing zeros', () => {
        expect(formatRawAmount('123456789012345678', 8)).toBe('1234567890.12345678');
        expect(formatRawAmount('1000500000', 6)).toBe('1000.5');
        expect(formatRawAmount('42', 0)).toBe('42');
    });
});
