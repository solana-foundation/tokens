import { describe, expect, test } from 'bun:test';
import { Effect, Exit } from 'effect';

import type { BadRequestError } from '@tokens/effect';

import type { V2ChainRollupResult, V2VariantResult } from '@/lib/cloudrun';

import {
    aggregateChainStats,
    buildV2Asset,
    computeChainStats,
    decodeAssetIdPath,
    decodeChainAddressPath,
    decodeChainParam,
    decodeKeysParam,
    decodeListParam,
    decodePrimaryScopeParam,
    hasVisibleVariantOnChain,
    headlineOnChainStats,
    toV2Chain,
    toV2Market,
    toV2PegHealth,
    variantIssuance,
    variantIssuanceByKey,
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

describe('headlineOnChainStats', () => {
    const v1 = {
        price: 1,
        liquidity: 1,
        volume24hUSD: 1,
        volume30dUSD: null,
        marketCap: 1560,
        fdv: 1600,
        priceChange24hPercent: null,
        priceChange1hPercent: null,
        totalSupply: 1600,
        circulatingSupply: 1560,
    };
    const aggregate = (excludedFromSupplyCount: number) => ({
        liquidity: 156,
        volume24hUSD: 40,
        trade24h: 9,
        marketCap: 1500,
        fdv: 1500,
        circulatingSupply: 1500,
        variantCount: 4,
        issuedVariantCount: 4 - excludedFromSupplyCount,
        excludedByIssuance: { bridged: excludedFromSupplyCount, wrapped: 0, derivative: 0 },
        chainCount: 3,
        excludedFromSupplyCount,
    });

    test('with wrapped or bridged claims present, supply figures come from the issuance-aware aggregate', () => {
        const out = headlineOnChainStats(v1, aggregate(2), 7);
        expect(out?.liquidity).toBe(156);
        expect(out?.volume24hUSD).toBe(40);
        expect(out?.volume30dUSD).toBe(7);
        expect(out?.marketCap).toBe(1500);
        expect(out?.fdv).toBe(1500);
        expect(out?.circulatingSupply).toBe(1500);
        expect(out?.totalSupply).toBe(1600);
    });

    test('with only native variants, v1 supply figures stand', () => {
        const out = headlineOnChainStats(v1, aggregate(0), null);
        expect(out?.marketCap).toBe(1560);
        expect(out?.circulatingSupply).toBe(1560);
        expect(out?.liquidity).toBe(156);
    });

    test('a null aggregate figure replaces a double-counted v1 one rather than keeping it', () => {
        const out = headlineOnChainStats(
            v1,
            { ...aggregate(1), marketCap: null, fdv: null, circulatingSupply: null },
            null,
        );
        expect(out?.marketCap).toBeNull();
        expect(out?.circulatingSupply).toBeNull();
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
        const commodity = computeChainStats([slv], byKey, null, variantIssuanceByKey([slv], 'commodity'));
        expect(commodity.solana?.marketCap).toBeNull();
        expect(commodity.solana?.liquidity).toBe(300);
        expect(commodity.solana?.excludedByIssuance.derivative).toBe(1);
    });

    test('liquidity sums every variant; supply / mcap only issued ones; canonical chain order', () => {
        const stats = computeChainStats(variants, marketByKey, null);
        expect(Object.keys(stats)).toEqual(['solana', 'ethereum', 'base']);
        expect(stats.base).toEqual({
            liquidity: 55,
            volume24hUSD: 20,
            trade24h: null,
            marketCap: 500,
            fdv: null,
            circulatingSupply: 5,
            variantCount: 2,
            issuedVariantCount: 1,
            excludedByIssuance: { bridged: 1, wrapped: 0, derivative: 0 },
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

    test('the Solana worker rollup overrides liquidity / volume for parity with v1', () => {
        const rollup: V2ChainRollupResult = {
            assetId: 'usd',
            chain: 'solana',
            liquidity: 999,
            volume24hUSD: 42,
            volume30dUSD: 7,
            primaryAddress: null,
            variantCount: 1,
            lastComputedAt: 1,
        };
        const stats = computeChainStats(variants, marketByKey, new Map([['solana', rollup]]));
        expect(stats.solana?.liquidity).toBe(999);
        expect(stats.solana?.volume24hUSD).toBe(42);
        expect(stats.solana?.marketCap).toBe(1000);
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
        expect(Object.keys(out).length).toBe(20);
        expect(toV2Market(null)).toBeNull();
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
