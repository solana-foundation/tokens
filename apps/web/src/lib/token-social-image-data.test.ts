import { describe, expect, test } from 'bun:test';

import {
    TOKEN_SOCIAL_IMAGE_VERSION,
    buildShareUrls,
    normalizeOptionalSocialText,
    readRequestedVariant,
    resolveSocialAdvisory,
    resolveVariantSocialData,
    selectVariantForKey,
    type TokenSocialVariant,
} from './token-social-image-data';

const SPACEX_BACKPACK_MINT = 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_BASE_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDC_BASE_ADDRESS_CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const spacexBackpack: TokenSocialVariant = {
    key: `solana:${SPACEX_BACKPACK_MINT}`,
    chain: 'solana',
    address: SPACEX_BACKPACK_MINT,
    name: 'SpaceX - Backpack Securities',
    symbol: 'SPCX',
    label: 'Backpack Securities',
    logoURI: 'https://example.com/backpack-spacex.png',
    advisory: null,
    market: { price: 18.25, priceChange24hPercent: 2.4 },
};

const usdcBase: TokenSocialVariant = {
    key: `base:${USDC_BASE_ADDRESS}`,
    chain: 'base',
    address: USDC_BASE_ADDRESS,
    name: 'USD Coin',
    symbol: 'USDC',
    label: null,
    logoURI: 'https://example.com/usdc-base.png',
    advisory: null,
    market: { price: 1.0002, priceChange24hPercent: 0.01 },
};

const variants: TokenSocialVariant[] = [spacexBackpack, usdcBase];

describe('token social image data helpers', () => {
    test('re-exports readRequestedVariant for URLSearchParams callers', () => {
        expect(readRequestedVariant(new URLSearchParams(`solana=${SPACEX_BACKPACK_MINT}`))).toEqual({
            chain: 'solana',
            address: SPACEX_BACKPACK_MINT,
            key: `solana:${SPACEX_BACKPACK_MINT}`,
        });
        expect(readRequestedVariant(new URLSearchParams(`base=${USDC_BASE_ADDRESS_CHECKSUMMED}`))?.address).toBe(
            USDC_BASE_ADDRESS,
        );
        expect(readRequestedVariant(new URLSearchParams('solana=not-a-mint'))).toBe(null);
        expect(readRequestedVariant(new URLSearchParams())).toBe(null);
    });

    test('normalizeOptionalSocialText drops placeholders and address-shaped text', () => {
        expect(normalizeOptionalSocialText(undefined)).toBe('');
        expect(normalizeOptionalSocialText('  —  ')).toBe('');
        expect(normalizeOptionalSocialText('???')).toBe('');
        expect(normalizeOptionalSocialText(SOL_MINT)).toBe('');
        expect(normalizeOptionalSocialText(USDC_BASE_ADDRESS)).toBe('');
        expect(normalizeOptionalSocialText(USDC_BASE_ADDRESS_CHECKSUMMED)).toBe('');
        expect(normalizeOptionalSocialText(' USD Coin ')).toBe('USD Coin');
    });

    test('builds canonical share URLs without a selected variant', () => {
        const urls = buildShareUrls({
            metadataBase: new URL('https://www.tokens.xyz'),
            requestedName: 'spacex',
            minuteBucket: '123',
        });

        expect(urls.canonicalUrl.toString()).toBe('https://www.tokens.xyz/spacex');
        expect(urls.ogImageUrl.searchParams.get('solana')).toBe(null);
        expect(urls.ogImageUrl.searchParams.get('v')).toBe('5');
        expect(urls.ogImageUrl.searchParams.get('t')).toBe('123');
        expect(urls.twitterImageUrl.searchParams.get('solana')).toBe(null);
    });

    test('builds Solana variant share URLs with the chain query key', () => {
        const urls = buildShareUrls({
            metadataBase: new URL('https://www.tokens.xyz'),
            requestedName: 'spacex',
            selected: { chain: 'solana', address: SPACEX_BACKPACK_MINT },
            minuteBucket: '456',
        });

        expect(urls.canonicalUrl.toString()).toBe(`https://www.tokens.xyz/spacex?solana=${SPACEX_BACKPACK_MINT}`);
        expect(urls.ogImageUrl.searchParams.get('solana')).toBe(SPACEX_BACKPACK_MINT);
        expect(urls.ogImageUrl.searchParams.get('v')).toBe('5');
        expect(urls.ogImageUrl.searchParams.get('t')).toBe('456');
        expect(urls.twitterImageUrl.searchParams.get('solana')).toBe(SPACEX_BACKPACK_MINT);
    });

    test('builds EVM variant share URLs with the chain query key', () => {
        const urls = buildShareUrls({
            metadataBase: new URL('https://www.tokens.xyz'),
            requestedName: 'usd-coin',
            selected: { chain: 'base', address: USDC_BASE_ADDRESS },
            minuteBucket: '789',
        });

        expect(urls.canonicalUrl.toString()).toBe(`https://www.tokens.xyz/usd-coin?base=${USDC_BASE_ADDRESS}`);
        expect(urls.ogImageUrl.searchParams.get('base')).toBe(USDC_BASE_ADDRESS);
        expect(urls.ogImageUrl.searchParams.get('solana')).toBe(null);
        expect(urls.twitterImageUrl.searchParams.get('base')).toBe(USDC_BASE_ADDRESS);
        expect(urls.twitterImageUrl.searchParams.get('v')).toBe('5');
    });

    test('social image version is bumped for the chain caption', () => {
        expect(TOKEN_SOCIAL_IMAGE_VERSION).toBe('5');
    });

    test('resolveSocialAdvisory: selected variant wins over primary', () => {
        const compromised = { status: 'compromised', reason: 'Exploit', url: 'https://sunrise.xyz', since: 1 };
        const caution = { status: 'caution', reason: 'Watch', url: null, since: 2 };

        expect(
            resolveSocialAdvisory({
                selectedVariant: { advisory: compromised as never },
                primaryVariant: { advisory: caution as never },
            })?.status,
        ).toBe('compromised');

        // Selected present but clean: the viewed token is not flagged.
        expect(
            resolveSocialAdvisory({
                selectedVariant: { advisory: null },
                primaryVariant: { advisory: caution as never },
            }),
        ).toBe(null);

        expect(
            resolveSocialAdvisory({
                selectedVariant: null,
                primaryVariant: { advisory: caution as never },
            })?.status,
        ).toBe('caution');

        expect(resolveSocialAdvisory({ selectedVariant: null, primaryVariant: { advisory: null } })).toBe(null);
        expect(resolveSocialAdvisory({ selectedVariant: null, primaryVariant: null })).toBe(null);
    });

    test('selects a variant by key', () => {
        const selected = selectVariantForKey(variants, `solana:${SPACEX_BACKPACK_MINT}`);

        expect(selected?.address).toBe(SPACEX_BACKPACK_MINT);
        expect(selected?.label).toBe('Backpack Securities');
        expect(selectVariantForKey(variants, `base:${USDC_BASE_ADDRESS}`)?.chain).toBe('base');
    });

    test('returns no selected variant for unknown or missing keys', () => {
        expect(selectVariantForKey(variants, `solana:${SOL_MINT}`)).toBe(null);
        expect(selectVariantForKey(variants, SPACEX_BACKPACK_MINT)).toBe(null);
        expect(selectVariantForKey(variants, '')).toBe(null);
        expect(selectVariantForKey(variants, null)).toBe(null);
        expect(selectVariantForKey(undefined, `solana:${SPACEX_BACKPACK_MINT}`)).toBe(null);
    });

    test('resolves variant-first social data with canonical fallback', () => {
        const data = resolveVariantSocialData({
            variant: spacexBackpack,
            canonicalDisplayName: 'SpaceX',
            canonicalSymbol: 'SPCX',
            canonicalLogoURI: '/logos/prestocks/spacex.png',
            latestVariantClose: 17.9,
            variantSevenDayChange: 4.2,
            canonicalPrice: 16.5,
            canonicalPriceChange: -1.1,
            canonicalPriceChangeLabel: '7D',
        });

        expect(data.displayName).toBe('SpaceX - Backpack Securities');
        expect(data.symbol).toBe('SPCX');
        expect(data.logoURI).toBe('https://example.com/backpack-spacex.png');
        expect(data.chainLabel).toBe('Solana');
        expect(data.price).toBe(18.25);
        expect(data.priceChange).toBe(4.2);
        expect(data.priceChangeLabel).toBe('7D');
    });

    test('resolves EVM variant social data with the chain label and no mint override', () => {
        const data = resolveVariantSocialData({
            variant: usdcBase,
            canonicalDisplayName: 'USDC',
            canonicalSymbol: 'USDC',
            canonicalLogoURI: '/logos/usdc.png',
            canonicalPrice: 1,
            canonicalPriceChange: 0.02,
            canonicalPriceChangeLabel: '24H',
        });

        expect(data.displayName).toBe('USD Coin');
        expect(data.symbol).toBe('USDC');
        expect(data.chainLabel).toBe('Base');
        expect(data.logoURI).toBe('https://example.com/usdc-base.png');
        expect(data.price).toBe(1.0002);
        expect(data.priceChange).toBe(0.01);
        expect(data.priceChangeLabel).toBe('24H');
    });

    test('falls back to canonical identity when variant text is an address', () => {
        const data = resolveVariantSocialData({
            variant: { ...usdcBase, name: USDC_BASE_ADDRESS, symbol: null, label: null, logoURI: null, market: null },
            canonicalDisplayName: 'USDC',
            canonicalSymbol: 'USDC',
            canonicalLogoURI: '/logos/usdc.png',
            canonicalPrice: 1,
            canonicalPriceChange: null,
        });

        expect(data.displayName).toBe('USDC');
        expect(data.symbol).toBe('USDC');
        expect(data.logoURI).toBe('/logos/usdc.png');
        expect(data.price).toBe(1);
        expect(data.priceChange).toBe(null);
        expect(data.priceChangeLabel).toBe(null);
    });
});
