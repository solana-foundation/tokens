import { describe, expect, test } from 'bun:test';
import { Effect, Exit } from 'effect';

import type { BadRequestError } from '@tokens/effect';

import type { V2ChainRollupResult, V2VariantResult } from '@/lib/cloudrun';

import {
    aggregateChainStats,
    computeChainStats,
    decodeAssetIdPath,
    decodeChainAddressPath,
    decodeChainParam,
    decodeKeysParam,
    decodeListParam,
    hasVisibleVariantOnChain,
    headlineOnChainStats,
    toV2Chain,
    toV2Market,
    variantIssuance,
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
        marketCap: 1500,
        fdv: 1500,
        circulatingSupply: 1500,
        variantCount: 4,
        issuedVariantCount: 4 - excludedFromSupplyCount,
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
        const out = headlineOnChainStats(v1, { ...aggregate(1), marketCap: null, fdv: null, circulatingSupply: null }, null);
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

    test('issuance: tag wins, then kind', () => {
        expect(variantIssuance({ kind: 'bridged', tags: [] })).toBe('bridged');
        expect(variantIssuance({ kind: 'wrapped', tags: [] })).toBe('wrapped');
        expect(variantIssuance({ kind: 'stablecoin', tags: [] })).toBe('native');
        expect(variantIssuance({ kind: 'bridged', tags: ['issuance:native'] })).toBe('native');
    });

    test('liquidity sums every variant; supply / mcap only issued ones; canonical chain order', () => {
        const stats = computeChainStats(variants, marketByKey, null);
        expect(Object.keys(stats)).toEqual(['solana', 'ethereum', 'base']);
        expect(stats.base).toEqual({
            liquidity: 55,
            volume24hUSD: 20,
            marketCap: 500,
            fdv: null,
            circulatingSupply: 5,
            variantCount: 2,
            issuedVariantCount: 1,
        });
        expect(stats.ethereum?.marketCap).toBeNull();
        expect(stats.ethereum?.liquidity).toBe(1);
        const aggregate = aggregateChainStats(stats);
        expect(aggregate.liquidity).toBe(156);
        expect(aggregate.marketCap).toBe(1500);
        expect(aggregate.chainCount).toBe(3);
        expect(aggregate.variantCount).toBe(4);
        expect(aggregate.excludedFromSupplyCount).toBe(2);
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
