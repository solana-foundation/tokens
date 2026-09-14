/**
 * In-house stablecoin peg guard (`refresh-peg-guard`): the second observation
 * source behind automated depeg advisories.
 *
 * Webacy's depeg monitor has live data for USDC, USDT and PYUSD only
 * (verified 2026-09-14). This job prices every curated `currencies` mint from
 * Birdeye's multi_price endpoint every few minutes, derives a tier from
 * below-peg deviation (pegReference.ts), keeps the same tier-streak state as
 * the Webacy job in `peg_guard_latest`, and feeds the shared reconciler
 * (depegReconciler.ts) as observer `peg_guard`. Webacy's tier wins wherever
 * its row is fresh; the peg guard owns the rest plus any advisory it set.
 *
 * Every log line is single-line JSON with `event`, `job`, `trigger`,
 * `dry_run`, `observer: 'peg_guard'`; alert-rules/stablecoin-peg-guard-*.json
 * key off `event`.
 */

import { Effect } from 'effect';
import { BadRequestError } from '@tokens/effect';
import { decodeJobArgs, type JobArgSpecs } from '@tokens/effect/job-args';
import type { PegTier } from '@tokens/asset-registry';

import type { BirdeyeMultiPriceEntry } from '../clients';
import type { PegGuardLatestRow, PegGuardPriceSource, PegGuardTierEventRow, PegGuardTrigger } from '../db/pegGuard';
import type { CronResult } from './crons';
import {
    DEPEG_CHAIN,
    advanceDepegState,
    applyAction,
    type AdvisoryActionCounters,
    type DepegCronDeps,
} from './crons.depeg';
import { reconcileDepegAdvisories, type ReconcilerObservation, type ReconcilerSkipReason } from './depegReconciler';
import {
    PEG_GUARD_MIN_LIQUIDITY_USD,
    PEG_GUARD_PRICE_STALE_MS,
    WEBACY_PEG_COVERAGE_MS,
    evaluatePegObservation,
    pegForStablecoinVariant,
    webacyCoversMint,
    type PegEvaluation,
    type PegObservationIssue,
    type PegReference,
} from './pegReference';

const CURRENCIES_SLUG = 'currencies';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Below this many mints with a previous tier a flip share is noise, not an incident. */
const FLIP_GUARD_MIN_TRACKED = 4;
/** `price_fetch_failed` opens when fewer than this share of USD mints get a fresh fallback price. */
const FALLBACK_MIN_FRESH_SHARE = 0.5;

export type PegGuardCircuit = 'mass_tier_flip' | 'price_fetch_failed' | 'mass_action';

export interface PegGuardRefreshResult extends CronResult, AdvisoryActionCounters {
    dryRun: boolean;
    trigger: PegGuardTrigger;
    disabled?: boolean;
    reason?: string;
    /** Curated currencies mints (or explicit targets) evaluated this run. */
    tracked: number;
    /** Mints priced by Birdeye. */
    priced: number;
    /** Mints priced from `variant_markets_latest` because Birdeye failed or omitted them. */
    fallbackPriced: number;
    /** Mints without a USD reference (non-USD pegs, BUIDL, unknown). */
    unsupported: number;
    issues: Record<PegObservationIssue, number>;
    tierCounts: Record<PegTier | 'null', number>;
    tierChanges: number;
    /** USD mints a fresh Webacy row covers (left to the Webacy job). */
    ownedByWebacy: number;
    /** USD mints this run handed to the reconciler. */
    reconciled: number;
    skipped: Partial<Record<ReconcilerSkipReason, number>>;
    circuit: PegGuardCircuit | null;
}

// Literal specs (not the clampedInt/boolWithDefault helpers) so DecodedJobArgs
// can narrow each field's type. `trigger` and `dryRun` are read by hand: the
// spec kinds cannot express an enum or a "tri-state with env fallback".
const PEG_GUARD_ARG_SPECS = {
    requireEnabled: { kind: 'bool', fallback: true },
    mints: { kind: 'targets', label: 'mints' },
    criticalImmediate: { kind: 'bool', fallback: false },
    criticalConfirmMs: { kind: 'int', fallback: 10 * MINUTE_MS, min: 0, max: 6 * HOUR_MS },
    warningConfirmMs: { kind: 'int', fallback: 20 * MINUTE_MS, min: 0, max: 6 * HOUR_MS },
    clearCooldownMs: { kind: 'int', fallback: 6 * HOUR_MS, min: 0, max: 48 * HOUR_MS },
    clearOnWatch: { kind: 'bool', fallback: false },
    staleObservationMs: { kind: 'int', fallback: 30 * MINUTE_MS, min: MINUTE_MS, max: 72 * HOUR_MS },
    priceStaleMs: { kind: 'int', fallback: PEG_GUARD_PRICE_STALE_MS, min: MINUTE_MS, max: 24 * HOUR_MS },
    minLiquidityUsd: { kind: 'int', fallback: PEG_GUARD_MIN_LIQUIDITY_USD, min: 0, max: 1_000_000_000 },
    webacyCoverageMs: { kind: 'int', fallback: WEBACY_PEG_COVERAGE_MS, min: MINUTE_MS, max: 72 * HOUR_MS },
    maxActionsPerRun: { kind: 'int', fallback: 5, min: 1, max: 100 },
    maxTierFlipSharePct: { kind: 'int', fallback: 25, min: 0, max: 100 },
    ignoreCircuitBreaker: { kind: 'bool', fallback: false },
    budgetMs: { kind: 'int', fallback: 60_000, min: 0, max: 3_600_000 },
} as const satisfies JobArgSpecs;

function defaultIsEnabled(): boolean {
    return (process.env.PEG_GUARD_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/**
 * Dry-run is the safe default. PEG_GUARD_DRY_RUN wins when set so the two
 * observers can be staggered; otherwise the Webacy switch (or its seam) takes
 * both live at once.
 */
function resolveDryRunDefault(deps: DepegCronDeps): boolean {
    if (deps.pegGuard?.isDryRunDefault) return deps.pegGuard.isDryRunDefault();
    const own = (process.env.PEG_GUARD_DRY_RUN ?? '').trim().toLowerCase();
    if (own) return own !== 'false';
    if (deps.isDryRunDefault) return deps.isDryRunDefault();
    return (process.env.WEBACY_DEPEG_DRY_RUN ?? '').trim().toLowerCase() !== 'false';
}

function defaultLog(line: Record<string, unknown>): void {
    console.log(JSON.stringify(line));
}

function readRawField(rawArgs: unknown, key: string): unknown {
    return rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>)[key] : undefined;
}

function readTrigger(rawArgs: unknown): PegGuardTrigger | null {
    const value = readRawField(rawArgs, 'trigger');
    if (value === undefined || value === null) return null;
    if (value === 'sweep' || value === 'manual') return value;
    throw new BadRequestError({ message: 'trigger must be sweep or manual' });
}

function readDryRun(rawArgs: unknown): boolean | undefined {
    const value = readRawField(rawArgs, 'dryRun');
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new BadRequestError({ message: 'dryRun must be a boolean' });
    return value;
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

function isBadTier(tier: PegTier | null): boolean {
    return tier === 'warning' || tier === 'critical';
}

function emptyTierCounts(): Record<PegTier | 'null', number> {
    return { ok: 0, watch: 0, warning: 0, critical: 0, premium: 0, null: 0 };
}

function emptyIssueCounts(): Record<PegObservationIssue, number> {
    return { thin_liquidity: 0, stale_price: 0, no_price: 0, unsupported_peg: 0 };
}

/** A price sample and where it came from. */
export interface PegPriceSample {
    priceUsd: number | null;
    /** Provider timestamp (Birdeye) or the markets refresh time (fallback). */
    updatedAt: number | null;
    liquidityUsd: number | null;
    source: PegGuardPriceSource;
}

export interface BuildPegGuardRowInput {
    prev: PegGuardLatestRow | null;
    address: string;
    symbol: string | null;
    peg: PegReference | null;
    price: PegPriceSample | null;
    evaluation: PegEvaluation;
    source: PegGuardTrigger;
    now: number;
}

/**
 * Builds the next `peg_guard_latest` row and, when the tier moved, its tier
 * event. A failed evaluation keeps the previous tier, streak and `lastOkAt`
 * (so the reconciler sees a stale-but-known tier with `ok: false`) while still
 * recording the price it saw and why it was rejected.
 */
export function buildPegGuardRow(input: BuildPegGuardRowInput): {
    row: PegGuardLatestRow;
    event: PegGuardTierEventRow | null;
} {
    const { prev, address, peg, price, evaluation, now } = input;
    const shared = {
        chain: DEPEG_CHAIN,
        address,
        symbol: input.symbol ?? prev?.symbol ?? null,
        pegCurrency: peg?.currency ?? null,
        pegUsd: peg?.pegUsd ?? null,
        priceUsd: price?.priceUsd ?? null,
        liquidityUsd: price?.liquidityUsd ?? null,
        deviationPct: evaluation.deviationPct,
        priceSource: price?.source ?? null,
        priceUpdatedAt: price?.updatedAt ?? null,
        lastFetchedAt: now,
    };
    if (!evaluation.ok) {
        return {
            row: {
                ...shared,
                tier: prev?.tier ?? null,
                prevTier: prev?.prevTier ?? null,
                tierSinceAt: prev?.tierSinceAt ?? null,
                badSinceAt: prev?.badSinceAt ?? null,
                observations: prev?.observations ?? 0,
                ok: false,
                errorMessage: evaluation.issue,
                lastOkAt: prev?.lastOkAt ?? null,
            },
            event: null,
        };
    }
    const state = advanceDepegState(prev, evaluation.tier, now);
    const row: PegGuardLatestRow = {
        ...shared,
        tier: evaluation.tier,
        prevTier: state.changed ? state.prevTier : (prev?.prevTier ?? null),
        tierSinceAt: state.tierSinceAt,
        badSinceAt: state.badSinceAt,
        observations: state.observations,
        ok: true,
        errorMessage: null,
        lastOkAt: now,
    };
    const event: PegGuardTierEventRow | null = state.changed
        ? {
              chain: DEPEG_CHAIN,
              address,
              oldTier: state.prevTier,
              newTier: evaluation.tier,
              deviationPct: evaluation.deviationPct,
              priceUsd: row.priceUsd,
              pegUsd: row.pegUsd,
              liquidityUsd: row.liquidityUsd,
              source: input.source,
              observedAt: now,
          }
        : null;
    return { row, event };
}

function toObservation(row: PegGuardLatestRow, inRegistry: boolean): ReconcilerObservation {
    return {
        mint: row.address,
        symbol: row.symbol,
        observer: 'peg_guard',
        liquidityUsd: row.liquidityUsd,
        inRegistry,
        ok: row.ok,
        tier: row.tier,
        prevTier: row.prevTier,
        overallRisk: null,
        deviationPct: row.deviationPct,
        priceUsd: row.priceUsd,
        pegUsd: row.pegUsd,
        tierSinceAt: row.tierSinceAt,
        badSinceAt: row.badSinceAt,
        // Staleness is measured from the last *successful* evaluation: a run of
        // thin or stale prices must age the observation out, not keep it fresh.
        lastFetchedAt: row.lastOkAt ?? row.lastFetchedAt,
    };
}

function birdeyeSample(entry: BirdeyeMultiPriceEntry): PegPriceSample {
    return {
        priceUsd: entry.priceUsd,
        updatedAt: entry.updatedAt,
        liquidityUsd: entry.liquidityUsd,
        source: 'birdeye_multi_price',
    };
}

export async function refreshPegGuard(deps: DepegCronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = await Effect.runPromise(decodeJobArgs(PEG_GUARD_ARG_SPECS, rawArgs));
    const rawTrigger = readTrigger(rawArgs);
    const dryRunArg = readDryRun(rawArgs);

    const trigger: PegGuardTrigger = rawTrigger ?? (args.mints ? 'manual' : 'sweep');
    const dryRun = dryRunArg ?? resolveDryRunDefault(deps);
    const log = deps.log ?? defaultLog;
    const base = { job: 'refresh-peg-guard', trigger, dry_run: dryRun, observer: 'peg_guard' as const };
    const start = deps.now();
    const overBudget = () => args.budgetMs > 0 && deps.now() - start >= args.budgetMs;

    const result: PegGuardRefreshResult = {
        ok: true,
        processed: 0,
        durationMs: 0,
        dryRun,
        trigger,
        tracked: 0,
        priced: 0,
        fallbackPriced: 0,
        unsupported: 0,
        issues: emptyIssueCounts(),
        tierCounts: emptyTierCounts(),
        tierChanges: 0,
        ownedByWebacy: 0,
        reconciled: 0,
        actionsSet: 0,
        actionsUpdated: 0,
        actionsCleared: 0,
        skipped: {},
        circuit: null,
    };
    const finish = (): PegGuardRefreshResult => ({ ...result, durationMs: deps.now() - start });
    const countSkip = (why: ReconcilerSkipReason) => {
        result.skipped[why] = (result.skipped[why] ?? 0) + 1;
    };

    const pegGuard = deps.pegGuard;
    if (!pegGuard) return { ...finish(), disabled: true, reason: 'peg_guard_not_configured' };
    if (args.requireEnabled && !(pegGuard.isEnabled ?? defaultIsEnabled)()) {
        return { ...finish(), disabled: true, reason: 'peg_guard_disabled' };
    }

    const snapshot = await deps.curated.getSnapshot();
    const targets = args.mints ? unique(args.mints) : unique(snapshot.mintsByList[CURRENCIES_SLUG] ?? []);
    result.tracked = targets.length;

    const [variants, prevRows] = await Promise.all([
        pegGuard.repo.listCurrencyVariants(targets),
        pegGuard.repo.listLatest(DEPEG_CHAIN),
    ]);
    const prevByAddress = new Map(prevRows.map(row => [row.address, row] as const));

    // One Birdeye call for every target; mints it omits (and every mint when
    // the call fails) fall back to the last price the markets refresh stored.
    const multi = targets.length > 0 ? await pegGuard.birdeye.fetchMultiPrice(targets) : null;
    const birdeyeFailed = multi !== null && !multi.ok;
    if (multi && !multi.ok) {
        log({ ...base, event: 'peg_guard_price_fetch_failed', status: multi.status, message: multi.message });
    }
    const needsFallback = targets.filter(mint => !(multi && multi.ok && multi.byMint.has(mint)));
    const fallback = await pegGuard.repo.listVariantMarketFallback(needsFallback);

    const now = deps.now();
    const nextRows: PegGuardLatestRow[] = [];
    const events: PegGuardTierEventRow[] = [];
    const usdMints: string[] = [];
    const inRegistryByMint = new Map<string, boolean>();
    let flips = 0;
    let previouslyTiered = 0;
    let freshFallbackUsd = 0;

    for (const mint of targets) {
        const variant = variants.get(mint) ?? null;
        const peg = variant ? pegForStablecoinVariant(variant) : null;
        const isUsd = peg?.currency === 'USD' && peg.pegUsd !== null;
        if (isUsd) usdMints.push(mint);
        inRegistryByMint.set(mint, variant?.isActive ?? false);

        let price: PegPriceSample | null = null;
        const entry = multi && multi.ok ? multi.byMint.get(mint) : undefined;
        if (entry) {
            price = birdeyeSample(entry);
            result.priced += 1;
        } else {
            const row = fallback.get(mint);
            if (row && row.price !== null) {
                price = {
                    priceUsd: row.price,
                    updatedAt: row.lastFetchedAt,
                    liquidityUsd: row.liquidity,
                    source: 'variant_markets_latest',
                };
                result.fallbackPriced += 1;
                if (isUsd && now - row.lastFetchedAt <= args.priceStaleMs) freshFallbackUsd += 1;
            }
        }

        const evaluation = evaluatePegObservation({
            peg,
            priceUsd: price?.priceUsd ?? null,
            priceUpdatedAt: price?.updatedAt ?? null,
            liquidityUsd: price?.liquidityUsd ?? null,
            now,
            isYield: variant?.kind === 'yield',
            priceStaleMs: args.priceStaleMs,
            minLiquidityUsd: args.minLiquidityUsd,
        });
        if (!evaluation.ok) {
            result.issues[evaluation.issue] += 1;
            if (evaluation.issue === 'unsupported_peg') result.unsupported += 1;
        }

        const prev = prevByAddress.get(mint) ?? null;
        if (prev && prev.tier !== null) previouslyTiered += 1;
        const { row, event } = buildPegGuardRow({
            prev,
            address: mint,
            symbol: variant?.symbol ?? snapshot.entriesByMint[mint]?.symbol ?? null,
            peg,
            price,
            evaluation,
            source: trigger,
            now,
        });
        nextRows.push(row);
        result.tierCounts[row.tier ?? 'null'] += 1;
        if (event) {
            events.push(event);
            if (prev && prev.tier !== null) flips += 1;
        }
    }
    result.processed = nextRows.length;
    result.tierChanges = events.length;
    // Total failure only when Birdeye is down and nothing stored is usable either.
    if (birdeyeFailed && result.fallbackPriced === 0) result.ok = false;

    // Circuit: a large share of previously tiered mints flipping in one run is a
    // price-feed incident (or a market-wide event). Persist, but do not act.
    let skipReconcile = false;
    if (previouslyTiered >= FLIP_GUARD_MIN_TRACKED) {
        const sharePct = (flips / previouslyTiered) * 100;
        if (sharePct > args.maxTierFlipSharePct) {
            log({
                ...base,
                event: 'depeg_circuit_open',
                reason: 'mass_tier_flip',
                flips,
                tracked: previouslyTiered,
                share_pct: Math.round(sharePct * 10) / 10,
                max_share_pct: args.maxTierFlipSharePct,
                ignored: args.ignoreCircuitBreaker,
            });
            if (!args.ignoreCircuitBreaker) {
                result.circuit = 'mass_tier_flip';
                skipReconcile = true;
            }
        }
    }
    // Circuit: Birdeye failed and the fallback covers too few USD mints with a
    // fresh price to trust any tier this run produced.
    if (birdeyeFailed && freshFallbackUsd < usdMints.length * FALLBACK_MIN_FRESH_SHARE) {
        log({
            ...base,
            event: 'depeg_circuit_open',
            reason: 'price_fetch_failed',
            usd_mints: usdMints.length,
            fresh_fallback: freshFallbackUsd,
            ignored: args.ignoreCircuitBreaker,
        });
        if (!args.ignoreCircuitBreaker) {
            result.circuit = result.circuit ?? 'price_fetch_failed';
            skipReconcile = true;
        }
    }

    if (nextRows.length > 0) await pegGuard.repo.upsertLatest(nextRows);
    if (events.length > 0) await pegGuard.repo.insertTierEvents(events);
    for (const event of events) {
        const row = nextRows.find(r => r.address === event.address);
        log({
            ...base,
            event: 'depeg_tier_changed',
            source: event.source,
            mint: event.address,
            symbol: row?.symbol ?? null,
            old_tier: event.oldTier,
            new_tier: event.newTier,
            deviation_pct: event.deviationPct,
            price_usd: event.priceUsd,
            peg_usd: event.pegUsd,
            liquidity_usd: event.liquidityUsd,
            price_source: row?.priceSource ?? null,
        });
    }

    if (!skipReconcile && usdMints.length > 0) {
        const [webacyRows, advisories, lastAdminClearAtByMint] = await Promise.all([
            deps.repo.listDepegLatest(DEPEG_CHAIN),
            deps.repo.listAdvisoriesForReconcile(usdMints),
            deps.repo.listLastAdminClearAtByMints(usdMints),
        ]);
        const webacyByAddress = new Map(webacyRows.map(row => [row.address, row] as const));
        const advisoryByMint = new Map(advisories.map(a => [a.mint, a] as const));
        const rowByAddress = new Map(nextRows.map(row => [row.address, row] as const));

        const observations: ReconcilerObservation[] = [];
        for (const mint of usdMints) {
            const row = rowByAddress.get(mint)!;
            const webacyRow = webacyByAddress.get(mint);
            const covered = webacyCoversMint(webacyRow, now, args.webacyCoverageMs);
            if (covered) result.ownedByWebacy += 1;
            // Two observers with a tier each, disagreeing on healthy vs bad:
            // worth a look either way (feed skew, or one of them is early).
            if (
                webacyRow &&
                webacyRow.tier !== null &&
                row.tier !== null &&
                isBadTier(webacyRow.tier) !== isBadTier(row.tier)
            ) {
                log({
                    ...base,
                    event: 'peg_guard_disagreement',
                    mint,
                    symbol: row.symbol,
                    webacy_tier: webacyRow.tier,
                    webacy_last_ok_at: webacyRow.lastOkAt,
                    webacy_covers: covered,
                    peg_guard_tier: row.tier,
                    deviation_pct: row.deviationPct,
                });
            }
            // Webacy owns the mint while fresh; the peg guard still reconciles a
            // row it set itself (during a Webacy outage) so it can be cleared.
            const ownsAdvisory = advisoryByMint.get(mint)?.source === 'peg_guard';
            if (!covered || ownsAdvisory) observations.push(toObservation(row, inRegistryByMint.get(mint) ?? false));
        }
        result.reconciled = observations.length;

        if (observations.length > 0) {
            const clearTiers: PegTier[] = args.clearOnWatch ? ['ok', 'premium', 'watch'] : ['ok', 'premium'];
            const decision = reconcileDepegAdvisories({
                observations,
                advisories,
                lastAdminClearAtByMint,
                now: deps.now(),
                config: {
                    setTiers: ['warning', 'critical'],
                    criticalImmediate: args.criticalImmediate,
                    criticalConfirmMs: args.criticalConfirmMs,
                    warningConfirmMs: args.warningConfirmMs,
                    clearTiers,
                    clearCooldownMs: args.clearCooldownMs,
                    staleObservationMs: args.staleObservationMs,
                    maxActionsPerRun: args.maxActionsPerRun,
                },
            });
            for (const skip of decision.skips) {
                countSkip(skip.why);
                // `unchanged` is the steady state for every healthy mint.
                if (skip.why === 'unchanged') continue;
                log({ ...base, event: 'depeg_advisory_skipped', mint: skip.mint, why: skip.why });
            }
            if (decision.overflow > 0) {
                result.circuit = result.circuit ?? 'mass_action';
                log({
                    ...base,
                    event: 'depeg_circuit_open',
                    reason: 'mass_action',
                    actions: decision.actions.length + decision.overflow,
                    applied: decision.actions.length,
                    dropped: decision.overflow,
                    max_actions_per_run: args.maxActionsPerRun,
                });
            }
            for (const action of decision.actions) {
                if (overBudget()) {
                    result.partial = true;
                    countSkip('max_actions_exceeded');
                    continue;
                }
                await applyAction(deps, action, dryRun, base, log, result);
            }
        }
    }

    log({
        ...base,
        event: 'peg_guard_summary',
        ok: result.ok,
        tracked: result.tracked,
        priced: result.priced,
        fallback_priced: result.fallbackPriced,
        unsupported: result.unsupported,
        issues: result.issues,
        tier_counts: result.tierCounts,
        tier_changes: result.tierChanges,
        owned_by_webacy: result.ownedByWebacy,
        reconciled: result.reconciled,
        actions_set: result.actionsSet,
        actions_updated: result.actionsUpdated,
        actions_cleared: result.actionsCleared,
        skipped: result.skipped,
        circuit: result.circuit,
        partial: result.partial ?? false,
        duration_ms: deps.now() - start,
    });
    return finish();
}
