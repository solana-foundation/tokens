import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { ChainKind } from '@tokens/asset-registry/chains';

import type { BirdeyeClient, BirdeyeOverview } from './crons';
import {
    EVM_NATIVE_ASSET_ADDRESS,
    COIN_LIST_FRESHNESS_WINDOW_MS,
    birdeyeOverviewToV2Upsert,
    deriveVariantKindForChain,
    isEvmChainDown,
    parseEvmChainsArg,
    refreshEvmVariantMarkets,
    syncEvmVariants,
    syncSolanaVariants,
    type V2AssetsCronDeps,
    type V2AssetsJobsRepo,
    type V2DerivationAssetRow,
    type V2DerivedVariantRow,
    type V2DerivedVariantUpsert,
    type V2VariantKeyRef,
} from './crons.v2Assets';

const NOW = 1_800_000_000_000;
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function fakeRepo(
    overrides: Partial<V2AssetsJobsRepo> = {},
): V2AssetsJobsRepo & {
    upserts: V2DerivedVariantUpsert[];
    deactivated: unknown[];
    touched: V2VariantKeyRef[];
    marketUpserts: unknown[];
} {
    const upserts: V2DerivedVariantUpsert[] = [];
    const deactivated: unknown[] = [];
    const touched: V2VariantKeyRef[] = [];
    const marketUpserts: unknown[] = [];
    return {
        upserts,
        deactivated,
        touched,
        marketUpserts,
        async mirrorSolanaVariants() {
            return { inserted: 1, updated: 2, replaced: 0 };
        },
        async deactivateUnseenSolanaVariants() {
            return 0;
        },
        async mirrorSolanaMarkets() {
            return 3;
        },
        async mirrorSolanaRollups() {
            return 1;
        },
        async listAssetsWithCoinPlatforms() {
            return [];
        },
        async listActiveAssets() {
            return [];
        },
        async findCoinPlatformsByCoinIds() {
            return [];
        },
        async listDerivedVariants() {
            return [];
        },
        async upsertDerivedVariant(args) {
            upserts.push(args);
            return 'inserted';
        },
        async deactivateDerivedVariants(keys) {
            deactivated.push(...keys);
            return keys.length;
        },
        async listStaleActiveVariantsByChains() {
            return [];
        },
        async upsertVariantMarketFromBirdeye(args) {
            marketUpserts.push(args);
        },
        async touchVariantMarket(chain, address) {
            touched.push({ chain, address });
        },
        async setVariantDecimalsIfNull() {},
        ...overrides,
    };
}

function deps(
    repo: V2AssetsJobsRepo,
    birdeyeByChain: Partial<Record<ChainKind, BirdeyeClient>> = {},
): V2AssetsCronDeps {
    return { repo, birdeyeByChain, now: () => NOW };
}

const ORIGINAL_LOG = console.log;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_ERROR = console.error;
beforeEach(() => {
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
});
afterEach(() => {
    console.log = ORIGINAL_LOG;
    console.warn = ORIGINAL_WARN;
    console.error = ORIGINAL_ERROR;
});

describe('parseEvmChainsArg', () => {
    test('defaults to every EVM chain and rejects solana / unknown ids', () => {
        expect(parseEvmChainsArg(undefined)).toEqual(['ethereum', 'base', 'arbitrum', 'polygon', 'bnb']);
        expect(parseEvmChainsArg(['base', 'base', 'bnb'])).toEqual(['base', 'bnb']);
        expect(() => parseEvmChainsArg(['solana'])).toThrow();
        expect(() => parseEvmChainsArg(['polygon-pos'])).toThrow();
        expect(() => parseEvmChainsArg([])).toThrow();
    });
});

describe('deriveVariantKindForChain', () => {
    test('category wins, then home platform decides native vs bridged', () => {
        expect(deriveVariantKindForChain({ category: 'stablecoin', assetPlatformId: null, chain: 'base' })).toBe(
            'stablecoin',
        );
        expect(deriveVariantKindForChain({ category: 'equity', assetPlatformId: null, chain: 'base' })).toBe(
            'tokenized_equity',
        );
        expect(deriveVariantKindForChain({ category: 'crypto', assetPlatformId: 'ethereum', chain: 'ethereum' })).toBe(
            'native',
        );
        expect(deriveVariantKindForChain({ category: 'crypto', assetPlatformId: 'ethereum', chain: 'arbitrum' })).toBe(
            'bridged',
        );
        expect(
            deriveVariantKindForChain({ category: 'crypto', assetPlatformId: 'binance-smart-chain', chain: 'bnb' }),
        ).toBe('native');
    });
});

describe('sync-v2-solana-variants', () => {
    test('reports the three mirror counts', async () => {
        const result = await syncSolanaVariants(deps(fakeRepo()), {});
        expect(result.ok).toBe(true);
        expect(result.variantsInserted).toBe(1);
        expect(result.variantsUpdated).toBe(2);
        expect(result.variantsReplaced).toBe(0);
        expect(result.marketsWritten).toBe(3);
        expect(result.rollupsWritten).toBe(1);
    });

    test('mirror rows removed because v1 re-minted their variant_id are reported as replaced', async () => {
        const repo = fakeRepo({
            async mirrorSolanaVariants() {
                return { inserted: 1, updated: 0, replaced: 1 };
            },
        });
        const result = await syncSolanaVariants(deps(repo), {});
        expect(result.ok).toBe(true);
        expect(result.variantsReplaced).toBe(1);
    });

    test('a failed variants mirror aborts the run with ok:false and skips markets', async () => {
        let marketsCalled = false;
        const repo = fakeRepo({
            async mirrorSolanaVariants() {
                throw new Error('boom');
            },
            async mirrorSolanaMarkets() {
                marketsCalled = true;
                return 0;
            },
        });
        const result = await syncSolanaVariants(deps(repo), {});
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('mirror_failed');
        expect(marketsCalled).toBe(false);
    });

    test('a failed markets mirror is partial, not fatal', async () => {
        const repo = fakeRepo({
            async mirrorSolanaMarkets() {
                throw new Error('boom');
            },
        });
        const result = await syncSolanaVariants(deps(repo), {});
        expect(result.ok).toBe(true);
        expect(result.partial).toBe(true);
        expect(result.rollupsWritten).toBe(1);
    });
});

describe('sync-v2-evm-variants', () => {
    const usdcCoin = (lastSyncedAt: number | null): V2DerivationAssetRow => ({
        assetId: 'usd-coin-asset',
        category: 'stablecoin',
        coingeckoId: 'usd-coin',
        platforms: {
            ethereum: USDC_ETH.toUpperCase().replace('0X', '0x'),
            base: USDC_BASE,
            solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        },
        decimalsByPlatform: { ethereum: 6 },
        assetPlatformId: 'ethereum',
        coinSymbol: 'usdc',
        coinLastSyncedAt: lastSyncedAt,
    });

    test('derives one normalized variant per EVM platform with decimals from detail_platforms', async () => {
        const repo = fakeRepo({
            async listAssetsWithCoinPlatforms() {
                return [usdcCoin(NOW)];
            },
            async listActiveAssets() {
                return [{ assetId: 'usd-coin-asset', category: 'stablecoin' }];
            },
        });
        const result = await syncEvmVariants(deps(repo), { chains: ['ethereum', 'base'] });
        expect(result.ok).toBe(true);
        expect(result.desired).toBe(2);
        expect(result.inserted).toBe(2);
        expect(result.byChain).toEqual({ ethereum: { desired: 1 }, base: { desired: 1 } });
        const eth = repo.upserts.find(u => u.chain === 'ethereum')!;
        expect(eth.address).toBe(USDC_ETH);
        expect(eth.variantId).toBe(`ethereum:${USDC_ETH}`);
        expect(eth.kind).toBe('stablecoin');
        expect(eth.decimals).toBe(6);
        expect(eth.label).toBe('USDC');
        expect(eth.tags).toEqual(['coingecko-derived', 'coin:usd-coin']);
        expect(eth.origin).toBe('coingecko');
        const base = repo.upserts.find(u => u.chain === 'base')!;
        expect(base.decimals).toBeNull();
    });

    test('native coins come from the registry table for registered assets only', async () => {
        const repo = fakeRepo({
            async listActiveAssets() {
                return [{ assetId: 'ethereum', category: 'crypto' }];
            },
        });
        const result = await syncEvmVariants(deps(repo), { chains: ['ethereum', 'bnb'] });
        const keys = repo.upserts.map(u => `${u.chain}:${u.address}`);
        expect(keys).toContain(`ethereum:${EVM_NATIVE_ASSET_ADDRESS}`);
        expect(keys).toContain('ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
        // BNB's native rows need the `bnb` asset, which is not active here.
        expect(keys.some(k => k.startsWith('bnb:'))).toBe(false);
        expect(
            repo.upserts.every(u => u.origin === 'config' && u.tags.includes('native-coin') && u.decimals === 18),
        ).toBe(true);
        expect(result.byChain).toEqual({ ethereum: { desired: 2 } });
    });

    test('dry run computes but writes nothing', async () => {
        const repo = fakeRepo({
            async listAssetsWithCoinPlatforms() {
                return [usdcCoin(NOW)];
            },
            async listActiveAssets() {
                return [{ assetId: 'usd-coin-asset', category: 'stablecoin' }];
            },
        });
        const result = await syncEvmVariants(deps(repo), { dryRun: true });
        expect(result.desired).toBe(2);
        expect(result.inserted).toBe(0);
        expect(repo.upserts).toHaveLength(0);
    });

    test('deactivates a dropped platform only when the coin row is fresh', async () => {
        const stale: V2DerivedVariantRow = {
            chain: 'base',
            address: USDC_BASE,
            assetId: 'usd-coin-asset',
            variantId: `base:${USDC_BASE}`,
            isActive: true,
        };
        const withoutBase = (lastSyncedAt: number | null): V2DerivationAssetRow => ({
            ...usdcCoin(lastSyncedAt),
            platforms: { ethereum: USDC_ETH },
        });

        const freshRepo = fakeRepo({
            async listAssetsWithCoinPlatforms() {
                return [withoutBase(NOW)];
            },
            async listActiveAssets() {
                return [{ assetId: 'usd-coin-asset', category: 'stablecoin' }];
            },
            async listDerivedVariants() {
                return [stale];
            },
        });
        const fresh = await syncEvmVariants(deps(freshRepo), {});
        expect(fresh.deactivated).toBe(1);
        expect(fresh.keptStale).toBe(0);

        const staleRepo = fakeRepo({
            async listAssetsWithCoinPlatforms() {
                return [withoutBase(NOW - COIN_LIST_FRESHNESS_WINDOW_MS - 1)];
            },
            async listActiveAssets() {
                return [{ assetId: 'usd-coin-asset', category: 'stablecoin' }];
            },
            async listDerivedVariants() {
                return [stale];
            },
        });
        const kept = await syncEvmVariants(deps(staleRepo), {});
        expect(kept.deactivated).toBe(0);
        expect(kept.keptStale).toBe(1);
    });

    test('a bounded scan leaves the derived rows of unscanned assets alone', async () => {
        const otherAssetRow: V2DerivedVariantRow = {
            chain: 'base',
            address: '0x1111111111111111111111111111111111111111',
            assetId: 'other-asset',
            variantId: 'base:0x1111111111111111111111111111111111111111',
            isActive: true,
        };
        const repoFor = () =>
            fakeRepo({
                // One scanned asset (usd-coin), the other active asset fell outside the window.
                async listAssetsWithCoinPlatforms() {
                    return [usdcCoin(NOW)];
                },
                async listActiveAssets() {
                    return [
                        { assetId: 'usd-coin-asset', category: 'stablecoin' },
                        { assetId: 'other-asset', category: 'crypto' },
                    ];
                },
                async listDerivedVariants() {
                    return [otherAssetRow];
                },
            });

        // maxAssets equals the rows returned: the scan may have been cut short.
        const bounded = await syncEvmVariants(deps(repoFor()), { maxAssets: 1 });
        expect(bounded.deactivated).toBe(0);
        expect(bounded.keptUnscanned).toBe(1);

        // The scan came back short of the bound, so it saw every linked asset:
        // other-asset really has no coin link any more and loses its row.
        const complete = await syncEvmVariants(deps(repoFor()), { maxAssets: 10 });
        expect(complete.deactivated).toBe(1);
        expect(complete.keptUnscanned).toBe(0);
    });

    test('a replaced address is not deactivated while its replacement write failed', async () => {
        const oldBase: V2DerivedVariantRow = {
            chain: 'base',
            address: '0x2222222222222222222222222222222222222222',
            assetId: 'usd-coin-asset',
            variantId: 'base:0x2222222222222222222222222222222222222222',
            isActive: true,
        };
        const goneRow: V2DerivedVariantRow = {
            chain: 'base',
            address: '0x3333333333333333333333333333333333333333',
            assetId: 'gone',
            variantId: 'base:0x3333333333333333333333333333333333333333',
            isActive: true,
        };
        const repo = fakeRepo({
            async listAssetsWithCoinPlatforms() {
                return [usdcCoin(NOW)];
            },
            async listActiveAssets() {
                return [{ assetId: 'usd-coin-asset', category: 'stablecoin' }];
            },
            async listDerivedVariants() {
                return [oldBase, goneRow];
            },
            async upsertDerivedVariant(args) {
                if (args.chain === 'base') throw new Error('write failed');
                return 'inserted';
            },
        });
        const result = await syncEvmVariants(deps(repo), { chains: ['ethereum', 'base'] });
        expect(result.failed).toBe(1);
        // usd-coin's old Base row stays until its new Base row is actually written…
        expect(result.keptPendingWrite).toBe(1);
        // …while the inactive asset's row, unaffected by the failure, is still removed.
        expect(result.deactivated).toBe(1);
        expect(repo.deactivated).toEqual([{ chain: 'base', address: goneRow.address, assetId: 'gone' }]);
    });

    test('an asset that is no longer active loses its derived rows regardless of coin freshness', async () => {
        const repo = fakeRepo({
            async listDerivedVariants() {
                return [
                    {
                        chain: 'base',
                        address: USDC_BASE,
                        assetId: 'gone',
                        variantId: `base:${USDC_BASE}`,
                        isActive: true,
                    },
                ];
            },
        });
        const result = await syncEvmVariants(deps(repo), {});
        expect(result.deactivated).toBe(1);
        expect(repo.deactivated).toEqual([{ chain: 'base', address: USDC_BASE, assetId: 'gone' }]);
    });
});

describe('refresh-v2-evm-variant-markets', () => {
    const overview = (decimals?: number): BirdeyeOverview => ({
        symbol: 'WETH',
        name: 'Wrapped Ether',
        price: 2500,
        liquidity: 1e6,
        ...(decimals !== undefined ? { decimals } : {}),
    });
    const client = (fn: (address: string) => Promise<BirdeyeOverview | null>): BirdeyeClient => ({
        fetchTokenOverview: fn,
    });

    test('birdeyeOverviewToV2Upsert never defaults decimals', () => {
        const withDecimals = birdeyeOverviewToV2Upsert('base', '0xabc', overview(18), NOW)!;
        expect(withDecimals.decimals).toBe(18);
        expect(withDecimals.chain).toBe('base');
        expect('mint' in withDecimals).toBe(false);
        const without = birdeyeOverviewToV2Upsert('base', '0xabc', overview(), NOW)!;
        expect(without.decimals).toBeNull();
        expect(birdeyeOverviewToV2Upsert('base', '0xabc', { symbol: '', name: 'x' }, NOW)).toBeNull();
    });

    test('refreshes per chain, touches misses, and reports byChain', async () => {
        const repo = fakeRepo({
            async listStaleActiveVariantsByChains(chains) {
                return [
                    { chain: 'base', address: '0x1' },
                    { chain: 'base', address: '0x2' },
                    { chain: 'arbitrum', address: '0x3' },
                ].filter(ref => chains.includes(ref.chain as ChainKind)) as V2VariantKeyRef[];
            },
        });
        const result = await refreshEvmVariantMarkets(
            deps(repo, {
                base: client(async address => (address === '0x2' ? null : overview(18))),
                arbitrum: client(async () => overview()),
            }),
            { chains: ['base', 'arbitrum'], delayMs: 0 },
        );
        expect(result.ok).toBe(true);
        expect(result.refreshed).toBe(2);
        expect(result.failed).toBe(1);
        expect(repo.touched).toEqual([{ chain: 'base', address: '0x2' }]);
        expect(result.byChain).toEqual({
            base: { attempted: 2, refreshed: 1, failed: 1, noClient: 0 },
            arbitrum: { attempted: 1, refreshed: 1, failed: 0, noClient: 0 },
        });
    });

    test('a chain with ≥3 attempts and no successes flips ok:false with downChains', async () => {
        const repo = fakeRepo({
            async listStaleActiveVariantsByChains() {
                return [
                    { chain: 'bnb', address: '0x1' },
                    { chain: 'bnb', address: '0x2' },
                    { chain: 'bnb', address: '0x3' },
                ];
            },
        });
        const result = await refreshEvmVariantMarkets(deps(repo, { bnb: client(async () => null) }), {
            chains: ['bnb'],
            delayMs: 0,
        });
        expect(result.ok).toBe(false);
        expect(result.downChains).toEqual(['bnb']);
        expect(isEvmChainDown({ attempted: 2, refreshed: 0, failed: 2, noClient: 0 })).toBe(false);
    });

    test('a chain without a Birdeye client is counted, not attempted', async () => {
        const repo = fakeRepo({
            async listStaleActiveVariantsByChains() {
                return [{ chain: 'polygon', address: '0x1' }];
            },
        });
        const result = await refreshEvmVariantMarkets(deps(repo, {}), { chains: ['polygon'], delayMs: 0 });
        expect(result.ok).toBe(true);
        expect(result.noClient).toBe(1);
        expect(repo.touched).toHaveLength(0);
    });
});
