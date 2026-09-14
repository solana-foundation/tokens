import { describe, expect, test } from 'bun:test';

import type { PegTier } from '@tokens/asset-registry';

import { BadRequestError } from '@tokens/effect';

import type { CuratedMembershipSource } from './curatedMembershipReads';
import {
    advanceDepegState,
    buildDepegRow,
    depegJobs,
    reconcileStablecoinDepeg,
    refreshStablecoinStructuralHealth,
    utcDayString,
    type ClearSystemAdvisoryOutcome,
    type DepegCronDeps,
    type DepegLatestRow,
    type DepegListResult,
    type DepegReconcileResult,
    type DepegRepo,
    type DepegTierEventRow,
    type DepegTokenResult,
    type SetSystemAdvisoryOutcome,
    type StructuralHealthBatchEntry,
    type StructuralHealthDailyRow,
    type StructuralHealthLatestRow,
    type StructuralHealthRefreshResult,
    type WebacyDepegClient,
} from './crons.depeg';
import type { WebacyDepegItem } from './depegNormalize';
import { buildDepegReason, type ReconcilerAdvisory } from './depegReconciler';

const HOUR = 60 * 60_000;
const FIXED_NOW = 1_789_000_000_000;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDE = 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const STRANGER = 'Strangerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function item(address: string, tier: PegTier | null, overrides: Partial<WebacyDepegItem> = {}): WebacyDepegItem {
    const risk = tier === 'critical' ? 80 : tier === 'warning' ? 60 : tier === 'watch' ? 30 : 5;
    return {
        address,
        symbol: address === USDC ? 'USDC' : address === USDE ? 'USDe' : null,
        tier,
        overallRisk: risk,
        deviationPct: tier === 'ok' ? 0.01 : -2.5,
        priceUsd: tier === 'ok' ? 1.0001 : 0.975,
        pegUsd: 1,
        tags: tier === 'premium' ? ['premium'] : [],
        raw: { address, risk: { overallRisk: risk } },
        ...overrides,
    };
}

function prevRow(address: string, tier: PegTier | null, overrides: Partial<DepegLatestRow> = {}): DepegLatestRow {
    const bad = tier === 'warning' || tier === 'critical';
    return {
        chain: 'solana',
        address,
        ok: true,
        status: 200,
        symbol: null,
        tier,
        overallRisk: 5,
        deviationPct: 0,
        priceUsd: 1,
        pegUsd: 1,
        tags: null,
        prevTier: null,
        tierSinceAt: FIXED_NOW - 2 * HOUR,
        badSinceAt: bad ? FIXED_NOW - 2 * HOUR : null,
        observations: 3,
        inRegistry: true,
        lastSeenInListAt: FIXED_NOW - 4 * HOUR,
        lastSource: 'sweep',
        payloadJson: null,
        errorMessage: null,
        lastFetchedAt: FIXED_NOW - 4 * HOUR,
        lastOkAt: FIXED_NOW - 4 * HOUR,
        ...overrides,
    };
}

function systemAdvisory(mint: string, tier: 'warning' | 'critical'): ReconcilerAdvisory {
    return {
        mint,
        status: 'caution',
        reason: buildDepegReason({
            symbol: null,
            mint,
            tier,
            deviationPct: -2,
            pegUsd: 1,
            observedAt: FIXED_NOW - HOUR,
        }),
        source: 'webacy_depeg',
        managedBySystem: true,
        setAt: FIXED_NOW - HOUR,
        updatedAt: FIXED_NOW - HOUR,
    };
}

interface Recording {
    upserts: DepegLatestRow[][];
    tierEvents: DepegTierEventRow[][];
    sets: Array<{ mint: string; reason: string; nowMs: number; source: string }>;
    clears: Array<{ mint: string; note: string; nowMs: number; source: string }>;
    structuralLatest: StructuralHealthLatestRow[][];
    structuralDaily: StructuralHealthDailyRow[][];
    logs: Record<string, unknown>[];
    tokenCalls: string[];
    listCalls: Array<{ pageSize: number; maxPages: number }>;
    batchCalls: string[][];
}

interface Fixture {
    registry?: string[];
    currencies?: string[];
    prevRows?: DepegLatestRow[];
    advisories?: ReconcilerAdvisory[];
    adminClears?: Array<[string, number]>;
    tokenResults?: Record<string, DepegTokenResult>;
    listResult?: DepegListResult;
    setOutcome?: SetSystemAdvisoryOutcome;
    clearOutcome?: ClearSystemAdvisoryOutcome;
    structuralPrev?: StructuralHealthLatestRow[];
    structuralTargets?: string[];
    batchResponder?: (addresses: string[]) => StructuralHealthBatchEntry[];
    configured?: boolean;
    refreshEnabled?: boolean;
    dryRunDefault?: boolean;
    nowSequence?: number[];
}

function makeDeps(fx: Fixture = {}): { deps: DepegCronDeps; rec: Recording } {
    const rec: Recording = {
        upserts: [],
        tierEvents: [],
        sets: [],
        clears: [],
        structuralLatest: [],
        structuralDaily: [],
        logs: [],
        tokenCalls: [],
        listCalls: [],
        batchCalls: [],
    };
    const registry = new Set(fx.registry ?? [USDC, USDT, USDE, PYUSD]);
    const currencies = fx.currencies ?? [USDC, USDT, USDE, PYUSD];
    const nowSeq = [...(fx.nowSequence ?? [])];

    const curated: CuratedMembershipSource = {
        warmup: async () => {},
        getSnapshot: async () => ({
            loadedAt: FIXED_NOW,
            mintsByList: { majors: [], lsts: [], currencies, rwas: [], etfs: [], metals: [], stocks: [] },
            allMints: currencies,
            entriesByMint: Object.fromEntries(
                currencies.map(mint => [
                    mint,
                    { assetId: 'usd', listSlugs: ['currencies' as const], symbol: mint === USDC ? 'USDC' : null },
                ]),
            ),
        }),
        getAllCuratedMintsInOrder: () => currencies,
        getCuratedMintRank: () => new Map(),
        getListSlugsByMint: () => new Map(),
    };

    const webacyDepeg: WebacyDepegClient = {
        isConfigured: () => fx.configured ?? true,
        async fetchDepegToken({ address }) {
            rec.tokenCalls.push(address);
            return fx.tokenResults?.[address] ?? { ok: true, status: 200, item: item(address, 'ok') };
        },
        async fetchDepegList({ pageSize, maxPages }) {
            rec.listCalls.push({ pageSize, maxPages });
            return (
                fx.listResult ?? {
                    ok: true,
                    items: [
                        item(USDC, 'ok'),
                        item(USDT, 'ok'),
                        item(USDE, 'ok'),
                        item(PYUSD, 'ok'),
                        item(STRANGER, 'critical'),
                    ],
                    pages: 1,
                    truncated: false,
                }
            );
        },
        async fetchStructuralHealthBatch(addresses) {
            const list = addresses.map(a => a.address);
            rec.batchCalls.push(list);
            return fx.batchResponder
                ? fx.batchResponder(list)
                : list.map(address => ({
                      address,
                      ok: true,
                      status: 200,
                      data: { composite_grade: 'A', composite_score: 12, categories: {} },
                  }));
        },
    };

    const repo: DepegRepo = {
        async listDepegLatest() {
            return fx.prevRows ?? [];
        },
        async upsertDepegLatest(rows) {
            rec.upserts.push([...rows]);
        },
        async insertDepegTierEvents(rows) {
            rec.tierEvents.push([...rows]);
        },
        async listActiveSolanaVariantMints(mints) {
            const out = new Map<string, { assetId: string; symbol: string | null }>();
            for (const mint of mints)
                if (registry.has(mint)) out.set(mint, { assetId: 'usd', symbol: mint === USDE ? 'USDe' : null });
            return out;
        },
        async listAdvisoriesForReconcile(mints) {
            return (fx.advisories ?? []).filter(a => mints.includes(a.mint));
        },
        async listLastAdminClearAtByMints() {
            return new Map(fx.adminClears ?? []);
        },
        async setSystemAdvisory(args) {
            rec.sets.push(args);
            return fx.setOutcome ?? 'set';
        },
        async clearSystemAdvisory(args) {
            rec.clears.push(args);
            return fx.clearOutcome ?? 'cleared';
        },
        async upsertStructuralHealthLatest(rows) {
            rec.structuralLatest.push([...rows]);
        },
        async upsertStructuralHealthDaily(rows) {
            rec.structuralDaily.push([...rows]);
        },
        async listStructuralHealthLatest() {
            return fx.structuralPrev ?? [];
        },
        async listStructuralTargets() {
            return fx.structuralTargets ?? [];
        },
    };

    const deps: DepegCronDeps = {
        webacyDepeg,
        repo,
        curated,
        now: () => (nowSeq.length > 0 ? nowSeq.shift()! : FIXED_NOW),
        isRefreshEnabled: () => fx.refreshEnabled ?? true,
        isDryRunDefault: () => fx.dryRunDefault ?? true,
        log: line => rec.logs.push(line),
    };
    return { deps, rec };
}

function events(rec: Recording, name: string): Record<string, unknown>[] {
    return rec.logs.filter(l => l.event === name);
}

async function reconcile(deps: DepegCronDeps, args: unknown): Promise<DepegReconcileResult> {
    return (await reconcileStablecoinDepeg(deps, args)) as DepegReconcileResult;
}

describe('advanceDepegState', () => {
    test('first observation starts a streak and reports a change', () => {
        const out = advanceDepegState(null, 'warning', FIXED_NOW);
        expect(out).toEqual({
            prevTier: null,
            tierSinceAt: FIXED_NOW,
            badSinceAt: FIXED_NOW,
            observations: 1,
            changed: true,
        });
    });

    test('same tier keeps both anchors and counts the observation', () => {
        const prev = { tier: 'warning' as const, tierSinceAt: 1, badSinceAt: 1, observations: 4 };
        expect(advanceDepegState(prev, 'warning', FIXED_NOW)).toEqual({
            prevTier: null,
            tierSinceAt: 1,
            badSinceAt: 1,
            observations: 5,
            changed: false,
        });
    });

    test('warning -> critical keeps badSinceAt (one episode) but restarts tierSinceAt', () => {
        const prev = { tier: 'warning' as const, tierSinceAt: 1, badSinceAt: 1, observations: 4 };
        expect(advanceDepegState(prev, 'critical', FIXED_NOW)).toEqual({
            prevTier: 'warning',
            tierSinceAt: FIXED_NOW,
            badSinceAt: 1,
            observations: 1,
            changed: true,
        });
    });

    test('critical -> ok clears badSinceAt', () => {
        const prev = { tier: 'critical' as const, tierSinceAt: 1, badSinceAt: 1, observations: 4 };
        expect(advanceDepegState(prev, 'ok', FIXED_NOW).badSinceAt).toBeNull();
    });

    test('ok -> warning opens a new episode at now', () => {
        const prev = { tier: 'ok' as const, tierSinceAt: 1, badSinceAt: null, observations: 4 };
        expect(advanceDepegState(prev, 'warning', FIXED_NOW).badSinceAt).toBe(FIXED_NOW);
    });
});

describe('buildDepegRow', () => {
    test('a failed fetch keeps the last good tier, bumps last_fetched_at and does not advance last_ok_at', () => {
        const prev = prevRow(USDE, 'critical', { lastOkAt: FIXED_NOW - 4 * HOUR, lastFetchedAt: FIXED_NOW - 4 * HOUR });
        const { row, event } = buildDepegRow({
            prev,
            address: USDE,
            result: { ok: false, status: 503, message: 'upstream' },
            registrySymbol: 'USDe',
            inRegistry: true,
            seenInList: false,
            source: 'webhook',
            webhookEventId: 'evt_1',
            now: FIXED_NOW,
        });
        expect(event).toBeNull();
        expect(row.ok).toBe(false);
        expect(row.tier).toBe('critical');
        expect(row.badSinceAt).toBe(prev.badSinceAt);
        expect(row.errorMessage).toBe('upstream');
        expect(row.lastFetchedAt).toBe(FIXED_NOW);
        expect(row.lastOkAt).toBe(FIXED_NOW - 4 * HOUR);
    });

    test('a successful fetch stamps last_ok_at = last_fetched_at = now', () => {
        const { row } = buildDepegRow({
            prev: null,
            address: USDE,
            result: { ok: true, status: 200, item: item(USDE, 'ok') },
            registrySymbol: null,
            inRegistry: true,
            seenInList: true,
            source: 'sweep',
            webhookEventId: null,
            now: FIXED_NOW,
        });
        expect(row.lastOkAt).toBe(FIXED_NOW);
        expect(row.lastFetchedAt).toBe(FIXED_NOW);
        expect(row.lastSeenInListAt).toBe(FIXED_NOW);
    });
});

describe('reconcile-stablecoin-depeg gates and args', () => {
    test('is registered under both job names', () => {
        expect(Object.keys(depegJobs).sort()).toEqual([
            'reconcile-stablecoin-depeg',
            'refresh-stablecoin-structural-health',
        ]);
    });

    test('returns disabled when the refresh flag is off and touches nothing', async () => {
        const { deps, rec } = makeDeps({ refreshEnabled: false });
        const out = await reconcile(deps, {});
        expect(out).toMatchObject({ ok: true, disabled: true, reason: 'depeg_refresh_disabled', dryRun: true });
        expect(rec.listCalls).toHaveLength(0);
        expect(rec.upserts).toHaveLength(0);
    });

    test('requireRefreshEnabled: false bypasses the flag', async () => {
        const { deps, rec } = makeDeps({ refreshEnabled: false });
        const out = await reconcile(deps, { requireRefreshEnabled: false });
        expect(out.disabled).toBeUndefined();
        expect(rec.listCalls).toHaveLength(1);
    });

    test('returns webacy_not_configured without a key', async () => {
        const { deps, rec } = makeDeps({ configured: false });
        const out = await reconcile(deps, {});
        expect(out).toMatchObject({ ok: true, disabled: true, reason: 'webacy_not_configured' });
        expect(rec.listCalls).toHaveLength(0);
    });

    test('rejects an unknown trigger and a non-boolean dryRun with BadRequestError', async () => {
        const { deps } = makeDeps();
        await expect(reconcile(deps, { trigger: 'cron' })).rejects.toBeInstanceOf(BadRequestError);
        await expect(reconcile(deps, { dryRun: 'yes' })).rejects.toBeInstanceOf(BadRequestError);
        await expect(reconcile(deps, { mints: 'USDC' })).rejects.toBeInstanceOf(BadRequestError);
    });

    test('dryRun defaults from the env seam and every log line carries the contract fields', async () => {
        const { deps, rec } = makeDeps({ dryRunDefault: false });
        const out = await reconcile(deps, {});
        expect(out.dryRun).toBe(false);
        expect(out.mode).toBe('sweep');
        for (const line of rec.logs) {
            expect(line.event).toBeString();
            expect(line.job).toBe('reconcile-stablecoin-depeg');
            expect(line.trigger).toBe('sweep');
            expect(line.dry_run).toBe(false);
        }
        expect(events(rec, 'depeg_poll_summary')).toHaveLength(1);
    });
});

describe('reconcile-stablecoin-depeg targeted mode', () => {
    test('webhook nudge fetches one token, writes a tier event with source webhook + event id, and skips the shrink guard', async () => {
        const { deps, rec } = makeDeps({
            prevRows: [prevRow(USDE, 'ok')],
            tokenResults: { [USDE]: { ok: true, status: 200, item: item(USDE, 'critical') } },
            dryRunDefault: false,
        });
        const out = await reconcile(deps, { mints: [USDE], trigger: 'webhook', webhookEventId: 'evt_123' });

        expect(out.mode).toBe('targeted');
        expect(rec.tokenCalls).toEqual([USDE]);
        expect(rec.listCalls).toHaveLength(0);
        expect(out.circuit).toBeNull();

        expect(rec.tierEvents).toHaveLength(1);
        expect(rec.tierEvents[0]![0]).toMatchObject({
            address: USDE,
            oldTier: 'ok',
            newTier: 'critical',
            source: 'webhook',
            webhookEventId: 'evt_123',
            observedAt: FIXED_NOW,
        });
        expect(rec.upserts[0]![0]).toMatchObject({
            address: USDE,
            tier: 'critical',
            lastSource: 'webhook',
            badSinceAt: FIXED_NOW,
            symbol: 'USDe',
        });

        const changed = events(rec, 'depeg_tier_changed');
        expect(changed).toHaveLength(1);
        expect(changed[0]).toMatchObject({
            source: 'webhook',
            new_tier: 'critical',
            old_tier: 'ok',
            mint: USDE,
            trigger: 'webhook',
        });

        // critical on first sight -> set, applied because dryRun is off
        expect(rec.sets).toHaveLength(1);
        expect(rec.sets[0]!.mint).toBe(USDE);
        expect(rec.sets[0]!.reason).toContain('USDe Critical: trading 2.50% below its $1 peg');
        expect(out.actionsSet).toBe(1);
        expect(events(rec, 'depeg_advisory_set')).toHaveLength(1);
    });

    test('trigger defaults to manual for targeted runs', async () => {
        const { deps, rec } = makeDeps();
        const out = await reconcile(deps, { mints: [USDC] });
        expect(out.mode).toBe('targeted');
        expect(rec.logs.every(l => l.trigger === 'manual')).toBe(true);
        expect(rec.upserts[0]![0]!.lastSource).toBe('manual');
    });

    test('dryRun writes the snapshot and tier event but logs would_set instead of writing an advisory', async () => {
        const { deps, rec } = makeDeps({
            tokenResults: { [USDE]: { ok: true, status: 200, item: item(USDE, 'critical') } },
        });
        const out = await reconcile(deps, { mints: [USDE], trigger: 'webhook' });
        expect(out.dryRun).toBe(true);
        expect(rec.upserts).toHaveLength(1);
        expect(rec.tierEvents).toHaveLength(1);
        expect(rec.sets).toHaveLength(0);
        expect(rec.clears).toHaveLength(0);
        expect(events(rec, 'depeg_advisory_would_set')).toHaveLength(1);
        expect(events(rec, 'depeg_advisory_set')).toHaveLength(0);
        expect(out.actionsSet).toBe(0);
    });

    test('dryRun logs would_clear for a recovered system advisory', async () => {
        const { deps, rec } = makeDeps({
            prevRows: [prevRow(USDE, 'ok', { tierSinceAt: FIXED_NOW - 7 * HOUR })],
            advisories: [systemAdvisory(USDE, 'warning')],
        });
        await reconcile(deps, { mints: [USDE] });
        expect(events(rec, 'depeg_advisory_would_clear')).toHaveLength(1);
        expect(rec.clears).toHaveLength(0);
    });

    test('a nudge for a mint we do not list is skipped without a fetch', async () => {
        const { deps, rec } = makeDeps({ registry: [USDC], currencies: [USDC] });
        const out = await reconcile(deps, { mints: [STRANGER], trigger: 'webhook' });
        expect(rec.tokenCalls).toHaveLength(0);
        expect(out.skipped.not_in_registry).toBe(1);
        expect(events(rec, 'depeg_advisory_skipped')[0]).toMatchObject({ mint: STRANGER, why: 'not_in_registry' });
    });

    test('a failed targeted fetch is cached with ok=false, keeps last_ok_at, never clears, and returns ok:false', async () => {
        const { deps, rec } = makeDeps({
            prevRows: [prevRow(USDE, 'ok', { tierSinceAt: FIXED_NOW - 24 * HOUR, lastOkAt: FIXED_NOW - 4 * HOUR })],
            advisories: [systemAdvisory(USDE, 'critical')],
            tokenResults: { [USDE]: { ok: false, status: 502, message: 'bad gateway' } },
            dryRunDefault: false,
        });
        const out = await reconcile(deps, { mints: [USDE], trigger: 'webhook' });
        expect(out.ok).toBe(false);
        expect(events(rec, 'depeg_poll_failed')).toHaveLength(1);
        expect(rec.upserts[0]![0]).toMatchObject({
            ok: false,
            status: 502,
            errorMessage: 'bad gateway',
            tier: 'ok',
            lastFetchedAt: FIXED_NOW,
            lastOkAt: FIXED_NOW - 4 * HOUR,
        });
        expect(rec.clears).toHaveLength(0);
    });

    test('a mixed targeted run with one failure stays ok:true and skips the failed mint as no_observation', async () => {
        const { deps, rec } = makeDeps({
            tokenResults: {
                [USDE]: { ok: false, status: 500, message: 'boom' },
                [USDC]: { ok: true, status: 200, item: item(USDC, 'ok') },
            },
        });
        const out = await reconcile(deps, { mints: [USDE, USDC] });
        expect(out.ok).toBe(true);
        expect(out.skipped.no_observation).toBe(1);
        expect(out.skipped.unchanged).toBe(1);
        expect(rec.upserts[0]).toHaveLength(2);
    });

    test('warning -> critical on an existing system row updates the reason', async () => {
        const { deps, rec } = makeDeps({
            prevRows: [prevRow(USDE, 'warning')],
            advisories: [systemAdvisory(USDE, 'warning')],
            tokenResults: { [USDE]: { ok: true, status: 200, item: item(USDE, 'critical') } },
            setOutcome: 'updated',
            dryRunDefault: false,
        });
        const out = await reconcile(deps, { mints: [USDE], trigger: 'webhook' });
        expect(rec.sets).toHaveLength(1);
        expect(out.actionsUpdated).toBe(1);
        expect(events(rec, 'depeg_advisory_updated')).toHaveLength(1);
        // Episode anchor survives the flip.
        expect(rec.upserts[0]![0]!.badSinceAt).toBe(FIXED_NOW - 2 * HOUR);
    });

    test('a human-owned row reported by the repo is logged as skipped, not counted as set', async () => {
        const { deps, rec } = makeDeps({
            tokenResults: { [USDE]: { ok: true, status: 200, item: item(USDE, 'critical') } },
            setOutcome: 'skipped_human_owned',
            dryRunDefault: false,
        });
        const out = await reconcile(deps, { mints: [USDE] });
        expect(out.actionsSet).toBe(0);
        expect(events(rec, 'depeg_advisory_skipped').at(-1)).toMatchObject({ mint: USDE, why: 'skipped_human_owned' });
    });
});

describe('reconcile-stablecoin-depeg sweep mode', () => {
    test('stores only tracked tokens, flags registry membership, counts tiers, logs coverage gaps and a summary', async () => {
        const { deps, rec } = makeDeps({
            currencies: [USDC, USDT, USDE, PYUSD, 'MissingFromWebacyxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
        });
        const out = await reconcile(deps, { trigger: 'sweep' });
        expect(out.mode).toBe('sweep');
        expect(out.tokensReturned).toBe(5);
        expect(out.tracked).toBe(4);
        expect(rec.listCalls).toEqual([{ pageSize: 200, maxPages: 4 }]);
        expect(rec.upserts[0]!.map(r => r.address).sort()).toEqual([USDC, USDT, USDE, PYUSD].sort());
        expect(
            rec.upserts[0]!.every(r => r.inRegistry && r.lastSource === 'sweep' && r.lastSeenInListAt === FIXED_NOW),
        ).toBe(true);
        expect(out.tierCounts.ok).toBe(4);
        // First sight of every token is a tier event (null -> ok) but not a "flip".
        expect(out.tierChanges).toBe(4);
        expect(rec.tierEvents[0]!.every(e => e.oldTier === null && e.source === 'sweep')).toBe(true);
        const gap = events(rec, 'depeg_coverage_gap');
        expect(gap).toHaveLength(1);
        expect(gap[0]).toMatchObject({ count: 1, mints: ['MissingFromWebacyxxxxxxxxxxxxxxxxxxxxxxxxxxx'] });
        expect(events(rec, 'depeg_poll_summary')[0]).toMatchObject({ tokens_returned: 5, tracked: 4, circuit: null });
    });

    test('an upstream list failure returns ok:false and logs depeg_poll_failed', async () => {
        const { deps, rec } = makeDeps({ listResult: { ok: false, status: 503, message: 'down' } });
        const out = await reconcile(deps, {});
        expect(out.ok).toBe(false);
        expect(rec.upserts).toHaveLength(0);
        expect(events(rec, 'depeg_poll_failed')[0]).toMatchObject({ status: 503 });
    });

    test('circuit A: a suspicious drop in covered tokens skips all writes and the reconciler', async () => {
        const prev = [USDC, USDT, USDE, PYUSD, 'Fifthxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'].map(a =>
            prevRow(a, 'ok'),
        );
        const { deps, rec } = makeDeps({
            prevRows: prev,
            registry: prev.map(r => r.address),
            listResult: { ok: true, items: [item(USDC, 'ok'), item(USDT, 'ok')], pages: 1, truncated: false },
            advisories: [systemAdvisory(USDE, 'critical')],
            dryRunDefault: false,
        });
        const out = await reconcile(deps, {});
        expect(out.ok).toBe(true);
        expect(out.circuit).toBe('suspicious_drop');
        expect(rec.upserts).toHaveLength(0);
        expect(rec.tierEvents).toHaveLength(0);
        expect(rec.clears).toHaveLength(0);
        expect(events(rec, 'depeg_circuit_open')[0]).toMatchObject({
            reason: 'suspicious_drop',
            previously_covered: 5,
            covered_now: 2,
        });
        expect(events(rec, 'depeg_poll_summary')).toHaveLength(1);
    });

    test('circuit A can be overridden with ignoreCircuitBreaker and still logs the missing tokens', async () => {
        const prev = [USDC, USDT, USDE, PYUSD, 'Fifthxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'].map(a =>
            prevRow(a, 'ok'),
        );
        const { deps, rec } = makeDeps({
            prevRows: prev,
            registry: prev.map(r => r.address),
            listResult: { ok: true, items: [item(USDC, 'ok'), item(USDT, 'ok')], pages: 1, truncated: false },
        });
        const out = await reconcile(deps, { ignoreCircuitBreaker: true });
        expect(out.circuit).toBeNull();
        expect(rec.upserts[0]).toHaveLength(2);
        expect(events(rec, 'depeg_tracked_token_missing')).toHaveLength(3);
        expect(out.skipped.missing_from_list).toBe(3);
    });

    test('circuit B: a mass tier flip persists snapshots and events but takes zero advisory actions', async () => {
        const { deps, rec } = makeDeps({
            prevRows: [prevRow(USDC, 'ok'), prevRow(USDT, 'ok'), prevRow(USDE, 'ok'), prevRow(PYUSD, 'ok')],
            listResult: {
                ok: true,
                items: [item(USDC, 'critical'), item(USDT, 'critical'), item(USDE, 'ok'), item(PYUSD, 'ok')],
                pages: 1,
                truncated: false,
            },
            dryRunDefault: false,
        });
        const out = await reconcile(deps, {});
        expect(out.circuit).toBe('mass_tier_flip');
        expect(rec.upserts).toHaveLength(1);
        expect(rec.tierEvents[0]).toHaveLength(2);
        expect(events(rec, 'depeg_tier_changed')).toHaveLength(2);
        expect(rec.sets).toHaveLength(0);
        expect(out.actionsSet).toBe(0);
        expect(events(rec, 'depeg_circuit_open')[0]).toMatchObject({ reason: 'mass_tier_flip', flips: 2, tracked: 4 });
    });

    test('circuit B ignores first-sight transitions (no previous tier)', async () => {
        const { deps } = makeDeps({
            listResult: {
                ok: true,
                items: [
                    item(USDC, 'critical'),
                    item(USDT, 'critical'),
                    item(USDE, 'critical'),
                    item(PYUSD, 'critical'),
                ],
                pages: 1,
                truncated: false,
            },
        });
        const out = await reconcile(deps, {});
        expect(out.circuit).toBeNull();
        expect(out.tierChanges).toBe(4);
    });

    test('circuit C: more actions than maxActionsPerRun applies the cap and logs mass_action', async () => {
        const { deps, rec } = makeDeps({
            listResult: {
                ok: true,
                items: [item(USDC, 'critical'), item(USDT, 'critical'), item(USDE, 'warning'), item(PYUSD, 'warning')],
                pages: 1,
                truncated: false,
            },
            dryRunDefault: false,
        });
        const out = await reconcile(deps, { maxActionsPerRun: 2 });
        expect(out.circuit).toBe('mass_action');
        expect(rec.sets.map(s => s.mint).sort()).toEqual([USDC, USDT].sort());
        expect(out.skipped.max_actions_exceeded).toBe(2);
    });

    test('tier state advances across two runs and the second run performs the cooldown clear', async () => {
        // Run 1: USDE goes ok -> warning; USDC recovered 3h ago (no clear yet).
        const first = makeDeps({
            prevRows: [prevRow(USDE, 'ok'), prevRow(USDC, 'ok', { tierSinceAt: FIXED_NOW - 3 * HOUR })],
            advisories: [systemAdvisory(USDC, 'warning')],
            listResult: { ok: true, items: [item(USDE, 'warning'), item(USDC, 'ok')], pages: 1, truncated: false },
            dryRunDefault: false,
        });
        const out1 = await reconcile(first.deps, {});
        const usdeRow = first.rec.upserts[0]!.find(r => r.address === USDE)!;
        expect(usdeRow).toMatchObject({
            tier: 'warning',
            prevTier: 'ok',
            tierSinceAt: FIXED_NOW,
            badSinceAt: FIXED_NOW,
            observations: 1,
        });
        const usdcRow = first.rec.upserts[0]!.find(r => r.address === USDC)!;
        expect(usdcRow).toMatchObject({ tier: 'ok', tierSinceAt: FIXED_NOW - 3 * HOUR, observations: 4 });
        expect(out1.actionsSet).toBe(1);
        expect(out1.skipped.cooldown_pending).toBe(1);

        // Run 2, four hours later, feeding run 1's rows back in.
        const later = FIXED_NOW + 4 * HOUR;
        const second = makeDeps({
            prevRows: first.rec.upserts[0]!,
            advisories: [systemAdvisory(USDC, 'warning'), systemAdvisory(USDE, 'warning')],
            listResult: { ok: true, items: [item(USDE, 'warning'), item(USDC, 'ok')], pages: 1, truncated: false },
            dryRunDefault: false,
        });
        second.deps.now = () => later;
        const out2 = await reconcile(second.deps, {});
        const usdeRow2 = second.rec.upserts[0]!.find(r => r.address === USDE)!;
        expect(usdeRow2).toMatchObject({
            tier: 'warning',
            tierSinceAt: FIXED_NOW,
            badSinceAt: FIXED_NOW,
            observations: 2,
        });
        expect(out2.tierChanges).toBe(0);
        expect(out2.skipped.unchanged).toBe(1);
        expect(second.rec.clears).toEqual([{ mint: USDC, note: 'Webacy tier ok for 7h', nowMs: later, source: 'webacy_depeg' }]);
        expect(out2.actionsCleared).toBe(1);
        expect(events(second.rec, 'depeg_advisory_cleared')).toHaveLength(1);
    });

    test('a truncated list is logged and reported', async () => {
        const { deps, rec } = makeDeps({
            listResult: { ok: true, items: [item(USDC, 'ok')], pages: 3, truncated: true },
        });
        const out = await reconcile(deps, { maxPages: 4 });
        expect(out.truncated).toBe(true);
        expect(events(rec, 'depeg_list_truncated')[0]).toMatchObject({ pages: 3 });
    });

    test('an admin clear during the episode suppresses re-flagging in the sweep', async () => {
        const { deps, rec } = makeDeps({
            prevRows: [prevRow(USDE, 'critical', { badSinceAt: FIXED_NOW - 3 * HOUR })],
            adminClears: [[USDE, FIXED_NOW - HOUR]],
            listResult: { ok: true, items: [item(USDE, 'critical')], pages: 1, truncated: false },
            dryRunDefault: false,
        });
        const out = await reconcile(deps, {});
        expect(rec.sets).toHaveLength(0);
        expect(out.skipped.suppressed_by_human_clear).toBe(1);
    });
});

describe('refresh-stablecoin-structural-health', () => {
    async function refresh(deps: DepegCronDeps, args: unknown): Promise<StructuralHealthRefreshResult> {
        return (await refreshStablecoinStructuralHealth(deps, args)) as StructuralHealthRefreshResult;
    }

    test('utcDayString keys by UTC date', () => {
        expect(utcDayString(Date.UTC(2026, 8, 13, 23, 59))).toBe('2026-09-13');
        expect(utcDayString(Date.UTC(2026, 8, 14, 0, 0))).toBe('2026-09-14');
    });

    test('honours the refresh flag and the key gate', async () => {
        const off = makeDeps({ refreshEnabled: false });
        expect(await refresh(off.deps, {})).toMatchObject({ disabled: true, reason: 'depeg_refresh_disabled' });
        const noKey = makeDeps({ configured: false });
        expect(await refresh(noKey.deps, {})).toMatchObject({ disabled: true, reason: 'webacy_not_configured' });
        expect(off.rec.batchCalls).toHaveLength(0);
        expect(noKey.rec.batchCalls).toHaveLength(0);
    });

    test('targets are depeg in_registry addresses union currencies, deduped and chunked by batchSize', async () => {
        const { deps, rec } = makeDeps({ structuralTargets: [USDC, STRANGER], currencies: [USDC, USDT, USDE] });
        const out = await refresh(deps, { batchSize: 2 });
        expect(out.targets).toBe(4);
        expect(rec.batchCalls).toEqual([
            [USDC, STRANGER],
            [USDT, USDE],
        ]);
        expect(out.succeeded).toBe(4);
        expect(out.ok).toBe(true);
    });

    test('writes _latest and _daily (UTC day) rows with normalised categories and logs grade changes with steps', async () => {
        const { deps, rec } = makeDeps({
            structuralTargets: [USDC],
            // USDC is both a depeg target and a currencies member: deduped to one target.
            currencies: [USDC],
            structuralPrev: [
                {
                    chain: 'solana',
                    address: USDC,
                    ok: true,
                    status: 200,
                    compositeGrade: 'A',
                    compositeScore: 10,
                    categoryScores: null,
                    criteriaFailCount: 0,
                    criteriaWarnCount: 0,
                    payloadJson: null,
                    errorMessage: null,
                    lastFetchedAt: FIXED_NOW - 24 * HOUR,
                    lastOkAt: FIXED_NOW - 24 * HOUR,
                },
            ],
            batchResponder: list =>
                list.map(address => ({
                    address,
                    ok: true,
                    status: 200,
                    data: {
                        structural_health: {
                            composite_grade: 'B+',
                            composite_score: 31.2,
                            categories: {
                                asset_collateral: {
                                    score: 20,
                                    weight: 30,
                                    criteria: [{ status: 'pass' }, { status: 'warn' }],
                                },
                                market_liquidity: { score: 40, weight: 0.25, status: 'fail' },
                            },
                        },
                    },
                })),
        });
        const out = await refresh(deps, {});
        expect(out.targets).toBe(1);
        expect(out.gradeChanges).toBe(1);
        const latest = rec.structuralLatest[0]![0]!;
        expect(latest).toMatchObject({
            address: USDC,
            ok: true,
            compositeGrade: 'B+',
            compositeScore: 31.2,
            // One pass + one warn criterion seen: counts become concrete (0 fails, 1 warn).
            criteriaFailCount: 0,
            criteriaWarnCount: 1,
            lastFetchedAt: FIXED_NOW,
            lastOkAt: FIXED_NOW,
        });
        expect(latest.categoryScores!.asset_collateral).toEqual({ score: 20, weight: 0.3, status: 'warn' });
        expect(latest.categoryScores!.market_liquidity).toEqual({ score: 40, weight: 0.25, status: 'fail' });
        expect(latest.categoryScores!.smart_contract).toEqual({ score: null, weight: null, status: 'unknown' });
        expect(rec.structuralDaily[0]![0]).toMatchObject({
            address: USDC,
            day: utcDayString(FIXED_NOW),
            compositeGrade: 'B+',
            recordedAt: FIXED_NOW,
        });
        const changed = events(rec, 'structural_health_grade_changed');
        expect(changed).toHaveLength(1);
        // A -> B+ is two steps towards F in STRUCTURAL_GRADES.
        expect(changed[0]).toMatchObject({
            mint: USDC,
            old_grade: 'A',
            new_grade: 'B+',
            old_score: 10,
            new_score: 31.2,
            steps: 2,
            symbol: 'USDC',
        });
        expect(events(rec, 'structural_health_refreshed')[0]).toMatchObject({
            ok: true,
            succeeded: 1,
            failed: 0,
            grade_changes: 1,
        });
    });

    test('per-token failures are cached with ok=false and the previous grade, without a daily row or a stale last_ok_at bump', async () => {
        const { deps, rec } = makeDeps({
            structuralTargets: [USDC, USDT],
            currencies: [],
            structuralPrev: [
                {
                    chain: 'solana',
                    address: USDT,
                    ok: true,
                    status: 200,
                    compositeGrade: 'A-',
                    compositeScore: 15,
                    categoryScores: null,
                    criteriaFailCount: null,
                    criteriaWarnCount: null,
                    payloadJson: '{}',
                    errorMessage: null,
                    lastFetchedAt: FIXED_NOW - 24 * HOUR,
                    lastOkAt: FIXED_NOW - 24 * HOUR,
                },
            ],
            batchResponder: list =>
                list.map(address =>
                    address === USDT
                        ? { address, ok: false, status: 429, message: 'rate limited' }
                        : { address, ok: true, status: 200, data: { grade: 'A', score: 9 } },
                ),
        });
        const out = await refresh(deps, {});
        expect(out).toMatchObject({ ok: true, succeeded: 1, failed: 1 });
        const usdt = rec.structuralLatest[0]!.find(r => r.address === USDT)!;
        expect(usdt).toMatchObject({
            ok: false,
            status: 429,
            errorMessage: 'rate limited',
            compositeGrade: 'A-',
            compositeScore: 15,
            lastFetchedAt: FIXED_NOW,
            lastOkAt: FIXED_NOW - 24 * HOUR,
        });
        expect(rec.structuralDaily[0]!.map(r => r.address)).toEqual([USDC]);
        // Unchanged grade for USDT: no grade_changed line for it.
        expect(events(rec, 'structural_health_grade_changed').map(l => l.mint)).toEqual([USDC]);
    });

    test('returns ok:false only when every token failed', async () => {
        const { deps } = makeDeps({
            structuralTargets: [USDC],
            currencies: [USDT],
            batchResponder: list => list.map(address => ({ address, ok: false, status: 500, message: 'boom' })),
        });
        const out = await refresh(deps, {});
        expect(out.ok).toBe(false);
        expect(out.failed).toBe(2);
    });

    test('an address missing from the batch response is recorded as a failure', async () => {
        const { deps, rec } = makeDeps({
            structuralTargets: [USDC, USDT],
            currencies: [],
            batchResponder: list =>
                list.filter(a => a === USDC).map(address => ({ address, ok: true, status: 200, data: { grade: 'A' } })),
        });
        const out = await refresh(deps, {});
        expect(out.failed).toBe(1);
        expect(rec.structuralLatest[0]!.find(r => r.address === USDT)).toMatchObject({
            ok: false,
            errorMessage: 'missing from batch response',
        });
    });
});
