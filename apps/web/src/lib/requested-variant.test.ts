import { describe, expect, test } from 'bun:test';

import { readRequestedVariant, requestedVariantFromPathName } from './requested-variant';

const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

describe('readRequestedVariant', () => {
    test('reads each chain key and lowercases EVM addresses', () => {
        expect(readRequestedVariant({ solana: USDC_SOLANA })).toEqual({
            chain: 'solana',
            address: USDC_SOLANA,
            key: `solana:${USDC_SOLANA}`,
        });
        expect(readRequestedVariant({ base: USDC_BASE.toUpperCase().replace('0X', '0x') })).toEqual({
            chain: 'base',
            address: USDC_BASE,
            key: `base:${USDC_BASE}`,
        });
        expect(readRequestedVariant(new URLSearchParams(`arbitrum=${USDC_BASE}`))?.key).toBe(`arbitrum:${USDC_BASE}`);
    });

    test('first valid key in canonical order wins; mismatched families are ignored', () => {
        expect(readRequestedVariant({ solana: USDC_BASE, base: USDC_BASE })?.chain).toBe('base');
        expect(readRequestedVariant({ ethereum: USDC_SOLANA })).toBeNull();
        expect(readRequestedVariant({ base: USDC_BASE, solana: USDC_SOLANA })?.chain).toBe('solana');
        expect(readRequestedVariant({ polygon: ['', USDC_BASE] })).toBeNull();
        expect(readRequestedVariant({ polygon: [USDC_BASE, 'x'] })?.chain).toBe('polygon');
        expect(readRequestedVariant({ tron: USDC_BASE, view: 'x' })).toBeNull();
        expect(readRequestedVariant(undefined)).toBeNull();
    });

    test('path names: base58 is a Solana ref, 0x and slugs are not', () => {
        expect(requestedVariantFromPathName(USDC_SOLANA)?.key).toBe(`solana:${USDC_SOLANA}`);
        expect(requestedVariantFromPathName(USDC_BASE)).toBeNull();
        expect(requestedVariantFromPathName('bitcoin')).toBeNull();
    });
});
