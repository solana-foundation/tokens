import { describe, expect, test } from 'bun:test';

import { cleanTokenName } from './logo-overrides';

describe('cleanTokenName', () => {
    test.each([
        ['Nasdaq xStock', 'Nasdaq'],
        ['Tesla xStock', 'Tesla'],
        ['SpaceX Prestock', 'SpaceX'],
        ['SpaceX PreStocks', 'SpaceX'],
        ['SpaceX - Prestock', 'SpaceX'],
        ['SpaceX (PreStocks)', 'SpaceX'],
        ['Jupiter Staked SOL', 'Jupiter'],
        ['Marinade staked SOL (mSOL)', 'Marinade'],
        ['Wrapped Ether', 'Ether'],
        ['Coinbase Wrapped BTC', 'BTC'],
        ['Ether (Wormhole)', 'Ether'],
        ['USD Coin (Bridged)', 'USD Coin'],
        ['Ondo Tokenized Treasury (Ondo Tokenized)', 'Ondo Tokenized Treasury'],
        ['(Wormhole) Coinbase Wrapped BTC', 'BTC'],
        ['Foo Wrapped (Bridged)', 'Foo'],
        ['Foo Wrapped Bar', 'Foo Bar'],
        ['  Nasdaq\txStock \n', 'Nasdaq'],
        ['Jito\n\nStaked   SOL', 'Jito'],
        ['Solana', 'Solana'],
        ['', 'Unknown'],
        ['   ', 'Unknown'],
        ['xStock', 'Unknown'],
    ])('%j -> %j', (input, expected) => {
        expect(cleanTokenName(input)).toBe(expected);
    });

    test('undefined is Unknown', () => {
        expect(cleanTokenName(undefined)).toBe('Unknown');
    });

    test('long whitespace runs do not blow up', () => {
        const input = `${'x'.repeat(10)}${' '.repeat(100_000)}y`;
        const started = performance.now();
        const out = cleanTokenName(input);
        expect(performance.now() - started).toBeLessThan(50);
        expect(out).toBe('xxxxxxxxxx y');
    });
});
