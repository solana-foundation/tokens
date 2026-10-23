import { describe, expect, test } from 'bun:test';
import { Effect, Exit } from 'effect';

import type { BadRequestError } from '@tokens/effect';

import type { V2ChainRollupResult, V2VariantResult } from '@/lib/cloudrun';

import {
    aggregateChainStats,
    buildStandaloneV2Variant,
    buildV2Asset,
    computeChainStats,
    computeChainStatsDetailed,
    decodeAssetIdPath,
    decodeChainAddressPath,
    decodeChainParam,
    decodeKeysParam,
    decodeListParam,
    decodePrimaryScopeParam,
    hasVisibleVariantOnChain,
    selectV2HeadlineStats,
    selectVolume30d,
    assessVariantMarkets,
    toV2Chain,
    toV2Market,
    toV2PegHealth,
    variantIssuance,
    variantIssuanceByKey,
    type V2Aggregate,
} from './_shared-assets';

const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/** The `details.code` of a failed decoder, or null when it succeeded. */
function failureCode<A>(effect: Effect.Effect<A, BadRequestError>): string | null {
    const exit = Effect.runSyncExit(Effect.flip(effect));
    if (!Exit.isSuccess(exit)) return null;
    const details = exit.value.details as Record<string, unknown> | undefined;
    return (details?.code as string | undefined) ?? null;
}

function variant(chain: V2VariantResult['chain'], address: string, kind: string, tags: string[] = []): V2VariantResult {
    return {
        chain,
        address,
        key: `${chain}:${address}`,
        assetId: 'usd',
        variantId: `${chain}:${address}`,
        kind,
        trustTier: 'tier3',
        stockVariantTier: null,
        tags,
        label: null,
        issuer: null,
        issuerUrl: null,
        decimals: 6,
        origin: 'coingecko',
        isActive: true,
        explorerUrl: 'https://example.test',
        coingeckoId: null,
    };
}

describe('hasVisibleVariantOnChain', () => {
    const blocked = { status: 'blocked' as const, reason: 'drainer', url: null, since: 1 };
    const caution = { status: 'caution' as const, reason: 'depeg', url: null, since: 1 };
    const variants = [variant('solana', USDC_SOLANA, 'stablecoin'), variant('base', USDC_BASE, 'stablecoin')];

    test('a chain whose only variant is blocked does not qualify the asset for chain=', () => {
        const advisories = new Map([[USDC_SOLANA, blocked]]);
        expect(hasVisibleVariantOnChain(variants, 'solana', advisories)).toBe(false);
        expect(hasVisibleVariantOnChain(variants, 'base', advisories)).toBe(true);
    });

    test('caution advisories and no advisories keep the variant visible', () => {
        expect(hasVisibleVariantOnChain(variants, 'solana', new Map([[USDC_SOLANA, caution]]))).toBe(true);
        expect(hasVisibleVariantOnChain(variants, 'solana', new Map())).toBe(true);
        expect(hasVisibleVariantOnChain(variants, 'ethereum', new Map())).toBe(false);
    });
});

describe('selectV2HeadlineStats', () => {
    const onChain = (overrides: Partial<V2Aggregate> = {}): V2Aggregate => ({
        price: 81_000,
        priceChange24hPercent: 1.5,
        priceChange1hPercent: 0.2,
        liquidity: 156,
        volume24hUSD: 40,
        trade24h: 9,
        marketCap: 9_400_000_000,
        fdv: 9_500_000_000,
        circulatingSupply: 116_000,
        totalSupply: 218_000,
        variantCount: 6,
        issuedVariantCount: 0,
        excludedByIssuance: { bridged: 0, wrapped: 6, derivative: 0 },
        excludedCount: 0,
        excludedByQuality: { stale: 0, dust: 0, priceOutlier: 0 },
        chainCount: 6,
        excludedFromSupplyCount: 6,
        ...overrides,
    });
    const coingecko = {
        coinId: 'bitcoin',
        priceUsd: 81_600,
        marketCapUsd: 1_640_000_000_000,
        volume24hUsd: 30_000_000_000,
        priceChange24hPercent: -0.4,
        providerLastUpdatedAt: 1,
        lastFetchedAt: 2,
        circulatingSupply: 19_900_000,
        totalSupply: 20_100_000,
        maxSupply: 21_000_000,
        fdvUsd: 1_710_000_000_000,
    };
    const stock = {
        assetId: 'tesla',
        symbol: 'TSLA',
        normalizedSymbol: 'TSLA',
        priceUsd: 378,
        volume24hUsd: 5_000_000_000,
        priceChange24hPercent: 2.1,
        sharesOutstanding: 3_200_000_000,
        sharesAsOf: 1,
        sharesLastFetchedAt: 1,
        asOf: 1,
        lastFetchedAt: 2,
        source: 'clickhouse_stock' as const,
        marketCapUsd: 1_210_000_000_000,
    };

    test("with a CoinGecko reference the valuation and supply are the coin's; liquidity, volume, 1h are on-chain", () => {
        const out = selectV2HeadlineStats({ reference: { coingecko, stock: null }, onChain: onChain(), volume30dUSD: 7 })!;
        expect(out.price).toBe(81_600);
        expect(out.marketCap).toBe(1_640_000_000_000);
        expect(out.fdv).toBe(1_710_000_000_000);
        expect(out.totalSupply).toBe(20_100_000);
        expect(out.circulatingSupply).toBe(19_900_000);
        expect(out.priceChange24hPercent).toBe(-0.4);
        expect(out.liquidity).toBe(156);
        expect(out.volume24hUSD).toBe(40);
        expect(out.volume30dUSD).toBe(7);
        expect(out.priceChange1hPercent).toBe(0.2);
        expect(out.source).toEqual({
            price: 'coingecko',
            marketCap: 'coingecko',
            fdv: 'coingecko',
            totalSupply: 'coingecko',
            circulatingSupply: 'coingecko',
            priceChange24hPercent: 'coingecko',
            liquidity: 'onchain',
            volume24hUSD: 'onchain',
            volume30dUSD: 'onchain',
            priceChange1hPercent: 'onchain',
        });
    });

    test('a null reference figure falls through to on-chain and says so', () => {
        const out = selectV2HeadlineStats({
            reference: { coingecko: { ...coingecko, totalSupply: null, fdvUsd: null }, stock: null },
            onChain: onChain(),
            volume30dUSD: null,
        })!;
        expect(out.totalSupply).toBe(218_000);
        expect(out.source.totalSupply).toBe('onchain');
        expect(out.fdv).toBe(9_500_000_000);
        expect(out.source.fdv).toBe('onchain');
        expect(out.volume30dUSD).toBeNull();
        expect('volume30dUSD' in out.source).toBe(false);
    });

    test("with a stock reference the price and company cap are the stock's, fdv is null, supply is the tokenized issued supply", () => {
        const out = selectV2HeadlineStats({
            reference: { coingecko: null, stock },
            onChain: onChain({ price: 8_826, marketCap: 90_000_000, circulatingSupply: 240_000, totalSupply: 289_000 }),
            volume30dUSD: null,
        })!;
        expect(out.price).toBe(378);
        expect(out.marketCap).toBe(1_210_000_000_000);
        expect(out.fdv).toBeNull();
        expect(out.circulatingSupply).toBe(240_000);
        expect(out.totalSupply).toBe(289_000);
        expect(out.priceChange24hPercent).toBe(2.1);
        expect(out.source.price).toBe('stock');
        expect(out.source.marketCap).toBe('stock');
        expect(out.source.circulatingSupply).toBe('onchain');
        expect('fdv' in out.source).toBe(false);
    });

    test('without any reference every figure is on-chain; with nothing at all the stats are null', () => {
        const out = selectV2HeadlineStats({ reference: { coingecko: null, stock: null }, onChain: onChain(), volume30dUSD: null })!;
        expect(out.price).toBe(81_000);
        expect(out.marketCap).toBe(9_400_000_000);
        expect(Object.values(out.source).every(v => v === 'onchain')).toBe(true);
        expect(
            selectV2HeadlineStats({
                reference: { coingecko: null, stock: null },
                onChain: onChain({
                    price: null,
                    priceChange24hPercent: null,
                    priceChange1hPercent: null,
                    liquidity: null,
                    volume24hUSD: null,
                    trade24h: null,
                    marketCap: null,
                    fdv: null,
                    circulatingSupply: null,
                    totalSupply: null,
                }),
                volume30dUSD: null,
            }),
        ).toBeNull();
    });
});

describe('buildV2Asset headline', () => {
    const request = new Request('https://api.example.test/api/v2/assets/x');
    const NOW = 1_800_000_000_000;
    const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
    const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
    const row = (price: number, liquidity: number, marketCap: number, supply: number, totalSupply = supply) => ({
        mint: 'x',
        source: 'birdeye' as const,
        lastFetchedAt: NOW - 60_000,
        price,
        liquidity,
        volume24hUSD: liquidity / 10,
        marketCap,
        circulatingSupply: supply,
        totalSupply,
    });
    const asset = (overrides: Partial<Parameters<typeof buildV2Asset>[0]['asset']> = {}) => ({
        assetId: 'bitcoin',
        category: 'crypto' as const,
        aliases: [],
        isActive: true,
        createdAt: 0,
        updatedAt: 0,
        region: null,
        industry: null,
        name: 'Bitcoin',
        symbol: 'BTC',
        coingeckoId: 'bitcoin',
        ...overrides,
    });
    const coingecko = {
        coinId: 'bitcoin',
        priceUsd: 81_600,
        marketCapUsd: 1_640_000_000_000,
        volume24hUsd: 30_000_000_000,
        priceChange24hPercent: -0.4,
        providerLastUpdatedAt: 1,
        lastFetchedAt: 2,
        circulatingSupply: 19_900_000,
        totalSupply: 20_100_000,
        maxSupply: 21_000_000,
        fdvUsd: 1_710_000_000_000,
    };
    const build = (params: {
        asset?: ReturnType<typeof asset>;
        variants: V2VariantResult[];
        markets: Array<[string, ReturnType<typeof row>]>;
        coingeckoPrice?: typeof coingecko | null;
        stockPrice?: Parameters<typeof buildV2Asset>[0]['stockPrice'];
        stockInstrument?: Parameters<typeof buildV2Asset>[0]['stockInstrument'];
        hideBlocked?: boolean;
        advisories?: Parameters<typeof buildV2Asset>[0]['advisoriesByMint'];
    }) =>
        buildV2Asset({
            request,
            asset: params.asset ?? asset(),
            variants: params.variants,
            marketByKey: new Map(params.markets),
            rollupByChain: null,
            advisoriesByMint: params.advisories ?? new Map(),
            coingeckoPrice: params.coingeckoPrice ?? null,
            stockInstrument: params.stockInstrument ?? null,
            stockPrice: params.stockPrice ?? null,
            preStocksByMint: new Map(),
            requestedStrategy: null,
            hideBlocked: params.hideBlocked ?? false,
            listChain: null,
            includeVariants: true,
            rank: null,
            nowMs: NOW,
        })!;

    test("bitcoin: headline supply is CoinGecko's, wrapped claims stay out of aggregate supply, referenceMarket is present", () => {
        const wbtc = { ...variant('ethereum', WBTC, 'wrapped'), assetId: 'bitcoin' };
        const cbbtc = { ...variant('base', CBBTC, 'wrapped'), assetId: 'bitcoin' };
        const out = build({
            variants: [wbtc, cbbtc],
            markets: [
                [`ethereum:${WBTC}`, row(81_600, 9_000_000, 9_480_000_000, 116_000)],
                [`base:${CBBTC}`, row(81_400, 4_000_000, 7_790_000_000, 95_700)],
            ],
            coingeckoPrice: coingecko,
        });
        expect(out.stats?.totalSupply).toBe(20_100_000);
        expect(out.stats?.marketCap).toBe(1_640_000_000_000);
        expect(out.stats?.source.totalSupply).toBe('coingecko');
        expect(out.stats?.liquidity).toBe(13_000_000);
        expect(out.stats?.source.liquidity).toBe('onchain');
        expect(out.aggregate.totalSupply).toBeNull();
        expect(out.aggregate.excludedByIssuance.wrapped).toBe(2);
        expect(out.aggregate.price).toBeCloseTo((81_600 * 9_000_000 + 81_400 * 4_000_000) / 13_000_000, 3);
        expect(out.referenceMarket?.source).toBe('coingecko');
    });

    test('a CoinGecko id without a synced price row yields referenceMarket null and an on-chain headline', () => {
        const wbtc = { ...variant('ethereum', WBTC, 'native'), assetId: 'bitcoin' };
        const out = build({ variants: [wbtc], markets: [[`ethereum:${WBTC}`, row(81_600, 9_000_000, 9_480_000_000, 116_000)]] });
        expect(out.referenceMarket).toBeNull();
        expect(out.stats?.price).toBe(81_600);
        expect(out.stats?.source.price).toBe('onchain');
        expect(out.stats?.marketCap).toBe(9_480_000_000);
    });

    test('tesla: the stock price is the headline even with a liquid pool; fdv null; supply is the tokenized float', () => {
        const SOL = 'XsDoVfqeBukxuZHWhdvWHBhgnNfS3zAXPj1F4FR9eYd';
        const ARB = '0x8ad3c73f0c8a5fe6c2a6b7f4e4ad6f34e8ea4ab1';
        const sol = { ...variant('solana', SOL, 'tokenized_equity'), assetId: 'tesla' };
        const arb = { ...variant('arbitrum', ARB, 'tokenized_equity'), assetId: 'tesla' };
        const out = build({
            asset: asset({ assetId: 'tesla', category: 'equity', name: 'Tesla', symbol: 'TSLA', coingeckoId: 'tesla-xstock' }),
            variants: [sol, arb],
            markets: [
                [`solana:${SOL}`, row(379, 4_200_000, 90_000_000, 237_000)],
                [`arbitrum:${ARB}`, { ...row(15_192, 11, 739_000_000, 48_000), volume24hUSD: 40 }],
            ],
            stockInstrument: { assetId: 'tesla', symbol: 'TSLA', normalizedSymbol: 'TSLA', exchange: null, name: 'Tesla' } as never,
            stockPrice: {
                assetId: 'tesla',
                symbol: 'TSLA',
                normalizedSymbol: 'TSLA',
                priceUsd: 378,
                volume24hUsd: 5_000_000_000,
                priceChange24hPercent: 2.1,
                sharesOutstanding: 3_200_000_000,
                sharesAsOf: NOW,
                sharesLastFetchedAt: NOW,
                asOf: NOW,
                lastFetchedAt: NOW,
                source: 'clickhouse_stock',
            },
        });
        expect(out.stats?.price).toBe(378);
        expect(out.stats?.source.price).toBe('stock');
        expect(out.stats?.fdv).toBeNull();
        expect(out.stats?.circulatingSupply).toBe(237_000);
        expect(out.stats?.source.circulatingSupply).toBe('onchain');
        expect(out.aggregate.marketCap).toBe(90_000_000);
        expect(out.aggregate.excludedCount).toBe(1);
        expect(out.variants?.find(v => v.chain === 'arbitrum')?.market?.quality.included).toBe(false);
        expect(out.referenceMarket?.source).toBe('stock');
    });

    test("ethereum: the native coin's home-chain row carries the reference supply; Base ETH is bridged", () => {
        const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
        const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
        const home = { ...variant('ethereum', NATIVE, 'native', ['native-coin', 'native-home']), assetId: 'ethereum' };
        const weth = { ...variant('ethereum', WETH, 'wrapped', ['native-coin']), assetId: 'ethereum' };
        const baseEth = { ...variant('base', NATIVE, 'bridged', ['native-coin']), assetId: 'ethereum' };
        const eth = {
            ...coingecko,
            coinId: 'ethereum',
            priceUsd: 3_000,
            marketCapUsd: 366_000_000_000,
            circulatingSupply: 122_000_000,
            totalSupply: 122_000_000,
            fdvUsd: 366_000_000_000,
        };
        const out = build({
            asset: asset({ assetId: 'ethereum', name: 'Ethereum', symbol: 'ETH', coingeckoId: 'ethereum' }),
            variants: [home, weth, baseEth],
            markets: [[`ethereum:${WETH}`, row(3_000, 50_000_000, 7_800_000_000, 2_600_000)]],
            coingeckoPrice: eth,
        });
        expect(out.chainStats.ethereum?.marketCap).toBe(366_000_000_000);
        expect(out.chainStats.ethereum?.circulatingSupply).toBe(122_000_000);
        expect(out.chainStats.ethereum?.issuedVariantCount).toBe(1);
        expect(out.chainStats.ethereum?.liquidity).toBe(50_000_000);
        expect(out.chainStats.base?.issuedVariantCount).toBe(0);
        expect(out.chainStats.base?.excludedByIssuance.bridged).toBe(1);
        expect(out.aggregate.marketCap).toBe(366_000_000_000);
    });

    test('a list (hideBlocked) and the detail of one asset share stats and aggregate', () => {
        const wbtc = { ...variant('ethereum', WBTC, 'native'), assetId: 'bitcoin' };
        const blockedSol = { ...variant('solana', 'B1ockedMint11111111111111111111111111111111', 'native'), assetId: 'bitcoin' };
        const markets: Array<[string, ReturnType<typeof row>]> = [
            [`ethereum:${WBTC}`, row(81_600, 9_000_000, 9_480_000_000, 116_000)],
            [`solana:${blockedSol.address}`, row(81_500, 2_000_000, 500_000_000, 6_000)],
        ];
        const advisories = new Map([
            [blockedSol.address, { status: 'blocked' as const, reason: 'x', url: null, since: 1, source: 'admin' as const }],
        ]);
        const detail = build({ variants: [wbtc, blockedSol], markets, advisories, hideBlocked: false });
        const list = build({ variants: [wbtc, blockedSol], markets, advisories, hideBlocked: true });
        expect(list.aggregate).toEqual(detail.aggregate);
        expect(list.stats).toEqual(detail.stats);
        expect(list.variants?.map(v => v.key)).toEqual([`ethereum:${WBTC}`]);
        expect(detail.variants?.length).toBe(2);
    });
});

describe('decoders', () => {
    test('chain param: absent → null, unknown → invalid_chain', () => {
        expect(Effect.runSync(decodeChainParam(new URLSearchParams('')))).toBeNull();
        expect(Effect.runSync(decodeChainParam(new URLSearchParams('chain=base')))).toBe('base');
        expect(failureCode(decodeChainParam(new URLSearchParams('chain=polygon-pos')))).toBe('invalid_chain');
    });

    test('chain/address path: family-checked, EVM lowercased', () => {
        const base = Effect.runSync(
            decodeChainAddressPath({ chain: 'base', address: USDC_BASE.toUpperCase().replace('0X', '0x') }),
        );
        expect(base).toEqual({ chain: 'base', address: USDC_BASE, key: `base:${USDC_BASE}` });
        expect(Effect.runSync(decodeChainAddressPath({ chain: 'solana', address: USDC_SOLANA })).key).toBe(
            `solana:${USDC_SOLANA}`,
        );
        expect(failureCode(decodeChainAddressPath({ chain: 'ethereum', address: USDC_SOLANA }))).toBe(
            'invalid_address',
        );
        expect(failureCode(decodeChainAddressPath({ chain: 'solana', address: USDC_BASE }))).toBe('invalid_address');
        expect(failureCode(decodeChainAddressPath({ chain: 'tron', address: USDC_BASE }))).toBe('invalid_chain');
    });

    test('keys param: required, deduped, bounded, request order kept', () => {
        const keys = Effect.runSync(
            decodeKeysParam(new URLSearchParams(`keys=base:${USDC_BASE},solana:${USDC_SOLANA},base:${USDC_BASE}`)),
        );
        expect(keys.map(k => k.key)).toEqual([`base:${USDC_BASE}`, `solana:${USDC_SOLANA}`]);
        expect(failureCode(decodeKeysParam(new URLSearchParams('')))).toBe('invalid_key');
        expect(failureCode(decodeKeysParam(new URLSearchParams('keys=nocolon')))).toBe('invalid_key');
        expect(failureCode(decodeKeysParam(new URLSearchParams(`keys=base:${USDC_SOLANA}`)))).toBe('invalid_address');
        const many = Array.from(
            { length: 51 },
            (_, i) => `solana:${USDC_SOLANA.slice(0, -2)}${String(i).padStart(2, '1')}`,
        ).join(',');
        expect(failureCode(decodeKeysParam(new URLSearchParams(`keys=${many}`)))).toBe('too_many_keys');
    });

    test('assetId path rejects addresses and keys with a hint', () => {
        expect(Effect.runSync(decodeAssetIdPath('bitcoin'))).toBe('bitcoin');
        expect(failureCode(decodeAssetIdPath(USDC_SOLANA))).toBe('invalid_asset_id');
        expect(failureCode(decodeAssetIdPath(USDC_BASE))).toBe('invalid_asset_id');
        expect(failureCode(decodeAssetIdPath(`solana:${USDC_SOLANA}`))).toBe('invalid_asset_id');
        expect(failureCode(decodeAssetIdPath(' '))).toBe('invalid_asset_id');
    });

    test('list param: all by default, unknown slugs rejected', () => {
        expect(Effect.runSync(decodeListParam(new URLSearchParams('')))).toBe('all');
        expect(Effect.runSync(decodeListParam(new URLSearchParams('list=majors')))).toBe('majors');
        expect(failureCode(decodeListParam(new URLSearchParams('list=nope')))).toBe('invalid_list');
    });
    test('primaryScope param: executable by default, unknown → invalid_primary_scope', () => {
        expect(Effect.runSync(decodePrimaryScopeParam(new URLSearchParams('')))).toBe('executable');
        expect(Effect.runSync(decodePrimaryScopeParam(new URLSearchParams('primaryScope=global')))).toBe('global');
        expect(failureCode(decodePrimaryScopeParam(new URLSearchParams('primaryScope=nope')))).toBe(
            'invalid_primary_scope',
        );
    });
});

describe('chain stats', () => {
    const variants = [
        variant('solana', USDC_SOLANA, 'native'),
        variant('base', USDC_BASE, 'stablecoin'),
        variant('base', '0x0000000000000000000000000000000000000001', 'bridged'),
        variant('ethereum', '0x0000000000000000000000000000000000000002', 'spot', ['issuance:wrapped']),
    ];
    const market = (liquidity: number, marketCap: number) => ({
        mint: 'x',
        source: 'birdeye' as const,
        lastFetchedAt: 1,
        liquidity,
        marketCap,
        volume24hUSD: 10,
        circulatingSupply: 5,
    });
    const marketByKey = new Map([
        [`solana:${USDC_SOLANA}`, market(100, 1000)],
        [`base:${USDC_BASE}`, market(50, 500)],
        ['base:0x0000000000000000000000000000000000000001', market(5, 50)],
        ['ethereum:0x0000000000000000000000000000000000000002', market(1, 10)],
    ]);

    test('issuance: tag wins, then kind; LST / ETF kinds are derivatives', () => {
        const at = (kind: string, tags: string[] = []) => ({ chain: 'solana' as const, address: USDC_SOLANA, kind, tags });
        expect(variantIssuance(at('bridged'))).toBe('bridged');
        expect(variantIssuance(at('wrapped'))).toBe('wrapped');
        expect(variantIssuance(at('stablecoin'))).toBe('native');
        expect(variantIssuance(at('yield'))).toBe('derivative');
        expect(variantIssuance(at('lst'))).toBe('derivative');
        expect(variantIssuance(at('etf'))).toBe('derivative');
        expect(variantIssuance(at('bridged', ['issuance:native']))).toBe('native');
        expect(variantIssuance(at('stablecoin', ['issuance:derivative']))).toBe('derivative');
    });

    test('a Solana LST adds liquidity to the chain but never to issued supply or market cap', () => {
        const lst = variant('solana', 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 'yield');
        const byKey = new Map([
            [`solana:${USDC_SOLANA}`, market(100, 1000)],
            [lst.key, market(900, 9000)],
        ]);
        const stats = computeChainStats([variants[0]!, lst], byKey, null);
        expect(stats.solana?.liquidity).toBe(1000);
        expect(stats.solana?.marketCap).toBe(1000);
        expect(stats.solana?.circulatingSupply).toBe(5);
        expect(stats.solana?.issuedVariantCount).toBe(1);
        expect(stats.solana?.excludedByIssuance).toEqual({ bridged: 0, wrapped: 0, derivative: 1 });
        const aggregate = aggregateChainStats(stats);
        expect(aggregate.excludedFromSupplyCount).toBe(1);
        expect(aggregate.excludedByIssuance.derivative).toBe(1);
    });

    test('a standalone fund whose only variant is a yield token counts its own supply', () => {
        const tbill = variant('solana', '4MmJVdwYN8LwvbGeCowYjSx7KoEi6BJWg8XXnW4fDDp6', 'yield');
        const byKey = new Map([[tbill.key, market(300, 3000)]]);
        const stats = computeChainStats([tbill], byKey, null);
        expect(stats.solana?.marketCap).toBe(3000);
        expect(stats.solana?.circulatingSupply).toBe(5);
        expect(stats.solana?.issuedVariantCount).toBe(1);
        expect(stats.solana?.excludedByIssuance).toEqual({ bridged: 0, wrapped: 0, derivative: 0 });
        expect(variantIssuanceByKey([tbill]).get(tbill.key)).toBe('native');
        // An explicit tag is an operator decision and is not promoted.
        const tagged = variant('solana', '4MmJVdwYN8LwvbGeCowYjSx7KoEi6BJWg8XXnW4fDDp6', 'yield', ['issuance:derivative']);
        expect(computeChainStats([tagged], byKey, null).solana?.marketCap).toBeNull();
        // A commodity's lone ETF-share token is not the metal's supply.
        const slv = variant('solana', '4MmJVdwYN8LwvbGeCowYjSx7KoEi6BJWg8XXnW4fDDp6', 'etf');
        const commodity = computeChainStats([slv], byKey, null, undefined, undefined, variantIssuanceByKey([slv], 'commodity'));
        expect(commodity.solana?.marketCap).toBeNull();
        expect(commodity.solana?.liquidity).toBe(300);
        expect(commodity.solana?.excludedByIssuance.derivative).toBe(1);
    });

    test('liquidity sums every variant; supply / mcap only issued ones; canonical chain order', () => {
        const stats = computeChainStats(variants, marketByKey, null);
        expect(Object.keys(stats)).toEqual(['solana', 'ethereum', 'base']);
        expect(stats.base).toEqual({
            price: null,
            priceChange24hPercent: null,
            priceChange1hPercent: null,
            liquidity: 55,
            volume24hUSD: 20,
            trade24h: null,
            marketCap: 500,
            fdv: null,
            circulatingSupply: 5,
            totalSupply: null,
            variantCount: 2,
            issuedVariantCount: 1,
            excludedByIssuance: { bridged: 1, wrapped: 0, derivative: 0 },
            excludedCount: 0,
            excludedByQuality: { stale: 0, dust: 0, priceOutlier: 0 },
        });
        expect(stats.ethereum?.marketCap).toBeNull();
        expect(stats.ethereum?.excludedByIssuance).toEqual({ bridged: 0, wrapped: 1, derivative: 0 });
        expect(stats.ethereum?.liquidity).toBe(1);
        const aggregate = aggregateChainStats(stats);
        expect(aggregate.liquidity).toBe(156);
        expect(aggregate.marketCap).toBe(1500);
        expect(aggregate.chainCount).toBe(3);
        expect(aggregate.variantCount).toBe(4);
        expect(aggregate.excludedFromSupplyCount).toBe(2);
        expect(aggregate.excludedByIssuance).toEqual({ bridged: 1, wrapped: 1, derivative: 0 });
    });

    test('trade24h sums known counts per chain and in the aggregate', () => {
        const withTrades = new Map<string, ReturnType<typeof market> & { trade24h?: number }>([
            [`solana:${USDC_SOLANA}`, { ...market(100, 1000), trade24h: 70 }],
            [`base:${USDC_BASE}`, { ...market(50, 500), trade24h: 5 }],
            ['base:0x0000000000000000000000000000000000000001', { ...market(5, 50), trade24h: 2 }],
            ['ethereum:0x0000000000000000000000000000000000000002', market(1, 10)],
        ]);
        const stats = computeChainStats(variants, withTrades, null);
        expect(stats.solana?.trade24h).toBe(70);
        expect(stats.base?.trade24h).toBe(7);
        expect(stats.ethereum?.trade24h).toBeNull();
        expect(aggregateChainStats(stats).trade24h).toBe(77);
    });

    test('a row the quality guard excludes leaves every sum but still counts as a variant', () => {
        const NOW = 1_800_000_000_000;
        const byKey = new Map([
            [`solana:${USDC_SOLANA}`, { ...market(100_000, 1000), price: 1, volume24hUSD: 50_000, lastFetchedAt: NOW - 60_000 }],
            // Dust-liquidity row priced 40× the reference: the Tesla Arbitrum case.
            [`base:${USDC_BASE}`, { ...market(11, 739_000_000), price: 40, volume24hUSD: 40, lastFetchedAt: NOW - 60_000 }],
        ]);
        const quality = assessVariantMarkets([variants[0]!, variants[1]!], byKey, { priceUsd: 1 }, NOW);
        expect(quality.get(`base:${USDC_BASE}`)?.included).toBe(false);
        const stats = computeChainStats([variants[0]!, variants[1]!], byKey, null, quality);
        expect(stats.base?.liquidity).toBeNull();
        expect(stats.base?.marketCap).toBeNull();
        expect(stats.base?.variantCount).toBe(1);
        expect(stats.base?.issuedVariantCount).toBe(0);
        expect(stats.base?.excludedCount).toBe(1);
        // Dust rows never reach the price pass: one reason, not two.
        expect(stats.base?.excludedByQuality).toEqual({ stale: 0, dust: 1, priceOutlier: 0 });
        expect(stats.solana?.marketCap).toBe(1000);
        expect(stats.solana?.liquidity).toBe(100_000);
        const aggregate = aggregateChainStats(stats);
        expect(aggregate.marketCap).toBe(1000);
        expect(aggregate.excludedCount).toBe(1);
        expect(aggregate.excludedByQuality.dust).toBe(1);
        expect(aggregate.excludedFromSupplyCount).toBe(0);
    });

    test('an LST priced at 1.3 SOL is a derivative and exempt from the outlier check; a spot row at 2× is not', () => {
        const NOW = 1_800_000_000_000;
        const sol = variant('solana', 'So11111111111111111111111111111111111111112', 'native');
        const msol = variant('solana', 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'yield');
        const odd = variant('solana', 'OddPool1111111111111111111111111111111111111', 'spot');
        const byKey = new Map([
            [sol.key, { ...market(1_000_000, 0), price: 100, volume24hUSD: 500_000, lastFetchedAt: NOW - 60_000 }],
            [msol.key, { ...market(200_000, 0), price: 130, volume24hUSD: 50_000, lastFetchedAt: NOW - 60_000 }],
            [odd.key, { ...market(20_000, 0), price: 200, volume24hUSD: 5_000, lastFetchedAt: NOW - 60_000 }],
        ]);
        const quality = assessVariantMarkets([sol, msol, odd], byKey, { priceUsd: 100 }, NOW);
        expect(quality.get(msol.key)).toEqual({ included: true, reasons: [] });
        expect(quality.get(odd.key)?.reasons).toEqual(['price_outlier']);
        const stats = computeChainStats([sol, msol, odd], byKey, null, quality);
        expect(stats.solana?.liquidity).toBe(1_200_000);
        expect(stats.solana?.excludedByIssuance.derivative).toBe(1);
    });

    test('a batch (standalone) variant carries its own staleness verdict instead of a default included', () => {
        const NOW = 1_800_000_000_000;
        const v = variant('base', USDC_BASE, 'stablecoin');
        const build = (lastFetchedAt: number) =>
            buildStandaloneV2Variant({
                request: new Request('https://api.example.test/api/v2/variants?keys=x'),
                variant: v,
                market: { ...market(50_000, 500), price: 1, volume24hUSD: 20_000, lastFetchedAt },
                advisoriesByMint: new Map(),
                canonicalSymbol: 'USDC',
                nowMs: NOW,
            });
        expect(build(NOW - 60_000).market?.quality).toEqual({ included: true, reasons: [] });
        expect(build(NOW - 3 * 24 * 60 * 60 * 1000).market?.quality).toEqual({ included: false, reasons: ['stale'] });
    });

    test('the Solana worker rollup no longer overrides liquidity / volume: every chain is the guarded variant sum', () => {
        const rollup: V2ChainRollupResult = {
            assetId: 'usd',
            chain: 'solana',
            liquidity: 999,
            volume24hUSD: 42,
            volume30dUSD: 7,
            volume30dDays: 30,
            primaryAddress: null,
            variantCount: 1,
            lastComputedAt: 1,
            origin: 'solana_v1',
        };
        const stats = computeChainStats(variants, marketByKey, new Map([['solana', rollup]]));
        expect(stats.solana?.liquidity).toBe(100);
        expect(stats.solana?.volume24hUSD).toBe(10);
        expect(stats.solana?.marketCap).toBe(1000);
    });

    test('a row the guard excludes leaves the chain sums even when a worker rollup is present', () => {
        const NOW = 1_800_000_000_000;
        const junk = variant('solana', 'JunkMint11111111111111111111111111111111111', 'spot');
        const byKey = new Map([
            [`solana:${USDC_SOLANA}`, { ...market(100_000, 1000), price: 1, volume24hUSD: 50_000, lastFetchedAt: NOW - 60_000 }],
            [junk.key, { ...market(11, 5), price: 40, volume24hUSD: 40, lastFetchedAt: NOW - 60_000 }],
        ]);
        const rollup: V2ChainRollupResult = {
            assetId: 'usd',
            chain: 'solana',
            liquidity: 100_011,
            volume24hUSD: 50_040,
            volume30dUSD: 7,
            volume30dDays: 30,
            primaryAddress: null,
            variantCount: 2,
            lastComputedAt: 1,
            origin: 'solana_v1',
        };
        const quality = assessVariantMarkets([variants[0]!, junk], byKey, { priceUsd: 1 }, NOW);
        expect(quality.get(junk.key)?.included).toBe(false);
        const stats = computeChainStats([variants[0]!, junk], byKey, new Map([['solana', rollup]]), quality);
        expect(stats.solana?.liquidity).toBe(100_000);
        expect(stats.solana?.volume24hUSD).toBe(50_000);
        expect(stats.solana?.excludedCount).toBe(1);
    });

    test("an ETF share's price stays out of gold's average but stands in when a chain has only derivatives", () => {
        const spot = variant('solana', 'PaxGold11111111111111111111111111111111111', 'spot');
        const share = variant('solana', 'GldxShare111111111111111111111111111111111', 'etf');
        const byKey = new Map([
            [spot.key, { ...market(100_000, 1000), price: 4000, volume24hUSD: 50_000 }],
            [share.key, { ...market(900_000, 9000), price: 300, volume24hUSD: 90_000 }],
        ]);
        const { chainStats, accumulatorsByChain } = computeChainStatsDetailed([spot, share], byKey, null);
        expect(chainStats.solana?.price).toBe(4000);
        expect(chainStats.solana?.liquidity).toBe(1_000_000);
        expect(chainStats.solana?.excludedByIssuance.derivative).toBe(1);
        expect(aggregateChainStats(chainStats, accumulatorsByChain).price).toBe(4000);
        // Across chains too: an ETF-only chain does not mix its share price into the aggregate.
        const shareOnBase = variant('base', '0x00000000000000000000000000000000000000e1', 'etf');
        byKey.set(shareOnBase.key, { ...market(5_000_000, 50_000), price: 310, volume24hUSD: 1_000_000 });
        const cross = computeChainStatsDetailed([spot, share, shareOnBase], byKey, null);
        expect(cross.chainStats.base?.price).toBe(310);
        expect(aggregateChainStats(cross.chainStats, cross.accumulatorsByChain).price).toBe(4000);
        // Silver-like: a commodity whose only token is the fund share still has a price.
        const only = computeChainStats([share], byKey, null, undefined, undefined, variantIssuanceByKey([share], 'commodity'));
        expect(only.solana?.price).toBe(300);
        expect(only.solana?.marketCap).toBeNull();
    });

    test('a row missing a field lends no weight to that field: +10% on $10K, -10% on $10K and $90K unreported is 0%', () => {
        const a1 = variant('base', '0x00000000000000000000000000000000000000a1', 'stablecoin');
        const a2 = variant('base', '0x00000000000000000000000000000000000000a2', 'stablecoin');
        const b1 = variant('ethereum', '0x00000000000000000000000000000000000000b1', 'stablecoin');
        const byKey = new Map([
            [a1.key, { ...market(10_000, 100), price: 1, priceChange24hPercent: 10 }],
            [a2.key, { ...market(90_000, 100), price: 1, priceChange24hPercent: undefined }],
            [b1.key, { ...market(10_000, 100), price: 1, priceChange24hPercent: -10 }],
        ]);
        const { chainStats, accumulatorsByChain } = computeChainStatsDetailed([a1, a2, b1], byKey, null);
        expect(chainStats.base?.priceChange24hPercent).toBe(10);
        expect(aggregateChainStats(chainStats, accumulatorsByChain).priceChange24hPercent).toBeCloseTo(0, 9);
        // Without the accumulators the chain's whole liquidity weights the field (the documented approximation).
        expect(aggregateChainStats(chainStats).priceChange24hPercent).toBeCloseTo((100_000 * 10 - 10_000 * 10) / 110_000, 6);
    });

    test('a priced row with no liquidity or volume still yields a price (plain mean fallback)', () => {
        const lone = variant('base', '0x00000000000000000000000000000000000000c1', 'stablecoin');
        const other = variant('base', '0x00000000000000000000000000000000000000c2', 'stablecoin');
        const byKey = new Map([
            [lone.key, { ...market(0, 100), price: 2, volume24hUSD: 0, priceChange24hPercent: 5 }],
            [other.key, { ...market(0, 100), price: 4, volume24hUSD: 0, priceChange24hPercent: undefined }],
        ]);
        const { chainStats, accumulatorsByChain } = computeChainStatsDetailed([lone, other], byKey, null);
        expect(chainStats.base?.price).toBe(3);
        expect(chainStats.base?.priceChange24hPercent).toBe(5);
        const aggregate = aggregateChainStats(chainStats, accumulatorsByChain);
        expect(aggregate.price).toBe(3);
        expect(aggregate.priceChange24hPercent).toBe(5);
        // A weighted row wins over the plain fallback once one exists.
        byKey.set(other.key, { ...market(50, 100), price: 4, volume24hUSD: 0, priceChange24hPercent: undefined });
        expect(computeChainStats([lone, other], byKey, null).base?.price).toBe(4);
    });

    test('chain price is the liquidity-weighted average of included priced rows; aggregate weights chains by liquidity', () => {
        const byKey = new Map([
            [`solana:${USDC_SOLANA}`, { ...market(300, 1000), price: 1.0 }],
            [`base:${USDC_BASE}`, { ...market(100, 500), price: 1.02 }],
            ['base:0x0000000000000000000000000000000000000001', { ...market(100, 50), price: 0.98 }],
            ['ethereum:0x0000000000000000000000000000000000000002', { ...market(1, 10), price: 1.5, totalSupply: 7 }],
        ]);
        const stats = computeChainStats(variants, byKey, null);
        expect(stats.base?.price).toBeCloseTo(1.0, 6);
        expect(stats.ethereum?.price).toBe(1.5);
        expect(stats.ethereum?.totalSupply).toBeNull();
        const aggregate = aggregateChainStats(stats);
        expect(aggregate.price).toBeCloseTo((300 * 1.0 + 200 * 1.0 + 1 * 1.5) / 501, 6);
    });
});

describe('mappers', () => {
    test('toV2Market: every key present, NaN never emitted, identity fields excluded', () => {
        const out = toV2Market({
            mint: 'x',
            source: 'birdeye',
            lastFetchedAt: 5,
            price: Number.NaN,
            liquidity: 3,
            symbol: 'USDC',
            decimals: 6,
        })!;
        expect(out.price).toBeNull();
        expect(out.liquidity).toBe(3);
        expect(out.metricsSource).toBeNull();
        expect(out.lastFetchedAt).toBe(5);
        expect('symbol' in out).toBe(false);
        expect('decimals' in out).toBe(false);
        expect(Object.keys(out).length).toBe(21);
        expect(toV2Market(null)).toBeNull();
        expect(out.quality).toEqual({ included: true, reasons: [] });
        expect(
            toV2Market({ mint: 'x', source: 'birdeye', lastFetchedAt: 5 }, { included: false, reasons: ['stale'] })?.quality,
        ).toEqual({ included: false, reasons: ['stale'] });
    });

    test('toV2Chain exposes caip2, explorer template and capabilities', () => {
        const base = toV2Chain('base', { variantCount: 3, assetCount: 2 });
        expect(base.caip2).toBe('eip155:8453');
        expect(base.evmChainId).toBe(8453);
        expect(base.explorer.tokenUrlTemplate).toBe('https://basescan.org/token/{address}');
        expect(base.capabilities.markets).toBe(true);
        expect(base.capabilities.swap).toBe(false);
        expect(toV2Chain('solana', { variantCount: null, assetCount: null }).evmChainId).toBeNull();
    });
});

describe('detail include= enrichments', () => {
    const solana = variant('solana', USDC_SOLANA, 'native');
    const base = variant('base', USDC_BASE, 'stablecoin');
    const request = new Request('https://api.example.test/api/v2/assets/usd');
    const asset = {
        assetId: 'usd',
        category: 'stablecoin' as const,
        aliases: [],
        isActive: true,
        createdAt: 0,
        updatedAt: 0,
        region: null,
        industry: null,
        name: 'US Dollar',
        symbol: 'USD',
    };
    const fillQuality = {
        source: 'clickhouse_fill_quality' as const,
        range: '24h' as const,
        horizon: '5s' as const,
        quoteMint: USDC_SOLANA,
        volume24hUSD: 1,
        trade24h: 2,
        botVolume24hUSD: 0,
        botTrade24h: 0,
        botVolumeRatio: Number.NaN,
        fee24hUSD: 0,
        feeBps: 0,
        flowSourceCount: 1,
        markoutPnl24hUSD: null,
        markoutCount: null,
        markoutBps: null,
        executionScore: 0.5,
        isEligibleForPrimary: true,
        asOf: null,
        lastComputedAt: 10,
    };
    const build = (enrichments: Parameters<typeof buildV2Asset>[0]['enrichments']) =>
        buildV2Asset({
            request,
            asset,
            variants: [solana, base],
            marketByKey: new Map(),
            rollupByChain: null,
            advisoriesByMint: new Map(),
            coingeckoPrice: null,
            stockInstrument: null,
            stockPrice: null,
            preStocksByMint: new Map(),
            requestedStrategy: null,
            hideBlocked: false,
            listChain: null,
            includeVariants: true,
            rank: null,
            ...(enrichments ? { enrichments } : {}),
        })!;

    test('keys are absent when nothing was requested', () => {
        const out = build(undefined);
        for (const v of out.variants!) {
            expect('executionQuality' in v).toBe(false);
            expect('pegHealth' in v).toBe(false);
            expect('preStocks' in v).toBe(false);
        }
    });

    test('requested keys are present on every variant, null off-capability, same object on primaryVariant', () => {
        const out = build({
            executionQualityByMint: new Map([[USDC_SOLANA, fillQuality]]),
            stablecoinHealthByMint: new Map(),
            preStocks: true,
        });
        const byKey = new Map(out.variants!.map(v => [v.key, v] as const));
        const sol = byKey.get(`solana:${USDC_SOLANA}`)!;
        const evm = byKey.get(`base:${USDC_BASE}`)!;
        expect(sol.executionQuality?.quoteKey).toBe(`solana:${USDC_SOLANA}`);
        expect('quoteMint' in (sol.executionQuality ?? {})).toBe(false);
        expect(sol.executionQuality?.botVolumeRatio).toBeNull();
        expect(sol.pegHealth).toBeNull();
        expect(sol.preStocks).toBeNull();
        expect(evm.executionQuality).toBeNull();
        expect(evm.pegHealth).toBeNull();
        expect(evm.preStocks).toBeNull();
        expect('executionQuality' in evm).toBe(true);
        expect(out.primaryVariant?.executionQuality).toEqual(sol.executionQuality);
    });

    test('toV2PegHealth defaults provider and reference kind', () => {
        expect(toV2PegHealth(null)).toBeNull();
        const out = toV2PegHealth({
            pegHealth: {
                provider: 'webacy',
                referenceKind: null,
                tier: 'stable',
                deviationPct: 0.01,
                updatedAt: 5,
                stale: false,
            } as never,
            structuralHealth: null,
        });
        expect(out).toEqual({
            provider: 'webacy',
            referenceKind: 'fixed',
            tier: 'stable',
            deviationPct: 0.01,
            updatedAt: 5,
            stale: false,
        });
    });
});

describe('variant reference', () => {
    const request = new Request('https://api.example.test/api/v2/assets/tesla');
    test("an equity's variant that is the asset's own coin still gets its CoinGecko reference while the headline is the stock", () => {
        const tslax = { ...variant('solana', 'TSLAxMint1111111111111111111111111111111111', 'tokenized_equity'), assetId: 'tesla', coingeckoId: 'tesla-xstock' };
        const out = buildV2Asset({
            request,
            asset: {
                assetId: 'tesla',
                category: 'equity',
                aliases: [],
                isActive: true,
                createdAt: 0,
                updatedAt: 0,
                region: null,
                industry: null,
                name: 'Tesla',
                symbol: 'TSLA',
                coingeckoId: 'tesla-xstock',
            },
            variants: [tslax],
            marketByKey: new Map(),
            rollupByChain: null,
            advisoriesByMint: new Map(),
            coingeckoPrice: {
                coinId: 'tesla-xstock',
                priceUsd: 401,
                marketCapUsd: 90_000_000,
                volume24hUsd: null,
                priceChange24hPercent: null,
                providerLastUpdatedAt: null,
                lastFetchedAt: 1,
                circulatingSupply: 225_000,
                totalSupply: 225_000,
                maxSupply: null,
                fdvUsd: 90_000_000,
            },
            stockInstrument: { assetId: 'tesla', symbol: 'TSLA', normalizedSymbol: 'TSLA', isActive: true, source: 'clickhouse', lastSyncedAt: 1 },
            stockPrice: {
                assetId: 'tesla',
                symbol: 'TSLA',
                normalizedSymbol: 'TSLA',
                priceUsd: 400,
                volume24hUsd: null,
                priceChange24hPercent: null,
                sharesOutstanding: null,
                sharesAsOf: null,
                sharesLastFetchedAt: null,
                asOf: null,
                lastFetchedAt: 1,
                source: 'clickhouse_stock',
            },
            preStocksByMint: new Map(),
            requestedStrategy: null,
            hideBlocked: false,
            listChain: null,
            includeVariants: true,
            rank: null,
        })!;
        expect(out.referenceMarket?.source).toBe('stock');
        const v = out.variants!.find(entry => entry.key === tslax.key)!;
        expect(v.coingeckoId).toBe('tesla-xstock');
        expect(v.reference?.source).toBe('coingecko');
        expect(v.reference?.coinId).toBe('tesla-xstock');
        expect(v.reference?.marketCap).toBe(90_000_000);
        expect(v.reference?.circulatingSupply).toBe(225_000);
    });
});

describe('primary variant selection', () => {
    const request = new Request('https://api.example.test/api/v2/assets/x');
    const SOL = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
    const ETH = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
    const ARB = '0x0000000000000000000000000000000000000abc';
    const market = (liquidity: number, volume24hUSD: number, trade24h: number) => ({
        mint: 'x',
        source: 'birdeye' as const,
        lastFetchedAt: 1,
        liquidity,
        volume24hUSD,
        trade24h,
    });
    const build = (params: {
        category?: 'crypto' | 'equity';
        variants: V2VariantResult[];
        markets: Array<[string, ReturnType<typeof market>]>;
        primaryScope?: 'executable' | 'global';
        advisories?: Parameters<typeof buildV2Asset>[0]['advisoriesByMint'];
    }) =>
        buildV2Asset({
            request,
            asset: {
                assetId: 'study',
                category: params.category ?? 'crypto',
                aliases: [],
                isActive: true,
                createdAt: 0,
                updatedAt: 0,
                region: null,
                industry: null,
                name: 'Study',
                symbol: 'STDY',
            },
            variants: params.variants,
            marketByKey: new Map(params.markets),
            rollupByChain: null,
            advisoriesByMint: params.advisories ?? new Map(),
            coingeckoPrice: null,
            stockInstrument: null,
            stockPrice: null,
            preStocksByMint: new Map(),
            requestedStrategy: null,
            ...(params.primaryScope ? { primaryScope: params.primaryScope } : {}),
            hideBlocked: false,
            listChain: null,
            includeVariants: false,
            rank: null,
        })!;
    const sol = variant('solana', SOL, 'wrapped');
    const eth = variant('ethereum', ETH, 'wrapped');

    test('a deeper Ethereum variant loses to the active Solana one by default and wins with primaryScope=global', () => {
        const markets: Array<[string, ReturnType<typeof market>]> = [
            [`solana:${SOL}`, market(37_000_000, 84_000_000, 200_000)],
            [`ethereum:${ETH}`, market(392_000_000, 155_000_000, 19_000)],
        ];
        const executable = build({ variants: [sol, eth], markets });
        expect(executable.primaryScope).toBe('executable');
        expect(executable.primaryVariant?.key).toBe(`solana:${SOL}`);
        expect(executable.primaryVariantSelection?.pool).toBe('executable_active');

        const global = build({ variants: [sol, eth], markets, primaryScope: 'global' });
        expect(global.primaryScope).toBe('global');
        expect(global.primaryVariant?.key).toBe(`ethereum:${ETH}`);
        expect(global.primaryVariantSelection).toEqual({ pool: 'active', reason: 'liquidity' });
    });

    test('a dead Solana variant falls back to the live EVM one', () => {
        const out = build({
            variants: [sol, eth],
            markets: [
                [`solana:${SOL}`, market(7_000, 0, 0)],
                [`ethereum:${ETH}`, market(1_300_000, 570_000, 14_000)],
            ],
        });
        expect(out.primaryVariant?.key).toBe(`ethereum:${ETH}`);
        expect(out.primaryVariantSelection?.pool).toBe('active');
    });

    test('with nothing trading anywhere, the executable chain keeps the primary', () => {
        const out = build({
            variants: [sol, eth],
            markets: [
                [`solana:${SOL}`, market(400, 10, 1)],
                [`ethereum:${ETH}`, market(90_000, 20, 1)],
            ],
        });
        expect(out.primaryVariant?.key).toBe(`solana:${SOL}`);
        expect(out.primaryVariantSelection?.pool).toBe('executable');
    });

    test('a compromised Solana variant yields primary to a safe EVM sibling instead of winning its pool', () => {
        const markets: Array<[string, ReturnType<typeof market>]> = [
            [`solana:${SOL}`, market(37_000_000, 84_000_000, 200_000)],
            [`ethereum:${ETH}`, market(1_300_000, 570_000, 14_000)],
        ];
        const compromised = new Map([
            [SOL, { status: 'compromised' as const, reason: 'exploit', url: null, since: 1, source: 'admin' as const }],
        ]);
        const out = build({ variants: [sol, eth], markets, advisories: compromised });
        expect(out.primaryVariant?.key).toBe(`ethereum:${ETH}`);
        expect(out.primaryVariantSelection?.pool).toBe('active');

        // With no safe sibling anywhere, the flagged variant still becomes primary so the page can warn.
        const alone = build({ variants: [sol], markets, advisories: compromised });
        expect(alone.primaryVariant?.key).toBe(`solana:${SOL}`);
        expect(alone.primaryVariantSelection?.pool).toBe('executable_active');
    });

    test('an unpriced EVM xStock never beats a quietly traded Solana xStock', () => {
        const xstock = (chain: V2VariantResult['chain'], address: string): V2VariantResult => ({
            ...variant(chain, address, 'tokenized_equity'),
            stockVariantTier: 'cash_redeemable',
        });
        const out = build({
            category: 'equity',
            variants: [xstock('arbitrum', ARB), xstock('solana', SOL)],
            markets: [[`solana:${SOL}`, market(1_700, 44, 2)]],
            primaryScope: 'global',
        });
        expect(out.primaryVariant?.key).toBe(`solana:${SOL}`);
    });
});

describe('selectVolume30d', () => {
    const chainStats = (volumes: Partial<Record<'solana' | 'ethereum' | 'base', number>>) => {
        const out: Parameters<typeof selectVolume30d>[0] = {};
        for (const [chain, volume24hUSD] of Object.entries(volumes)) {
            out[chain as 'solana' | 'ethereum' | 'base'] = {
                price: null,
                priceChange24hPercent: null,
                priceChange1hPercent: null,
                liquidity: null,
                volume24hUSD,
                trade24h: null,
                marketCap: null,
                fdv: null,
                circulatingSupply: null,
                totalSupply: null,
                variantCount: 1,
                issuedVariantCount: 1,
                excludedByIssuance: { bridged: 0, wrapped: 0, derivative: 0 },
                excludedCount: 0,
                excludedByQuality: { stale: 0, dust: 0, priceOutlier: 0 },
            };
        }
        return out;
    };
    const NOW = 1_800_000_000_000;
    const rollup = (
        chain: 'solana' | 'ethereum' | 'base',
        volume30dUSD: number | null,
        days: number,
        origin: 'solana_v1' | 'computed',
        lastComputedAt: number = NOW - 60_000,
    ) =>
        [chain, { assetId: 'x', chain, liquidity: 0, volume24hUSD: 0, volume30dUSD, volume30dDays: days, primaryAddress: null, variantCount: 1, lastComputedAt, origin }] as const;

    test('Solana-only volume with the mirrored rollup is served with scope solana', () => {
        expect(selectVolume30d(chainStats({ solana: 100 }), new Map([rollup('solana', 3_000, 30, 'solana_v1')]), NOW)).toEqual({
            volume30dUSD: 3_000,
            scope: 'solana',
        });
    });

    test('a traded EVM chain with fewer than 28 sampled days makes the figure null', () => {
        const rollups = new Map([rollup('solana', 3_000, 30, 'solana_v1'), rollup('ethereum', 900, 20, 'computed')]);
        expect(selectVolume30d(chainStats({ solana: 100, ethereum: 50 }), rollups, NOW)).toEqual({ volume30dUSD: null, scope: null });
        expect(selectVolume30d(chainStats({ solana: 100, ethereum: 50 }), new Map([rollup('solana', 3_000, 30, 'solana_v1')]), NOW)).toEqual({
            volume30dUSD: null,
            scope: null,
        });
    });

    test('a computed rollup the daily job stopped refreshing is not served, however many days it had', () => {
        const stale = new Map([rollup('solana', 3_000, 30, 'solana_v1'), rollup('ethereum', 900, 30, 'computed', NOW - 3 * 24 * 60 * 60 * 1000)]);
        expect(selectVolume30d(chainStats({ solana: 100, ethereum: 50 }), stale, NOW)).toEqual({ volume30dUSD: null, scope: null });
        const fresh = new Map([rollup('solana', 3_000, 30, 'solana_v1'), rollup('ethereum', 900, 30, 'computed', NOW - 40 * 60 * 60 * 1000)]);
        expect(selectVolume30d(chainStats({ solana: 100, ethereum: 50 }), fresh, NOW)).toEqual({ volume30dUSD: 3_900, scope: 'all' });
        // The mirrored Solana rollup is v1's and is not age-checked here.
        expect(selectVolume30d(chainStats({ solana: 100 }), new Map([rollup('solana', 3_000, 30, 'solana_v1', 1)]), NOW)).toEqual({ volume30dUSD: 3_000, scope: 'solana' });
    });

    test('complete windows on every traded chain sum with scope all; untraded chains are ignored', () => {
        const rollups = new Map([
            rollup('solana', 3_000, 30, 'solana_v1'),
            rollup('ethereum', 900, 29, 'computed'),
            rollup('base', 50, 3, 'computed'),
        ]);
        expect(selectVolume30d(chainStats({ solana: 100, ethereum: 50, base: 0 }), rollups, NOW)).toEqual({ volume30dUSD: 3_900, scope: 'all' });
        expect(selectVolume30d(chainStats({}), rollups, NOW)).toEqual({ volume30dUSD: null, scope: null });
    });
});
