import { describe, expect, test } from 'bun:test';

import {
    applyFilters,
    buildFilter,
    decodeFilters,
    decodeSort,
    encodeFilters,
    encodeSort,
    formatFilter,
    parseUsdInput,
} from './filters';
import type { RegistryRow } from './types';

function row(overrides: Partial<RegistryRow>): RegistryRow {
    return {
        symbol: 'X',
        mintAddress: 'mint',
        name: null,
        logoURI: null,
        hasTokenPage: false,
        solanaClass: 'Stocks',
        rwaClass: null,
        alliumClass: null,
        rwaValueUsd: null,
        alliumValueUsd: null,
        marketCapUsd: null,
        valueUsd: null,
        ...overrides,
    };
}

describe('parseUsdInput', () => {
    test('accepts compact suffixes, dollar signs and separators', () => {
        expect(parseUsdInput('5m')).toBe(5_000_000);
        expect(parseUsdInput('$1.5b')).toBe(1_500_000_000);
        expect(parseUsdInput('2bn')).toBe(2_000_000_000);
        expect(parseUsdInput('200,000')).toBe(200_000);
        expect(parseUsdInput('0.5T')).toBe(500_000_000_000);
        expect(parseUsdInput(' 10k ')).toBe(10_000);
    });

    test('rejects junk', () => {
        expect(parseUsdInput('')).toBeNull();
        expect(parseUsdInput('five')).toBeNull();
        expect(parseUsdInput('5mm')).toBeNull();
        expect(parseUsdInput('-5')).toBeNull();
    });
});

describe('buildFilter', () => {
    test('normalizes usd text to a number and validates', () => {
        expect(buildFilter({ field: 'alliumValueUsd', op: 'gt', value: '5m' })).toEqual({
            filter: { field: 'alliumValueUsd', op: 'gt', value: 5_000_000 },
        });
        expect('error' in buildFilter({ field: 'alliumValueUsd', op: 'gt', value: 'nope' })).toBe(true);
        expect('error' in buildFilter({ field: 'alliumValueUsd', op: 'is', value: '5m' })).toBe(true);
        expect('error' in buildFilter({ field: 'solanaClass', op: 'is', value: ' ' })).toBe(true);
        expect('error' in buildFilter({ field: 'bogus', op: 'is', value: 'x' })).toBe(true);
    });
});

describe('formatFilter', () => {
    test('renders labels, symbols and compact usd', () => {
        expect(formatFilter({ field: 'alliumValueUsd', op: 'gt', value: 5_000_000 })).toBe('Allium value > $5M');
        expect(formatFilter({ field: 'marketCapUsd', op: 'lte', value: 1_250_000_000 })).toBe('Market cap ≤ $1.25B');
        expect(formatFilter({ field: 'solanaClass', op: 'is', value: 'Stocks' })).toBe('Asset class is Stocks');
        expect(formatFilter({ field: 'rwaClass', op: 'is_not', value: 'Stablecoins' })).toBe(
            'RWA.xyz class is not Stablecoins',
        );
    });
});

describe('applyFilters', () => {
    const rows = [
        row({ symbol: 'USDC', name: 'USD Coin', solanaClass: 'USD Stablecoins', alliumValueUsd: 7e9, valueUsd: 7e9 }),
        row({ symbol: 'TSLAX', solanaClass: 'Stocks', marketCapUsd: 4e6, valueUsd: 4e6, hasTokenPage: true }),
        row({ symbol: 'NOVAL', solanaClass: 'Stocks' }),
    ];

    test('search matches symbol, name or mint', () => {
        expect(applyFilters(rows, { q: 'usd coin', filters: [] }).map(r => r.symbol)).toEqual(['USDC']);
        expect(applyFilters(rows, { q: 'MINT', filters: [] })).toHaveLength(3);
    });

    test('category is / is_not', () => {
        expect(
            applyFilters(rows, { q: '', filters: [{ field: 'solanaClass', op: 'is', value: 'Stocks' }] }).map(
                r => r.symbol,
            ),
        ).toEqual(['TSLAX', 'NOVAL']);
        expect(
            applyFilters(rows, { q: '', filters: [{ field: 'solanaClass', op: 'is_not', value: 'Stocks' }] }).map(
                r => r.symbol,
            ),
        ).toEqual(['USDC']);
        expect(
            applyFilters(rows, { q: '', filters: [{ field: 'hasTokenPage', op: 'is', value: 'yes' }] }).map(
                r => r.symbol,
            ),
        ).toEqual(['TSLAX']);
    });

    test('usd comparisons never match null values', () => {
        expect(
            applyFilters(rows, { q: '', filters: [{ field: 'valueUsd', op: 'gt', value: 5_000_000 }] }).map(
                r => r.symbol,
            ),
        ).toEqual(['USDC']);
        expect(
            applyFilters(rows, { q: '', filters: [{ field: 'valueUsd', op: 'lt', value: 5_000_000 }] }).map(
                r => r.symbol,
            ),
        ).toEqual(['TSLAX']);
        expect(
            applyFilters(rows, { q: '', filters: [{ field: 'marketCapUsd', op: 'eq', value: 4e6 }] }).map(
                r => r.symbol,
            ),
        ).toEqual(['TSLAX']);
    });

    test('filters AND together with search', () => {
        expect(
            applyFilters(rows, {
                q: 'tsla',
                filters: [
                    { field: 'solanaClass', op: 'is', value: 'Stocks' },
                    { field: 'valueUsd', op: 'gte', value: 4e6 },
                ],
            }).map(r => r.symbol),
        ).toEqual(['TSLAX']);
    });
});

describe('filter url codec', () => {
    test('round-trips', () => {
        const filters = [
            { field: 'alliumValueUsd', op: 'gt', value: 5_000_000 },
            { field: 'solanaClass', op: 'is', value: 'Stocks' },
        ] as const;
        expect(decodeFilters(encodeFilters(filters))).toEqual([...filters]);
    });

    test('fails closed on garbage and drops unknown entries', () => {
        expect(decodeFilters('not json')).toEqual([]);
        expect(decodeFilters('{"a":1}')).toEqual([]);
        expect(decodeFilters('[["bogus","is","x"],["solanaClass","is","Stocks"],["valueUsd","gt","abc"]]')).toEqual([
            { field: 'solanaClass', op: 'is', value: 'Stocks' },
        ]);
    });
});

describe('sort url codec', () => {
    test('round-trips sortable columns only', () => {
        expect(decodeSort(encodeSort({ id: 'marketCapUsd', desc: true }))).toEqual({ id: 'marketCapUsd', desc: true });
        expect(decodeSort('token.asc')).toEqual({ id: 'token', desc: false });
        expect(decodeSort('valueUsd.desc')).toBeNull();
        expect(decodeSort('marketCapUsd.sideways')).toBeNull();
        expect(decodeSort('')).toBeNull();
    });
});
