import { describe, expect, it } from 'bun:test';

import { InvalidArgsError, type BirdeyeClient, type BirdeyeOverview, type CronDeps } from './crons';
import {
    refreshCuratedTokenMarkets,
    refreshStaleTokens,
    type BirdeyeMarketsClient,
    type MiscCronDeps,
    type MiscJobsRepo,
    type TokenMarketEntry,
    type TokenMarketsUpsert,
    type TokenUpsertFromBirdeye,
} from './crons.misc';

const FIXED_NOW = 1_780_000_000_000;

interface MiscState {
    staleAddresses?: string[];
    upsertedTokens?: TokenUpsertFromBirdeye[];
    tokenMarketsLastByMint?: Record<string, number>;
    upsertedTokenMarkets?: TokenMarketsUpsert[];
    touchedTokenMarkets?: { mint: string; lastFetchedAt: number }[];
}

function makeMiscRepo(state: MiscState = {}): MiscJobsRepo {
    state.upsertedTokens ??= [];
    state.upsertedTokenMarkets ??= [];
    state.touchedTokenMarkets ??= [];
    return {
        async listStaleTokenAddresses() {
            return state.staleAddresses ?? [];
        },
        async upsertTokenFromBirdeye(args) {
            state.upsertedTokens!.push(args);
        },
        async getTokenMarketsLastFetchedAtByMint(mint) {
            return state.tokenMarketsLastByMint?.[mint] ?? null;
        },
        async upsertTokenMarketsLatest(args) {
            state.upsertedTokenMarkets!.push(args);
        },
        async touchTokenMarketsLatest(mint, lastFetchedAt) {
            state.touchedTokenMarkets!.push({ mint, lastFetchedAt });
        },
    };
}

function makeBirdeye(byMint: Record<string, BirdeyeOverview | null>): BirdeyeClient {
    return {
        async fetchTokenOverview(mint) {
            return Object.hasOwn(byMint, mint) ? byMint[mint] ?? null : null;
        },
    };
}

function makeBirdeyeMarkets(
    byAddress: Record<string, TokenMarketEntry[] | Error>,
): BirdeyeMarketsClient {
    return {
        async fetchTokenMarkets(args) {
            const v = byAddress[args.address];
            if (v instanceof Error) throw v;
            return v ?? [];
        },
    };
}

function makeBase(overrides: Partial<CronDeps> = {}, curatedMints: readonly string[] = []): CronDeps {
    const rank = new Map<string, number>();
    for (let i = 0; i < curatedMints.length; i++) rank.set(curatedMints[i]!, i);
    return {
        repo: overrides.repo ?? ({} as never),
        curated: overrides.curated ?? {
            warmup: async () => {},
            getSnapshot: async () => ({
                loadedAt: 0,
                mintsByList: {
                    majors: [...curatedMints], lsts: [], currencies: [], rwas: [], etfs: [], metals: [], stocks: [],
                },
                allMints: [...curatedMints],
                entriesByMint: {},
            }),
            getAllCuratedMintsInOrder: () => Array.from(curatedMints),
            getCuratedMintRank: () => rank,
            getListSlugsByMint: () => new Map(),
        },
        birdeye: overrides.birdeye ?? { async fetchTokenOverview() { return null; } },
        birdeyeOhlcv: overrides.birdeyeOhlcv ?? { async fetchOhlcv() { return []; } },
        sanctum: overrides.sanctum ?? { async fetchAndNormalizeLsts() { return { ok: false, reason: 'missing_env' }; } },
        webacy:
            overrides.webacy ??
            {
                isConfigured: () => true,
                async fetchAll() {
                    return {
                        token: { ok: false, status: 0, message: 'n/a' },
                        trading: { ok: false, status: 0, message: 'n/a' },
                        holder: { ok: false, status: 0, message: 'n/a' },
                    };
                },
            },
        now: overrides.now ?? (() => FIXED_NOW),
    };
}

function makeDeps(opts: {
    state?: MiscState;
    base?: Partial<CronDeps>;
    curatedMints?: readonly string[];
    birdeyeMarkets?: BirdeyeMarketsClient;
} = {}): { deps: MiscCronDeps; state: MiscState } {
    const state = opts.state ?? {};
    const deps: MiscCronDeps = {
        base: makeBase(opts.base ?? {}, opts.curatedMints ?? []),
        repo: makeMiscRepo(state),
        birdeyeMarkets: opts.birdeyeMarkets ?? makeBirdeyeMarkets({}),
    };
    return { deps, state };
}

describe('refreshStaleTokens', () => {
    it('upserts birdeye token overviews for stale addresses', async () => {
        const overview: BirdeyeOverview = {
            symbol: 'JUP',
            name: 'Jupiter',
            decimals: 6,
            price: 1.23,
            liquidity: 100,
            marketCap: 1000,
            v24hUSD: 50,
        };
        const { deps, state } = makeDeps({
            state: { staleAddresses: ['mintA', 'mintB'] },
            base: { birdeye: makeBirdeye({ mintA: overview, mintB: overview }) },
        });
        const res = await refreshStaleTokens(deps, { delayMs: 0, concurrency: 1 });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(2);
        expect(state.upsertedTokens!.map(u => u.address).sort()).toEqual(['mintA', 'mintB']);
        expect(state.upsertedTokens![0]!.symbol).toBe('JUP');
        expect(state.upsertedTokens![0]!.lastFetchedAt).toBe(FIXED_NOW);
    });

    it('counts birdeye null/missing-identity payloads as failures', async () => {
        const { deps, state } = makeDeps({
            state: { staleAddresses: ['mintA', 'mintB'] },
            base: {
                birdeye: makeBirdeye({
                    mintA: null,
                    mintB: { symbol: '', name: '', decimals: 9 } as BirdeyeOverview,
                }),
            },
        });
        const res = await refreshStaleTokens(deps, { delayMs: 0, concurrency: 1 });
        expect(res.failed).toBe(2);
        expect(state.upsertedTokens).toHaveLength(0);
    });
});

describe('refreshCuratedTokenMarkets', () => {
    it('upserts markets for curated mints and skips recently fetched', async () => {
        const markets: TokenMarketEntry[] = [
            { address: 'poolA', liquidity: 10_000, volume24h: 100 },
            { address: 'poolB', liquidity: 5_000, volume24h: 50 },
        ];
        const { deps, state } = makeDeps({
            curatedMints: ['mintA', 'mintB'],
            state: { tokenMarketsLastByMint: { mintA: FIXED_NOW - 30_000 } },
            birdeyeMarkets: makeBirdeyeMarkets({ mintA: markets, mintB: markets }),
        });
        const res = await refreshCuratedTokenMarkets(deps, {
            minAgeMs: 5 * 60_000,
            delayMs: 0,
            concurrency: 1,
            priorityCount: 0,
            maxMints: 2,
        });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(1);
        expect(res.skipped).toBe(1);
        expect(state.upsertedTokenMarkets!.map(u => u.mint)).toEqual(['mintB']);
        expect(state.upsertedTokenMarkets![0]!.markets).toHaveLength(2);
    });

    it('touches the row when the upstream throws and counts it as failed', async () => {
        const { deps, state } = makeDeps({
            curatedMints: ['mintA'],
            birdeyeMarkets: makeBirdeyeMarkets({ mintA: new Error('birdeye down') }),
        });
        const res = await refreshCuratedTokenMarkets(deps, {
            delayMs: 0,
            concurrency: 1,
            priorityCount: 0,
            maxMints: 1,
        });
        expect(res.failed).toBe(1);
        expect(res.refreshed).toBe(0);
        expect(state.touchedTokenMarkets!.map(t => t.mint)).toEqual(['mintA']);
    });

    it('rejects invalid args with InvalidArgsError', async () => {
        const { deps } = makeDeps({ curatedMints: ['mintA'] });
        await expect(refreshCuratedTokenMarkets(deps, { maxMints: 'big' })).rejects.toThrow(InvalidArgsError);
    });
});
