import { describe, expect, test } from 'bun:test';

import {
    classifyIssuanceOverrides,
    renderIssuanceOverridesModule,
    type OverrideCoinInput,
    type OverrideVariantInput,
} from './issuanceOverridesGenerator';

const TSLAX_SOL = 'XsDoVfqeBukxuZHWhdvWHBhgnNfS3zAXPj1F4FR9eYd';
const TSLAX_ARB = '0x8aD3c73F0C8A5fE6c2a6b7f4e4AD6F34E8EA4Ab1';
const USDC_E_POLYGON = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const WETH_WORMHOLE_SOL = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';

function variant(overrides: Partial<OverrideVariantInput>): OverrideVariantInput {
    return {
        chain: 'solana',
        address: TSLAX_SOL,
        assetId: 'tesla',
        category: 'equity',
        kind: 'tokenized_equity',
        label: 'xStock',
        source: 'registry',
        coinId: 'tesla-xstock',
        ...overrides,
    };
}

const coins: OverrideCoinInput[] = [
    { coinId: 'tesla-xstock', name: 'Tesla xStock', symbol: 'tslax', platforms: { solana: TSLAX_SOL, 'arbitrum-one': TSLAX_ARB.toLowerCase(), 'binance-smart-chain': '0x1' } },
    { coinId: 'bridged-usdc-polygon-pos', name: 'Bridged USDC (Polygon PoS)', symbol: 'usdc.e', platforms: { 'polygon-pos': USDC_E_POLYGON } },
    { coinId: 'ethereum-wormhole', name: 'Ethereum (Wormhole)', symbol: 'eth', platforms: { solana: WETH_WORMHOLE_SOL } },
    { coinId: 'ishares-gold-trust', name: 'iShares Gold Trust', symbol: 'iau', platforms: { solana: 'IAUonMint' } },
    { coinId: 'usd-coin', name: 'USDC', symbol: 'usdc', platforms: { solana: 'EPjF', ethereum: '0xa0b8' } },
    { coinId: 'wormhole', name: 'Wormhole', symbol: 'w', platforms: { solana: 'WMint', ethereum: '0xb0b0' } },
    { coinId: 'binance-peg-wormhole', name: 'Binance-Peg Wormhole', symbol: 'w', platforms: { 'binance-smart-chain': '0xpeg' } },
];

describe('classifyIssuanceOverrides', () => {
    test("an equity's EVM deployments of the coin issued on its registry Solana mint are bridged; the Solana mint is not listed", () => {
        const out = classifyIssuanceOverrides(
            [
                variant({}),
                variant({ chain: 'arbitrum', address: TSLAX_ARB, source: 'coingecko', label: null }),
                variant({ chain: 'bnb', address: '0x1', source: 'coingecko', label: null }),
            ],
            coins,
        );
        expect(out.map(e => e.key)).toEqual([`arbitrum:${TSLAX_ARB.toLowerCase()}`, 'bnb:0x1']);
        expect(out[0]).toEqual({
            key: `arbitrum:${TSLAX_ARB.toLowerCase()}`,
            issuance: 'bridged',
            reason: 'tesla-xstock is issued on Solana; the arbitrum deployment is a bridged copy',
            coinId: 'tesla-xstock',
        });
    });

    test('bridge / peg coins are bridged wherever they are deployed, unless the kind already says so', () => {
        const out = classifyIssuanceOverrides(
            [
                variant({ chain: 'polygon', address: USDC_E_POLYGON, assetId: 'usd', category: 'stablecoin', kind: 'stablecoin', coinId: 'bridged-usdc-polygon-pos', source: 'coingecko' }),
                variant({ chain: 'solana', address: WETH_WORMHOLE_SOL, assetId: 'ethereum', category: 'crypto', kind: 'bridged', coinId: 'ethereum-wormhole' }),
            ],
            coins,
        );
        expect(out).toHaveLength(1);
        expect(out[0]?.key).toBe(`polygon:${USDC_E_POLYGON}`);
        expect(out[0]?.issuance).toBe('bridged');
    });

    test("a project's own token is not a bridged copy of itself: Wormhole's W gets no entry, Binance-Peg W does", () => {
        const out = classifyIssuanceOverrides(
            [
                variant({ chain: 'solana', address: 'WMint', assetId: 'wormhole', category: 'crypto', kind: 'native', coinId: 'wormhole', assetCoinId: 'wormhole' }),
                variant({ chain: 'ethereum', address: '0xb0b0', assetId: 'wormhole', category: 'crypto', kind: 'spot', coinId: 'wormhole', assetCoinId: 'wormhole', source: 'coingecko' }),
                variant({ chain: 'bnb', address: '0xpeg', assetId: 'wormhole', category: 'crypto', kind: 'spot', coinId: 'binance-peg-wormhole', assetCoinId: 'wormhole', source: 'coingecko' }),
            ],
            coins,
        );
        expect(out.map(e => e.key)).toEqual(['bnb:0xpeg']);
        expect(out[0]?.issuance).toBe('bridged');
    });

    test('a fund-share token inside a commodity asset is a derivative; a natively issued stablecoin gets no entry', () => {
        const out = classifyIssuanceOverrides(
            [
                variant({ address: 'IAUonMint', assetId: 'gold', category: 'commodity', kind: 'spot', label: 'IAUon', coinId: 'ishares-gold-trust' }),
                variant({ address: 'EPjF', assetId: 'usd', category: 'stablecoin', kind: 'stablecoin', coinId: 'usd-coin' }),
                variant({ chain: 'ethereum', address: '0xa0b8', assetId: 'usd', category: 'stablecoin', kind: 'stablecoin', coinId: 'usd-coin', source: 'coingecko' }),
            ],
            coins,
        );
        expect(out).toEqual([{ key: 'solana:IAUonMint', issuance: 'derivative', reason: "iShares Gold Trust is a fund share, not the commodity's own supply", coinId: 'ishares-gold-trust' }]);
    });

    test('a registry-seeded Solana mint with no source column is still the home', () => {
        const out = classifyIssuanceOverrides(
            [variant({ source: null }), variant({ chain: 'arbitrum', address: TSLAX_ARB, source: 'coingecko', label: null })],
            coins,
        );
        expect(out.map(e => e.key)).toEqual([`arbitrum:${TSLAX_ARB.toLowerCase()}`]);
    });

    test('an equity whose Solana mint is derived (not registry / admin) is not treated as the home', () => {
        const out = classifyIssuanceOverrides(
            [variant({ source: 'coingecko' }), variant({ chain: 'arbitrum', address: TSLAX_ARB, source: 'coingecko' })],
            coins,
        );
        expect(out).toHaveLength(0);
    });

    test('the module renderer emits sorted, typed entries', () => {
        const text = renderIssuanceOverridesModule(
            [{ key: 'bnb:0x1', issuance: 'bridged', reason: 'r', coinId: 'c' }, { key: 'solana:X', issuance: 'derivative', reason: 'q' }],
            '2026-10-23',
        );
        expect(text).toContain("'bnb:0x1': { issuance: 'bridged', reason: \"r\", coinId: 'c' },");
        expect(text).toContain("'solana:X': { issuance: 'derivative', reason: \"q\" },");
        expect(text).toContain('export const ISSUANCE_OVERRIDES');
    });
});
