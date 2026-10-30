import { afterEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import {
    __setAssetIdRenamesForTests,
    __setAssetIdRenamesLoaderForTests,
    currentAssetId,
    loadAssetIdRenames,
} from './asset-id-renames';

afterEach(() => {
    __setAssetIdRenamesForTests(null);
    __setAssetIdRenamesLoaderForTests(null);
});

describe('loadAssetIdRenames', () => {
    it('loads the table once and serves it from cache afterwards', async () => {
        let calls = 0;
        __setAssetIdRenamesLoaderForTests(() => {
            calls += 1;
            return Effect.succeed([{ from: 'Bitcoin', to: 'btc' }]);
        });

        const first = await Effect.runPromise(loadAssetIdRenames());
        const second = await Effect.runPromise(loadAssetIdRenames());
        expect(calls).toBe(1);
        expect(second).toBe(first);
        expect([...first]).toEqual([['bitcoin', 'btc']]); // former ids are keyed lowercased
    });

    it('shares one in-flight load between concurrent callers', async () => {
        let calls = 0;
        __setAssetIdRenamesLoaderForTests(() => {
            calls += 1;
            return Effect.promise(() => new Promise(resolve => setTimeout(() => resolve([{ from: 'a', to: 'b' }]), 5)));
        });

        const [one, two] = await Promise.all([
            Effect.runPromise(loadAssetIdRenames()),
            Effect.runPromise(loadAssetIdRenames()),
        ]);
        expect(calls).toBe(1);
        expect(one.get('a')).toBe('b');
        expect(two.get('a')).toBe('b');
    });

    it('is empty, not failing, when the load fails, and backs off before retrying', async () => {
        let calls = 0;
        __setAssetIdRenamesLoaderForTests(() => {
            calls += 1;
            return Effect.die(new Error('assets service down'));
        });

        expect((await Effect.runPromise(loadAssetIdRenames())).size).toBe(0);
        expect((await Effect.runPromise(loadAssetIdRenames())).size).toBe(0);
        expect(calls).toBe(1);
    });

    it('drops malformed rows', async () => {
        __setAssetIdRenamesLoaderForTests(() =>
            Effect.succeed([
                { from: '', to: 'x' },
                { from: 'same', to: 'same' },
                { from: 'ok', to: 'renamed' },
                null,
            ] as never),
        );
        expect([...(await Effect.runPromise(loadAssetIdRenames()))]).toEqual([['ok', 'renamed']]);
    });
});

describe('currentAssetId', () => {
    it('returns the renamed id for a former id, in any case, and the input otherwise', () => {
        const renames = new Map([['bitcoin', 'btc']]);
        expect(currentAssetId(renames, 'bitcoin')).toBe('btc');
        expect(currentAssetId(renames, ' Bitcoin ')).toBe('btc');
        expect(currentAssetId(renames, 'ethereum')).toBe('ethereum');
        expect(currentAssetId(renames, 'btc')).toBe('btc');
    });
});
