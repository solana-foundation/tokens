import { describe, expect, test } from 'bun:test';

import type { PegTier } from '@tokens/asset-registry';

import { BadRequestError } from '@tokens/effect';

import type { BirdeyeMultiPriceEntry, BirdeyeMultiPriceResult } from '../clients';
import type {
    PegGuardCurrencyVariant,
    PegGuardLatestRow,
    PegGuardMarketFallback,
    PegGuardRepo,
    PegGuardTierEventRow,
} from '../db/pegGuard';
import {
    depegJobs,
    type DepegCronDeps,
    type DepegLatestRow,
    type DepegRepo,
    type WebacyDepegClient,
} from './crons.depeg';
import { buildPegGuardRow, refreshPegGuard, type PegGuardRefreshResult } from './crons.pegGuard';
import type { CuratedMembershipSource } from './curatedMembershipReads';
import { buildDepegReason, type ReconcilerAdvisory } from './depegReconciler';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FIXED_NOW = 1_789_000_000_000;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDE = 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT';
const USDY = 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6';
const EURC = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
const TRYB = 'A94X2fRy3wydNShU4dRaDyap2UuoeWJGWyATtyp61WZf';
const BUIDL = 'GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr';

const DEFAULT_CURRENCIES = [USDC, USDT, USDE, USDY, EURC, TRYB, BUIDL];
const USD_MINTS = [USDC, USDT, USDE, USDY];

const VARIANTS: Record<string, PegGuardCurrencyVariant> = {
    [USDC]: { assetId: 'usd', variantId: 'usd:usdc', symbol: 'USDC', kind: 'native', isActive: true },
    [USDT]: { assetId: 'usd', variantId: 'usd:usdt', symbol: 'USDT', kind: 'native', isActive: true },
    [USDE]: { assetId: 'usd', variantId: 'usd:usde', symbol: 'USDe', kind: 'native', isActive: true },
    [USDY]: { assetId: 'usd', variantId: 'usd:usdy', symbol: 'USDY', kind: 'yield', isActive: true },
    [EURC]: { assetId: 'eur', variantId: 'eur:eurc', symbol: 'EURC', kind: 'native', isActive: true },
    [TRYB]: { assetId: 'tryb', variantId: 'tryb:mint', symbol: 'TRYB', kind: 'stablecoin', isActive: true },
    [BUIDL]: { assetId: 'buidl', variantId: 'buidl:mint', symbol: 'BUIDL', kind: 'stablecoin', isActive: true },
};

function entry(
    mint: string,
    priceUsd: number,
    overrides: Partial<BirdeyeMultiPriceEntry> = {},
): BirdeyeMultiPriceEntry {
    return {
        mint,
        priceUsd,
        updatedAt: FIXED_NOW - 10_000,
        liquidityUsd: 5_000_000,
        isScaledUiToken: false,
        ...overrides,
    };
}

function webacyRow(address: string, tier: PegTier | null, overrides: Partial<DepegLatestRow> = {}): DepegLatestRow {
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
        badSinceAt: null,
        observations: 3,
        inRegistry: true,
        lastSeenInListAt: FIXED_NOW - HOUR,
        lastSource: 'sweep',
        payloadJson: null,
        errorMessage: null,
        lastFetchedAt: FIXED_NOW - HOUR,
        lastOkAt: FIXED_NOW - HOUR,
        ...overrides,
    };
}

function pegRow(address: string, tier: PegTier | null, overrides: Partial<PegGuardLatestRow> = {}): PegGuardLatestRow {
    const bad = tier === 'warning' || tier === 'critical';
    return {
        chain: 'solana',
        address,
        symbol: VARIANTS[address]?.symbol ?? null,
        pegCurrency: 'USD',
        pegUsd: 1,
        priceUsd: bad ? 0.98 : 1,
        liquidityUsd: 5_000_000,
        deviationPct: bad ? -2 : 0,
        tier,
        prevTier: null,
        tierSinceAt: FIXED_NOW - 2 * HOUR,
        badSinceAt: bad ? FIXED_NOW - 2 * HOUR : null,
        observations: 3,
        ok: true,
        errorMessage: null,
        priceSource: 'birdeye_multi_price',
        priceUpdatedAt: FIXED_NOW - 5 * MINUTE - 10_000,
        lastFetchedAt: FIXED_NOW - 5 * MINUTE,
        lastOkAt: FIXED_NOW - 5 * MINUTE,
        ...overrides,
    };
}

function advisory(
    mint: string,
    tier: 'warning' | 'critical',
    source: 'webacy_depeg' | 'peg_guard',
): ReconcilerAdvisory {
    return {
        mint,
        status: 'caution',
        reason: buildDepegReason({
            symbol: VARIANTS[mint]?.symbol ?? null,
            mint,
            tier,
            deviationPct: -2,
            pegUsd: 1,
            observedAt: FIXED_NOW - HOUR,
            observer: source === 'peg_guard' ? 'peg_guard' : 'webacy',
            liquidityUsd: 5_000_000,
        }),
        source,
        managedBySystem: true,
        setAt: FIXED_NOW - HOUR,
        updatedAt: FIXED_NOW - HOUR,
    };
}

interface Recording {
    upserts: PegGuardLatestRow[][];
    tierEvents: PegGuardTierEventRow[][];
    sets: Array<{ mint: string; reason: string; nowMs: number; source: string }>;
    clears: Array<{ mint: string; note: string; nowMs: number; source: string }>;
    logs: Record<string, unknown>[];
    multiCalls: string[][];
    fallbackCalls: string[][];
    variantCalls: string[][];
    webacyListCalls: number;
}

interface Fixture {
    currencies?: string[];
    variants?: Record<string, PegGuardCurrencyVariant>;
    /** Seed for the in-memory peg_guard_latest table. */
    prevRows?: PegGuardLatestRow[];
    webacyRows?: DepegLatestRow[];
    advisories?: ReconcilerAdvisory[];
    adminClears?: Array<[string, number]>;
    /** Per-mint Birdeye entries; mints absent here are reported `missing`. */
    prices?: Record<string, BirdeyeMultiPriceEntry>;
    /** Overrides the whole Birdeye result (e.g. a failure). */
    multiResult?: BirdeyeMultiPriceResult;
    fallbackRows?: Record<string, PegGuardMarketFallback>;
    configured?: boolean;
    enabled?: boolean;
    dryRunDefault?: boolean;
    webacyDryRunDefault?: boolean;
}

interface Harness {
    deps: DepegCronDeps;
    rec: Recording;
    /** Mutable clock read by `deps.now`. */
    clock: { now: number };
    /** Live in-memory peg_guard_latest, updated by upserts. */
    latest: Map<string, PegGuardLatestRow>;
    advisories: ReconcilerAdvisory[];
}

function defaultPrices(currencies: string[]): Record<string, BirdeyeMultiPriceEntry> {
    return Object.fromEntries(currencies.map(mint => [mint, entry(mint, 1)]));
}

function makeHarness(fx: Fixture = {}): Harness {
    const rec: Recording = {
        upserts: [],
        tierEvents: [],
        sets: [],
        clears: [],
        logs: [],
        multiCalls: [],
        fallbackCalls: [],
        variantCalls: [],
        webacyListCalls: 0,
    };
    const clock = { now: FIXED_NOW };
    const currencies = fx.currencies ?? DEFAULT_CURRENCIES;
    const variants = fx.variants ?? VARIANTS;
    const latest = new Map((fx.prevRows ?? []).map(row => [row.address, row] as const));
    const advisories = [...(fx.advisories ?? [])];
    const prices = fx.prices ?? defaultPrices(currencies);

    const curated: CuratedMembershipSource = {
        warmup: async () => {},
        getSnapshot: async () => ({
            loadedAt: FIXED_NOW,
            mintsByList: { majors: [], lsts: [], currencies, rwas: [], etfs: [], metals: [], stocks: [] },
            allMints: currencies,
            entriesByMint: Object.fromEntries(
                currencies.map(mint => [
                    mint,
                    { assetId: variants[mint]?.assetId ?? null, listSlugs: ['currencies' as const], symbol: null },
                ]),
            ),
        }),
        getAllCuratedMintsInOrder: () => currencies,
        getCuratedMintRank: () => new Map(),
        getListSlugsByMint: () => new Map(),
    };

    const webacyDepeg: WebacyDepegClient = {
        isConfigured: () => true,
        async fetchDepegToken() {
            throw new Error('peg guard must not poll Webacy');
        },
        async fetchDepegList() {
            throw new Error('peg guard must not poll Webacy');
        },
        async fetchStructuralHealthBatch() {
            throw new Error('peg guard must not poll Webacy');
        },
    };

    const repo: DepegRepo = {
        async listDepegLatest() {
            rec.webacyListCalls += 1;
            return fx.webacyRows ?? [];
        },
        async upsertDepegLatest() {
            throw new Error('peg guard must not write webacy_depeg_latest');
        },
        async insertDepegTierEvents() {
            throw new Error('peg guard must not write webacy_depeg_tier_events');
        },
        async listActiveSolanaVariantMints() {
            return new Map();
        },
        async listAdvisoriesForReconcile(mints) {
            return advisories.filter(a => mints.includes(a.mint));
        },
        async listLastAdminClearAtByMints() {
            return new Map(fx.adminClears ?? []);
        },
        async setSystemAdvisory(args) {
            rec.sets.push(args);
            const existing = advisories.find(a => a.mint === args.mint);
            if (existing) {
                existing.reason = args.reason;
                existing.updatedAt = args.nowMs;
                return 'updated';
            }
            advisories.push({
                mint: args.mint,
                status: 'caution',
                reason: args.reason,
                source: args.source,
                managedBySystem: true,
                setAt: args.nowMs,
                updatedAt: args.nowMs,
            });
            return 'set';
        },
        async clearSystemAdvisory(args) {
            rec.clears.push(args);
            const index = advisories.findIndex(a => a.mint === args.mint);
            if (index >= 0) advisories.splice(index, 1);
            return 'cleared';
        },
        async upsertStructuralHealthLatest() {},
        async upsertStructuralHealthDaily() {},
        async listStructuralHealthLatest() {
            return [];
        },
        async listStructuralTargets() {
            return [];
        },
    };

    const pegRepo: PegGuardRepo = {
        async listLatest() {
            return [...latest.values()];
        },
        async upsertLatest(rows) {
            rec.upserts.push([...rows]);
            for (const row of rows) latest.set(row.address, row);
        },
        async insertTierEvents(rows) {
            rec.tierEvents.push([...rows]);
        },
        async listCurrencyVariants(mints) {
            rec.variantCalls.push([...mints]);
            const out = new Map<string, PegGuardCurrencyVariant>();
            for (const mint of mints) if (variants[mint]) out.set(mint, variants[mint]!);
            return out;
        },
        async listVariantMarketFallback(mints) {
            rec.fallbackCalls.push([...mints]);
            const out = new Map<string, PegGuardMarketFallback>();
            for (const mint of mints) if (fx.fallbackRows?.[mint]) out.set(mint, fx.fallbackRows[mint]!);
            return out;
        },
    };

    const deps: DepegCronDeps = {
        webacyDepeg,
        repo,
        curated,
        now: () => clock.now,
        isRefreshEnabled: () => true,
        isDryRunDefault: () => fx.webacyDryRunDefault ?? true,
        log: line => rec.logs.push(line),
        ...(fx.configured === false
            ? {}
            : {
                  pegGuard: {
                      birdeye: {
                          async fetchMultiPrice(mints) {
                              rec.multiCalls.push([...mints]);
                              if (fx.multiResult) return fx.multiResult;
                              const byMint = new Map<string, BirdeyeMultiPriceEntry>();
                              const missing: string[] = [];
                              for (const mint of mints) {
                                  const e = prices[mint];
                                  if (e) byMint.set(mint, { ...e, updatedAt: e.updatedAt + (clock.now - FIXED_NOW) });
                                  else missing.push(mint);
                              }
                              return { ok: true, byMint, missing };
                          },
                      },
                      repo: pegRepo,
                      isEnabled: () => fx.enabled ?? true,
                      ...(fx.dryRunDefault === undefined ? {} : { isDryRunDefault: () => fx.dryRunDefault! }),
                  },
              }),
    };
    return { deps, rec, clock, latest, advisories };
}

function events(rec: Recording, name: string): Record<string, unknown>[] {
    return rec.logs.filter(l => l.event === name);
}

async function run(h: Harness, args: unknown = {}): Promise<PegGuardRefreshResult> {
    return (await refreshPegGuard(h.deps, args)) as PegGuardRefreshResult;
}

function summary(rec: Recording): Record<string, unknown> {
    const lines = events(rec, 'peg_guard_summary');
    expect(lines.length).toBeGreaterThan(0);
    return lines[lines.length - 1]!;
}

describe('refresh-peg-guard gates and args', () => {
    test('is registered in depegJobs and dispatches to refreshPegGuard', async () => {
        const h = makeHarness({ configured: false });
        const out = (await depegJobs['refresh-peg-guard']!(h.deps, {})) as PegGuardRefreshResult;
        expect(out.disabled).toBe(true);
        expect(out.reason).toBe('peg_guard_not_configured');
    });

    test('returns peg_guard_not_configured when deps.pegGuard is missing and touches nothing', async () => {
        const h = makeHarness({ configured: false });
        const out = await run(h);
        expect(out).toMatchObject({ ok: true, disabled: true, reason: 'peg_guard_not_configured', processed: 0 });
        expect(h.rec.logs).toHaveLength(0);
        expect(h.rec.upserts).toHaveLength(0);
    });

    test('returns peg_guard_disabled when the flag is off; requireEnabled:false bypasses it', async () => {
        const h = makeHarness({ enabled: false });
        const out = await run(h);
        expect(out).toMatchObject({ disabled: true, reason: 'peg_guard_disabled' });
        expect(h.rec.multiCalls).toHaveLength(0);
        const forced = await run(h, { requireEnabled: false });
        expect(forced.disabled).toBeUndefined();
        expect(h.rec.multiCalls).toHaveLength(1);
    });

    test('dry-run default: pegGuard seam wins, then the Webacy seam; explicit dryRun overrides both', async () => {
        const own = makeHarness({ dryRunDefault: false, webacyDryRunDefault: true });
        expect((await run(own)).dryRun).toBe(false);
        const inherited = makeHarness({ webacyDryRunDefault: false });
        expect((await run(inherited)).dryRun).toBe(false);
        const inheritedDry = makeHarness({ webacyDryRunDefault: true });
        expect((await run(inheritedDry)).dryRun).toBe(true);
        const explicit = makeHarness({ dryRunDefault: false });
        expect((await run(explicit, { dryRun: true })).dryRun).toBe(true);
    });

    test('rejects an unknown trigger and a non-boolean dryRun', async () => {
        const h = makeHarness();
        await expect(run(h, { trigger: 'webhook' })).rejects.toBeInstanceOf(BadRequestError);
        await expect(run(h, { dryRun: 'yes' })).rejects.toBeInstanceOf(BadRequestError);
    });

    test('trigger defaults to sweep, or manual when explicit mints are given', async () => {
        const sweep = makeHarness();
        expect((await run(sweep)).trigger).toBe('sweep');
        expect(summary(sweep.rec).trigger).toBe('sweep');
        const targeted = makeHarness();
        const out = await run(targeted, { mints: [USDC] });
        expect(out.trigger).toBe('manual');
        expect(out.tracked).toBe(1);
        expect(targeted.rec.multiCalls).toEqual([[USDC]]);
        expect(targeted.rec.variantCalls).toEqual([[USDC]]);
    });

    test('every log line carries observer:peg_guard and the job name', async () => {
        const h = makeHarness({
            prices: { ...defaultPrices(DEFAULT_CURRENCIES), [USDE]: entry(USDE, 0.97) },
            webacyRows: [webacyRow(USDE, 'ok')],
        });
        await run(h);
        expect(h.rec.logs.length).toBeGreaterThan(2);
        for (const line of h.rec.logs) {
            expect(line.observer).toBe('peg_guard');
            expect(line.job).toBe('refresh-peg-guard');
            expect(line.dry_run).toBe(true);
        }
    });
});

describe('refresh-peg-guard observations', () => {
    test('healthy sweep: every USD mint ok, non-USD unsupported, summary always emitted', async () => {
        const h = makeHarness();
        const out = await run(h);
        expect(out.ok).toBe(true);
        expect(out.tracked).toBe(7);
        expect(out.priced).toBe(7);
        expect(out.fallbackPriced).toBe(0);
        expect(out.unsupported).toBe(3);
        expect(out.issues).toEqual({ thin_liquidity: 0, stale_price: 0, no_price: 0, unsupported_peg: 3 });
        expect(out.tierCounts).toEqual({ ok: 4, watch: 0, warning: 0, critical: 0, premium: 0, null: 3 });
        expect(out.tierChanges).toBe(4);
        expect(out.reconciled).toBe(4);
        expect(out.actionsSet).toBe(0);
        expect(out.skipped).toEqual({ unchanged: 4 });
        expect(h.rec.multiCalls).toEqual([DEFAULT_CURRENCIES]);
        expect(h.rec.fallbackCalls).toEqual([[]]);
        const s = summary(h.rec);
        expect(s).toMatchObject({
            ok: true,
            tracked: 7,
            priced: 7,
            fallback_priced: 0,
            unsupported: 3,
            owned_by_webacy: 0,
            reconciled: 4,
            circuit: null,
            partial: false,
        });
        expect(typeof s.duration_ms).toBe('number');
    });

    test('non-USD pegs are stored with their currency, tier null and unsupported_peg', async () => {
        const h = makeHarness();
        await run(h);
        const rows = h.rec.upserts[0]!;
        const eurc = rows.find(r => r.address === EURC)!;
        expect(eurc).toMatchObject({
            pegCurrency: 'EUR',
            pegUsd: null,
            tier: null,
            ok: false,
            errorMessage: 'unsupported_peg',
            priceUsd: 1,
            priceSource: 'birdeye_multi_price',
            lastOkAt: null,
        });
        expect(rows.find(r => r.address === TRYB)).toMatchObject({
            pegCurrency: 'TRY',
            errorMessage: 'unsupported_peg',
        });
        expect(rows.find(r => r.address === BUIDL)).toMatchObject({
            pegCurrency: null,
            errorMessage: 'unsupported_peg',
        });
        // Non-USD mints never reach the reconciler.
        expect(h.rec.logs.filter(l => l.event === 'depeg_advisory_skipped' && l.mint === EURC)).toHaveLength(0);
    });

    test('first sighting logs depeg_tier_changed with the peg guard fields and stores a tier event', async () => {
        const h = makeHarness({
            currencies: [USDE],
            prices: { [USDE]: entry(USDE, 0.985, { liquidityUsd: 1_234_567 }) },
        });
        await run(h);
        const changed = events(h.rec, 'depeg_tier_changed');
        expect(changed).toHaveLength(1);
        expect(changed[0]).toMatchObject({
            observer: 'peg_guard',
            source: 'sweep',
            mint: USDE,
            symbol: 'USDe',
            old_tier: null,
            new_tier: 'warning',
            price_usd: 0.985,
            peg_usd: 1,
            liquidity_usd: 1_234_567,
            price_source: 'birdeye_multi_price',
        });
        expect(changed[0]!.deviation_pct as number).toBeCloseTo(-1.5, 6);
        expect(h.rec.tierEvents[0]![0]).toMatchObject({
            address: USDE,
            oldTier: null,
            newTier: 'warning',
            source: 'sweep',
        });
    });

    test('yield variants above peg stay ok while a native variant reads premium', async () => {
        const h = makeHarness({
            currencies: [USDC, USDY],
            prices: { [USDC]: entry(USDC, 1.03), [USDY]: entry(USDY, 1.08) },
        });
        const out = await run(h);
        const rows = h.rec.upserts[0]!;
        expect(rows.find(r => r.address === USDY)!.tier).toBe('ok');
        expect(rows.find(r => r.address === USDC)!.tier).toBe('premium');
        expect(out.skipped).toEqual({ unchanged: 1, premium_tier: 1 });
    });

    test('thin liquidity and stale price: ok:false, previous tier kept, no action, last_ok_at untouched', async () => {
        const h = makeHarness({
            currencies: [USDC, USDT],
            prevRows: [pegRow(USDC, 'ok'), pegRow(USDT, 'warning')],
            prices: {
                [USDC]: entry(USDC, 0.9, { liquidityUsd: 99_999 }),
                [USDT]: entry(USDT, 0.9, { updatedAt: FIXED_NOW - 31 * MINUTE }),
            },
        });
        const out = await run(h, { dryRun: false });
        expect(out.issues).toMatchObject({ thin_liquidity: 1, stale_price: 1 });
        expect(out.tierChanges).toBe(0);
        expect(out.actionsSet).toBe(0);
        expect(h.rec.sets).toHaveLength(0);
        expect(out.skipped).toEqual({ no_observation: 2 });
        const rows = h.rec.upserts[0]!;
        const usdc = rows.find(r => r.address === USDC)!;
        expect(usdc).toMatchObject({
            ok: false,
            errorMessage: 'thin_liquidity',
            tier: 'ok',
            observations: 3,
            lastOkAt: FIXED_NOW - 5 * MINUTE,
            lastFetchedAt: FIXED_NOW,
            priceUsd: 0.9,
            liquidityUsd: 99_999,
        });
        expect(usdc.deviationPct).toBeCloseTo(-10, 6);
        const usdt = rows.find(r => r.address === USDT)!;
        expect(usdt).toMatchObject({
            ok: false,
            errorMessage: 'stale_price',
            tier: 'warning',
            badSinceAt: FIXED_NOW - 2 * HOUR,
        });
    });

    test('a mint Birdeye omits falls back to variant_markets_latest', async () => {
        const h = makeHarness({
            currencies: [USDC, USDE],
            prices: { [USDC]: entry(USDC, 1) },
            fallbackRows: { [USDE]: { price: 0.975, liquidity: 800_000, lastFetchedAt: FIXED_NOW - 3 * MINUTE } },
        });
        const out = await run(h);
        expect(out).toMatchObject({ ok: true, priced: 1, fallbackPriced: 1 });
        expect(h.rec.fallbackCalls).toEqual([[USDE]]);
        const usde = h.rec.upserts[0]!.find(r => r.address === USDE)!;
        expect(usde).toMatchObject({
            ok: true,
            tier: 'warning',
            priceSource: 'variant_markets_latest',
            priceUpdatedAt: FIXED_NOW - 3 * MINUTE,
            liquidityUsd: 800_000,
        });
        expect(events(h.rec, 'depeg_tier_changed').find(l => l.mint === USDE)).toMatchObject({
            price_source: 'variant_markets_latest',
        });
    });

    test('a mint with no price anywhere records no_price', async () => {
        const h = makeHarness({ currencies: [USDC], prices: {} });
        const out = await run(h);
        expect(out.issues.no_price).toBe(1);
        expect(h.rec.upserts[0]![0]).toMatchObject({
            ok: false,
            errorMessage: 'no_price',
            priceUsd: null,
            priceSource: null,
        });
    });
});

describe('refresh-peg-guard circuits', () => {
    test('Birdeye failure: fallback prices are used, price_fetch_failed opens when under half are fresh', async () => {
        const h = makeHarness({
            multiResult: { ok: false, status: 503, message: 'upstream' },
            fallbackRows: {
                [USDC]: { price: 0.9, liquidity: 5_000_000, lastFetchedAt: FIXED_NOW - 2 * MINUTE },
                [USDT]: { price: 1, liquidity: 5_000_000, lastFetchedAt: FIXED_NOW - 2 * HOUR },
            },
        });
        const out = await run(h);
        expect(out.ok).toBe(true);
        expect(out.priced).toBe(0);
        expect(out.fallbackPriced).toBe(2);
        expect(out.circuit).toBe('price_fetch_failed');
        expect(out.reconciled).toBe(0);
        expect(h.rec.fallbackCalls).toEqual([DEFAULT_CURRENCIES]);
        expect(events(h.rec, 'peg_guard_price_fetch_failed')).toHaveLength(1);
        const circuit = events(h.rec, 'depeg_circuit_open');
        expect(circuit).toHaveLength(1);
        expect(circuit[0]).toMatchObject({
            reason: 'price_fetch_failed',
            usd_mints: 4,
            fresh_fallback: 1,
            ignored: false,
        });
        // Rows and tier events are still persisted.
        expect(h.rec.upserts).toHaveLength(1);
        expect(h.rec.upserts[0]!.find(r => r.address === USDC)).toMatchObject({
            tier: 'critical',
            priceSource: 'variant_markets_latest',
        });
        // USDT's fallback is two hours old: stale_price, so only USDC gets a tier.
        expect(h.rec.tierEvents[0]!.map(e => e.address)).toEqual([USDC]);
        expect(h.rec.upserts[0]!.find(r => r.address === USDT)).toMatchObject({
            ok: false,
            errorMessage: 'stale_price',
        });
        expect(h.rec.webacyListCalls).toBe(0);
        expect(summary(h.rec).circuit).toBe('price_fetch_failed');
    });

    test('Birdeye failure with enough fresh fallback prices reconciles normally', async () => {
        const h = makeHarness({
            multiResult: { ok: false, status: 500, message: 'boom' },
            fallbackRows: Object.fromEntries(
                USD_MINTS.map(mint => [mint, { price: 1, liquidity: 5_000_000, lastFetchedAt: FIXED_NOW - MINUTE }]),
            ),
        });
        const out = await run(h);
        expect(out.ok).toBe(true);
        expect(out.circuit).toBeNull();
        expect(out.reconciled).toBe(4);
        expect(events(h.rec, 'depeg_circuit_open')).toHaveLength(0);
    });

    test('Birdeye failure with no usable fallback at all is a total failure (ok:false)', async () => {
        const h = makeHarness({ multiResult: { ok: false, status: 500, message: 'boom' } });
        const out = await run(h);
        expect(out.ok).toBe(false);
        expect(out.circuit).toBe('price_fetch_failed');
        expect(out.issues.no_price).toBe(4);
        expect(summary(h.rec).ok).toBe(false);
    });

    test('ignoreCircuitBreaker lifts price_fetch_failed but still logs it', async () => {
        const h = makeHarness({
            multiResult: { ok: false, status: 503, message: 'upstream' },
            fallbackRows: { [USDC]: { price: 1, liquidity: 5_000_000, lastFetchedAt: FIXED_NOW - MINUTE } },
        });
        const out = await run(h, { ignoreCircuitBreaker: true });
        expect(out.circuit).toBeNull();
        expect(out.reconciled).toBe(4);
        expect(events(h.rec, 'depeg_circuit_open')[0]).toMatchObject({ reason: 'price_fetch_failed', ignored: true });
    });

    test('mass tier flip: rows and events persisted, reconciler skipped, zero actions', async () => {
        const h = makeHarness({
            prevRows: USD_MINTS.map(mint => pegRow(mint, 'ok')),
            prices: {
                ...defaultPrices(DEFAULT_CURRENCIES),
                [USDC]: entry(USDC, 0.95),
                [USDT]: entry(USDT, 0.95),
            },
        });
        const out = await run(h, { dryRun: false });
        expect(out.circuit).toBe('mass_tier_flip');
        expect(out.tierChanges).toBe(2);
        expect(out.reconciled).toBe(0);
        expect(out.actionsSet).toBe(0);
        expect(h.rec.sets).toHaveLength(0);
        expect(h.rec.upserts).toHaveLength(1);
        expect(h.rec.tierEvents[0]).toHaveLength(2);
        expect(events(h.rec, 'depeg_circuit_open')[0]).toMatchObject({
            reason: 'mass_tier_flip',
            flips: 2,
            tracked: 4,
            share_pct: 50,
            ignored: false,
        });
        expect(events(h.rec, 'depeg_tier_changed')).toHaveLength(2);
    });

    test('mass flip guard needs at least four previously tiered mints (cold start never trips it)', async () => {
        const h = makeHarness({
            prices: { ...defaultPrices(DEFAULT_CURRENCIES), [USDC]: entry(USDC, 0.95), [USDT]: entry(USDT, 0.95) },
        });
        const out = await run(h);
        expect(out.circuit).toBeNull();
        expect(out.tierChanges).toBe(4);
        expect(events(h.rec, 'depeg_circuit_open')).toHaveLength(0);
    });

    test('mass_action: more actions than maxActionsPerRun opens the circuit and defers the rest', async () => {
        const h = makeHarness({
            prevRows: USD_MINTS.map(mint => pegRow(mint, 'critical', { badSinceAt: FIXED_NOW - HOUR })),
            prices: Object.fromEntries(DEFAULT_CURRENCIES.map(mint => [mint, entry(mint, 0.9)])),
        });
        const out = await run(h, { dryRun: false, maxActionsPerRun: 2 });
        expect(out.circuit).toBe('mass_action');
        expect(out.actionsSet).toBe(2);
        expect(out.skipped.max_actions_exceeded).toBe(2);
        expect(events(h.rec, 'depeg_circuit_open')[0]).toMatchObject({ reason: 'mass_action', applied: 2, dropped: 2 });
    });
});

describe('refresh-peg-guard ownership', () => {
    test('USDC covered by a fresh Webacy row is not reconciled; the others are', async () => {
        const h = makeHarness({ webacyRows: [webacyRow(USDC, 'ok')] });
        const out = await run(h);
        expect(out.ownedByWebacy).toBe(1);
        expect(out.reconciled).toBe(3);
        expect(out.skipped).toEqual({ unchanged: 3 });
        expect(summary(h.rec)).toMatchObject({ owned_by_webacy: 1, reconciled: 3 });
    });

    test('a critical USDC with a fresh Webacy row is left to Webacy even when the peg guard agrees', async () => {
        const h = makeHarness({
            prevRows: [pegRow(USDC, 'critical', { badSinceAt: FIXED_NOW - HOUR })],
            prices: { ...defaultPrices(DEFAULT_CURRENCIES), [USDC]: entry(USDC, 0.9) },
            webacyRows: [webacyRow(USDC, 'critical')],
        });
        const out = await run(h, { dryRun: false });
        expect(out.ownedByWebacy).toBe(1);
        expect(h.rec.sets).toHaveLength(0);
        expect(events(h.rec, 'peg_guard_disagreement')).toHaveLength(0);
    });

    test('a 10h-old Webacy row hands USDC to the peg guard', async () => {
        const h = makeHarness({
            prevRows: [pegRow(USDC, 'critical', { badSinceAt: FIXED_NOW - HOUR })],
            prices: { ...defaultPrices(DEFAULT_CURRENCIES), [USDC]: entry(USDC, 0.9) },
            webacyRows: [
                webacyRow(USDC, 'ok', { lastOkAt: FIXED_NOW - 10 * HOUR, lastFetchedAt: FIXED_NOW - 10 * HOUR }),
            ],
        });
        const out = await run(h, { dryRun: false });
        expect(out.ownedByWebacy).toBe(0);
        expect(out.reconciled).toBe(4);
        expect(out.actionsSet).toBe(1);
        expect(h.rec.sets[0]).toMatchObject({ mint: USDC, source: 'peg_guard', nowMs: FIXED_NOW });
        expect(h.rec.sets[0]!.reason.startsWith('tokens.xyz peg monitor rates USDC Critical:')).toBe(true);
        expect(events(h.rec, 'depeg_advisory_set')[0]).toMatchObject({
            observer: 'peg_guard',
            mint: USDC,
            tier: 'critical',
        });
    });

    test('a failed Webacy poll (ok:false) does not cover the mint', async () => {
        const h = makeHarness({ webacyRows: [webacyRow(USDC, 'ok', { ok: false })] });
        const out = await run(h);
        expect(out.ownedByWebacy).toBe(0);
        expect(out.reconciled).toBe(4);
    });

    test('orphan: a live peg_guard advisory is still reconciled (and cleared) once Webacy is fresh again', async () => {
        const h = makeHarness({
            prevRows: [pegRow(USDC, 'ok', { tierSinceAt: FIXED_NOW - 7 * HOUR })],
            webacyRows: [webacyRow(USDC, 'ok')],
            advisories: [advisory(USDC, 'warning', 'peg_guard')],
        });
        const out = await run(h, { dryRun: false });
        expect(out.ownedByWebacy).toBe(1);
        expect(out.reconciled).toBe(4);
        expect(out.actionsCleared).toBe(1);
        expect(h.rec.clears[0]).toMatchObject({
            mint: USDC,
            source: 'peg_guard',
            note: 'tokens.xyz peg monitor: on peg for 7h',
        });
        expect(events(h.rec, 'depeg_advisory_cleared')[0]).toMatchObject({ observer: 'peg_guard', mint: USDC });
    });

    test('a Webacy-owned advisory on an uncovered mint is skipped as other_system_owner', async () => {
        const h = makeHarness({
            prevRows: [pegRow(USDE, 'ok', { tierSinceAt: FIXED_NOW - 8 * HOUR })],
            advisories: [advisory(USDE, 'warning', 'webacy_depeg')],
        });
        const out = await run(h, { dryRun: false });
        expect(out.skipped.other_system_owner).toBe(1);
        expect(h.rec.clears).toHaveLength(0);
        expect(events(h.rec, 'depeg_advisory_skipped')).toContainEqual(
            expect.objectContaining({ mint: USDE, why: 'other_system_owner', observer: 'peg_guard' }),
        );
    });

    test('logs peg_guard_disagreement when exactly one observer reads a bad tier', async () => {
        const h = makeHarness({
            prices: { ...defaultPrices(DEFAULT_CURRENCIES), [USDT]: entry(USDT, 0.98) },
            webacyRows: [webacyRow(USDT, 'ok'), webacyRow(USDC, 'ok')],
        });
        await run(h);
        const lines = events(h.rec, 'peg_guard_disagreement');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
            mint: USDT,
            symbol: 'USDT',
            webacy_tier: 'ok',
            peg_guard_tier: 'warning',
            webacy_covers: true,
        });
    });

    test('inactive variants are skipped as not_in_registry', async () => {
        const h = makeHarness({
            currencies: [USDC],
            variants: { [USDC]: { ...VARIANTS[USDC]!, isActive: false } },
            prices: { [USDC]: entry(USDC, 0.9) },
        });
        const out = await run(h, { dryRun: false });
        expect(out.skipped).toEqual({ not_in_registry: 1 });
        expect(h.rec.sets).toHaveLength(0);
    });
});

describe('refresh-peg-guard confirmation windows', () => {
    test('warning sets only after 20 min of consecutive runs (0 / 10 / 20 min)', async () => {
        const h = makeHarness({
            currencies: [USDE],
            prices: { [USDE]: entry(USDE, 0.98) },
        });
        const first = await run(h, { dryRun: false });
        expect(first.tierChanges).toBe(1);
        expect(first.skipped).toEqual({ hysteresis_pending: 1 });
        expect(h.rec.sets).toHaveLength(0);

        h.clock.now = FIXED_NOW + 10 * MINUTE;
        const second = await run(h, { dryRun: false });
        expect(second.tierChanges).toBe(0);
        expect(second.skipped).toEqual({ hysteresis_pending: 1 });
        expect(h.latest.get(USDE)).toMatchObject({ observations: 2, badSinceAt: FIXED_NOW, tierSinceAt: FIXED_NOW });

        h.clock.now = FIXED_NOW + 20 * MINUTE;
        const third = await run(h, { dryRun: false });
        expect(third.actionsSet).toBe(1);
        expect(h.rec.sets).toHaveLength(1);
        expect(h.rec.sets[0]).toMatchObject({ mint: USDE, source: 'peg_guard', nowMs: FIXED_NOW + 20 * MINUTE });
        expect(h.rec.sets[0]!.reason).toContain(
            'tokens.xyz peg monitor rates USDe Warning: trading 2.00% below its $1 peg on Solana DEXs',
        );
        expect(h.rec.sets[0]!.reason).toContain('liquidity $5M');

        // Fourth run: the row exists with the same tier, nothing to do.
        h.clock.now = FIXED_NOW + 25 * MINUTE;
        const fourth = await run(h, { dryRun: false });
        expect(fourth.skipped).toEqual({ unchanged: 1 });
        expect(h.rec.sets).toHaveLength(1);
    });

    test('critical sets after 10 min (0 / 5 / 10 min), not on first sight', async () => {
        const h = makeHarness({
            currencies: [USDE],
            prices: { [USDE]: entry(USDE, 0.95) },
        });
        const first = await run(h, { dryRun: false });
        expect(first.skipped).toEqual({ hysteresis_pending: 1 });
        h.clock.now = FIXED_NOW + 5 * MINUTE;
        const second = await run(h, { dryRun: false });
        expect(second.skipped).toEqual({ hysteresis_pending: 1 });
        expect(h.rec.sets).toHaveLength(0);
        h.clock.now = FIXED_NOW + 10 * MINUTE;
        const third = await run(h, { dryRun: false });
        expect(third.actionsSet).toBe(1);
        expect(h.rec.sets[0]!.reason.startsWith('tokens.xyz peg monitor rates USDe Critical:')).toBe(true);
        expect(events(h.rec, 'depeg_advisory_set')[0]).toMatchObject({ why: 'enter_critical', observer: 'peg_guard' });
    });

    test('criticalImmediate:true sets critical on first sight', async () => {
        const h = makeHarness({ currencies: [USDE], prices: { [USDE]: entry(USDE, 0.95) } });
        const out = await run(h, { dryRun: false, criticalImmediate: true });
        expect(out.actionsSet).toBe(1);
    });

    test('dry run logs would_set with the observer and writes nothing', async () => {
        const h = makeHarness({
            currencies: [USDE],
            prevRows: [pegRow(USDE, 'warning', { badSinceAt: FIXED_NOW - HOUR })],
            prices: { [USDE]: entry(USDE, 0.98) },
        });
        const out = await run(h);
        expect(out.dryRun).toBe(true);
        expect(out.actionsSet).toBe(0);
        expect(h.rec.sets).toHaveLength(0);
        expect(events(h.rec, 'depeg_advisory_would_set')[0]).toMatchObject({
            observer: 'peg_guard',
            mint: USDE,
            tier: 'warning',
        });
        // Observations are still persisted in dry run.
        expect(h.rec.upserts).toHaveLength(1);
    });

    test('clear waits for the 6h cooldown and then clears with the peg guard note', async () => {
        const h = makeHarness({
            currencies: [USDE],
            prevRows: [pegRow(USDE, 'ok', { tierSinceAt: FIXED_NOW - 5 * HOUR })],
            advisories: [advisory(USDE, 'warning', 'peg_guard')],
        });
        const pending = await run(h, { dryRun: false });
        expect(pending.skipped).toEqual({ cooldown_pending: 1 });
        h.clock.now = FIXED_NOW + HOUR;
        const cleared = await run(h, { dryRun: false });
        expect(cleared.actionsCleared).toBe(1);
        expect(h.rec.clears[0]).toMatchObject({
            mint: USDE,
            source: 'peg_guard',
            note: 'tokens.xyz peg monitor: on peg for 6h',
        });
    });

    test('stale observation (ok:false since more than 30 min) neither sets nor clears', async () => {
        const h = makeHarness({
            currencies: [USDE],
            prevRows: [pegRow(USDE, 'warning', { badSinceAt: FIXED_NOW - 2 * HOUR, lastOkAt: FIXED_NOW - 2 * HOUR })],
            prices: { [USDE]: entry(USDE, 0.98, { liquidityUsd: 10 }) },
        });
        const out = await run(h, { dryRun: false });
        expect(out.skipped).toEqual({ no_observation: 1 });
        expect(h.rec.sets).toHaveLength(0);
    });

    test('an admin clear during the current episode suppresses the peg guard', async () => {
        const h = makeHarness({
            currencies: [USDE],
            prevRows: [pegRow(USDE, 'warning', { badSinceAt: FIXED_NOW - 2 * HOUR })],
            prices: { [USDE]: entry(USDE, 0.98) },
            adminClears: [[USDE, FIXED_NOW - HOUR]],
        });
        const out = await run(h, { dryRun: false });
        expect(out.skipped).toEqual({ suppressed_by_human_clear: 1 });
    });
});

describe('buildPegGuardRow', () => {
    test('a successful evaluation after a failure restarts nothing when the tier is unchanged', () => {
        const prev = pegRow(USDC, 'ok', { ok: false, errorMessage: 'thin_liquidity', lastOkAt: FIXED_NOW - HOUR });
        const { row, event } = buildPegGuardRow({
            prev,
            address: USDC,
            symbol: 'USDC',
            peg: { currency: 'USD', pegUsd: 1 },
            price: { priceUsd: 1, updatedAt: FIXED_NOW - 1000, liquidityUsd: 1_000_000, source: 'birdeye_multi_price' },
            evaluation: { ok: true, tier: 'ok', deviationPct: 0 },
            source: 'sweep',
            now: FIXED_NOW,
        });
        expect(event).toBeNull();
        expect(row).toMatchObject({
            ok: true,
            errorMessage: null,
            observations: 4,
            tierSinceAt: prev.tierSinceAt,
            lastOkAt: FIXED_NOW,
        });
    });

    test('warning -> critical keeps badSinceAt and emits an event with the previous tier', () => {
        const prev = pegRow(USDE, 'warning', { badSinceAt: FIXED_NOW - HOUR, tierSinceAt: FIXED_NOW - HOUR });
        const { row, event } = buildPegGuardRow({
            prev,
            address: USDE,
            symbol: 'USDe',
            peg: { currency: 'USD', pegUsd: 1 },
            price: {
                priceUsd: 0.95,
                updatedAt: FIXED_NOW - 1000,
                liquidityUsd: 1_000_000,
                source: 'birdeye_multi_price',
            },
            evaluation: { ok: true, tier: 'critical', deviationPct: -5 },
            source: 'manual',
            now: FIXED_NOW,
        });
        expect(row).toMatchObject({
            tier: 'critical',
            prevTier: 'warning',
            badSinceAt: FIXED_NOW - HOUR,
            tierSinceAt: FIXED_NOW,
            observations: 1,
        });
        expect(event).toMatchObject({
            oldTier: 'warning',
            newTier: 'critical',
            source: 'manual',
            liquidityUsd: 1_000_000,
        });
    });

    test('a failure with no previous row stores a blank tier and keeps the price it saw', () => {
        const { row, event } = buildPegGuardRow({
            prev: null,
            address: USDE,
            symbol: 'USDe',
            peg: { currency: 'USD', pegUsd: 1 },
            price: {
                priceUsd: 0.98,
                updatedAt: FIXED_NOW - 2 * HOUR,
                liquidityUsd: 1_000_000,
                source: 'variant_markets_latest',
            },
            evaluation: { ok: false, issue: 'stale_price', deviationPct: -2 },
            source: 'sweep',
            now: FIXED_NOW,
        });
        expect(event).toBeNull();
        expect(row).toMatchObject({
            tier: null,
            ok: false,
            errorMessage: 'stale_price',
            deviationPct: -2,
            priceUsd: 0.98,
            priceSource: 'variant_markets_latest',
            observations: 0,
            lastOkAt: null,
        });
    });
});
