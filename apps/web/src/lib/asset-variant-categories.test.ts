import { describe, expect, test } from 'bun:test';

import {
    chainDisplayLabel,
    getAssetVariantChainCategory,
    groupAssetVariantsByDisplayCategory,
    hasMultipleChains,
} from './asset-variant-categories';

const rows = [
    { mint: 'A', kind: 'native' as const, chain: 'solana' },
    { mint: 'B', kind: 'stablecoin' as const, chain: 'base' },
    { mint: 'C', kind: 'stablecoin' as const, chain: 'ethereum' },
    { mint: 'D', kind: 'yield' as const },
];

describe('chain sections', () => {
    test('single-chain assets keep kind sections', () => {
        const solanaOnly = rows.filter(r => r.chain !== 'base' && r.chain !== 'ethereum');
        expect(hasMultipleChains(solanaOnly)).toBe(false);
        expect(groupAssetVariantsByDisplayCategory('usd', solanaOnly).map(g => g.category.id)).toEqual([
            'native',
            'yield-bearing',
        ]);
    });

    test('multi-chain assets group by chain in canonical order with registry labels', () => {
        expect(hasMultipleChains(rows)).toBe(true);
        const groups = groupAssetVariantsByDisplayCategory('usd', rows);
        expect(groups.map(g => g.category.id)).toEqual(['chain:solana', 'chain:ethereum', 'chain:base']);
        expect(groups.map(g => g.category.label)).toEqual(['Solana', 'Ethereum', 'Base']);
        expect(groups[0]?.variants.map(v => v.mint)).toEqual(['A', 'D']);
    });

    test('labels and categories fall back to solana', () => {
        expect(chainDisplayLabel(undefined)).toBe('Solana');
        expect(chainDisplayLabel('bnb')).toBe('BNB Smart Chain');
        expect(getAssetVariantChainCategory({ chain: 'nope' })).toEqual({
            id: 'chain:solana',
            label: 'Solana',
            order: 0,
        });
    });
});
