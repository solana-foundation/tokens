import { describe, expect, test } from 'bun:test';
import { ISSUANCE_OVERRIDES } from './data/issuance-overrides';
import {
    DERIVATIVE_KINDS,
    VARIANT_ISSUANCE,
    isVariantIssuance,
    issuanceFromKind,
    issuanceOverrideKey,
    resolveAssetIssuance,
    resolveVariantIssuance,
} from './issuance';

describe('resolveVariantIssuance', () => {
    test('kind mapping: bridged / wrapped map to themselves, derivative kinds to derivative, the rest native', () => {
        expect(issuanceFromKind('bridged')).toBe('bridged');
        expect(issuanceFromKind('wrapped')).toBe('wrapped');
        for (const kind of DERIVATIVE_KINDS) expect(issuanceFromKind(kind)).toBe('derivative');
        for (const kind of ['native', 'spot', 'stablecoin', 'tokenized_equity', 'unknown']) {
            expect(issuanceFromKind(kind)).toBe('native');
        }
    });

    test('an LST on Solana is a derivative, not issued SOL', () => {
        expect(resolveVariantIssuance({ chain: 'solana', address: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', kind: 'yield', tags: [] })).toBe('derivative');
        expect(resolveVariantIssuance({ chain: 'solana', address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', kind: 'lst', tags: [] })).toBe('derivative');
    });

    test('an explicit issuance: tag wins over kind and accepts every class', () => {
        for (const value of VARIANT_ISSUANCE) {
            expect(resolveVariantIssuance({ chain: 'base', address: '0xabc', kind: 'bridged', tags: [`issuance:${value}`] })).toBe(value);
        }
        expect(resolveVariantIssuance({ chain: 'base', address: '0xabc', kind: 'bridged', tags: ['issuance:bogus'] })).toBe('bridged');
    });

    test('the override table sits between the tag and the kind, keyed with lowercase EVM addresses', () => {
        const key = issuanceOverrideKey('bnb', '0xABCDEF0000000000000000000000000000000001');
        expect(key).toBe('bnb:0xabcdef0000000000000000000000000000000001');
        expect(issuanceOverrideKey('solana', 'EPjFWdd5AuFqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(
            'solana:EPjFWdd5AuFqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        );
        const overrides = ISSUANCE_OVERRIDES as Record<string, { issuance: 'bridged'; reason: string }>;
        overrides[key] = { issuance: 'bridged', reason: 'test' };
        try {
            expect(resolveVariantIssuance({ chain: 'bnb', address: '0xABCDEF0000000000000000000000000000000001', kind: 'stablecoin', tags: [] })).toBe('bridged');
            expect(resolveVariantIssuance({ chain: 'bnb', address: '0xABCDEF0000000000000000000000000000000001', kind: 'stablecoin', tags: ['issuance:native'] })).toBe('native');
        } finally {
            delete overrides[key];
        }
    });

    test('a standalone fund whose only variant is a yield token is the asset, so it counts as native', () => {
        const tbill = { chain: 'solana' as const, address: '4MmJVdwYN8LwvbGeCowYjSx7KoEi6BJWg8XXnW4fDDp6', kind: 'yield', tags: [] };
        expect(resolveVariantIssuance(tbill)).toBe('derivative');
        expect(resolveAssetIssuance([tbill])).toEqual(['native']);
        const tqqq = { chain: 'solana' as const, address: 'XsjQP3iMAaQ3kQScQKthQpx9ALRbjKAjQtHg6TFomoc', kind: 'leveraged', tags: [] };
        const basket = { chain: 'solana' as const, address: 'BasketMint111111111111111111111111111111111', kind: 'basket', tags: [] };
        expect(resolveAssetIssuance([tqqq, basket])).toEqual(['native', 'native']);
    });

    test('a derivative next to a native, bridged or wrapped sibling stays a derivative', () => {
        const sol = { chain: 'solana' as const, address: 'So11111111111111111111111111111111111111112', kind: 'native', tags: [] };
        const lst = { chain: 'solana' as const, address: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', kind: 'yield', tags: [] };
        expect(resolveAssetIssuance([sol, lst])).toEqual(['native', 'derivative']);
        const wrapped = { chain: 'ethereum' as const, address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', kind: 'wrapped', tags: [] };
        expect(resolveAssetIssuance([wrapped, lst])).toEqual(['wrapped', 'derivative']);
        expect(resolveAssetIssuance([])).toEqual([]);
    });

    test("a commodity's ETF-share token is never promoted: the asset is the metal, not the fund", () => {
        const slv = { chain: 'solana' as const, address: 'SilverEtfMint11111111111111111111111111111111', kind: 'etf', tags: [] };
        expect(resolveAssetIssuance([slv], { category: 'commodity' })).toEqual(['derivative']);
        expect(resolveAssetIssuance([slv], { category: 'rwa' })).toEqual(['native']);
        expect(resolveAssetIssuance([slv], { category: 'etf' })).toEqual(['native']);
        expect(resolveAssetIssuance([slv])).toEqual(['native']);
    });

    test('an explicit issuance:derivative tag is never promoted, but its kind-derived siblings are', () => {
        const fund = { chain: 'solana' as const, address: 'FundMint1111111111111111111111111111111111111', kind: 'yield', tags: [] };
        const tagged = { chain: 'solana' as const, address: 'FundMint2222222222222222222222222222222222222', kind: 'yield', tags: ['issuance:derivative'] };
        expect(resolveAssetIssuance([fund, tagged])).toEqual(['native', 'derivative']);
        expect(resolveAssetIssuance([tagged])).toEqual(['derivative']);
    });

    test('isVariantIssuance guards the union', () => {
        expect(isVariantIssuance('derivative')).toBe(true);
        expect(isVariantIssuance('native')).toBe(true);
        expect(isVariantIssuance('spot')).toBe(false);
        expect(isVariantIssuance(null)).toBe(false);
    });

    test('override keys are well-formed and lowercase for EVM chains', () => {
        for (const [key, entry] of Object.entries(ISSUANCE_OVERRIDES)) {
            const [chain, address] = key.split(':');
            expect(chain).toBeDefined();
            expect(address).toBeDefined();
            if (chain !== 'solana') expect(address).toBe(address!.toLowerCase());
            expect(isVariantIssuance(entry.issuance)).toBe(true);
            expect(entry.reason.length).toBeGreaterThan(0);
        }
    });
});
