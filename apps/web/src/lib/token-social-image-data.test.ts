import { describe, expect, test } from 'bun:test';

import {
    TOKEN_SOCIAL_IMAGE_VERSION,
    buildShareUrls,
    normalizeRequestedSolanaMint,
    resolveSocialAdvisory,
    resolveVariantSocialData,
    selectVariantForMint,
    type TokenSocialVariantGroups,
} from './token-social-image-data';

const SPACEX_BACKPACK_MINT = 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const groups: TokenSocialVariantGroups = {
    tokenizedEquity: [
        {
            mint: SPACEX_BACKPACK_MINT,
            name: 'SpaceX - Backpack Securities',
            symbol: 'SPCX',
            label: 'Backpack Securities',
            market: {
                name: 'Backpack SpaceX',
                symbol: 'SPCX',
                logoURI: 'https://example.com/backpack-spacex.png',
                price: 18.25,
                priceChange24hPercent: 2.4,
            },
        },
    ],
};

describe('token social image data helpers', () => {
    test('normalizes requested Solana mints', () => {
        expect(normalizeRequestedSolanaMint(undefined)).toBe(null);
        expect(normalizeRequestedSolanaMint('')).toBe(null);
        expect(normalizeRequestedSolanaMint('not-a-mint')).toBe(null);
        expect(normalizeRequestedSolanaMint(` ${SPACEX_BACKPACK_MINT} `)).toBe(SPACEX_BACKPACK_MINT);
    });

    test('builds canonical share URLs without solana', () => {
        const urls = buildShareUrls({
            metadataBase: new URL('https://www.tokens.xyz'),
            requestedName: 'spacex',
            minuteBucket: '123',
        });

        expect(urls.canonicalUrl.toString()).toBe('https://www.tokens.xyz/spacex');
        expect(urls.ogImageUrl.searchParams.get('solana')).toBe(null);
        expect(urls.ogImageUrl.searchParams.get('v')).toBe('4');
        expect(urls.ogImageUrl.searchParams.get('t')).toBe('123');
        expect(urls.twitterImageUrl.searchParams.get('solana')).toBe(null);
    });

    test('builds variant share URLs with solana image params', () => {
        const urls = buildShareUrls({
            metadataBase: new URL('https://www.tokens.xyz'),
            requestedName: 'spacex',
            selectedMint: SPACEX_BACKPACK_MINT,
            minuteBucket: '456',
        });

        expect(urls.canonicalUrl.toString()).toBe(
            `https://www.tokens.xyz/spacex?solana=${SPACEX_BACKPACK_MINT}`,
        );
        expect(urls.ogImageUrl.searchParams.get('solana')).toBe(SPACEX_BACKPACK_MINT);
        expect(urls.ogImageUrl.searchParams.get('v')).toBe('4');
        expect(urls.ogImageUrl.searchParams.get('t')).toBe('456');
        expect(urls.twitterImageUrl.searchParams.get('solana')).toBe(SPACEX_BACKPACK_MINT);
    });

    test('social image version is bumped for the advisory strip', () => {
        expect(TOKEN_SOCIAL_IMAGE_VERSION).toBe('4');
    });

    test('resolveSocialAdvisory: selected variant wins over primary', () => {
        const compromised = { status: 'compromised', reason: 'Exploit', url: 'https://sunrise.xyz', since: 1 };
        const caution = { status: 'caution', reason: 'Watch', url: null, since: 2 };

        expect(
            resolveSocialAdvisory({
                selectedVariant: { mint: SPACEX_BACKPACK_MINT, advisory: compromised },
                primaryVariant: { mint: SOL_MINT, advisory: caution },
            })?.status,
        ).toBe('compromised');

        // Selected present but clean: the viewed token is not flagged.
        expect(
            resolveSocialAdvisory({
                selectedVariant: { mint: SPACEX_BACKPACK_MINT, advisory: null },
                primaryVariant: { mint: SOL_MINT, advisory: caution },
            }),
        ).toBe(null);

        expect(
            resolveSocialAdvisory({
                selectedVariant: null,
                primaryVariant: { mint: SOL_MINT, advisory: caution },
            })?.status,
        ).toBe('caution');

        // Missing field (older API payload) degrades to no advisory.
        expect(resolveSocialAdvisory({ selectedVariant: null, primaryVariant: { mint: SOL_MINT } })).toBe(null);
        expect(resolveSocialAdvisory({ selectedVariant: null, primaryVariant: null })).toBe(null);
    });

    test('selects a SpaceX Backpack variant by mint', () => {
        const selected = selectVariantForMint(groups, SPACEX_BACKPACK_MINT);

        expect(selected?.mint).toBe(SPACEX_BACKPACK_MINT);
        expect(selected?.label).toBe('Backpack Securities');
    });

    test('returns no selected variant for unrelated valid mints', () => {
        expect(selectVariantForMint(groups, SOL_MINT)).toBe(null);
    });

    test('resolves variant-first social data with canonical fallback', () => {
        const selected = selectVariantForMint(groups, SPACEX_BACKPACK_MINT);
        if (!selected) throw new Error('expected selected variant');

        const data = resolveVariantSocialData({
            variant: selected,
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
        expect(data.price).toBe(18.25);
        expect(data.priceChange).toBe(4.2);
        expect(data.priceChangeLabel).toBe('7D');
    });
});
