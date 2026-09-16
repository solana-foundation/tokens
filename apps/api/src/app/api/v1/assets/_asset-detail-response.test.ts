import { describe, expect, it } from 'bun:test';
import type { StablecoinHealth } from '@tokens/asset-registry';

import { buildAssetDetailResponse } from './_asset-detail-response';
import { absolutizeLocalLogoUrl } from './_asset-helpers';

describe('asset logo helpers', () => {
    it('normalizes local SVG logo URLs to PNG siblings', () => {
        const request = new Request('https://api.tokens.xyz/v1/assets/search?q=hype');

        expect(absolutizeLocalLogoUrl(request, '/logos/popular/hyperliquid.svg')).toBe(
            'https://api.tokens.xyz/logos/popular/hyperliquid.png',
        );
        expect(absolutizeLocalLogoUrl(request, 'https://api.tokens.xyz/logos/popular/hyperliquid.svg')).toBe(
            'https://api.tokens.xyz/logos/popular/hyperliquid.png',
        );
    });
});

describe('buildAssetDetailResponse', () => {
    it('includes the DB asset description when present', () => {
        const result = buildAssetDetailResponse({
            asset: {
                assetId: 'aapl',
                name: 'Apple',
                symbol: 'AAPL',
                category: 'equity',
                aliases: ['apple'],
                variants: [],
            },
            assetDescription: 'Apple Inc. is a technology company.',
            primaryVariant: null,
            token: undefined,
            tokenByMint: new Map(),
            fillQualityByMint: new Map(),
            marketMeta: undefined,
            marketMetaByMint: new Map(),
            effectiveStats: null,
            imageUrl: null,
            symbols: ['AAPL'],
            stockSymbol: 'AAPL',
            canonicalMarket: undefined,
            mintRank: new Map(),
            sanctumActiveMints: null,
            includeMint: null,
            variantsMode: '',
            includesOut: {},
            hasIncludes: false,
        });

        expect(result.asset.description).toBe('Apple Inc. is a technology company.');
        expect('resolution' in result).toBe(false);
    });

    it('carries the company market cap on a clickhouse_stock canonicalMarket', () => {
        const result = buildAssetDetailResponse({
            asset: {
                assetId: 'micron',
                name: 'Micron Technology',
                symbol: 'MU',
                category: 'equity',
                aliases: ['micron'],
                variants: [],
            },
            assetDescription: null,
            primaryVariant: null,
            token: undefined,
            tokenByMint: new Map(),
            fillQualityByMint: new Map(),
            marketMeta: undefined,
            marketMetaByMint: new Map(),
            effectiveStats: null,
            imageUrl: null,
            symbols: ['MU'],
            stockSymbol: 'MU',
            canonicalMarket: {
                source: 'clickhouse_stock',
                symbol: 'MU',
                price: 90,
                marketCap: 90 * 1_129_393_151,
                volume24hUSD: 1_000_000,
                priceChange24hPercent: 1.2,
                lastFetchedAt: 1_234_500,
                providerLastUpdatedAt: 999_999,
                asOf: 999_999,
            },
            mintRank: new Map(),
            sanctumActiveMints: null,
            includeMint: null,
            variantsMode: '',
            includesOut: {},
            hasIncludes: false,
        });

        const canonicalMarket = result.asset.canonicalMarket as { source: string; marketCap: number | null };
        expect(canonicalMarket.source).toBe('clickhouse_stock');
        expect(canonicalMarket.marketCap).toBe(90 * 1_129_393_151);
    });

    it('includes resolution metadata when present', () => {
        const result = buildAssetDetailResponse({
            asset: {
                assetId: 'usd',
                name: 'US Dollar',
                symbol: 'USD',
                category: 'stablecoin',
                aliases: ['usd'],
                variants: [],
            },
            assetDescription: null,
            primaryVariant: null,
            token: undefined,
            tokenByMint: new Map(),
            fillQualityByMint: new Map(),
            marketMeta: undefined,
            marketMetaByMint: new Map(),
            effectiveStats: null,
            imageUrl: null,
            symbols: ['USD'],
            stockSymbol: null,
            canonicalMarket: undefined,
            mintRank: new Map(),
            sanctumActiveMints: null,
            includeMint: null,
            variantsMode: '',
            includesOut: {},
            hasIncludes: false,
            resolution: {
                assetId: 'usd',
                ref: 'solana-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                resolvedBy: 'singletonMint',
                mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            },
        });

        expect(JSON.stringify(result.resolution)).toBe(
            JSON.stringify({
                assetId: 'usd',
                ref: 'solana-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                resolvedBy: 'singletonMint',
                mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            }),
        );
    });

    it('includes stockVariantTier on primary and tokenized-equity variant group rows', () => {
        const primaryVariant = {
            variantId: 'spacex:backpack',
            mint: 'BackpackSpcx1111111111111111111111111111',
            kind: 'tokenized_equity' as const,
            trustTier: 'tier2' as const,
            stockVariantTier: 'share_redeemable' as const,
            tags: ['equity'],
            label: 'Backpack Securities',
        };
        const result = buildAssetDetailResponse({
            asset: {
                assetId: 'spacex',
                name: 'SpaceX',
                symbol: 'SPCX',
                category: 'equity',
                aliases: ['spcx'],
                variants: [primaryVariant],
            },
            assetDescription: null,
            primaryVariant,
            token: undefined,
            tokenByMint: new Map(),
            fillQualityByMint: new Map(),
            marketMeta: undefined,
            marketMetaByMint: new Map(),
            effectiveStats: null,
            imageUrl: null,
            symbols: ['SPCX'],
            stockSymbol: 'SPCX',
            canonicalMarket: undefined,
            mintRank: new Map(),
            sanctumActiveMints: null,
            includeMint: null,
            variantsMode: '',
            includesOut: {},
            hasIncludes: false,
            primaryVariantStrategy: 'stock_redeemability',
        });

        expect(result.asset.primaryVariant?.stockVariantTier).toBe('share_redeemable');
        expect(result.asset.variantGroups.tokenizedEquity[0]?.stockVariantTier).toBe('share_redeemable');
        expect(result.asset.primaryVariantStrategy).toBe('stock_redeemability');
    });

    it('emits volume30dUSD when provided in stats', () => {
        const result = buildAssetDetailResponse({
            asset: {
                assetId: 'usd',
                name: 'US Dollar',
                symbol: 'USD',
                category: 'stablecoin',
                aliases: ['usd'],
                variants: [],
            },
            assetDescription: null,
            primaryVariant: null,
            token: undefined,
            tokenByMint: new Map(),
            fillQualityByMint: new Map(),
            marketMeta: undefined,
            marketMetaByMint: new Map(),
            effectiveStats: {
                price: null,
                liquidity: 1,
                volume24hUSD: 2,
                volume30dUSD: 30,
                marketCap: null,
                fdv: null,
                priceChange24hPercent: null,
                priceChange1hPercent: null,
                totalSupply: null,
                circulatingSupply: null,
            },
            imageUrl: null,
            symbols: ['USD'],
            stockSymbol: null,
            canonicalMarket: undefined,
            mintRank: new Map(),
            sanctumActiveMints: null,
            includeMint: null,
            variantsMode: '',
            includesOut: {},
            hasIncludes: false,
        });

        expect((result.asset.stats as { volume30dUSD: number }).volume30dUSD).toBe(30);
    });

    it('does not use the canonical image as a variant market logo fallback', () => {
        const result = buildAssetDetailResponse({
            asset: {
                assetId: 'uniswap',
                name: 'Uniswap',
                symbol: 'UNI',
                category: 'crypto',
                aliases: ['uniswap'],
                variants: [
                    {
                        variantId: 'uniswap:UNI_Bridge',
                        mint: 'uniHfuPhEQSrtpzXpJZDCSq53yaejKKpNhFUiKoHKHV',
                        kind: 'wrapped',
                        trustTier: 'tier3',
                        tags: ['Bridge'],
                    },
                ],
            },
            primaryVariant: null,
            token: undefined,
            tokenByMint: new Map([
                [
                    'uniHfuPhEQSrtpzXpJZDCSq53yaejKKpNhFUiKoHKHV',
                    {
                        address: 'uniHfuPhEQSrtpzXpJZDCSq53yaejKKpNhFUiKoHKHV',
                        symbol: 'UNI',
                        name: 'Uniswap',
                        decimals: 9,
                        logoURI: null,
                        liquidity: null,
                        volume24hUSD: 0,
                        price: null,
                        priceChange24hPercent: null,
                        priceChange1hPercent: null,
                        marketCap: null,
                        fdv: null,
                        holder: null,
                        totalSupply: null,
                        circulatingSupply: null,
                    },
                ],
            ]),
            fillQualityByMint: new Map(),
            marketMeta: undefined,
            marketMetaByMint: new Map(),
            effectiveStats: null,
            imageUrl: 'https://api.tokens.xyz/logos/popular/uniswap.png',
            symbols: ['UNI'],
            stockSymbol: null,
            canonicalMarket: undefined,
            mintRank: new Map(),
            sanctumActiveMints: null,
            includeMint: null,
            variantsMode: '',
            includesOut: {},
            hasIncludes: false,
        });

        expect(result.asset.imageUrl).toBe('https://api.tokens.xyz/logos/popular/uniswap.png');
        expect(result.asset.variantGroups.spot[0]?.market?.logoURI).toBe(null);
    });
});

describe('buildAssetDetailResponse advisories', () => {
    const SILV = 'SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L';
    const ONDO = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkYtvdQ7BPP3Qz1n';
    const BLOCKED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const compromised = { status: 'compromised' as const, reason: 'Issuer exploited', url: 'https://x', since: 2 };
    const blocked = { status: 'blocked' as const, reason: 'Drainer', url: null, since: 3 };

    function baseParams(asset: Parameters<typeof buildAssetDetailResponse>[0]['asset']) {
        return {
            asset,
            assetDescription: null,
            token: undefined,
            tokenByMint: new Map(),
            fillQualityByMint: new Map(),
            marketMeta: undefined,
            marketMetaByMint: new Map(),
            effectiveStats: null,
            imageUrl: null,
            symbols: ['XAG'],
            stockSymbol: null,
            canonicalMarket: undefined,
            mintRank: new Map(),
            sanctumActiveMints: null,
            includeMint: null,
            variantsMode: '',
            includesOut: {},
            hasIncludes: false,
        };
    }

    it('emits advisory on every variant group row and on the primary; advisories defaults to []', () => {
        const ondo = {
            variantId: 'silver:ondo',
            mint: ONDO,
            kind: 'wrapped' as const,
            trustTier: 'tier2' as const,
            tags: [],
        };
        const silv = {
            variantId: 'silver:silv',
            mint: SILV,
            kind: 'wrapped' as const,
            trustTier: 'tier2' as const,
            tags: [],
            advisory: compromised,
        };
        const result = buildAssetDetailResponse({
            ...baseParams({
                assetId: 'silver',
                name: 'Silver',
                symbol: 'XAG',
                category: 'commodity',
                aliases: [],
                variants: [ondo, silv],
            }),
            primaryVariant: ondo,
        });

        expect(result.asset.advisories).toEqual([]);
        expect(result.asset.primaryVariant?.advisory).toBeNull();
        expect('advisory' in result.asset.primaryVariant!).toBe(true);

        const byMint = new Map(result.asset.variantGroups.spot.map(v => [v.mint, v] as const));
        expect(byMint.get(ONDO)?.advisory).toBeNull();
        expect(byMint.get(SILV)?.advisory).toEqual(compromised);
    });

    it('carries the advisories summary (including hidden siblings) and a flagged primary keeps its advisory', () => {
        const silv = {
            variantId: 'silver:silv',
            mint: SILV,
            kind: 'wrapped' as const,
            trustTier: 'tier2' as const,
            tags: [],
            advisory: compromised,
        };
        const result = buildAssetDetailResponse({
            ...baseParams({
                assetId: 'silver',
                name: 'Silver',
                symbol: 'XAG',
                category: 'commodity',
                aliases: [],
                variants: [silv],
            }),
            primaryVariant: silv,
            advisories: [
                { mint: BLOCKED, variantId: 'silver:blocked', ...blocked },
                { mint: SILV, variantId: 'silver:silv', ...compromised },
            ],
        });

        expect(result.asset.primaryVariant?.advisory?.status).toBe('compromised');
        expect(result.asset.advisories.map(a => a.mint)).toEqual([BLOCKED, SILV]);
        expect(result.asset.advisories[0]?.variantId).toBe('silver:blocked');
        expect(result.asset.advisories[0]?.status).toBe('blocked');
    });
});

describe('buildAssetDetailResponse stablecoin pegHealth', () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkYtvdQ7BPP3Qz1n';
    const NOW = 1_800_000_000_000;

    const usdcHealth: StablecoinHealth = {
        pegHealth: {
            provider: 'webacy',
            tier: 'warning',
            overallRisk: 62.5,
            deviationPct: -2.4,
            priceUsd: 0.976,
            pegUsd: 1,
            tierSince: NOW - 60_000,
            updatedAt: NOW - 1_000,
            stale: false,
        },
        structuralHealth: null,
    };

    const usdc = { variantId: 'usd:usdc', mint: USDC, kind: 'native' as const, trustTier: 'tier1' as const, tags: [] };
    const usdt = { variantId: 'usd:usdt', mint: USDT, kind: 'native' as const, trustTier: 'tier1' as const, tags: [] };

    function baseParams(asset: Parameters<typeof buildAssetDetailResponse>[0]['asset']) {
        return {
            asset,
            assetDescription: null,
            token: undefined,
            tokenByMint: new Map(),
            fillQualityByMint: new Map(),
            marketMeta: undefined,
            marketMetaByMint: new Map(),
            effectiveStats: null,
            imageUrl: null,
            symbols: ['USD'],
            stockSymbol: null,
            canonicalMarket: undefined,
            mintRank: new Map(),
            sanctumActiveMints: null,
            includeMint: null,
            variantsMode: '',
            includesOut: {},
            hasIncludes: false,
        };
    }

    it('emits compact pegHealth on every variant row and the primary for stablecoin assets (null when no entry)', () => {
        const result = buildAssetDetailResponse({
            ...baseParams({
                assetId: 'usd',
                name: 'US Dollar',
                symbol: 'USD',
                category: 'stablecoin',
                aliases: ['usd'],
                variants: [usdc, usdt],
            }),
            primaryVariant: usdc,
            stablecoinHealthByMint: new Map([[USDC, usdcHealth]]),
        });

        const compact = {
            provider: 'webacy',
            tier: 'warning',
            deviationPct: -2.4,
            updatedAt: NOW - 1_000,
            stale: false,
        };
        expect(result.asset.primaryVariant?.pegHealth).toEqual(compact);
        expect('overallRisk' in (result.asset.primaryVariant?.pegHealth as object)).toBe(false);

        const byMint = new Map(result.asset.variantGroups.spot.map(v => [v.mint, v] as const));
        expect(byMint.get(USDC)?.pegHealth).toEqual(compact);
        expect(byMint.get(USDT)?.pegHealth).toBeNull();
        expect('pegHealth' in byMint.get(USDT)!).toBe(true);
    });

    it('still emits pegHealth: null for stablecoin assets when no map is provided', () => {
        const result = buildAssetDetailResponse({
            ...baseParams({
                assetId: 'usd',
                name: 'US Dollar',
                symbol: 'USD',
                category: 'stablecoin',
                aliases: ['usd'],
                variants: [usdc],
            }),
            primaryVariant: usdc,
        });

        expect('pegHealth' in result.asset.primaryVariant!).toBe(true);
        expect(result.asset.primaryVariant?.pegHealth).toBeNull();
        expect(result.asset.variantGroups.spot[0]?.pegHealth).toBeNull();
    });

    it('omits the pegHealth key entirely for non-stablecoin assets, even with a populated map', () => {
        const result = buildAssetDetailResponse({
            ...baseParams({
                assetId: 'silver',
                name: 'Silver',
                symbol: 'XAG',
                category: 'commodity',
                aliases: [],
                variants: [usdc],
            }),
            primaryVariant: usdc,
            stablecoinHealthByMint: new Map([[USDC, usdcHealth]]),
        });

        expect('pegHealth' in result.asset.primaryVariant!).toBe(false);
        expect('pegHealth' in result.asset.variantGroups.spot[0]!).toBe(false);
    });
});
