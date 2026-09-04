import { describe, expect, test } from 'bun:test';

import { CURATED_TOKEN_ADDED_AT } from './curated-token-added-at';
import { getLatestAddedToken } from './curated-latest-added';
import type { CuratedTokenList } from './curated-token-lists';
import {
    CURRENCY_MINTS,
    ETF_MINTS,
    LST_MINTS,
    MAJORS_MINTS,
    METALS_MINTS,
    RWA_MINTS,
    STOCKS_MINTS,
} from './list-mints';

describe('curated token added-at coverage', () => {
    test('every registry list mint has a generated added-at entry', () => {
        const lists: Array<[string, readonly string[]]> = [
            ['majors', MAJORS_MINTS],
            ['lsts', LST_MINTS],
            ['currencies', CURRENCY_MINTS],
            ['rwas', RWA_MINTS],
            ['etfs', ETF_MINTS],
            ['metals', METALS_MINTS],
            ['stocks', STOCKS_MINTS],
        ];
        const missing: string[] = [];
        for (const [listId, addresses] of lists) {
            for (const address of addresses) {
                if (CURATED_TOKEN_ADDED_AT[address] === undefined) missing.push(`${listId}: ${address}`);
            }
        }

        // NOTE: never regenerate curated-token-added-at.ts in this repo — the
        // generator walks git history that the OSS squash destroyed. The
        // committed values are the final seed input; new members get their
        // added_at stamped in the database by the admin app.
        expect(missing).toEqual([]);
    });
});

describe('getLatestAddedToken', () => {
    const list = (addresses: string[]): CuratedTokenList => ({
        id: 'test',
        name: 'Test',
        description: 'test',
        addresses,
    });

    test('picks the address with the highest addedAt regardless of array order', () => {
        const result = getLatestAddedToken(list(['newest', 'middle', 'oldest']), {
            newest: 300,
            middle: 200,
            oldest: 100,
        });
        expect(result).toEqual({ address: 'newest', addedAt: 300 });
    });

    test('treats addresses missing from the map as newest', () => {
        const result = getLatestAddedToken(list(['known', 'just-added']), { known: 999 });
        expect(result).toEqual({ address: 'just-added', addedAt: null });
    });

    test('breaks timestamp ties by later array position', () => {
        const result = getLatestAddedToken(list(['a', 'b', 'c']), { a: 100, b: 100, c: 50 });
        expect(result).toEqual({ address: 'b', addedAt: 100 });
    });

    test('returns null for an empty list', () => {
        expect(getLatestAddedToken(list([]), {})).toBeNull();
    });
});
