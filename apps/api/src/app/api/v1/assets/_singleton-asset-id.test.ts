import { describe, expect, it } from 'bun:test';

import {
    isSingletonAssetId,
    looksLikeSolanaMintAddress,
    mintToSingletonAssetId,
    singletonAssetIdToMint,
} from './_singleton-asset-id';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('looksLikeSolanaMintAddress', () => {
    it('accepts common Solana mint lengths in base58', () => {
        expect(looksLikeSolanaMintAddress(USDC_MINT)).toBe(true);
        expect(looksLikeSolanaMintAddress('11111111111111111111111111111111')).toBe(true);
    });

    it('rejects empty, too-short, and non-base58 values', () => {
        expect(looksLikeSolanaMintAddress('')).toBe(false);
        expect(looksLikeSolanaMintAddress('abc')).toBe(false);
        expect(looksLikeSolanaMintAddress('0'.repeat(32))).toBe(false);
        expect(looksLikeSolanaMintAddress('O'.repeat(32))).toBe(false);
    });
});

describe('singleton asset id helpers', () => {
    it('builds a solana- prefixed singleton asset id', () => {
        expect(mintToSingletonAssetId(` ${USDC_MINT} `)).toBe(`solana-${USDC_MINT}`);
    });

    it('round-trips mint ↔ singleton asset id', () => {
        const assetId = mintToSingletonAssetId(USDC_MINT);
        expect(singletonAssetIdToMint(assetId)).toBe(USDC_MINT);
        expect(isSingletonAssetId(assetId)).toBe(true);
    });

    it('returns null for non-singleton or invalid mint suffixes', () => {
        expect(singletonAssetIdToMint('usdc')).toBe(null);
        expect(singletonAssetIdToMint('solana-not-a-mint')).toBe(null);
        expect(isSingletonAssetId('solana-not-a-mint')).toBe(false);
    });
});
