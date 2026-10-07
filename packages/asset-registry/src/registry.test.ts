import { describe, expect, test } from 'bun:test';
import { getAsset, getVariantByMint, resolveAlias, validateRegistry } from './registry';
import { getHub, getHubByMint, listHubs } from './hubs';
import { getVariantHubByAssetId, getVariantHubById } from './variant-hubs';
import { getCuratedTokenAddresses, getCuratedTokenList } from './compat';

describe('asset registry', () => {
    test('reports alias collisions with clear candidates', () => {
        const result = validateRegistry();

        expect(result.ok).toBe(false);
        if (result.ok) return;

        const collision = result.issues.find(issue => issue.kind === 'alias_collision');
        expect(collision?.message).toContain('Alias collision');
        expect(collision?.candidates.length).toBeGreaterThan(1);
    });

    test('does not register issuer labels (Ondo, xStock) as asset aliases', () => {
        // Variant labels are issuer names shared by hundreds of tokenized assets. Registering them as
        // aliases made `resolveAlias('ondo')` return an arbitrary WisdomTree fund, which then overrode
        // the DB-authored ONDO asset's name in the API.
        expect(resolveAlias('ondo')).toBeNull();
        expect(resolveAlias('Ondo')).toBeNull();
        expect(resolveAlias('ONDO')).toBeNull();
        expect(resolveAlias('xstock')).toBeNull();

        const result = validateRegistry();
        const collisions = result.ok ? [] : result.issues.filter(issue => issue.kind === 'alias_collision');
        expect(collisions.some(issue => issue.alias === 'ondo' || issue.alias === 'xstock')).toBe(false);
        expect(collisions.length).toBeLessThan(20);
    });

    test('keeps bitcoin aliases and variants after immutable construction', () => {
        const bitcoin = getAsset('bitcoin');

        expect(bitcoin?.aliases).toContain('bitcoin');
        expect(bitcoin?.variants.length ?? 0).toBeGreaterThan(1);
    });

    test('legacy hub wrappers return canonical registry results', () => {
        const bitcoin = getAsset('bitcoin');
        expect(getHub('bitcoin')).toBe(bitcoin);
        expect(listHubs()).toContain(bitcoin);

        const variant = bitcoin?.variants[0];
        expect(variant).toBeDefined();
        if (!variant) return;

        expect(getHubByMint(variant.mint)?.hub).toBe(getVariantByMint(variant.mint)?.asset);
        expect(getVariantHubByAssetId('bitcoin')).toEqual(getVariantHubById('bitcoin'));
    });

    test('canonicalizes curated LST mints under the solana asset', () => {
        const mints = getCuratedTokenAddresses(getCuratedTokenList('lsts'));

        expect(mints.length).toBeGreaterThan(0);
        expect(new Set(mints).size).toBe(mints.length);

        for (const mint of mints) {
            expect(getVariantByMint(mint)?.asset.assetId).toBe('solana');
        }
    });

    test('classifies Portal UNI as a bridged Wormhole variant with a unique id', () => {
        const uniswap = getAsset('uniswap');
        const variants = uniswap?.variants ?? [];
        const portalUni = getVariantByMint('8FU95xFJhUUkyyCLU13HSzDLs7oC4QZdXQHL6SCeab36')?.variant;

        expect(variants.map(variant => variant.variantId).sort()).toEqual([
            'uniswap:UNI_Bridge',
            'uniswap:UNI_Wormhole',
        ]);
        expect(portalUni?.variantId).toBe('uniswap:UNI_Wormhole');
        expect(portalUni?.kind).toBe('bridged');
        expect(portalUni?.issuer).toBe('Wormhole');
        expect(portalUni?.name).toBe('Uniswap (Portal)');
    });

    test('classifies SpaceX stock variant redeemability tiers', () => {
        const spacex = getAsset('spacex');
        const byVariantId = new Map((spacex?.variants ?? []).map(variant => [variant.variantId, variant]));

        expect(spacex?.symbol).toBe('SPCX');
        expect(spacex?.aliases).toContain('SPACEX');
        expect(byVariantId.get('spacex:backpack')?.stockVariantTier).toBe('share_redeemable');
        expect(byVariantId.get('spacex:xstock')?.stockVariantTier).toBe('cash_redeemable');
        expect(byVariantId.get('spacex:ondo')?.stockVariantTier).toBe('cash_redeemable');
        expect(byVariantId.get('spacex:prestocks')?.stockVariantTier).toBe('not_redeemable');
        expect(byVariantId.get('spacex:tspx')?.stockVariantTier).toBe('not_redeemable');
    });

    test('classifies generated xStock and Ondo equity variants as cash redeemable', () => {
        const apple = getAsset('apple');
        const xstock = apple?.variants.find(variant => variant.label === 'xStock');
        const ondo = apple?.variants.find(variant => variant.label === 'Ondo');

        expect(xstock?.stockVariantTier).toBe('cash_redeemable');
        expect(ondo?.stockVariantTier).toBe('cash_redeemable');
    });

    test('promotes oil to a commodity canonical with the Ondo USO variant', () => {
        const oil = getAsset('oil');

        expect(oil?.category).toBe('commodity');
        expect(oil?.symbol).toBe('USO');
        expect(oil?.variants).toHaveLength(1);
        expect(oil?.variants[0]?.kind).toBe('etf');
        expect(oil?.variants[0]?.mint).toBe('rpydAzWdCy85HEmoQkH5PVxYtDYQWjmLxgHHadxondo');
    });

    test('resolves oil aliases (including the old equity slug) to the commodity asset', () => {
        for (const alias of ['oil', 'uso', 'wti', 'crude-oil', 'united-states-oil-fund']) {
            expect(resolveAlias(alias)?.assetId).toBe('oil');
        }
        expect(getVariantByMint('rpydAzWdCy85HEmoQkH5PVxYtDYQWjmLxgHHadxondo')?.asset.assetId).toBe('oil');
        expect(getAsset('united-states-oil-fund')).toBeNull();
    });

    test('categorizes gold variants as spot vs etf', () => {
        const gold = getAsset('gold');
        const byVariantId = new Map((gold?.variants ?? []).map(variant => [variant.variantId, variant]));

        expect(byVariantId.get('gold:tether-gold')?.kind).toBe('spot');
        expect(byVariantId.get('gold:pax-gold')?.kind).toBe('spot');
        expect(byVariantId.get('gold:matrixdock-gold')?.kind).toBe('spot');
        expect(byVariantId.get('gold:gold')?.kind).toBe('spot');
        // GLDx tracks the GLD ETF share price, not spot gold.
        expect(byVariantId.get('gold:gold-token')?.kind).toBe('etf');
        expect(byVariantId.get('gold:ondo-ishares-gold-trust')?.kind).toBe('etf');
        expect(byVariantId.get('gold:ondo-spdr-gold-shares')?.kind).toBe('etf');
    });

    test('uses SLV as the silver benchmark symbol while keeping xag alias', () => {
        const silver = getAsset('silver');

        expect(silver?.symbol).toBe('SLV');
        expect(resolveAlias('xag')?.assetId).toBe('silver');
        expect(resolveAlias('slv')?.assetId).toBe('silver');
    });
});
