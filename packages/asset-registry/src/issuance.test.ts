import { describe, expect, test } from 'bun:test';
import { ISSUANCE_OVERRIDES } from './data/issuance-overrides';
import {
    DERIVATIVE_KINDS,
    VARIANT_ISSUANCE,
    isVariantIssuance,
    issuanceFromKind,
    issuanceOverrideKey,
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
