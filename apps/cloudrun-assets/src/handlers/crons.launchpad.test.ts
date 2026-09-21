import { describe, expect, it } from 'bun:test';

import type { CronDeps } from './crons';
import type { TokenUpsertFromBirdeye } from './crons.misc';
import {
    parseLaunchpadSyncArgs,
    parseStonkfunTokensPayload,
    selectLaunchpadTokens,
    syncStonkfunLaunches,
    type LaunchpadCronDeps,
    type LaunchpadTokenUpsert,
    type StonkfunFetchResult,
    type StonkfunToken,
    type StonkfunTokenMarket,
} from './crons.launchpad';

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const SPYX = 'XsoCS1TfEyfFhfvj8EtZ6ahqXbHD2wTAfcbCjiYsAKe';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const COIN_A = '4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8';
const COIN_B = 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR';
const COIN_C = '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx';
const COIN_D = '2gLLBYEfkhnuSBBeiKgeS4ToVmxPuYo3dGQhssYS123g';

function rawToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        mint: COIN_A,
        name: 'Artificial Giga Inu',
        symbol: 'AGI',
        pool: 'Pool11111111111111111111111111111111111111',
        quote: { mint: NVDAX, symbol: 'NVDAX', name: 'NVIDIA xStock', category: 'xstock' },
        creator: 'Creator111111111111111111111111111111111111',
        launchpad: 'launchlab',
        mode: 'reward',
        market: {
            priceUsd: 0.00012,
            marketCapUsd: 163_199.49,
            fdvUsd: 163_199.49,
            liquidityUsd: 40_000,
            volume24hUsd: 141_426.19,
            priceChange24h: 12.5,
        },
        status: 'graduated',
        graduationProgress: 1,
        graduatedAt: '2026-09-13T10:00:00.000Z',
        createdAt: '2026-09-13T09:00:00.000Z',
        imageUrl: 'https://cdn.example/agi.webp',
        links: { website: 'https://agi.example', twitter: '' },
        ...overrides,
    };
}

function token(
    overrides: Omit<Partial<StonkfunToken>, 'market'> & { market?: Partial<StonkfunTokenMarket> } = {},
): StonkfunToken {
    const { market, ...rest } = overrides;
    return {
        mint: COIN_A,
        symbol: 'AGI',
        name: 'Artificial Giga Inu',
        imageUrl: null,
        pool: null,
        status: 'graduated',
        mode: 'reward',
        creator: null,
        launchpad: 'launchlab',
        quoteMint: NVDAX,
        quoteSymbol: 'NVDAX',
        market: {
            priceUsd: 0.1,
            marketCapUsd: 100_000,
            fdvUsd: 100_000,
            liquidityUsd: 10_000,
            volume24hUsd: 50_000,
            priceChange24h: 1,
            ...market,
        },
        createdAt: 1_700_000_000_000,
        graduatedAt: 1_700_000_100_000,
        links: {},
        raw: {},
        ...rest,
    };
}

describe('parseStonkfunTokensPayload', () => {
    it('parses the live envelope (data.tokens + data.pagination) and normalizes timestamps/links/images', () => {
        const parsed = parseStonkfunTokensPayload({
            data: {
                tokens: [rawToken({ imageUrl: '/api/asset/quote-logo/abc?v=1' })],
                pagination: { page: 1, pageSize: 100, total: 2167, totalPages: 22 },
                network: 'mainnet-beta',
            },
            meta: { generatedAt: '2026-09-16T16:43:14.443Z' },
        });
        expect(parsed).not.toBeNull();
        expect(parsed!.totalPages).toBe(22);
        expect(parsed!.items).toHaveLength(1);
        const item = parsed!.items[0]!;
        expect(item.mint).toBe(COIN_A);
        expect(item.quoteMint).toBe(NVDAX);
        expect(item.quoteSymbol).toBe('NVDAX');
        expect(item.imageUrl).toBe('https://www.stonkfun.xyz/api/asset/quote-logo/abc?v=1');
        expect(item.market.volume24hUsd).toBeCloseTo(141_426.19);
        expect(item.market.liquidityUsd).toBeCloseTo(40_000);
        expect(item.graduatedAt).toBe(Date.parse('2026-09-13T10:00:00.000Z'));
        expect(item.links).toEqual({ website: 'https://agi.example' });
    });

    it('also accepts a bare data array with meta.totalPages', () => {
        const parsed = parseStonkfunTokensPayload({ data: [rawToken()], meta: { totalPages: 3 } });
        expect(parsed!.items).toHaveLength(1);
        expect(parsed!.totalPages).toBe(3);
        expect(parsed!.items[0]!.imageUrl).toBe('https://cdn.example/agi.webp');
    });

    it('drops items without a usable mint or quote mint and rejects a bad envelope', () => {
        const parsed = parseStonkfunTokensPayload({
            data: {
                tokens: [rawToken({ mint: 'nope' }), rawToken({ quote: { symbol: 'X' } }), rawToken({ mint: COIN_B })],
            },
        });
        expect(parsed!.items.map(i => i.mint)).toEqual([COIN_B]);
        expect(parsed!.totalPages).toBeNull();
        expect(parseStonkfunTokensPayload({ tokens: [] })).toBeNull();
        expect(parseStonkfunTokensPayload({ data: { items: [] } })).toBeNull();
        expect(parseStonkfunTokensPayload(null)).toBeNull();
    });
});

describe('selectLaunchpadTokens', () => {
    const args = parseLaunchpadSyncArgs({});

    it('keeps only coins quoted in a curated mint that pass the threshold', () => {
        const curated = new Set([NVDAX, USDC]);
        const selected = selectLaunchpadTokens(
            [
                token({ mint: COIN_A, quoteMint: NVDAX }),
                token({ mint: COIN_B, quoteMint: BONK }),
                token({ mint: COIN_C, quoteMint: USDC, market: { marketCapUsd: 1_000, volume24hUsd: 500 } }),
                token({ mint: COIN_D, quoteMint: USDC, market: { marketCapUsd: 1_000, volume24hUsd: 20_000 } }),
            ],
            curated,
            args,
        );
        expect(selected.map(t => t.mint)).toEqual([COIN_A, COIN_D]);
    });

    it('approved mints bypass the threshold but still need a curated quote', () => {
        const curated = new Set([NVDAX]);
        const approved = new Set([COIN_A, COIN_B]);
        const selected = selectLaunchpadTokens(
            [
                token({ mint: COIN_A, quoteMint: NVDAX, market: { marketCapUsd: 10, volume24hUsd: 5 } }),
                token({ mint: COIN_B, quoteMint: BONK, market: { marketCapUsd: 10, volume24hUsd: 5 } }),
                token({ mint: COIN_C, quoteMint: NVDAX, market: { marketCapUsd: 10, volume24hUsd: 5 } }),
            ],
            curated,
            args,
            approved,
        );
        expect(selected.map(t => t.mint)).toEqual([COIN_A]);
    });

    it('approved mints survive the per-quote cap without consuming a slot', () => {
        const curated = new Set([NVDAX]);
        const selected = selectLaunchpadTokens(
            [
                token({ mint: COIN_A, market: { volume24hUsd: 90_000 } }),
                token({ mint: COIN_B, market: { volume24hUsd: 80_000 } }),
                token({ mint: COIN_C, market: { volume24hUsd: 100 } }),
            ],
            curated,
            { ...args, maxPerQuote: 1, minVolume24hUsd: 50_000, minMarketCapUsd: 10_000_000 },
            new Set([COIN_C]),
        );
        // COIN_A is the cap winner; COIN_C is approved and comes along regardless.
        expect(selected.map(t => t.mint)).toEqual([COIN_A, COIN_C]);
    });

    it('dedupes by mint, caps per quote, and ranks by 24h volume', () => {
        const curated = new Set([NVDAX]);
        const selected = selectLaunchpadTokens(
            [
                token({ mint: COIN_A, market: { volume24hUsd: 10_000 } }),
                token({ mint: COIN_A, market: { volume24hUsd: 999_999 } }),
                token({ mint: COIN_B, market: { volume24hUsd: 30_000 } }),
                token({ mint: COIN_C, market: { volume24hUsd: 20_000 } }),
            ],
            curated,
            { ...args, maxPerQuote: 2 },
        );
        expect(selected.map(t => t.mint)).toEqual([COIN_B, COIN_C]);
    });
});

interface Harness {
    deps: LaunchpadCronDeps;
    upserts: LaunchpadTokenUpsert[];
    tokenUpserts: TokenUpsertFromBirdeye[];
    marketUpserts: string[];
    deactivateCalls: Array<{ activeMints: readonly string[] }>;
    overviewCalls: string[];
}

function makeHarness(opts: {
    fetch: StonkfunFetchResult;
    curatedMints?: string[];
    existingActive?: number;
    approvedMints?: string[];
    knownTokens?: string[];
    withMarket?: string[];
    overview?: (mint: string) => Record<string, unknown> | null;
}): Harness {
    const upserts: LaunchpadTokenUpsert[] = [];
    const tokenUpserts: TokenUpsertFromBirdeye[] = [];
    const marketUpserts: string[] = [];
    const deactivateCalls: Array<{ activeMints: readonly string[] }> = [];
    const overviewCalls: string[] = [];
    const known = new Set(opts.knownTokens ?? []);
    const withMarket = new Set(opts.withMarket ?? []);
    const overview =
        opts.overview ??
        ((mint: string) => ({ symbol: `S${mint.slice(0, 3)}`, name: `Coin ${mint.slice(0, 4)}`, decimals: 6 }));

    const base = {
        curated: { getAllCuratedMintsInOrder: () => opts.curatedMints ?? [NVDAX, SPYX, USDC] },
        birdeye: {
            async fetchTokenOverview(mint: string) {
                overviewCalls.push(mint);
                return overview(mint);
            },
        },
        repo: {
            async upsertVariantMarketFromBirdeye(args: { mint: string }) {
                marketUpserts.push(args.mint);
            },
        },
        now: () => 1_780_000_000_000,
    } as unknown as CronDeps;

    const deps: LaunchpadCronDeps = {
        base,
        stonkfun: {
            async fetchGraduatedTokens() {
                return opts.fetch;
            },
            async fetchGraduatedTokensByQuote() {
                return opts.fetch;
            },
            async fetchToken() {
                return { ok: true, items: [] };
            },
            async fetchPairs() {
                return { ok: true, pairs: [] };
            },
        },
        repo: {
            async listActiveLaunchpadCount() {
                return opts.existingActive ?? 0;
            },
            async listApprovedMints() {
                return opts.approvedMints ?? [];
            },
            async listSyncedStates() {
                return new Map();
            },
            async findApproval() {
                return null;
            },
            async findQuoteAssetByMint() {
                return null;
            },
            async upsertLaunchpadTokenLatest(args) {
                upserts.push(args);
            },
            async deactivateMissingLaunchpadTokens(_launchpad, activeMints) {
                deactivateCalls.push({ activeMints });
                return 0;
            },
            async filterMintsKnownTokens(mints) {
                return mints.filter(m => known.has(m));
            },
            async filterMintsWithVariantMarket(mints) {
                return mints.filter(m => withMarket.has(m));
            },
            async upsertTokenFromBirdeye(args) {
                tokenUpserts.push(args);
            },
        },
    };
    return { deps, upserts, tokenUpserts, marketUpserts, deactivateCalls, overviewCalls };
}

describe('syncStonkfunLaunches', () => {
    it('fails the run (without deactivating anything) when the provider fetch fails', async () => {
        const h = makeHarness({ fetch: { ok: false, reason: 'http_error', status: 503 } });
        const res = await syncStonkfunLaunches(h.deps, {});
        expect(res).toMatchObject({ ok: false, reason: 'http_error', status: 503 });
        expect(res.skipped).toBeUndefined();
        expect(h.upserts).toHaveLength(0);
        expect(h.deactivateCalls).toHaveLength(0);
    });

    it('fails the run on a network error or an invalid provider payload', async () => {
        const failures: Array<Extract<StonkfunFetchResult, { ok: false }>> = [
            { ok: false, reason: 'error', message: 'boom' },
            { ok: false, reason: 'invalid_payload' },
        ];
        for (const fetch of failures) {
            const h = makeHarness({ fetch });
            const res = await syncStonkfunLaunches(h.deps, {});
            expect(res).toMatchObject({ ok: false, reason: fetch.reason });
            expect(h.upserts).toHaveLength(0);
            expect(h.deactivateCalls).toHaveLength(0);
        }
    });

    it('skips on a suspicious drop against the existing active count', async () => {
        const h = makeHarness({
            fetch: { ok: true, items: [token({ mint: COIN_A })] },
            existingActive: 10,
        });
        const res = await syncStonkfunLaunches(h.deps, {});
        expect(res).toMatchObject({ skipped: true, reason: 'suspicious_drop', existingActiveCount: 10 });
        expect(h.upserts).toHaveLength(0);
        expect(h.deactivateCalls).toHaveLength(0);
    });

    it('activates coins that already have identity without calling Birdeye', async () => {
        const h = makeHarness({
            fetch: { ok: true, items: [token({ mint: COIN_A })] },
            knownTokens: [COIN_A],
            withMarket: [COIN_A],
        });
        const res = await syncStonkfunLaunches(h.deps, {});
        expect(h.overviewCalls).toHaveLength(0);
        expect(h.upserts).toHaveLength(1);
        expect(h.upserts[0]).toMatchObject({
            launchpad: 'stonkfun',
            mint: COIN_A,
            quoteMint: NVDAX,
            quoteSymbol: 'NVDAX',
            isActive: true,
            sourceRank: 0,
            lastSeenAt: 1_780_000_000_000,
        });
        expect(h.deactivateCalls[0]!.activeMints).toEqual([COIN_A]);
        expect(res).toMatchObject({ ok: true, synced: 1, activated: 1, pendingIdentity: 0, birdeyeCalls: 0 });
    });

    it('fetches identity for new mints within budget, writes tokens + variant market, and activates them', async () => {
        const h = makeHarness({
            fetch: {
                ok: true,
                items: [
                    token({ mint: COIN_A, market: { volume24hUsd: 30_000 } }),
                    token({ mint: COIN_B, market: { volume24hUsd: 20_000 } }),
                    token({ mint: COIN_C, quoteMint: SPYX, market: { volume24hUsd: 10_000 } }),
                ],
            },
            knownTokens: [COIN_A],
        });
        const res = await syncStonkfunLaunches(h.deps, { newMintBirdeyeBudget: 2, delayMs: 0 });
        // COIN_A has a tokens row but no market row → still needs identity.
        expect(h.overviewCalls.sort()).toEqual([COIN_A, COIN_B].sort());
        expect(h.tokenUpserts.map(t => t.address).sort()).toEqual([COIN_A, COIN_B].sort());
        expect(h.tokenUpserts[0]!.decimals).toBe(6);
        expect(h.marketUpserts.sort()).toEqual([COIN_A, COIN_B].sort());

        const byMint = new Map(h.upserts.map(u => [u.mint, u]));
        expect(byMint.get(COIN_A)!.isActive).toBe(true);
        expect(byMint.get(COIN_B)!.isActive).toBe(true);
        // Over budget: row is stored (rank/raw retained) but stays inactive.
        expect(byMint.get(COIN_C)!.isActive).toBe(false);
        expect(h.deactivateCalls[0]!.activeMints.slice().sort()).toEqual([COIN_A, COIN_B].sort());
        expect(res).toMatchObject({ synced: 3, activated: 2, pendingIdentity: 1, birdeyeCalls: 2, identityFailed: 0 });
    });

    it('gives approved mints first claim on the Birdeye budget and reports approvedSelected', async () => {
        const h = makeHarness({
            fetch: {
                ok: true,
                items: [
                    token({ mint: COIN_A, market: { volume24hUsd: 90_000 } }),
                    token({ mint: COIN_B, market: { marketCapUsd: 1, volume24hUsd: 1 } }),
                ],
            },
            approvedMints: [COIN_B],
        });
        const res = await syncStonkfunLaunches(h.deps, { newMintBirdeyeBudget: 1, delayMs: 0 });
        expect(h.overviewCalls).toEqual([COIN_B]);
        const byMint = new Map(h.upserts.map(u => [u.mint, u]));
        expect(byMint.get(COIN_B)!.isActive).toBe(true);
        expect(byMint.get(COIN_A)!.isActive).toBe(false);
        expect(res).toMatchObject({ selected: 2, approvedSelected: 1, activated: 1, birdeyeCalls: 1 });
    });

    it('leaves a coin inactive when Birdeye has no identity for it', async () => {
        const h = makeHarness({
            fetch: { ok: true, items: [token({ mint: COIN_A })] },
            overview: () => null,
        });
        const res = await syncStonkfunLaunches(h.deps, { delayMs: 0 });
        expect(h.tokenUpserts).toHaveLength(0);
        expect(h.upserts[0]!.isActive).toBe(false);
        expect(h.deactivateCalls[0]!.activeMints).toEqual([]);
        expect(res).toMatchObject({ activated: 0, pendingIdentity: 1, identityFailed: 1 });
    });

    it('reports no_matches when nothing is quoted in a curated mint', async () => {
        const h = makeHarness({
            fetch: { ok: true, items: [token({ mint: COIN_A, quoteMint: BONK })] },
        });
        const res = await syncStonkfunLaunches(h.deps, {});
        expect(res).toMatchObject({ skipped: true, reason: 'no_matches', fetched: 1 });
    });

    it('rejects non-numeric args', async () => {
        const h = makeHarness({ fetch: { ok: true, items: [] } });
        await expect(syncStonkfunLaunches(h.deps, { maxPerQuote: 'ten' })).rejects.toThrow();
    });
});
