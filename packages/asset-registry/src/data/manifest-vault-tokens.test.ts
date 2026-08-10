import { describe, expect, test } from 'bun:test';

import { getVariantByMint, resolveAlias, searchAssets } from '../registry';

// Manifest Destiny vault LP tokens ("up" tokens). Each is curated as a yield
// variant of its underlying canonical asset (USD stablecoins → `usd`,
// upJitoSOL → `solana`, upBTC → `bitcoin`), mirroring how syrupUSDC/USDY are
// modeled. These assertions lock in that they are discoverable in search and
// resolve to the expected canonical asset.
const UP_TOKENS: Array<{ symbol: string; mint: string; assetId: string }> = [
    { symbol: 'upCASH', mint: 'upCASH4EueUGr6QpzmfZcec9DE76SiUipfj97HYMUrS', assetId: 'usd' },
    { symbol: 'upUSD1', mint: 'upUSD1NPCzeFsNUj4mgqoUjwoJZpzxmfq3H6yHNbzd6', assetId: 'usd' },
    { symbol: 'upPYUSD', mint: 'upPyusDv3nEtrUE6ESsX2j6BiZhwBjzogoirFenYg6m', assetId: 'usd' },
    { symbol: 'upUSDS', mint: 'upUSDSL8V1nhX9B7N51XtHQZ9RAS1v7RKURXrFDdamp', assetId: 'usd' },
    { symbol: 'upUSDG', mint: 'upUSDGePfXHWusRCRqGYkuSrQY3DkEGwu5w3VfzkhsB', assetId: 'usd' },
    { symbol: 'upJitoSOL', mint: 'upJ1TohUMJaeZGcFDBf6V3zxkm4KCpx5PiUfzWXw3aA', assetId: 'solana' },
    { symbol: 'upBTC', mint: 'upBTCBNCis2uHqFdCg2vFACLhkJ3NKwYbC4k8xbHjj4', assetId: 'bitcoin' },
];

describe('Manifest Destiny vault ("up") tokens', () => {
    for (const token of UP_TOKENS) {
        test(`${token.symbol} is searchable (case-insensitive) and resolves to ${token.assetId}`, () => {
            // Search by symbol, lowercased (users type "uppyusd").
            const byLowerSymbol = searchAssets(token.symbol.toLowerCase(), { limit: 5 });
            expect(byLowerSymbol.some(a => a.assetId === token.assetId)).toBe(true);

            // Search by mint.
            const byMint = searchAssets(token.mint, { limit: 5 });
            expect(byMint.some(a => a.assetId === token.assetId)).toBe(true);

            // Alias resolution lands on the canonical asset.
            expect(resolveAlias(token.symbol)?.assetId).toBe(token.assetId);
        });

        test(`${token.symbol} is a curated variant of ${token.assetId}`, () => {
            const match = getVariantByMint(token.mint);
            expect(match?.asset.assetId).toBe(token.assetId);
            expect(match?.variant.mint).toBe(token.mint);
        });
    }
});
