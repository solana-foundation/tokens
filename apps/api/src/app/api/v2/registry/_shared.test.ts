import { describe, expect, it } from 'bun:test';

import { toRegistryItem } from './_shared';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function row(overrides: Partial<Parameters<typeof toRegistryItem>[0]> = {}): Parameters<typeof toRegistryItem>[0] {
    return {
        mint: MINT,
        symbol: 'USDC',
        name: 'USD Coin',
        logoURI: null,
        hasTokenPage: true,
        assetId: 'usd',
        group: null,
        category: null,
        assetClass: null,
        alliumClass: null,
        alliumValueUsd: null,
        rwaClass: null,
        rwaValueUsd: null,
        marketCapUsd: null,
        rank: 0,
        ...overrides,
    } as Parameters<typeof toRegistryItem>[0];
}

describe('toRegistryItem: assetId / hasTokenPage follow the registered asset only', () => {
    it('a registered asset id is passed through and marks the page as present', () => {
        const item = toRegistryItem(row({ assetId: 'usd' }));
        expect(item.assetId).toBe('usd');
        expect(item.hasTokenPage).toBe(true);
    });

    it('a registered asset whose id is the raw mint is exposed under its solana-<mint> id', () => {
        const item = toRegistryItem(row({ assetId: MINT }));
        expect(item.assetId).toBe(`solana-${MINT}`);
        expect(item.hasTokenPage).toBe(true);
    });

    it('a mint the token index knows but no registered asset owns has no page, whatever the SQL flag said', () => {
        const item = toRegistryItem(row({ assetId: null, hasTokenPage: true }));
        expect(item.assetId).toBeNull();
        expect(item.hasTokenPage).toBe(false);
    });
});
