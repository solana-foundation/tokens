import { describe, expect, test } from 'bun:test';

import { CHAIN_KINDS } from '@tokens/asset-registry/chains';

import { buildCoinHref, buildVariantHref } from './coin-href';

const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE_CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('buildVariantHref', () => {
    test('one query key per chain, EVM lowercased', () => {
        for (const chain of CHAIN_KINDS) {
            const address = chain === 'solana' ? USDC_SOLANA : USDC_BASE_CHECKSUMMED;
            const expected = chain === 'solana' ? USDC_SOLANA : USDC_BASE_CHECKSUMMED.toLowerCase();
            expect(buildVariantHref('usd', { chain, address })).toBe(`/usd?${chain}=${expected}`);
        }
    });

    test('missing chain means solana; mismatched family drops the selection', () => {
        expect(buildVariantHref('usd', { address: USDC_SOLANA })).toBe(`/usd?solana=${USDC_SOLANA}`);
        expect(buildVariantHref('usd', { chain: 'solana', address: USDC_BASE_CHECKSUMMED })).toBe('/usd');
        expect(buildVariantHref('usd', { chain: 'base', address: USDC_SOLANA })).toBe('/usd');
        expect(buildVariantHref('usd', { chain: 'polygon-pos', address: USDC_BASE_CHECKSUMMED })).toBe('/usd');
        expect(buildVariantHref('usd', { address: null })).toBe('/usd');
        expect(buildVariantHref(' ', { chain: 'base', address: USDC_BASE_CHECKSUMMED })).toBe('/');
    });

    test('buildCoinHref keeps the Solana-only contract', () => {
        expect(buildCoinHref('bitcoin', USDC_SOLANA)).toBe(`/bitcoin?solana=${USDC_SOLANA}`);
        expect(buildCoinHref('bitcoin', undefined)).toBe('/bitcoin');
        expect(buildCoinHref('bitcoin', USDC_BASE_CHECKSUMMED)).toBe('/bitcoin');
    });
});
