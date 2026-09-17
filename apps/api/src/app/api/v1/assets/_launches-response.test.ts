import { describe, expect, it } from 'bun:test';

import type { VariantAdvisory } from '@tokens/asset-registry';

import type { LaunchpadTokenResult } from '@/lib/cloudrun';
import { buildAssetLaunchesResponse, stonkfunTokenUrl } from './_launches-response';

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';

function row(mint: string, overrides: Partial<LaunchpadTokenResult> = {}): LaunchpadTokenResult {
    return {
        launchpad: 'stonkfun',
        mint,
        quoteMint: NVDAX,
        quoteSymbol: 'NVDAX',
        symbol: mint.slice(0, 3),
        name: `Coin ${mint.slice(0, 4)}`,
        logoURI: null,
        pool: null,
        status: 'graduated',
        mode: 'reward',
        price: 0.1,
        marketCap: 100_000,
        fdv: 100_000,
        liquidity: 10_000,
        volume24hUSD: 1_000,
        priceChange24hPercent: 0,
        launchedAt: null,
        graduatedAt: null,
        sourceRank: 0,
        lastSyncedAt: 1_780_000_000_000,
        ...overrides,
    };
}

function advisory(status: VariantAdvisory['status']): VariantAdvisory {
    return { status, reason: 'r', url: null, since: 1 };
}

describe('buildAssetLaunchesResponse', () => {
    it('hides blocked mints, attaches other advisories, orders by volume, and caps to limit', () => {
        const advisories = new Map<string, VariantAdvisory>([
            ['blocked1', advisory('blocked')],
            ['caution1', advisory('caution')],
        ]);
        const res = buildAssetLaunchesResponse({
            assetId: 'nvidia-xstock',
            rows: [
                row('low', { volume24hUSD: 10 }),
                row('blocked1', { volume24hUSD: 9_999 }),
                row('caution1', { volume24hUSD: 500 }),
                row('high', { volume24hUSD: 5_000, lastSyncedAt: 1_780_000_005_000 }),
                row('high', { volume24hUSD: 5_000 }),
            ],
            advisoriesByMint: advisories,
            limit: 2,
        });

        expect(res.assetId).toBe('nvidia-xstock');
        expect(res.total).toBe(3);
        expect(res.limit).toBe(2);
        expect(res.launches.map(l => l.mint)).toEqual(['high', 'caution1']);
        expect(res.launches[1]!.advisory).toEqual(advisory('caution'));
        expect(res.launches[0]!.advisory).toBeNull();
        expect(res.launches[0]!.externalUrl).toBe(stonkfunTokenUrl('high'));
        expect(res.lastUpdatedAt).toBe(1_780_000_005_000);
    });

    it('returns an empty payload for no rows', () => {
        const res = buildAssetLaunchesResponse({ assetId: 'usdc', rows: [], advisoriesByMint: new Map(), limit: 25 });
        expect(res).toEqual({ assetId: 'usdc', total: 0, limit: 25, launches: [], lastUpdatedAt: null });
    });

    it('builds the stonk.fun coin URL from the mint', () => {
        expect(stonkfunTokenUrl('4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8')).toBe(
            'https://www.stonkfun.xyz/token/4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8',
        );
    });
});
