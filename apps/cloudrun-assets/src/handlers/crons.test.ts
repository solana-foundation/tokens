import { describe, expect, it } from 'bun:test';

import {
    InvalidArgsError,
    pruneApiRequestEvents,
    refreshCuratedAssetMarkets,
    refreshCuratedAssetRisk,
    refreshCuratedOhlcv,
    refreshCuratedVariantMarkets,
    refreshStaleVariantMarkets,
    rollupActiveApiUsage,
    syncSanctumLsts,
    __testing,
    type ApiRequestEvent,
    type AssetAggregateUpsert,
    type AssetRiskUpsert,
    type BirdeyeClient,
    type BirdeyeInterval,
    type BirdeyeOhlcvClient,
    type BirdeyeOverview,
    type CronDeps,
    type DailyRollupDelta,
    type EndpointDailyRollupDelta,
    type JobsRepo,
    type OhlcvCandle,
    type OhlcvUpsertResult,
    type SanctumClient,
    type SanctumFetchResult,
    type VariantMarketUpsertFromBirdeye,
    type WebacyClient,
} from './crons';
import type { CuratedMembershipSource } from './curatedMembershipReads';

const FIXED_NOW = 1_780_000_000_000;

interface MockRepoState {
    overviewLastByMint?: Record<string, number>;
    staleMints?: string[];
    upsertedBirdeye?: VariantMarketUpsertFromBirdeye[];
    touched?: { mint: string; lastFetchedAt: number }[];
    curatedAssetIds?: string[];
    variantsForRollup?: Record<string, {
        mint: string;
        assetId: string;
        chain: string;
        kind: string;
        trustTier: string;
        liquidity: number;
        volume24hUSD: number;
        lastFetchedAt: number | null;
    }[]>;
    lastComputedByAsset?: Record<string, number | null>;
    volume30dByMint?: Record<string, number | null>;
    upsertedAggregates?: AssetAggregateUpsert[];
    activeSanctumLstCount?: number;
    sanctumSourceRanks?: Record<string, number>;
    upsertedSanctumLsts?: { mint: string; sourceRank: number }[];
    deactivatedSanctumCount?: number;
    variantByMint?: Record<string, { assetId: string; chain: string }>;
    assetRiskLastByMint?: Record<string, number>;
    upsertedAssetRisks?: AssetRiskUpsert[];
    variantMarketForRiskByMint?: Record<string, {
        liquidity: number | null;
        marketCap: number | null;
        volume24hUSD: number | null;
        holder: number | null;
    }>;
    upsertedWebacyTokenLatest?: { chain: string; address: string; ok: boolean }[];
    upsertedWebacyTradingLiteLatest?: { chain: string; address: string; ok: boolean }[];
    upsertedWebacyHolderAnalysisLatest?: { chain: string; address: string; ok: boolean }[];
    recentActiveProjects?: string[];
    rollupStateByProject?: Record<string, { cursorCreationTime: number; lockedUntil: number }>;
    lockAcquisitions?: { projectId: string; now: number }[];
    lockReleases?: { projectId: string; nextCursor: number }[];
    eventsByProject?: Record<string, ApiRequestEvent[]>;
    appliedDailyDeltas?: DailyRollupDelta[];
    appliedEndpointDeltas?: EndpointDailyRollupDelta[];
    allProjectIds?: string[];
    prunedByProject?: Record<string, number>;
    pruneCalls?: { projectId: string; cutoffTs: number; beforeCreationTime: number }[];
    ohlcvBoundsByKey?: Record<string, { minTime: number | null; maxTime: number | null }>;
    upsertedOhlcvBatches?: { address: string; interval: string; candles: OhlcvCandle[] }[];
    ohlcvUpsertResult?: OhlcvUpsertResult;
}

function makeRepo(state: MockRepoState = {}): JobsRepo {
    state.upsertedBirdeye ??= [];
    state.touched ??= [];
    state.upsertedAggregates ??= [];
    state.upsertedSanctumLsts ??= [];
    state.upsertedAssetRisks ??= [];
    state.upsertedWebacyTokenLatest ??= [];
    state.upsertedWebacyTradingLiteLatest ??= [];
    state.upsertedWebacyHolderAnalysisLatest ??= [];
    state.lockAcquisitions ??= [];
    state.lockReleases ??= [];
    state.appliedDailyDeltas ??= [];
    state.appliedEndpointDeltas ??= [];
    state.upsertedOhlcvBatches ??= [];
    state.pruneCalls ??= [];
    return {
        async upsertVariantMarketFromBirdeye(args) {
            state.upsertedBirdeye!.push(args);
        },
        async touchVariantMarket(mint, lastFetchedAt) {
            state.touched!.push({ mint, lastFetchedAt });
        },
        async getOverviewLastFetchedAtByMint(mint) {
            return state.overviewLastByMint?.[mint] ?? null;
        },
        async listStaleVariantMints() {
            return state.staleMints ?? [];
        },
        async listCuratedAssetIds() {
            return state.curatedAssetIds ?? [];
        },
        async listVariantsForRollup(assetIds) {
            return assetIds.map(assetId => ({
                assetId,
                variants: state.variantsForRollup?.[assetId] ?? [],
            }));
        },
        async listVariantLastComputedByAssetIds(assetIds) {
            const out = new Map<string, number | null>();
            for (const id of assetIds) out.set(id, state.lastComputedByAsset?.[id] ?? null);
            return out;
        },
        async sumDailyOhlcvVolumeByAddresses(addresses) {
            const out = new Map<string, number | null>();
            for (const addr of addresses) out.set(addr, state.volume30dByMint?.[addr] ?? null);
            return out;
        },
        async upsertAssetAggregate(args) {
            state.upsertedAggregates!.push(args);
        },
        async listActiveSanctumLstCount() {
            return state.activeSanctumLstCount ?? 0;
        },
        async listSanctumSourceRanks(mints) {
            const out = new Map<string, number>();
            for (const m of mints) {
                const r = state.sanctumSourceRanks?.[m];
                if (r !== undefined) out.set(m, r);
            }
            return out;
        },
        async upsertSanctumLstLatest(args) {
            state.upsertedSanctumLsts!.push({ mint: args.mint, sourceRank: args.sourceRank });
        },
        async deactivateMissingSanctumLsts() {
            return state.deactivatedSanctumCount ?? 0;
        },
        async findVariantByMint(mint) {
            return state.variantByMint?.[mint] ?? null;
        },
        async getAssetRiskLastFetchedAtByMint(mint) {
            return state.assetRiskLastByMint?.[mint] ?? null;
        },
        async upsertAssetRiskLatest(args) {
            state.upsertedAssetRisks!.push(args);
        },
        async findVariantMarketForRiskByMint(mint) {
            return state.variantMarketForRiskByMint?.[mint] ?? null;
        },
        async upsertWebacyTokenLatest(args) {
            state.upsertedWebacyTokenLatest!.push(args);
        },
        async upsertWebacyTradingLiteLatest(args) {
            state.upsertedWebacyTradingLiteLatest!.push(args);
        },
        async upsertWebacyHolderAnalysisLatest(args) {
            state.upsertedWebacyHolderAnalysisLatest!.push(args);
        },
        async findRwaXyzAssetLatestByAssetId() {
            return null;
        },
        async findRwaXyzTokenLatestByNetworkAndAddress() {
            return null;
        },
        async upsertRwaXyzAssetLatest() {},
        async upsertRwaXyzTokenLatest() {},
        async listRecentActiveProjects() {
            return state.recentActiveProjects ?? [];
        },
        async getRollupStateForProject(projectId) {
            return state.rollupStateByProject?.[projectId] ?? null;
        },
        async tryAcquireRollupLock(projectId, now) {
            state.lockAcquisitions!.push({ projectId, now });
            const existing = state.rollupStateByProject?.[projectId];
            if (existing && existing.lockedUntil > now) return false;
            return true;
        },
        async releaseRollupLock(projectId, nextCursor) {
            state.lockReleases!.push({ projectId, nextCursor });
            if (state.rollupStateByProject) {
                state.rollupStateByProject[projectId] = {
                    cursorCreationTime: nextCursor,
                    lockedUntil: 0,
                };
            }
        },
        async listProjectEventsForRollup(projectId) {
            return state.eventsByProject?.[projectId] ?? [];
        },
        async applyDailyRollupDelta(delta) {
            state.appliedDailyDeltas!.push(delta);
        },
        async applyEndpointDailyRollupDelta(delta) {
            state.appliedEndpointDeltas!.push(delta);
        },
        async applyRollupBatchAtomic({ projectId, daily, endpointDaily, nextCursor }) {
            for (const d of daily) state.appliedDailyDeltas!.push(d);
            for (const d of endpointDaily) state.appliedEndpointDeltas!.push(d);
            state.lockReleases!.push({ projectId, nextCursor });
            return true;
        },
        async listAllProjectIds() {
            return state.allProjectIds ?? [];
        },
        async pruneApiRequestEventsForProject(projectId, cutoffTs, beforeCreationTime) {
            state.pruneCalls!.push({ projectId, cutoffTs, beforeCreationTime });
            return state.prunedByProject?.[projectId] ?? 0;
        },
        async getOhlcvBounds(address, interval) {
            return state.ohlcvBoundsByKey?.[`${address}\n${interval}`] ?? { minTime: null, maxTime: null };
        },
        async upsertOhlcvCandles(address, interval, candles) {
            state.upsertedOhlcvBatches!.push({ address, interval, candles: [...candles] });
            return state.ohlcvUpsertResult ?? { inserted: candles.length, updated: 0, skipped: 0 };
        },
    };
}

function makeCurated(mints: readonly string[] = []): CuratedMembershipSource {
    const rank = new Map<string, number>();
    for (let i = 0; i < mints.length; i++) rank.set(mints[i]!, i);
    return {
        warmup: async () => {},
        getSnapshot: async () => ({
            loadedAt: 0,
            mintsByList: { majors: [...mints], lsts: [], currencies: [], rwas: [], etfs: [], metals: [], stocks: [] },
            allMints: [...mints],
            entriesByMint: {},
        }),
        getAllCuratedMintsInOrder: () => Array.from(mints),
        getCuratedMintRank: () => rank,
        getListSlugsByMint: () => new Map(),
    };
}

function makeBirdeye(byMint: Record<string, BirdeyeOverview | null>): BirdeyeClient {
    return { async fetchTokenOverview(mint) {
        return Object.hasOwn(byMint, mint) ? byMint[mint] ?? null : null;
    } };
}

function makeSanctum(result: SanctumFetchResult): SanctumClient {
    return { async fetchAndNormalizeLsts() {
        return result;
    } };
}

function makeWebacy(result: { ok: boolean; status: number; data?: unknown; message?: string }): WebacyClient {
    return {
        isConfigured: () => true,
        async fetchAll() {
            return { token: result, trading: result, holder: result };
        },
    };
}

function makeBirdeyeOhlcv(
    byAddress: Record<string, OhlcvCandle[] | ((interval: BirdeyeInterval) => OhlcvCandle[])>,
): BirdeyeOhlcvClient {
    return {
        async fetchOhlcv(args) {
            const v = byAddress[args.address];
            if (!v) return [];
            return typeof v === 'function' ? v(args.interval) : v;
        },
    };
}

function makeFailingBirdeyeOhlcv(): BirdeyeOhlcvClient {
    return {
        async fetchOhlcv() {
            throw new Error('birdeye ohlcv down');
        },
    };
}

function makeDeps(overrides: Partial<CronDeps> & { state?: MockRepoState; curatedMints?: readonly string[] } = {}): {
    deps: CronDeps;
    state: MockRepoState;
} {
    const state = overrides.state ?? {};
    const deps: CronDeps = {
        repo: overrides.repo ?? makeRepo(state),
        curated: overrides.curated ?? makeCurated(overrides.curatedMints ?? []),
        birdeye: overrides.birdeye ?? makeBirdeye({}),
        birdeyeOhlcv: overrides.birdeyeOhlcv ?? makeBirdeyeOhlcv({}),
        sanctum: overrides.sanctum ?? makeSanctum({ ok: false, reason: 'missing_env' }),
        webacy: overrides.webacy ?? makeWebacy({ ok: false, status: 0, message: 'no webacy' }),
        now: overrides.now ?? (() => FIXED_NOW),
    };
    return { deps, state };
}

describe('refreshCuratedVariantMarkets', () => {
    it('skips mints whose overview was recently fetched, upserts the rest', async () => {
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
            curatedMints: ['mintA', 'mintB'],
            state: {
                overviewLastByMint: { mintA: FIXED_NOW - 30_000 },
            },
            birdeye: makeBirdeye({ mintA: overview, mintB: overview }),
        });
        const res = await refreshCuratedVariantMarkets(deps, { minAgeMs: 60_000, delayMs: 0 });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(1);
        expect(res.skipped).toBe(1);
        expect(state.upsertedBirdeye!.map(u => u.mint)).toEqual(['mintB']);
    });

    it('touches the row when birdeye returns null and counts it as failed', async () => {
        const { deps, state } = makeDeps({
            curatedMints: ['m1'],
            birdeye: makeBirdeye({ m1: null }),
        });
        const res = await refreshCuratedVariantMarkets(deps, { delayMs: 0 });
        expect(res.failed).toBe(1);
        expect(state.touched!.map(t => t.mint)).toEqual(['m1']);
    });

    it('rejects invalid args with InvalidArgsError', async () => {
        const { deps } = makeDeps();
        await expect(refreshCuratedVariantMarkets(deps, { maxMints: 'big' })).rejects.toThrow(
            /numeric arg/,
        );
    });

    it('reports ok=false when every attempted mint fails (total failure)', async () => {
        const { deps } = makeDeps({
            curatedMints: ['m1', 'm2'],
            birdeye: {
                async fetchTokenOverview() {
                    throw new Error('birdeye down');
                },
            },
        });
        const res = await refreshCuratedVariantMarkets(deps, { delayMs: 0 });
        expect(res.ok).toBe(false);
        expect(res.failed).toBe(2);
        expect(res.refreshed).toBe(0);
    });

    it('keeps ok=true on partial failure', async () => {
        const overview: BirdeyeOverview = { symbol: 'JUP', name: 'Jupiter', decimals: 6 };
        const { deps } = makeDeps({
            curatedMints: ['good', 'bad'],
            birdeye: {
                async fetchTokenOverview(mint) {
                    if (mint === 'bad') throw new Error('boom');
                    return overview;
                },
            },
        });
        const res = await refreshCuratedVariantMarkets(deps, { delayMs: 0 });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(1);
        expect(res.failed).toBe(1);
    });
});

describe('refreshCuratedVariantMarkets explicit mints', () => {
    const overview: BirdeyeOverview = { symbol: 'X', name: 'X Token', decimals: 6 };

    it('uses args.mints instead of the curated selection', async () => {
        const { deps, state } = makeDeps({
            curatedMints: ['curated1', 'curated2'],
            birdeye: makeBirdeye({ explicit1: overview, curated1: overview, curated2: overview }),
        });
        const res = await refreshCuratedVariantMarkets(deps, { mints: ['explicit1'], delayMs: 0 });
        expect(res.processed).toBe(1);
        expect(state.upsertedBirdeye!.map(u => u.mint)).toEqual(['explicit1']);
    });

    it('trims, dedupes, and drops empty entries in args.mints', async () => {
        const { deps, state } = makeDeps({
            birdeye: makeBirdeye({ a: overview, b: overview }),
        });
        const res = await refreshCuratedVariantMarkets(deps, { mints: [' a ', 'a', '', 'b'], delayMs: 0 });
        expect(res.processed).toBe(2);
        expect(state.upsertedBirdeye!.map(u => u.mint).sort()).toEqual(['a', 'b']);
    });

    it('caps explicit mints at 250', async () => {
        const mints = Array.from({ length: 300 }, (_, i) => `mint${i}`);
        const byMint: Record<string, BirdeyeOverview | null> = {};
        for (const mint of mints) byMint[mint] = overview;
        const { deps } = makeDeps({ birdeye: makeBirdeye(byMint) });
        const res = await refreshCuratedVariantMarkets(deps, { mints, delayMs: 0, concurrency: 5 });
        expect(res.processed).toBe(250);
    });

    it('still applies per-mint freshness dedup for explicit mints', async () => {
        const { deps, state } = makeDeps({
            state: { overviewLastByMint: { fresh1: FIXED_NOW - 5_000 } },
            birdeye: makeBirdeye({ fresh1: overview, stale1: overview }),
        });
        const res = await refreshCuratedVariantMarkets(deps, {
            mints: ['fresh1', 'stale1'],
            minAgeMs: 60_000,
            delayMs: 0,
        });
        expect(res.skipped).toBe(1);
        expect(state.upsertedBirdeye!.map(u => u.mint)).toEqual(['stale1']);
    });

    it('rejects non-string entries in args.mints', async () => {
        const { deps } = makeDeps({});
        await expect(refreshCuratedVariantMarkets(deps, { mints: ['ok', 5] })).rejects.toThrow(InvalidArgsError);
    });

    it('rejects a non-array args.mints', async () => {
        const { deps } = makeDeps({});
        await expect(refreshCuratedVariantMarkets(deps, { mints: 'not-an-array' })).rejects.toThrow(
            InvalidArgsError,
        );
    });
});

describe('refreshStaleVariantMarkets', () => {
    it('fetches stale mints from the repo and writes overview rows', async () => {
        const overview: BirdeyeOverview = { symbol: 'X', name: 'X', decimals: 9 };
        const { deps, state } = makeDeps({
            state: { staleMints: ['s1', 's2'] },
            birdeye: makeBirdeye({ s1: overview, s2: overview }),
        });
        const res = await refreshStaleVariantMarkets(deps, { delayMs: 0 });
        expect(res.refreshed).toBe(2);
        expect(state.upsertedBirdeye!.length).toBe(2);
    });

    it('returns processed=0 when there are no stale mints', async () => {
        const { deps } = makeDeps();
        const res = await refreshStaleVariantMarkets(deps, { delayMs: 0 });
        expect(res.processed).toBe(0);
    });
});

describe('refreshCuratedAssetMarkets', () => {
    it('computes rollups, picks primary mint by liquidity', async () => {
        const { deps, state } = makeDeps({
            curatedMints: ['mA', 'mB'],
            state: {
                curatedAssetIds: ['jup'],
                variantsForRollup: {
                    jup: [
                        {
                            mint: 'mA',
                            assetId: 'jup',
                            chain: 'solana',
                            kind: 'native',
                            trustTier: 'tier1',
                            liquidity: 100,
                            volume24hUSD: 10,
                            lastFetchedAt: FIXED_NOW - 1000,
                        },
                        {
                            mint: 'mB',
                            assetId: 'jup',
                            chain: 'solana',
                            kind: 'wrapped',
                            trustTier: 'tier2',
                            liquidity: 500,
                            volume24hUSD: 50,
                            lastFetchedAt: FIXED_NOW - 2000,
                        },
                    ],
                },
                lastComputedByAsset: { jup: null },
                volume30dByMint: { mA: 1000, mB: 2000 },
            },
        });
        const res = await refreshCuratedAssetMarkets(deps, {});
        expect(res.refreshed).toBe(1);
        const upsert = state.upsertedAggregates![0]!;
        expect(upsert.assetId).toBe('jup');
        expect(upsert.liquidity).toBe(600);
        expect(upsert.volume24hUSD).toBe(60);
        expect(upsert.volume30dUSD).toBe(3000);
        expect(upsert.primaryMint).toBe('mB');
        expect(upsert.minVariantLastFetchedAt).toBe(FIXED_NOW - 2000);
        expect(upsert.maxVariantLastFetchedAt).toBe(FIXED_NOW - 1000);
    });

    it('skips assets whose last_computed_at is fresh', async () => {
        const { deps, state } = makeDeps({
            state: {
                curatedAssetIds: ['jup'],
                lastComputedByAsset: { jup: FIXED_NOW - 1000 },
                variantsForRollup: {},
            },
        });
        const res = await refreshCuratedAssetMarkets(deps, { minAgeMs: 60_000 });
        expect(res.skipped).toBe(1);
        expect(state.upsertedAggregates!.length).toBe(0);
    });
});

describe('syncSanctumLsts', () => {
    it('upserts items ordered by tvlUsd desc and deactivates the rest', async () => {
        const { deps, state } = makeDeps({
            state: { activeSanctumLstCount: 0, deactivatedSanctumCount: 3 },
            sanctum: makeSanctum({
                ok: true,
                items: [
                    { parsed: { mint: 'a'.padEnd(33, '1'), tvlUsd: 100 }, raw: { mint: 'a' } },
                    { parsed: { mint: 'b'.padEnd(33, '1'), tvlUsd: 500 }, raw: { mint: 'b' } },
                ],
            }),
        });
        const res = await syncSanctumLsts(deps, {});
        expect(res.synced).toBe(2);
        expect(res.deactivated).toBe(3);
        const mints = state.upsertedSanctumLsts!.map(s => s.mint);
        expect(mints).toHaveLength(2);
        expect(mints[0]!.startsWith('b')).toBe(true);
        expect(mints[1]!.startsWith('a')).toBe(true);
    });

    it('skips on suspicious drop', async () => {
        const { deps } = makeDeps({
            state: { activeSanctumLstCount: 100 },
            sanctum: makeSanctum({
                ok: true,
                items: [{ parsed: { mint: 'x'.padEnd(33, '1') }, raw: {} }],
            }),
        });
        const res = await syncSanctumLsts(deps, {});
        expect(res.skipped).toBe(true);
        expect(res.reason).toBe('suspicious_drop');
    });

    it('reports skipped on http_error', async () => {
        const { deps } = makeDeps({ sanctum: makeSanctum({ ok: false, reason: 'http_error', status: 503 }) });
        const res = await syncSanctumLsts(deps, {});
        expect(res.skipped).toBe(true);
        expect(res.reason).toBe('http_error');
        expect(res.status).toBe(503);
    });
});

describe('refreshCuratedAssetRisk', () => {
    it('short-circuits with disabled:true when Webacy is not configured (no key)', async () => {
        const unconfiguredWebacy: WebacyClient = {
            isConfigured: () => false,
            async fetchAll() {
                throw new Error('should not be called when Webacy is unconfigured');
            },
        };
        const { deps, state } = makeDeps({
            curatedMints: ['m1', 'm2'],
            state: { variantByMint: { m1: { assetId: 'jup', chain: 'solana' } } },
            webacy: unconfiguredWebacy,
        });
        const res = await refreshCuratedAssetRisk(deps, { delayMs: 0, minAgeMs: 0 });
        expect(res.disabled).toBe(true);
        expect(res.reason).toBe('webacy_not_configured');
        expect(res.refreshed).toBe(0);
        expect(state.upsertedAssetRisks ?? []).toHaveLength(0);
    });

    it('skips mints without a variant and writes a row when variant exists', async () => {
        const { deps, state } = makeDeps({
            curatedMints: ['m1', 'm2'],
            state: {
                variantByMint: { m2: { assetId: 'jup', chain: 'solana' } },
            },
            webacy: makeWebacy({ ok: true, status: 200, data: { risk: {} } }),
        });
        const res = await refreshCuratedAssetRisk(deps, { delayMs: 0, minAgeMs: 0 });
        expect(res.skipped).toBe(1);
        expect(res.refreshed).toBe(1);
        expect(state.upsertedAssetRisks!.length).toBe(1);
        expect(state.upsertedAssetRisks![0]!.mint).toBe('m2');
    });

    it('writes an upstream_error row when all webacy upstreams fail', async () => {
        const { deps, state } = makeDeps({
            curatedMints: ['m1'],
            state: { variantByMint: { m1: { assetId: 'jup', chain: 'solana' } } },
            webacy: makeWebacy({ ok: false, status: 500, message: 'down' }),
        });
        const res = await refreshCuratedAssetRisk(deps, { delayMs: 0, minAgeMs: 0 });
        expect(res.failed).toBe(1);
        expect(state.upsertedAssetRisks![0]!.ok).toBe(false);
        expect(state.upsertedAssetRisks![0]!.reason).toBe('upstream_error');
    });

    it('caches raw webacy responses to webacy_*_latest tables', async () => {
        const { deps, state } = makeDeps({
            curatedMints: ['m1'],
            state: { variantByMint: { m1: { assetId: 'jup', chain: 'solana' } } },
            webacy: makeWebacy({ ok: true, status: 200, data: { risk: {} } }),
        });
        await refreshCuratedAssetRisk(deps, { delayMs: 0, minAgeMs: 0 });
        expect(state.upsertedWebacyTokenLatest!.length).toBe(1);
        expect(state.upsertedWebacyTradingLiteLatest!.length).toBe(1);
        expect(state.upsertedWebacyHolderAnalysisLatest!.length).toBe(1);
        const cached = state.upsertedWebacyTokenLatest![0]!;
        expect(cached.chain).toBe('sol');
        expect(cached.address).toBe('m1');
        expect(cached.ok).toBe(true);
    });

    it('caches raw webacy responses with error status when calls fail', async () => {
        const { deps, state } = makeDeps({
            curatedMints: ['m1'],
            state: { variantByMint: { m1: { assetId: 'jup', chain: 'solana' } } },
            webacy: makeWebacy({ ok: false, status: 502, message: 'gateway' }),
        });
        await refreshCuratedAssetRisk(deps, { delayMs: 0, minAgeMs: 0 });
        expect(state.upsertedWebacyTokenLatest![0]!.ok).toBe(false);
    });

    it('computes risk score, safety score, and tags from webacy token data', async () => {
        const tokenPayload = {
            risk: {
                issues: [
                    { tags: [{ key: 'honeypot', name: 'Honeypot', type: 'risk', severity: 8, description: 'd1' }] },
                    { tags: [{ key: 'liquidity_low', name: 'Low LP', type: 'risk', severity: 4, description: 'd2' }] },
                ],
            },
        };
        const { deps, state } = makeDeps({
            curatedMints: ['m1'],
            state: { variantByMint: { m1: { assetId: 'jup', chain: 'solana' } } },
            webacy: {
                isConfigured: () => true,
                async fetchAll() {
                    return {
                        token: { ok: true, status: 200, data: tokenPayload },
                        trading: { ok: true, status: 200, data: { Top10Holders: 45, TotalHolders: 1234 } },
                        holder: { ok: true, status: 200, data: { token_mint_time: '2024-01-01' } },
                    };
                },
            },
        });
        await refreshCuratedAssetRisk(deps, { delayMs: 0, minAgeMs: 0 });
        const row = state.upsertedAssetRisks![0]!;
        expect(row.ok).toBe(true);
        const tags = row.tags as Array<{ key: string }>;
        expect(tags.map(t => t.key).sort()).toEqual(['honeypot', 'liquidity_low']);
        expect(row.riskScore10).toBe(2);
        expect(row.safetyScore10).toBe(8);
        expect(row.top10HoldersPercent).toBe(45);
        expect(row.holderCount).toBe(1234);
        expect(row.tokenMintTime).toBe('2024-01-01');
    });

    it('invokes computeMarketScore when injected and uses variant_markets fallback values', async () => {
        const seen: unknown[] = [];
        const { deps, state } = makeDeps({
            curatedMints: ['m1'],
            state: {
                variantByMint: { m1: { assetId: 'jup', chain: 'solana' } },
                variantMarketForRiskByMint: {
                    m1: { liquidity: 10_000, marketCap: 1_000_000, volume24hUSD: 5_000, holder: 999 },
                },
            },
            webacy: makeWebacy({ ok: true, status: 200, data: { risk: {} } }),
        });
        deps.computeMarketScore = (input: unknown) => {
            seen.push(input);
            return { score: 42, breakdown: {} };
        };
        await refreshCuratedAssetRisk(deps, { delayMs: 0, minAgeMs: 0 });
        expect(seen.length).toBe(1);
        const input = seen[0] as { liquidityUsd: number | null; marketCapUsd: number | null; tokenAddress: string };
        expect(input.tokenAddress).toBe('m1');
        expect(input.liquidityUsd).toBe(10_000);
        expect(input.marketCapUsd).toBe(1_000_000);
        const row = state.upsertedAssetRisks![0]!;
        expect(row.marketScore).toEqual({ score: 42, breakdown: {} });
    });

    it('respects minAgeMs and skips mints that were refreshed recently', async () => {
        const { deps, state } = makeDeps({
            curatedMints: ['m1'],
            state: {
                variantByMint: { m1: { assetId: 'jup', chain: 'solana' } },
                assetRiskLastByMint: { m1: FIXED_NOW - 1_000 },
            },
            webacy: makeWebacy({ ok: true, status: 200, data: { risk: {} } }),
        });
        const res = await refreshCuratedAssetRisk(deps, { delayMs: 0, minAgeMs: 60_000 });
        expect(res.skipped).toBe(1);
        expect(state.upsertedAssetRisks!.length).toBe(0);
    });
});

describe('rollupActiveApiUsage', () => {
    it('rolls up events for active projects into daily + endpoint deltas', async () => {
        const day = '2026-06-24';
        const dayMs = Date.UTC(2026, 5, 24, 12, 0, 0);
        const events: ApiRequestEvent[] = [
            {
                projectId: 'p1',
                endpoint: '/api/v1/assets/jup',
                status: 200,
                latencyMs: 30,
                ts: dayMs,
                creationTime: dayMs + 1,
            },
            {
                projectId: 'p1',
                endpoint: '/api/v1/tokens/jup',
                status: 500,
                latencyMs: 80,
                ts: dayMs,
                creationTime: dayMs + 2,
            },
        ];
        const { deps, state } = makeDeps({
            now: () => dayMs + 5 * 60_000,
            state: {
                recentActiveProjects: ['p1'],
                eventsByProject: { p1: events },
                rollupStateByProject: { p1: { cursorCreationTime: 0, lockedUntil: 0 } },
            },
        });
        const res = await rollupActiveApiUsage(deps, {});
        expect(res.ok).toBe(true);
        expect(res.processed).toBe(2);
        expect(res.projectsRolledUp).toBe(1);
        expect(state.appliedDailyDeltas!).toHaveLength(1);
        const daily = state.appliedDailyDeltas![0]!;
        expect(daily.day).toBe(day);
        expect(daily.totalCalls).toBe(2);
        expect(daily.assetCalls).toBe(1);
        expect(daily.successCalls).toBe(1);
        expect(daily.sumLatencyMs).toBe(110);
        expect(state.appliedEndpointDeltas!).toHaveLength(2);
        expect(state.lockReleases!.map(r => r.projectId)).toEqual(['p1']);
        expect(state.lockReleases![0]!.nextCursor).toBe(dayMs + 2);
    });

    it('rolls back deltas and cursor advance when applyRollupBatchAtomic throws', async () => {
        const dayMs = Date.UTC(2026, 5, 24, 12, 0, 0);
        const events: ApiRequestEvent[] = [
            { projectId: 'p1', endpoint: '/api/v1/assets/jup', status: 200, latencyMs: 10, ts: dayMs, creationTime: dayMs + 1 },
        ];
        const { deps, state } = makeDeps({
            now: () => dayMs + 5 * 60_000,
            state: {
                recentActiveProjects: ['p1'],
                eventsByProject: { p1: events },
                rollupStateByProject: { p1: { cursorCreationTime: 0, lockedUntil: 0 } },
            },
        });
        deps.repo.applyRollupBatchAtomic = async () => {
            throw new Error('connection reset mid-batch');
        };
        const res = await rollupActiveApiUsage(deps, {});
        expect(res.failed).toBe(1);
        expect(state.appliedDailyDeltas!).toHaveLength(0);
        expect(state.appliedEndpointDeltas!).toHaveLength(0);
        expect(state.lockReleases!).toHaveLength(0);
    });

    it('skips rollup when the lock is already held', async () => {
        const { deps, state } = makeDeps({
            now: () => 1_000_000,
            state: {
                recentActiveProjects: ['p1'],
                rollupStateByProject: { p1: { cursorCreationTime: 123, lockedUntil: 9_999_999 } },
                eventsByProject: { p1: [] },
            },
        });
        const res = await rollupActiveApiUsage(deps, {});
        expect(res.processed).toBe(0);
        expect(res.projectsRolledUp).toBe(0);
        expect(state.appliedDailyDeltas!).toHaveLength(0);
        expect(state.lockReleases!).toHaveLength(0);
    });

    it('rejects non-numeric args with InvalidArgsError', async () => {
        const { deps } = makeDeps();
        await expect(rollupActiveApiUsage(deps, { maxProjects: 'lots' })).rejects.toThrow(/numeric arg/);
    });
});

describe('pruneApiRequestEvents', () => {
    it('prunes events older than retention for each project, bounded by rollup cursor', async () => {
        const { deps, state } = makeDeps({
            now: () => 1_780_000_000_000,
            state: {
                allProjectIds: ['p1', 'p2'],
                rollupStateByProject: {
                    p1: { cursorCreationTime: 1_700_000_000_000, lockedUntil: 0 },
                    p2: { cursorCreationTime: 0, lockedUntil: 0 },
                },
                prunedByProject: { p1: 7, p2: 0 },
            },
        });
        const res = await pruneApiRequestEvents(deps, { retentionDays: 30, batchSizePerProject: 100, maxProjects: 10 });
        expect(res.deleted).toBe(7);
        expect(res.processed).toBe(2);
        expect(state.pruneCalls!.map(c => c.projectId)).toEqual(['p1', 'p2']);
        expect(state.pruneCalls![0]!.beforeCreationTime).toBe(1_700_000_000_000);
    });

    it('handles repo failure for one project without aborting the rest', async () => {
        const baseRepo = makeRepo({
            allProjectIds: ['p1', 'p2'],
            prunedByProject: { p2: 3 },
            rollupStateByProject: {
                p1: { cursorCreationTime: 0, lockedUntil: 0 },
                p2: { cursorCreationTime: 0, lockedUntil: 0 },
            },
        });
        const failingRepo: JobsRepo = {
            ...baseRepo,
            async pruneApiRequestEventsForProject(projectId, cutoffTs, beforeCreationTime, batchSize) {
                if (projectId === 'p1') throw new Error('boom');
                return baseRepo.pruneApiRequestEventsForProject(projectId, cutoffTs, beforeCreationTime, batchSize);
            },
        };
        const deps: CronDeps = {
            repo: failingRepo,
            curated: makeCurated(),
            birdeye: makeBirdeye({}),
            birdeyeOhlcv: makeBirdeyeOhlcv({}),
            sanctum: makeSanctum({ ok: false, reason: 'missing_env' }),
            webacy: makeWebacy({ ok: false, status: 0, message: '' }),
            now: () => 1_780_000_000_000,
        };
        const res = await pruneApiRequestEvents(deps, {});
        expect(res.failed).toBe(1);
        expect(res.deleted).toBe(3);
    });
});

describe('refreshCuratedOhlcv', () => {
    it('fetches and upserts candles for selected mints when no bounds exist', async () => {
        const candles: OhlcvCandle[] = [
            { time: 1_780_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
            { time: 1_780_003_600, open: 1.5, high: 2.5, low: 1, close: 2, volume: 200 },
        ];
        const { deps, state } = makeDeps({
            curatedMints: ['mintA'],
            birdeyeOhlcv: makeBirdeyeOhlcv({ mintA: candles }),
            state: {
                ohlcvUpsertResult: { inserted: 2, updated: 0, skipped: 0 },
            },
        });
        const res = await refreshCuratedOhlcv(deps, { interval: '1H', days: 90, delayMs: 0 });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(1);
        expect(res.inserted).toBe(2);
        expect(state.upsertedOhlcvBatches!).toHaveLength(1);
        expect(state.upsertedOhlcvBatches![0]!.address).toBe('mintA');
        expect(state.upsertedOhlcvBatches![0]!.interval).toBe('1H');
    });

    it('skips fetches when existing bounds already cover the requested range', async () => {
        const fixedNow = 1_780_000_000_000;
        const nowSec = Math.floor(fixedNow / 1000);
        const { deps, state } = makeDeps({
            curatedMints: ['mintA'],
            now: () => fixedNow,
            birdeyeOhlcv: makeBirdeyeOhlcv({ mintA: [] }),
            state: {
                ohlcvBoundsByKey: {
                    'mintA\n1H': { minTime: nowSec - 90 * 24 * 60 * 60 + 100, maxTime: nowSec - 10 },
                },
            },
        });
        const res = await refreshCuratedOhlcv(deps, { interval: '1H', days: 90, delayMs: 0 });
        expect(res.refreshed).toBe(0);
        expect(res.skipped).toBe(1);
        expect(state.upsertedOhlcvBatches!).toHaveLength(0);
    });

    it('counts failure and continues when birdeye throws', async () => {
        const { deps } = makeDeps({
            curatedMints: ['mintA', 'mintB'],
            birdeyeOhlcv: makeFailingBirdeyeOhlcv(),
        });
        const res = await refreshCuratedOhlcv(deps, { interval: '15m', days: 1, delayMs: 0, concurrency: 1 });
        expect(res.failed).toBe(2);
        expect(res.refreshed).toBe(0);
    });

    it('rejects unknown interval with InvalidArgsError', async () => {
        const { deps } = makeDeps();
        await expect(refreshCuratedOhlcv(deps, { interval: '3m', days: 1 })).rejects.toThrow(/interval/);
    });
});

describe('__testing helpers', () => {
    it('pickDeterministicBatch wraps around', () => {
        const items = ['a', 'b', 'c', 'd'];
        const slot0 = __testing.pickDeterministicBatch(items, 2, 60_000, 0);
        const slot1 = __testing.pickDeterministicBatch(items, 2, 60_000, 60_000);
        expect(slot0).toEqual(['a', 'b']);
        expect(slot1).toEqual(['c', 'd']);
    });

    it('birdeyeOverviewToUpsert rejects missing identity', () => {
        const out = __testing.birdeyeOverviewToUpsert('mint', { symbol: 'X' }, 1);
        expect(out).toBeNull();
    });

    it('uniqueStrings deduplicates with trim', () => {
        expect(__testing.uniqueStrings(['a', ' a ', 'b', ''])).toEqual(['a', 'b']);
    });
});
