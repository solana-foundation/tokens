import { describe, expect, it } from 'bun:test';

import { getAsset } from '@tokens/asset-registry';

import { buildProbeLadderUsd, parityBasisOf, selectVariants, type VariantDisplay } from './variant-selection';

const EMPTY_RANK = new Map<string, number>();

/** Give every variant enough market activity to pass the registry's activity filter. */
function healthyDisplays(mints: readonly string[], liquidity = 5_000_000): Map<string, VariantDisplay> {
    return new Map(
        mints.map(mint => [
            mint,
            {
                symbol: mint.slice(0, 4),
                name: mint.slice(0, 8),
                decimals: 8,
                price: 1,
                liquidity,
                volume24hUSD: 1_000_000,
            },
        ]),
    );
}

function marketsFrom(displays: Map<string, VariantDisplay>) {
    return new Map(
        [...displays.entries()].map(([mint, display]) => [
            mint,
            { liquidity: display.liquidity ?? null, volume24hUSD: display.volume24hUSD ?? null, trade24h: 500 },
        ]),
    );
}

describe('parityBasisOf', () => {
    it('grants kind parity to stablecoin variants (exotic fiat stables)', () => {
        const variant = { variantId: 'audd:mint', mint: 'AUDDmint', kind: 'stablecoin' } as never;
        expect(parityBasisOf(variant)).toBe('kind');
    });

    it('grants kind parity to wrapped/bridged and nothing to derivatives', () => {
        const bitcoin = getAsset('bitcoin')!;
        for (const variant of bitcoin.variants) {
            expect(parityBasisOf(variant)).toBe('kind');
        }
        const gold = getAsset('gold')!;
        const etf = gold.variants.find(variant => variant.kind === 'etf');
        if (etf) expect(parityBasisOf(etf)).toBe('none');
        // Spot commodity claims are parity — the runtime price-clustering
        // gate, not a static list, catches a mispriced "1-oz" sibling.
        for (const spot of gold.variants.filter(variant => variant.kind === 'spot')) {
            expect(parityBasisOf(spot)).toBe('kind');
        }
    });

    it('grants issuer_assertion only to redeemable equity tiers', () => {
        const asset = getAsset('sk-hynix')!;
        for (const variant of asset.variants) {
            const basis = parityBasisOf(variant);
            if (variant.stockVariantTier === 'not_redeemable') expect(basis).toBe('none');
            else expect(basis).toBe('issuer_assertion');
        }
    });
});

describe('selectVariants', () => {
    it('selects bitcoin variants in rank order with kind parity', () => {
        const asset = getAsset('bitcoin')!;
        const displays = healthyDisplays(asset.variants.map(variant => variant.mint));
        const selection = selectVariants({
            asset,
            mintRank: EMPTY_RANK,
            marketByMint: marketsFrom(displays),
            fillQualityByMint: new Map(),
            displayByMint: displays,
            targetUsd: 5_000_000,
            maxVariants: 4,
        });
        expect(selection.selected.length).toBe(4);
        expect(selection.selected.map(entry => entry.rank)).toEqual([1, 2, 3, 4]);
        for (const entry of selection.selected) expect(entry.parityBasis).toBe('kind');
        // The rest of the 8 variants are excluded with an explicit reason.
        const beyond = selection.excluded.filter(entry => entry.reason === 'beyond_max_variants');
        expect(beyond.length).toBe(asset.variants.length - 4);
    });

    it('excludes pre-IPO claims from equity assets as not_redeemable', () => {
        const asset = getAsset('spacex')!;
        const displays = healthyDisplays(asset.variants.map(variant => variant.mint));
        const selection = selectVariants({
            asset,
            mintRank: EMPTY_RANK,
            marketByMint: marketsFrom(displays),
            fillQualityByMint: new Map(),
            displayByMint: displays,
            targetUsd: 100_000,
            maxVariants: 6,
        });
        const notRedeemable = selection.excluded.filter(entry => entry.reason === 'not_redeemable');
        expect(notRedeemable.length).toBeGreaterThan(0);
        for (const entry of selection.selected) {
            expect(entry.parityBasis).toBe('issuer_assertion');
        }
    });

    it('applies the target-scaled liquidity floor', () => {
        const asset = getAsset('bitcoin')!;
        const mints = asset.variants.map(variant => variant.mint);
        const displays = healthyDisplays(mints);
        // One variant has a pool far below 1% of a $5M target.
        const thin = mints[0]!;
        displays.set(thin, { ...displays.get(thin)!, liquidity: 30_000 });
        const selection = selectVariants({
            asset,
            mintRank: EMPTY_RANK,
            marketByMint: marketsFrom(displays),
            fillQualityByMint: new Map(),
            displayByMint: displays,
            targetUsd: 5_000_000,
            maxVariants: 6,
        });
        expect(selection.selected.some(entry => entry.variant.mint === thin)).toBe(false);
        expect(selection.excluded.some(entry => entry.mint === thin && entry.reason === 'below_liquidity_floor')).toBe(
            true,
        );
    });

    it('excludes variants whose decimals cannot be resolved', () => {
        const asset = getAsset('bitcoin')!;
        const mints = asset.variants.map(variant => variant.mint);
        const displays = healthyDisplays(mints);
        const unknown = mints[1]!;
        displays.set(unknown, { ...displays.get(unknown)!, decimals: null });
        const selection = selectVariants({
            asset,
            mintRank: EMPTY_RANK,
            marketByMint: marketsFrom(displays),
            fillQualityByMint: new Map(),
            displayByMint: displays,
            targetUsd: 1_000_000,
            maxVariants: 6,
        });
        expect(selection.excluded.some(entry => entry.mint === unknown && entry.reason === 'missing_decimals')).toBe(
            true,
        );
    });
});

describe('buildProbeLadderUsd', () => {
    it('scales to the target with the top rung exactly at T', () => {
        expect(buildProbeLadderUsd(5_000_000)).toEqual([40_000, 200_000, 1_000_000, 5_000_000]);
        expect(buildProbeLadderUsd(1_000_000)).toEqual([8_000, 40_000, 200_000, 1_000_000]);
    });

    it('floors rungs at $1k and dedupes collisions', () => {
        // T=$10k: 80/400/2000 all floor to 1000 and collapse.
        expect(buildProbeLadderUsd(10_000)).toEqual([1_000, 2_000, 10_000]);
        expect(buildProbeLadderUsd(1_000)).toEqual([1_000]);
    });
});
