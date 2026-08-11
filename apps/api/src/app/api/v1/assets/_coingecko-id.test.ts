import { describe, expect, it } from 'bun:test';

import { normalizeCoinGeckoCoinIdForAsset } from './_coingecko-id';

describe('normalizeCoinGeckoCoinIdForAsset', () => {
    it('returns null for empty coin ids', () => {
        expect(normalizeCoinGeckoCoinIdForAsset({ assetId: 'solana', coinId: null })).toBe(null);
        expect(normalizeCoinGeckoCoinIdForAsset({ assetId: 'solana', coinId: '   ' })).toBe(null);
    });

    it('rewrites legacy bnb coin id to binancecoin', () => {
        expect(normalizeCoinGeckoCoinIdForAsset({ assetId: 'bnb', coinId: 'bnb' })).toBe('binancecoin');
    });

    it('keeps canonical tron when a legacy xStock coin id is present', () => {
        expect(normalizeCoinGeckoCoinIdForAsset({ assetId: 'tron', coinId: 'tron-xstock' })).toBe('tron');
    });

    it('drops the PreStocks CoinGecko listing for canonical spacex', () => {
        expect(normalizeCoinGeckoCoinIdForAsset({ assetId: 'spacex', coinId: 'spacex-prestocks-2' })).toBe(null);
    });

    it('passes through unrelated coin ids unchanged', () => {
        expect(normalizeCoinGeckoCoinIdForAsset({ assetId: 'solana', coinId: ' solana ' })).toBe('solana');
        expect(normalizeCoinGeckoCoinIdForAsset({ assetId: 'bnb', coinId: 'binancecoin' })).toBe('binancecoin');
    });
});
