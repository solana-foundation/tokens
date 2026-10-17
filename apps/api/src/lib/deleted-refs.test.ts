import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import {
    __deletedRefsMemoSizeForTests,
    __resetDeletedRefsForTests,
    __setDeletedRefsForTests,
    __setDeletedRefsLoaderForTests,
    listDeletedRefs,
} from './deleted-refs';

const ORIGINAL_FLAG = process.env.TOKENS_DELETED_REFS_MEMO;

let calls: string[][] = [];
let deletedOnServer: Set<string> = new Set();
let failNext = false;

function installLoader(): void {
    __setDeletedRefsLoaderForTests(({ refs }) =>
        Effect.suspend(() => {
            calls.push([...refs]);
            if (failNext) {
                failNext = false;
                return Effect.fail(new Error('assets down') as never);
            }
            return Effect.succeed(refs.filter(ref => deletedOnServer.has(ref)));
        }),
    );
}

beforeEach(() => {
    delete process.env.TOKENS_DELETED_REFS_MEMO;
    calls = [];
    deletedOnServer = new Set();
    failNext = false;
    __resetDeletedRefsForTests();
    installLoader();
});

afterEach(() => {
    __resetDeletedRefsForTests();
    if (ORIGINAL_FLAG === undefined) delete process.env.TOKENS_DELETED_REFS_MEMO;
    else process.env.TOKENS_DELETED_REFS_MEMO = ORIGINAL_FLAG;
});

const run = (refs: string[]) => Effect.runPromise(listDeletedRefs({ refs }));

describe('listDeletedRefs memo', () => {
    it('answers repeated refs from the memo after one round-trip, positive and negative', async () => {
        deletedOnServer = new Set(['gone-coin']);
        expect(await run(['gone-coin', 'bitcoin'])).toEqual(['gone-coin']);
        expect(calls).toEqual([['gone-coin', 'bitcoin']]);

        expect(await run(['bitcoin'])).toEqual([]);
        expect(await run(['gone-coin'])).toEqual(['gone-coin']);
        expect(calls.length).toBe(1);
    });

    it('normalises and de-duplicates like the server, and returns refs in first-occurrence order', async () => {
        deletedOnServer = new Set(['gone-coin', 'other']);
        const out = await run(['  Other ', 'GONE-COIN', 'gone-coin', '', 'bitcoin']);
        expect(out).toEqual(['other', 'gone-coin']);
        expect(calls).toEqual([['other', 'gone-coin', 'bitcoin']]);
    });

    it('only sends the unknown refs when some are already memoised', async () => {
        __setDeletedRefsForTests({ deleted: ['gone-coin'], live: ['bitcoin'] });
        deletedOnServer = new Set(['gone-coin', 'also-gone']);
        const out = await run(['gone-coin', 'also-gone', 'bitcoin', 'ethereum']);
        expect(out).toEqual(['gone-coin', 'also-gone']);
        expect(calls).toEqual([['also-gone', 'ethereum']]);
    });

    it('propagates loader failures and memoises nothing from a failed call', async () => {
        failNext = true;
        let thrown: unknown;
        try {
            await run(['gone-coin']);
        } catch (error) {
            thrown = error;
        }
        expect((thrown as Error | undefined)?.message).toBe('assets down');
        expect(__deletedRefsMemoSizeForTests()).toBe(0);

        deletedOnServer = new Set(['gone-coin']);
        expect(await run(['gone-coin'])).toEqual(['gone-coin']);
        expect(calls.length).toBe(2);
    });

    it('caps a call at the server limit of 2 000 refs and does not memoise the overflow', async () => {
        const refs = Array.from({ length: 2_050 }, (_, i) => `ref-${i}`);
        deletedOnServer = new Set(['ref-2049']);
        const out = await run(refs);
        expect(out).toEqual([]);
        expect(calls[0]?.length).toBe(2_000);
        expect(__deletedRefsMemoSizeForTests()).toBe(2_000);
    });

    it('evicts the oldest entries past the cap', async () => {
        for (let batch = 0; batch < 6; batch += 1) {
            await run(Array.from({ length: 2_000 }, (_, i) => `b${batch}-${i}`));
        }
        expect(__deletedRefsMemoSizeForTests()).toBe(10_000);
        // The first batch has been evicted, so asking again costs a round-trip.
        calls = [];
        await run(['b0-0']);
        expect(calls).toEqual([['b0-0']]);
        // The last batch is still memoised.
        calls = [];
        await run(['b5-1999']);
        expect(calls).toEqual([]);
    });

    it('is a pass-through when TOKENS_DELETED_REFS_MEMO=off', async () => {
        process.env.TOKENS_DELETED_REFS_MEMO = 'off';
        deletedOnServer = new Set(['gone-coin']);
        expect(await run(['gone-coin'])).toEqual(['gone-coin']);
        expect(await run(['gone-coin'])).toEqual(['gone-coin']);
        expect(calls.length).toBe(2);
        expect(__deletedRefsMemoSizeForTests()).toBe(0);
    });
});
