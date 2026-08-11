import { describe, expect, it } from 'bun:test';

import {
    canonicalizeAsset,
    canonicalizeAssetVariants,
    SUI_ASSET_ID,
    SUI_CANONICAL_MINT,
    SUI_CANONICAL_NAME,
    SUI_CANONICAL_SYMBOL,
    SUI_LEGACY_MINT,
} from './_canonical-overrides';

describe('canonicalizeAssetVariants', () => {
    it('leaves non-SUI assets untouched', () => {
        const variants = [{ mint: 'abc', symbol: 'ABC', name: 'Abc' }];
        expect(canonicalizeAssetVariants('solana', variants)).toBe(variants);
    });

    it('drops the legacy SUI mint and forces canonical identity on the primary mint', () => {
        const variants = [
            { mint: SUI_LEGACY_MINT, symbol: 'OLD', name: 'Old SUI' },
            { mint: SUI_CANONICAL_MINT, symbol: 'wrong', name: 'wrong' },
            { mint: 'other-mint', symbol: 'KEEP', name: 'Keep' },
        ];

        expect(canonicalizeAssetVariants(SUI_ASSET_ID, variants)).toEqual([
            {
                mint: SUI_CANONICAL_MINT,
                symbol: SUI_CANONICAL_SYMBOL,
                name: SUI_CANONICAL_NAME,
            },
            { mint: 'other-mint', symbol: 'KEEP', name: 'Keep' },
        ]);
    });
});

describe('canonicalizeAsset', () => {
    it('forces SUI name/symbol and canonicalizes variants', () => {
        const asset = {
            assetId: SUI_ASSET_ID,
            name: 'Wrong',
            symbol: 'WRONG',
            variants: [
                { mint: SUI_LEGACY_MINT, symbol: 'OLD' },
                { mint: SUI_CANONICAL_MINT, symbol: 'x', name: 'y' },
            ],
        };

        expect(canonicalizeAsset(asset)).toEqual({
            assetId: SUI_ASSET_ID,
            name: SUI_CANONICAL_NAME,
            symbol: SUI_CANONICAL_SYMBOL,
            variants: [
                {
                    mint: SUI_CANONICAL_MINT,
                    symbol: SUI_CANONICAL_SYMBOL,
                    name: SUI_CANONICAL_NAME,
                },
            ],
        });
    });

    it('returns other assets unchanged', () => {
        const asset = {
            assetId: 'solana',
            name: 'Solana',
            symbol: 'SOL',
            variants: [{ mint: 'So11111111111111111111111111111111111111112' }],
        };
        expect(canonicalizeAsset(asset)).toBe(asset);
    });
});
