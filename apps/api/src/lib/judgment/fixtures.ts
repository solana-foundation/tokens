/**
 * Test fixtures: pre-enriched candidates so the judgment pipeline can be
 * exercised offline (no network, no registry). Used by the golden set and
 * module tests only.
 */

import type { EnrichedCandidate } from './types';

export const NOW_MS = Date.parse('2026-07-05T12:00:00Z');

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
export const FAKE_USDC_MINT = 'FakeUSDCmint11111111111111111111111111111111';
export const HOMOGLYPH_USDC_MINT = 'SpoofUSDCmint2222222222222222222222222222222';
export const NEW_DOG_MINT = 'NewDogMint3333333333333333333333333333333333';
export const LOW_LIQ_DOG_MINT = 'DustDogMint44444444444444444444444444444444';

function base(overrides: Partial<EnrichedCandidate> & { mint: string }): EnrichedCandidate {
    return {
        symbol: null,
        name: null,
        decimals: 9,
        logoURI: null,
        price: null,
        liquidityUsd: null,
        volume24hUsd: null,
        marketCapUsd: null,
        priceChange24hPercent: null,
        holderCount: null,
        top10HoldersPercent: null,
        tokenMintTime: null,
        sources: ['provider'],
        registry: null,
        risk: null,
        fillQuality: null,
        tombstoned: false,
        dataAsOf: NOW_MS - 60_000,
        ...overrides,
    };
}

/** The real USDC: curated, deep liquidity, old, huge holder base. */
export function realUsdc(): EnrichedCandidate {
    return base({
        mint: USDC_MINT,
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        price: 1,
        liquidityUsd: 500_000_000,
        volume24hUsd: 900_000_000,
        marketCapUsd: 9_000_000_000,
        holderCount: 3_000_000,
        top10HoldersPercent: 20,
        tokenMintTime: '2020-10-01T00:00:00Z',
        sources: ['provider', 'db', 'registry'],
        registry: {
            assetId: 'usd-coin',
            symbol: 'USDC',
            name: 'USD Coin',
            kind: 'stablecoin',
            trustTier: 'tier1',
            curatedListIds: ['currencies'],
        },
        risk: { marketScore: 100, grade: 'A', webacyTags: [] },
        fillQuality: { executionScore: 92, botVolumeRatio: 0.1 },
    });
}

/** A fresh, shallow impostor claiming the USDC symbol. */
export function fakeUsdc(): EnrichedCandidate {
    return base({
        mint: FAKE_USDC_MINT,
        symbol: 'USDC',
        name: 'USD Coin',
        price: 0.98,
        liquidityUsd: 4_000,
        volume24hUsd: 60_000,
        marketCapUsd: 120_000,
        holderCount: 210,
        top10HoldersPercent: 88,
        tokenMintTime: '2026-07-03T00:00:00Z',
    });
}

/** Homoglyph impostor: Cyrillic С in "USDС". */
export function homoglyphUsdc(): EnrichedCandidate {
    return base({
        mint: HOMOGLYPH_USDC_MINT,
        symbol: 'USD\u0421', // trailing U+0421 CYRILLIC CAPITAL LETTER ES
        name: 'USD\u200BCoin', // embedded zero-width space
        price: 0.99,
        liquidityUsd: 25_000,
        volume24hUsd: 90_000,
        marketCapUsd: 200_000,
        holderCount: 400,
        top10HoldersPercent: 92,
        tokenMintTime: '2026-06-28T00:00:00Z',
    });
}

export function realBonk(): EnrichedCandidate {
    return base({
        mint: BONK_MINT,
        symbol: 'BONK',
        name: 'Bonk',
        decimals: 5,
        price: 0.00002,
        liquidityUsd: 18_000_000,
        volume24hUsd: 35_000_000,
        marketCapUsd: 1_500_000_000,
        holderCount: 900_000,
        top10HoldersPercent: 25,
        tokenMintTime: '2022-12-25T00:00:00Z',
        sources: ['provider', 'db', 'registry'],
        registry: {
            assetId: 'bonk',
            symbol: 'BONK',
            name: 'Bonk',
            kind: 'native',
            trustTier: 'tier1',
            curatedListIds: ['majors'],
        },
        risk: { marketScore: 88, grade: 'A', webacyTags: [] },
        fillQuality: { executionScore: 75, botVolumeRatio: 0.3 },
    });
}

/** A legit but young dog-themed memecoin with modest liquidity. */
export function newDogToken(): EnrichedCandidate {
    return base({
        mint: NEW_DOG_MINT,
        symbol: 'DOGWIF',
        name: 'dog wif house',
        price: 0.004,
        liquidityUsd: 80_000,
        volume24hUsd: 400_000,
        marketCapUsd: 2_000_000,
        holderCount: 5_000,
        top10HoldersPercent: 45,
        tokenMintTime: '2026-07-01T00:00:00Z',
    });
}

/** Dust: no meaningful market. */
export function lowLiqDogToken(): EnrichedCandidate {
    return base({
        mint: LOW_LIQ_DOG_MINT,
        symbol: 'DOGGO',
        name: 'doggo coin',
        price: 0.0000001,
        liquidityUsd: 150,
        volume24hUsd: 20,
        marketCapUsd: 900,
        holderCount: 12,
        top10HoldersPercent: 99,
        tokenMintTime: '2026-05-01T00:00:00Z',
    });
}

export function tombstonedToken(): EnrichedCandidate {
    return base({
        mint: 'RuggedMint5555555555555555555555555555555555',
        symbol: 'RUGD',
        name: 'Rugged Token',
        price: 0.001,
        liquidityUsd: 50_000,
        volume24hUsd: 10_000,
        tombstoned: true,
    });
}
