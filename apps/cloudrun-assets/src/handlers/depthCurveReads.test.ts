import { describe, expect, it } from 'bun:test';

import { getLatestByMints, type DepthCurveReadsRepo, type DepthCurveRow } from './depthCurveReads';

const MINT_A = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
const MINT_B = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';

function row(mint: string, overrides: Partial<DepthCurveRow> = {}): DepthCurveRow {
    return {
        mint,
        quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        side: 'buy',
        source: 'titan',
        ladder: [
            {
                sizeUsd: 10_000,
                inAmount: 10_000_000_000,
                outAmount: 9_000_000,
                priceImpactBps: 0,
                effectivePrice: 0.0009,
                routeVenues: ['Fake'],
                contextSlot: 123,
            },
            { bogus: true },
        ],
        points: 1,
        failed_points: 3,
        as_of: 1_700_000_000,
        last_computed_at: 1_700_000_000_000,
        ...overrides,
    };
}

function repoWith(rows: DepthCurveRow[], onArgs?: (args: unknown) => void): DepthCurveReadsRepo {
    return {
        async findLatestByMints(args) {
            onArgs?.(args);
            return rows;
        },
    };
}

describe('depthCurveReads.getLatestByMints', () => {
    it('validates args', async () => {
        const repo = repoWith([]);
        await expect(getLatestByMints(repo, null)).rejects.toThrow('args must be an object');
        await expect(getLatestByMints(repo, {})).rejects.toThrow('mints must be an array of strings');
        await expect(getLatestByMints(repo, { mints: [42] })).rejects.toThrow('mints must be an array of strings');
        await expect(getLatestByMints(repo, { mints: [MINT_A], side: 'hold' })).rejects.toThrow(
            'side must be buy or sell',
        );
        await expect(getLatestByMints(repo, { mints: [MINT_A], source: 'other' })).rejects.toThrow(
            'source must be one of',
        );
        await expect(getLatestByMints(repo, { mints: [MINT_A], quoteMint: ' ' })).rejects.toThrow(
            'quoteMint must be a non-empty string',
        );
    });

    it('defaults side/source/quoteMint and preserves request order with nulls', async () => {
        let seen: unknown;
        const repo = repoWith([row(MINT_B)], args => {
            seen = args;
        });
        const entries = await getLatestByMints(repo, { mints: [MINT_A, MINT_B] });
        expect(seen).toEqual({
            mints: [MINT_A, MINT_B],
            quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            side: 'buy',
            source: 'titan',
        });
        expect(entries.map(entry => entry.mint)).toEqual([MINT_A, MINT_B]);
        expect(entries[0]?.depthCurve).toBeNull();
        expect(entries[1]?.depthCurve?.mint).toBe(MINT_B);
    });

    it('maps rows to docs and drops malformed ladder points', async () => {
        const repo = repoWith([row(MINT_A)]);
        const [entry] = await getLatestByMints(repo, { mints: [MINT_A] });
        const doc = entry!.depthCurve!;
        expect(doc.side).toBe('buy');
        expect(doc.source).toBe('titan');
        expect(doc.ladder).toHaveLength(1); // the bogus point is dropped
        expect(doc.ladder[0]).toEqual({
            sizeUsd: 10_000,
            inAmount: 10_000_000_000,
            outAmount: 9_000_000,
            priceImpactBps: 0,
            effectivePrice: 0.0009,
            routeVenues: ['Fake'],
            contextSlot: 123,
        });
        expect(doc.failedPoints).toBe(3);
    });

    it('nulls docs with an unknown source and caps mints at 250', async () => {
        const repo = repoWith([row(MINT_A, { source: 'mystery' })]);
        const [entry] = await getLatestByMints(repo, { mints: [MINT_A] });
        expect(entry?.depthCurve).toBeNull();

        const manyMints = Array.from({ length: 300 }, (_, i) => `${MINT_A.slice(0, -3)}${String(i).padStart(3, '0')}`);
        let seen: { mints: readonly string[] } | undefined;
        const capRepo = repoWith([], args => {
            seen = args as { mints: readonly string[] };
        });
        await getLatestByMints(capRepo, { mints: manyMints });
        expect(seen?.mints).toHaveLength(250);
    });

    it('returns empty for an empty mints list without a repo call', async () => {
        const repo = repoWith([], () => {
            throw new Error('should not be called');
        });
        expect(await getLatestByMints(repo, { mints: [] })).toEqual([]);
    });
});
