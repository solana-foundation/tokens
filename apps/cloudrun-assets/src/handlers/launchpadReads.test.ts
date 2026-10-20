import { describe, expect, it } from 'bun:test';

import { approvedMints, listByQuoteMints, type LaunchpadReadsRepo, type LaunchpadTokenRow } from './launchpadReads';

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const COIN_A = '4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8';

function row(overrides: Partial<LaunchpadTokenRow> = {}): LaunchpadTokenRow {
    return {
        launchpad: 'stonkfun',
        mint: COIN_A,
        quote_mint: NVDAX,
        quote_symbol: 'NVDAX',
        symbol: 'AGI',
        name: 'Artificial Giga Inu',
        logo_uri: 'https://cdn.example/agi.webp',
        pool: null,
        status: 'graduated',
        mode: 'reward',
        price_usd: 0.00012,
        market_cap_usd: 163_199,
        fdv_usd: 163_199,
        liquidity_usd: 40_000,
        volume_24h_usd: 141_426,
        price_change_24h: 12.5,
        launched_at: '1780000000000',
        graduated_at: 1780000100000n,
        source_rank: 3,
        last_synced_at: 1780000200000,
        ...overrides,
    };
}

function repoWith(
    rows: LaunchpadTokenRow[],
    calls: Array<{ quoteMints: readonly string[]; limit: number }> = [],
): LaunchpadReadsRepo {
    return {
        async listActiveByQuoteMints(quoteMints, limit) {
            calls.push({ quoteMints, limit });
            return rows;
        },
        async listApprovedActiveMints() {
            return [];
        },
    };
}

describe('launchpadListByQuoteMints', () => {
    it('maps rows to camelCase results and coerces epoch columns to numbers', async () => {
        const result = await listByQuoteMints(repoWith([row()]), { quoteMints: [NVDAX] });
        expect(result).toEqual([
            {
                launchpad: 'stonkfun',
                mint: COIN_A,
                quoteMint: NVDAX,
                quoteSymbol: 'NVDAX',
                symbol: 'AGI',
                name: 'Artificial Giga Inu',
                logoURI: 'https://cdn.example/agi.webp',
                pool: null,
                status: 'graduated',
                mode: 'reward',
                price: 0.00012,
                marketCap: 163_199,
                fdv: 163_199,
                liquidity: 40_000,
                volume24hUSD: 141_426,
                priceChange24hPercent: 12.5,
                launchedAt: 1780000000000,
                graduatedAt: 1780000100000,
                sourceRank: 3,
                lastSyncedAt: 1780000200000,
            },
        ]);
    });

    it('trims, dedupes, and drops empty quote mints; defaults and clamps limit', async () => {
        const calls: Array<{ quoteMints: readonly string[]; limit: number }> = [];
        await listByQuoteMints(repoWith([], calls), { quoteMints: [` ${NVDAX} `, NVDAX, '', 'other'] });
        expect(calls[0]).toEqual({ quoteMints: [NVDAX, 'other'], limit: 50 });

        await listByQuoteMints(repoWith([], calls), { quoteMints: [NVDAX], limit: 9_999 });
        expect(calls[1]!.limit).toBe(200);
    });

    it('short-circuits to [] without hitting the repo when no quote mints remain', async () => {
        const calls: Array<{ quoteMints: readonly string[]; limit: number }> = [];
        expect(await listByQuoteMints(repoWith([row()], calls), { quoteMints: ['', '  '] })).toEqual([]);
        expect(calls).toHaveLength(0);
    });

    it('rejects malformed args', async () => {
        await expect(listByQuoteMints(repoWith([]), null)).rejects.toThrow('args must be an object');
        await expect(listByQuoteMints(repoWith([]), { quoteMints: 'x' })).rejects.toThrow('quoteMints');
        await expect(listByQuoteMints(repoWith([]), { quoteMints: [NVDAX], limit: 'ten' })).rejects.toThrow('limit');
    });
});

describe('launchpadApprovedMints', () => {
    const COIN_B = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    function approvalsRepo(approvedActive: string[], seen: string[][] = []): LaunchpadReadsRepo {
        return {
            async listActiveByQuoteMints() {
                return [];
            },
            async listApprovedActiveMints(mints) {
                seen.push([...mints]);
                return mints.filter(m => approvedActive.includes(m));
            },
        };
    }

    it('returns only the requested mints that are approved and still active, deduplicated and trimmed', async () => {
        const seen: string[][] = [];
        const out = await approvedMints(approvalsRepo([COIN_A], seen), { mints: [` ${COIN_A} `, COIN_B, COIN_A, ''] });
        expect(out).toEqual({ mints: [COIN_A] });
        expect(seen).toEqual([[COIN_A, COIN_B]]);
    });

    it('short-circuits to [] without hitting the repo when nothing remains', async () => {
        const seen: string[][] = [];
        expect(await approvedMints(approvalsRepo([COIN_A], seen), { mints: ['  '] })).toEqual({ mints: [] });
        expect(seen).toEqual([]);
    });

    it('rejects malformed args', async () => {
        await expect(approvedMints(approvalsRepo([]), null)).rejects.toThrow(/args must be an object/);
        await expect(approvedMints(approvalsRepo([]), { mints: 'x' })).rejects.toThrow(/mints must be an array/);
        await expect(approvedMints(approvalsRepo([]), { mints: [1] })).rejects.toThrow(/mints must be an array/);
    });
});
