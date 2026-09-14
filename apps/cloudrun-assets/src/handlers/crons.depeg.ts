/**
 * Webacy stablecoin depeg pipeline on the jobs worker.
 *
 * - `reconcile-stablecoin-depeg`: targeted (webhook nudge / manual, `mints`
 *   present) or sweep (Cloud Scheduler). Fetches the depeg monitor, advances
 *   per-mint tier-streak state in `webacy_depeg_latest`, appends tier events,
 *   and runs the pure reconciler (depegReconciler.ts) to set / re-word / clear
 *   system-owned `caution` advisories.
 * - `refresh-stablecoin-structural-health`: daily v3 structural grades.
 *
 * Separate `DepegCronDeps` job group (pattern: crons.prestocks.ts) so the
 * existing Webacy token-risk client and its fixtures stay untouched.
 *
 * Every log line is single-line JSON with `event`, `job`, `trigger`,
 * `dry_run`; alert-rules/stablecoin-depeg-*.json key off `event`.
 */

import { Effect } from 'effect';
import { BadRequestError } from '@tokens/effect';
import { decodeJobArgs, type JobArgSpecs } from '@tokens/effect/job-args';
import { STRUCTURAL_GRADES, type PegTier, type StructuralGrade } from '@tokens/asset-registry';

import type { CronResult } from './crons';
import type { CuratedMembershipSource } from './curatedMembershipReads';
import {
    normalizeStructuralHealth as normalizeStructural,
    type NormalizedStructuralHealth,
    type WebacyDepegItem,
} from './depegNormalize';
import {
    reconcileDepegAdvisories,
    type ReconcilerAction,
    type ReconcilerAdvisory,
    type ReconcilerObservation,
    type ReconcilerSkipReason,
} from './depegReconciler';

export const DEPEG_CHAIN = 'solana';
const CURRENCIES_SLUG = 'currencies';
const HOUR_MS = 60 * 60_000;
/** Below this many previously covered tokens the shrink guard has no signal. */
const SHRINK_GUARD_MIN_PREVIOUS = 5;
/** Below this many tracked tokens a flip share is noise, not a vendor incident. */
const FLIP_GUARD_MIN_TRACKED = 4;

export type DepegTrigger = 'webhook' | 'sweep' | 'manual';

export type DepegTokenResult =
    { ok: true; status: number; item: WebacyDepegItem } | { ok: false; status: number; message: string };

export type DepegListResult =
    | { ok: true; items: WebacyDepegItem[]; pages: number; truncated: boolean }
    | { ok: false; status: number; message: string };

export interface StructuralHealthBatchEntry {
    address: string;
    ok: boolean;
    status: number;
    data?: unknown;
    message?: string;
}

export interface WebacyDepegClient {
    isConfigured(): boolean;
    fetchDepegToken(args: { chain: string; address: string }): Promise<DepegTokenResult>;
    fetchDepegList(args: { chain: string; pageSize: number; maxPages: number }): Promise<DepegListResult>;
    fetchStructuralHealthBatch(
        addresses: ReadonlyArray<{ address: string; chain: string }>,
    ): Promise<StructuralHealthBatchEntry[]>;
}

/** One `webacy_depeg_latest` row (camelCase). Unix ms timestamps. */
export interface DepegLatestRow {
    chain: string;
    address: string;
    ok: boolean;
    status: number;
    symbol: string | null;
    tier: PegTier | null;
    overallRisk: number | null;
    deviationPct: number | null;
    priceUsd: number | null;
    pegUsd: number | null;
    tags: string[] | null;
    prevTier: PegTier | null;
    tierSinceAt: number | null;
    badSinceAt: number | null;
    observations: number;
    inRegistry: boolean;
    lastSeenInListAt: number | null;
    lastSource: DepegTrigger | null;
    payloadJson: string | null;
    errorMessage: string | null;
    /** Unix ms of the last fetch attempt (success or failure). */
    lastFetchedAt: number;
    /** Unix ms of the last successful fetch; untouched by failures so staleness is measurable. */
    lastOkAt: number | null;
}

export interface DepegTierEventRow {
    chain: string;
    address: string;
    oldTier: PegTier | null;
    newTier: PegTier;
    overallRisk: number | null;
    deviationPct: number | null;
    priceUsd: number | null;
    pegUsd: number | null;
    source: DepegTrigger;
    webhookEventId: string | null;
    observedAt: number;
}

export interface StructuralHealthLatestRow {
    chain: string;
    address: string;
    ok: boolean;
    status: number;
    compositeGrade: StructuralGrade | null;
    compositeScore: number | null;
    categoryScores: NormalizedStructuralHealth['categoryScores'] | null;
    criteriaFailCount: number | null;
    criteriaWarnCount: number | null;
    payloadJson: string | null;
    errorMessage: string | null;
    lastFetchedAt: number;
    lastOkAt: number | null;
}

export interface StructuralHealthDailyRow {
    chain: string;
    address: string;
    /** UTC calendar day, `YYYY-MM-DD`. */
    day: string;
    compositeGrade: StructuralGrade | null;
    compositeScore: number | null;
    categoryScores: NormalizedStructuralHealth['categoryScores'] | null;
    recordedAt: number;
}

export type SetSystemAdvisoryOutcome = 'set' | 'updated' | 'unchanged' | 'skipped_human_owned' | 'variant_not_found';
export type ClearSystemAdvisoryOutcome = 'cleared' | 'skipped_not_system' | 'not_found';

export interface DepegRepo {
    listDepegLatest(chain: string): Promise<DepegLatestRow[]>;
    upsertDepegLatest(rows: readonly DepegLatestRow[]): Promise<void>;
    insertDepegTierEvents(rows: readonly DepegTierEventRow[]): Promise<void>;
    /** Active Solana variants among `mints`, with the parent asset's symbol. */
    listActiveSolanaVariantMints(
        mints: readonly string[],
    ): Promise<Map<string, { assetId: string; symbol: string | null }>>;
    listAdvisoriesForReconcile(mints: readonly string[]): Promise<ReconcilerAdvisory[]>;
    /** Latest `action='clear' AND source='admin'` event time per mint. */
    listLastAdminClearAtByMints(mints: readonly string[]): Promise<Map<string, number>>;
    setSystemAdvisory(args: { mint: string; reason: string; nowMs: number }): Promise<SetSystemAdvisoryOutcome>;
    clearSystemAdvisory(args: { mint: string; note: string; nowMs: number }): Promise<ClearSystemAdvisoryOutcome>;
    upsertStructuralHealthLatest(rows: readonly StructuralHealthLatestRow[]): Promise<void>;
    upsertStructuralHealthDaily(rows: readonly StructuralHealthDailyRow[]): Promise<void>;
    listStructuralHealthLatest(chain: string): Promise<StructuralHealthLatestRow[]>;
    /** Addresses in `webacy_depeg_latest` with `in_registry = true`. */
    listStructuralTargets(): Promise<string[]>;
}

export interface DepegCronDeps {
    webacyDepeg: WebacyDepegClient;
    repo: DepegRepo;
    curated: CuratedMembershipSource;
    now: () => number;
    /** Env `WEBACY_DEPEG_REFRESH_ENABLED === 'true'` by default. */
    isRefreshEnabled?: () => boolean;
    /** Env `WEBACY_DEPEG_DRY_RUN`, defaulting to true when unset. */
    isDryRunDefault?: () => boolean;
    /** Structured-log seam; production prints one JSON line per call. */
    log?: (line: Record<string, unknown>) => void;
}

function defaultIsRefreshEnabled(): boolean {
    return (process.env.WEBACY_DEPEG_REFRESH_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/** Dry-run is the safe default: writes only start once the env var is explicitly 'false'. */
function defaultIsDryRun(): boolean {
    return (process.env.WEBACY_DEPEG_DRY_RUN ?? '').trim().toLowerCase() !== 'false';
}

function defaultLog(line: Record<string, unknown>): void {
    console.log(JSON.stringify(line));
}

function isDepegTrigger(value: unknown): value is DepegTrigger {
    return value === 'webhook' || value === 'sweep' || value === 'manual';
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

function isBadTier(tier: PegTier | null): boolean {
    return tier === 'warning' || tier === 'critical';
}

/**
 * Pure tier-streak update. Same tier: count the observation, keep both
 * anchors. Different tier: restart `tierSinceAt`; `badSinceAt` survives a
 * warning<->critical flip (one episode) and resets when leaving the bad tiers.
 */
export function advanceDepegState(
    prev: Pick<DepegLatestRow, 'tier' | 'tierSinceAt' | 'badSinceAt' | 'observations'> | null,
    tier: PegTier | null,
    now: number,
): {
    prevTier: PegTier | null;
    tierSinceAt: number | null;
    badSinceAt: number | null;
    observations: number;
    changed: boolean;
} {
    if (prev && prev.tier === tier) {
        return {
            prevTier: null,
            tierSinceAt: prev.tierSinceAt ?? now,
            badSinceAt: isBadTier(tier) ? (prev.badSinceAt ?? now) : null,
            observations: prev.observations + 1,
            changed: false,
        };
    }
    const prevTier = prev?.tier ?? null;
    let badSinceAt: number | null = null;
    if (isBadTier(tier)) badSinceAt = prev && isBadTier(prev.tier) ? (prev.badSinceAt ?? now) : now;
    return { prevTier, tierSinceAt: now, badSinceAt, observations: 1, changed: tier !== null };
}

function emptyTierCounts(): Record<PegTier | 'null', number> {
    return { ok: 0, watch: 0, warning: 0, critical: 0, premium: 0, null: 0 };
}

function toObservation(row: DepegLatestRow): ReconcilerObservation {
    return {
        mint: row.address,
        symbol: row.symbol,
        inRegistry: row.inRegistry,
        ok: row.ok,
        tier: row.tier,
        prevTier: row.prevTier,
        overallRisk: row.overallRisk,
        deviationPct: row.deviationPct,
        priceUsd: row.priceUsd,
        pegUsd: row.pegUsd,
        tierSinceAt: row.tierSinceAt,
        badSinceAt: row.badSinceAt,
        // Staleness is measured from the last *successful* fetch: a run of
        // failed polls must age the observation out, not keep it fresh.
        lastFetchedAt: row.lastOkAt ?? row.lastFetchedAt,
    };
}

interface BuildRowInput {
    prev: DepegLatestRow | null;
    address: string;
    result: DepegTokenResult;
    registrySymbol: string | null | undefined;
    inRegistry: boolean;
    seenInList: boolean;
    source: DepegTrigger;
    webhookEventId: string | null;
    now: number;
}

/** Builds the next `webacy_depeg_latest` row and, when the tier moved, its tier event. */
export function buildDepegRow(input: BuildRowInput): { row: DepegLatestRow; event: DepegTierEventRow | null } {
    const { prev, address, result, now } = input;
    if (!result.ok) {
        // Keep the last good observation so a provider outage never blanks the
        // tier the reconciler and the API read; `ok=false` says it is stale.
        const base: DepegLatestRow = prev ?? {
            chain: DEPEG_CHAIN,
            address,
            ok: false,
            status: result.status,
            symbol: input.registrySymbol ?? null,
            tier: null,
            overallRisk: null,
            deviationPct: null,
            priceUsd: null,
            pegUsd: null,
            tags: null,
            prevTier: null,
            tierSinceAt: null,
            badSinceAt: null,
            observations: 0,
            inRegistry: input.inRegistry,
            lastSeenInListAt: null,
            lastSource: null,
            payloadJson: null,
            errorMessage: null,
            lastFetchedAt: now,
            lastOkAt: null,
        };
        return {
            row: {
                ...base,
                ok: false,
                status: result.status,
                inRegistry: input.inRegistry,
                lastSource: input.source,
                errorMessage: result.message,
                lastFetchedAt: now,
                lastOkAt: prev?.lastOkAt ?? null,
            },
            event: null,
        };
    }
    const item = result.item;
    const state = advanceDepegState(prev, item.tier, now);
    const row: DepegLatestRow = {
        chain: DEPEG_CHAIN,
        address,
        ok: true,
        status: result.status,
        symbol: input.registrySymbol ?? item.symbol ?? prev?.symbol ?? null,
        tier: item.tier,
        overallRisk: item.overallRisk,
        deviationPct: item.deviationPct,
        priceUsd: item.priceUsd,
        pegUsd: item.pegUsd,
        tags: item.tags.length > 0 ? item.tags : null,
        prevTier: state.changed ? state.prevTier : (prev?.prevTier ?? null),
        tierSinceAt: state.tierSinceAt,
        badSinceAt: state.badSinceAt,
        observations: state.observations,
        inRegistry: input.inRegistry,
        lastSeenInListAt: input.seenInList ? now : (prev?.lastSeenInListAt ?? null),
        lastSource: input.source,
        payloadJson: JSON.stringify(item.raw),
        errorMessage: null,
        lastFetchedAt: now,
        lastOkAt: now,
    };
    const event: DepegTierEventRow | null =
        state.changed && item.tier !== null
            ? {
                  chain: DEPEG_CHAIN,
                  address,
                  oldTier: state.prevTier,
                  newTier: item.tier,
                  overallRisk: item.overallRisk,
                  deviationPct: item.deviationPct,
                  priceUsd: item.priceUsd,
                  pegUsd: item.pegUsd,
                  source: input.source,
                  webhookEventId: input.webhookEventId,
                  observedAt: now,
              }
            : null;
    return { row, event };
}

// Literal specs (not the clampedInt/boolWithDefault helpers) so DecodedJobArgs
// can narrow each field's type; the helpers return the wide JobArgSpec union.
const RECONCILE_ARG_SPECS = {
    requireRefreshEnabled: { kind: 'bool', fallback: true },
    mints: { kind: 'targets', label: 'mints' },
    pageSize: { kind: 'int', fallback: 100, min: 10, max: 200 },
    maxPages: { kind: 'int', fallback: 3, min: 1, max: 20 },
    criticalImmediate: { kind: 'bool', fallback: true },
    warningConfirmMs: { kind: 'int', fallback: 0, min: 0, max: 6 * HOUR_MS },
    clearCooldownMs: { kind: 'int', fallback: 6 * HOUR_MS, min: 0, max: 48 * HOUR_MS },
    clearOnWatch: { kind: 'bool', fallback: false },
    maxActionsPerRun: { kind: 'int', fallback: 5, min: 1, max: 100 },
    shrinkGuardRatio: { kind: 'int', fallback: 70, min: 0, max: 100 },
    maxTierFlipSharePct: { kind: 'int', fallback: 25, min: 0, max: 100 },
    ignoreCircuitBreaker: { kind: 'bool', fallback: false },
    staleObservationMs: { kind: 'int', fallback: 9 * HOUR_MS, min: 60_000, max: 72 * HOUR_MS },
    budgetMs: { kind: 'int', fallback: 0, min: 0, max: 3_600_000 },
} as const satisfies JobArgSpecs;

function readOptionalString(raw: unknown, key: string): string | null {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new BadRequestError({ message: `${key} must be a string` });
    return value.trim() || null;
}

export interface DepegReconcileResult extends CronResult {
    mode: 'targeted' | 'sweep';
    dryRun: boolean;
    disabled?: boolean;
    reason?: string;
    tokensReturned: number;
    tracked: number;
    tierCounts: Record<PegTier | 'null', number>;
    tierChanges: number;
    actionsSet: number;
    actionsUpdated: number;
    actionsCleared: number;
    skipped: Partial<Record<ReconcilerSkipReason | 'missing_from_list', number>>;
    circuit: 'suspicious_drop' | 'mass_tier_flip' | 'mass_action' | null;
    truncated: boolean;
}

export async function reconcileStablecoinDepeg(deps: DepegCronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = await Effect.runPromise(decodeJobArgs(RECONCILE_ARG_SPECS, rawArgs));
    const rawTrigger = readOptionalString(rawArgs, 'trigger');
    if (rawTrigger !== null && !isDepegTrigger(rawTrigger)) {
        throw new BadRequestError({ message: 'trigger must be webhook, sweep or manual' });
    }
    const webhookEventId = readOptionalString(rawArgs, 'webhookEventId');
    const dryRunArg = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>).dryRun : undefined;
    if (dryRunArg !== undefined && typeof dryRunArg !== 'boolean') {
        throw new BadRequestError({ message: 'dryRun must be a boolean' });
    }

    const mode: 'targeted' | 'sweep' = args.mints ? 'targeted' : 'sweep';
    const trigger: DepegTrigger = rawTrigger ?? (mode === 'sweep' ? 'sweep' : 'manual');
    const dryRun = dryRunArg ?? (deps.isDryRunDefault ?? defaultIsDryRun)();
    const log = deps.log ?? defaultLog;
    const job = 'reconcile-stablecoin-depeg';
    const base = { job, trigger, dry_run: dryRun, mode };
    const start = deps.now();
    const budgetMs = args.budgetMs > 0 ? args.budgetMs : mode === 'targeted' ? 30_000 : 90_000;
    const overBudget = () => deps.now() - start >= budgetMs;

    const result: DepegReconcileResult = {
        ok: true,
        processed: 0,
        durationMs: 0,
        mode,
        dryRun,
        tokensReturned: 0,
        tracked: 0,
        tierCounts: emptyTierCounts(),
        tierChanges: 0,
        actionsSet: 0,
        actionsUpdated: 0,
        actionsCleared: 0,
        skipped: {},
        circuit: null,
        truncated: false,
    };
    const finish = (): DepegReconcileResult => ({ ...result, durationMs: deps.now() - start });
    const countSkip = (why: keyof DepegReconcileResult['skipped']) => {
        result.skipped[why] = (result.skipped[why] ?? 0) + 1;
    };

    if (args.requireRefreshEnabled && !(deps.isRefreshEnabled ?? defaultIsRefreshEnabled)()) {
        return { ...finish(), disabled: true, reason: 'depeg_refresh_disabled' };
    }
    if (!deps.webacyDepeg.isConfigured()) {
        return { ...finish(), disabled: true, reason: 'webacy_not_configured' };
    }

    const snapshot = await deps.curated.getSnapshot();
    const currencies = unique(snapshot.mintsByList[CURRENCIES_SLUG] ?? []);
    const currencySet = new Set(currencies);
    const symbolFromSnapshot = (mint: string): string | null => snapshot.entriesByMint[mint]?.symbol ?? null;

    const prevRows = await deps.repo.listDepegLatest(DEPEG_CHAIN);
    const prevByAddress = new Map(prevRows.map(row => [row.address, row] as const));

    const nextRows: DepegLatestRow[] = [];
    const events: DepegTierEventRow[] = [];
    const observations: ReconcilerObservation[] = [];
    let flipsAmongPreviouslyTracked = 0;

    if (mode === 'targeted') {
        const mints = args.mints ?? [];
        const registry = await deps.repo.listActiveSolanaVariantMints(mints);
        for (const mint of mints) {
            if (overBudget()) {
                result.partial = true;
                break;
            }
            const inRegistry = registry.has(mint);
            if (!inRegistry && !currencySet.has(mint)) {
                // A nudge for a mint we do not list: nothing to protect, save the CU.
                countSkip('not_in_registry');
                log({ ...base, event: 'depeg_advisory_skipped', mint, why: 'not_in_registry' });
                continue;
            }
            const fetched = await deps.webacyDepeg.fetchDepegToken({ chain: DEPEG_CHAIN, address: mint });
            result.processed += 1;
            if (fetched.ok) result.tokensReturned += 1;
            else log({ ...base, event: 'depeg_poll_failed', mint, status: fetched.status, message: fetched.message });
            const prev = prevByAddress.get(mint) ?? null;
            const { row, event } = buildDepegRow({
                prev,
                address: mint,
                result: fetched,
                registrySymbol: registry.get(mint)?.symbol ?? symbolFromSnapshot(mint),
                inRegistry,
                seenInList: false,
                source: trigger,
                webhookEventId,
                now: deps.now(),
            });
            nextRows.push(row);
            if (event) events.push(event);
            observations.push(toObservation(row));
        }
        if (result.processed > 0 && result.tokensReturned === 0) {
            result.ok = false;
            await deps.repo.upsertDepegLatest(nextRows);
            return finish();
        }
    } else {
        const list = await deps.webacyDepeg.fetchDepegList({
            chain: DEPEG_CHAIN,
            pageSize: args.pageSize,
            maxPages: args.maxPages,
        });
        if (!list.ok) {
            log({ ...base, event: 'depeg_poll_failed', status: list.status, message: list.message });
            result.ok = false;
            return finish();
        }
        result.tokensReturned = list.items.length;
        result.truncated = list.truncated;
        if (list.truncated) {
            log({
                ...base,
                event: 'depeg_list_truncated',
                pages: list.pages,
                page_size: args.pageSize,
                items: list.items.length,
            });
        }

        const itemsByAddress = new Map<string, WebacyDepegItem>();
        for (const item of list.items) if (!itemsByAddress.has(item.address)) itemsByAddress.set(item.address, item);
        const registry = await deps.repo.listActiveSolanaVariantMints([...itemsByAddress.keys()]);
        const trackedInList = [...itemsByAddress.keys()].filter(addr => registry.has(addr) || currencySet.has(addr));
        result.tracked = trackedInList.length;

        // Circuit A: Webacy suddenly covers far fewer of our tokens than last
        // time. Treat as a vendor incident, not as everyone recovering.
        const previouslyCovered = prevRows.filter(row => row.lastSeenInListAt !== null).map(row => row.address);
        if (previouslyCovered.length >= SHRINK_GUARD_MIN_PREVIOUS) {
            const threshold = (previouslyCovered.length * args.shrinkGuardRatio) / 100;
            if (trackedInList.length < threshold) {
                log({
                    ...base,
                    event: 'depeg_circuit_open',
                    reason: 'suspicious_drop',
                    previously_covered: previouslyCovered.length,
                    covered_now: trackedInList.length,
                    ratio_pct: args.shrinkGuardRatio,
                    ignored: args.ignoreCircuitBreaker,
                });
                if (!args.ignoreCircuitBreaker) {
                    result.circuit = 'suspicious_drop';
                    log({
                        ...base,
                        event: 'depeg_poll_summary',
                        ...summaryFields(result),
                        covered: trackedInList.length,
                    });
                    return finish();
                }
            }
        }

        const trackedSet = new Set(trackedInList);
        for (const address of previouslyCovered) {
            if (!trackedSet.has(address)) {
                countSkip('missing_from_list');
                log({
                    ...base,
                    event: 'depeg_tracked_token_missing',
                    mint: address,
                    symbol: prevByAddress.get(address)?.symbol ?? null,
                });
            }
        }

        const observedAt = deps.now();
        for (const address of trackedInList) {
            const item = itemsByAddress.get(address)!;
            const prev = prevByAddress.get(address) ?? null;
            const { row, event } = buildDepegRow({
                prev,
                address,
                result: { ok: true, status: 200, item },
                registrySymbol: registry.get(address)?.symbol ?? symbolFromSnapshot(address),
                inRegistry: registry.has(address),
                seenInList: true,
                source: 'sweep',
                webhookEventId: null,
                now: observedAt,
            });
            nextRows.push(row);
            if (event) {
                events.push(event);
                if (prev && prev.tier !== null) flipsAmongPreviouslyTracked += 1;
            }
            observations.push(toObservation(row));
        }
        result.processed = trackedInList.length;

        const gaps = currencies.filter(mint => !itemsByAddress.has(mint));
        if (gaps.length > 0) {
            log({
                ...base,
                event: 'depeg_coverage_gap',
                count: gaps.length,
                mints: gaps.slice(0, 100),
                symbols: gaps.slice(0, 100).map(symbolFromSnapshot),
            });
        }
    }

    for (const row of nextRows) result.tierCounts[row.tier ?? 'null'] += 1;
    result.tierChanges = events.length;

    // Circuit B (sweep only): a large share of tracked tokens flipping tier in
    // one poll is a data incident. Persist what we saw, but do not act on it.
    let skipReconcile = false;
    if (mode === 'sweep' && result.tracked >= FLIP_GUARD_MIN_TRACKED) {
        const sharePct = (flipsAmongPreviouslyTracked / result.tracked) * 100;
        if (sharePct > args.maxTierFlipSharePct) {
            log({
                ...base,
                event: 'depeg_circuit_open',
                reason: 'mass_tier_flip',
                flips: flipsAmongPreviouslyTracked,
                tracked: result.tracked,
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

    if (nextRows.length > 0) await deps.repo.upsertDepegLatest(nextRows);
    if (events.length > 0) await deps.repo.insertDepegTierEvents(events);
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
            overall_risk: event.overallRisk,
            deviation_pct: event.deviationPct,
            price_usd: event.priceUsd,
            peg_usd: event.pegUsd,
            in_registry: row?.inRegistry ?? false,
            webhook_event_id: event.webhookEventId,
        });
    }

    if (!skipReconcile && observations.length > 0) {
        const mints = observations.map(o => o.mint);
        const [advisories, lastAdminClearAtByMint] = await Promise.all([
            deps.repo.listAdvisoriesForReconcile(mints),
            deps.repo.listLastAdminClearAtByMints(mints),
        ]);
        const clearTiers: PegTier[] = args.clearOnWatch ? ['ok', 'premium', 'watch'] : ['ok', 'premium'];
        const decision = reconcileDepegAdvisories({
            observations,
            advisories,
            lastAdminClearAtByMint,
            now: deps.now(),
            config: {
                setTiers: ['warning', 'critical'],
                criticalImmediate: args.criticalImmediate,
                warningConfirmMs: args.warningConfirmMs,
                clearTiers,
                clearCooldownMs: args.clearCooldownMs,
                staleObservationMs: args.staleObservationMs,
                maxActionsPerRun: args.maxActionsPerRun,
            },
        });
        for (const skip of decision.skips) {
            countSkip(skip.why);
            // `unchanged` is the steady state for every healthy token; logging it
            // per mint per sweep would drown the useful skips.
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

    log({ ...base, event: 'depeg_poll_summary', ...summaryFields(result) });
    return finish();
}

function summaryFields(result: DepegReconcileResult): Record<string, unknown> {
    return {
        ok: result.ok,
        tokens_returned: result.tokensReturned,
        tracked: result.tracked,
        processed: result.processed,
        tier_counts: result.tierCounts,
        tier_changes: result.tierChanges,
        actions_set: result.actionsSet,
        actions_updated: result.actionsUpdated,
        actions_cleared: result.actionsCleared,
        skipped: result.skipped,
        circuit: result.circuit,
        truncated: result.truncated,
        partial: result.partial ?? false,
    };
}

async function applyAction(
    deps: DepegCronDeps,
    action: ReconcilerAction,
    dryRun: boolean,
    base: Record<string, unknown>,
    log: (line: Record<string, unknown>) => void,
    result: DepegReconcileResult,
): Promise<void> {
    const nowMs = deps.now();
    if (action.kind === 'clear') {
        if (dryRun) {
            log({
                ...base,
                event: 'depeg_advisory_would_clear',
                mint: action.mint,
                note: action.note,
                why: action.why,
            });
            return;
        }
        const outcome = await deps.repo.clearSystemAdvisory({ mint: action.mint, note: action.note, nowMs });
        if (outcome === 'cleared') {
            result.actionsCleared += 1;
            log({ ...base, event: 'depeg_advisory_cleared', mint: action.mint, note: action.note, why: action.why });
        } else {
            log({ ...base, event: 'depeg_advisory_skipped', mint: action.mint, why: outcome });
        }
        return;
    }
    const wouldEvent = action.kind === 'set' ? 'depeg_advisory_would_set' : 'depeg_advisory_would_update';
    if (dryRun) {
        log({
            ...base,
            event: wouldEvent,
            mint: action.mint,
            tier: action.tier,
            why: action.why,
            reason: action.reason,
        });
        return;
    }
    const outcome = await deps.repo.setSystemAdvisory({ mint: action.mint, reason: action.reason, nowMs });
    if (outcome === 'set') {
        result.actionsSet += 1;
        log({
            ...base,
            event: 'depeg_advisory_set',
            mint: action.mint,
            tier: action.tier,
            why: action.why,
            reason: action.reason,
        });
    } else if (outcome === 'updated') {
        result.actionsUpdated += 1;
        log({
            ...base,
            event: 'depeg_advisory_updated',
            mint: action.mint,
            tier: action.tier,
            why: action.why,
            reason: action.reason,
        });
    } else {
        log({ ...base, event: 'depeg_advisory_skipped', mint: action.mint, why: outcome });
    }
}

const STRUCTURAL_ARG_SPECS = {
    requireRefreshEnabled: { kind: 'bool', fallback: true },
    batchSize: { kind: 'int', fallback: 100, min: 1, max: 100 },
    budgetMs: { kind: 'int', fallback: 0, min: 0, max: 3_600_000 },
} as const satisfies JobArgSpecs;

/** UTC calendar day for `webacy_structural_health_daily.day`. */
export function utcDayString(unixMs: number): string {
    return new Date(unixMs).toISOString().slice(0, 10);
}

function gradeIndex(grade: StructuralGrade | null): number | null {
    if (grade === null) return null;
    const index = (STRUCTURAL_GRADES as readonly string[]).indexOf(grade);
    return index >= 0 ? index : null;
}

export interface StructuralHealthRefreshResult extends CronResult {
    dryRun: boolean;
    disabled?: boolean;
    reason?: string;
    targets: number;
    succeeded: number;
    failed: number;
    gradeChanges: number;
}

export async function refreshStablecoinStructuralHealth(deps: DepegCronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = await Effect.runPromise(decodeJobArgs(STRUCTURAL_ARG_SPECS, rawArgs));
    const log = deps.log ?? defaultLog;
    const job = 'refresh-stablecoin-structural-health';
    const dryRun = (deps.isDryRunDefault ?? defaultIsDryRun)();
    // Structural grades are cache writes, never advisories, so dry-run is
    // reported for log symmetry only and does not gate anything.
    const base = { job, trigger: 'sweep' as const, dry_run: dryRun };
    const start = deps.now();
    const budgetMs = args.budgetMs > 0 ? args.budgetMs : 300_000;

    const result: StructuralHealthRefreshResult = {
        ok: true,
        processed: 0,
        durationMs: 0,
        dryRun,
        targets: 0,
        succeeded: 0,
        failed: 0,
        gradeChanges: 0,
    };
    const finish = (): StructuralHealthRefreshResult => ({ ...result, durationMs: deps.now() - start });

    if (args.requireRefreshEnabled && !(deps.isRefreshEnabled ?? defaultIsRefreshEnabled)()) {
        return { ...finish(), disabled: true, reason: 'depeg_refresh_disabled' };
    }
    if (!deps.webacyDepeg.isConfigured()) {
        return { ...finish(), disabled: true, reason: 'webacy_not_configured' };
    }

    const snapshot = await deps.curated.getSnapshot();
    const targets = unique([
        ...(await deps.repo.listStructuralTargets()),
        ...(snapshot.mintsByList[CURRENCIES_SLUG] ?? []),
    ]);
    result.targets = targets.length;
    if (targets.length === 0) return finish();

    const [previousRows, registry] = await Promise.all([
        deps.repo.listStructuralHealthLatest(DEPEG_CHAIN),
        deps.repo.listActiveSolanaVariantMints(targets),
    ]);
    const previous = new Map(previousRows.map(r => [r.address, r] as const));
    const symbolFor = (address: string): string | null =>
        registry.get(address)?.symbol ?? snapshot.entriesByMint[address]?.symbol ?? null;
    const latestRows: StructuralHealthLatestRow[] = [];
    const dailyRows: StructuralHealthDailyRow[] = [];

    for (let offset = 0; offset < targets.length; offset += args.batchSize) {
        if (deps.now() - start >= budgetMs) {
            result.partial = true;
            break;
        }
        const chunk = targets.slice(offset, offset + args.batchSize);
        const entries = await deps.webacyDepeg.fetchStructuralHealthBatch(
            chunk.map(address => ({ address, chain: DEPEG_CHAIN })),
        );
        const byAddress = new Map(entries.map(e => [e.address, e] as const));
        const fetchedAt = deps.now();
        for (const address of chunk) {
            const entry = byAddress.get(address) ?? {
                address,
                ok: false,
                status: 0,
                message: 'missing from batch response',
            };
            const prev = previous.get(address) ?? null;
            result.processed += 1;
            if (!entry.ok) {
                result.failed += 1;
                latestRows.push({
                    chain: DEPEG_CHAIN,
                    address,
                    ok: false,
                    status: entry.status,
                    compositeGrade: prev?.compositeGrade ?? null,
                    compositeScore: prev?.compositeScore ?? null,
                    categoryScores: prev?.categoryScores ?? null,
                    criteriaFailCount: prev?.criteriaFailCount ?? null,
                    criteriaWarnCount: prev?.criteriaWarnCount ?? null,
                    payloadJson: prev?.payloadJson ?? null,
                    errorMessage: entry.message ?? 'Request failed',
                    lastFetchedAt: fetchedAt,
                    lastOkAt: prev?.lastOkAt ?? null,
                });
                continue;
            }
            result.succeeded += 1;
            const normalized = normalizeStructural(entry.data);
            latestRows.push({
                chain: DEPEG_CHAIN,
                address,
                ok: true,
                status: entry.status,
                compositeGrade: normalized.compositeGrade,
                compositeScore: normalized.compositeScore,
                categoryScores: normalized.categoryScores,
                criteriaFailCount: normalized.failCount,
                criteriaWarnCount: normalized.warnCount,
                payloadJson: JSON.stringify(entry.data ?? null),
                errorMessage: null,
                lastFetchedAt: fetchedAt,
                lastOkAt: fetchedAt,
            });
            dailyRows.push({
                chain: DEPEG_CHAIN,
                address,
                day: utcDayString(fetchedAt),
                compositeGrade: normalized.compositeGrade,
                compositeScore: normalized.compositeScore,
                categoryScores: normalized.categoryScores,
                recordedAt: fetchedAt,
            });
            const oldGrade = prev?.compositeGrade ?? null;
            if (oldGrade !== normalized.compositeGrade) {
                result.gradeChanges += 1;
                const oldIndex = gradeIndex(oldGrade);
                const newIndex = gradeIndex(normalized.compositeGrade);
                log({
                    ...base,
                    event: 'structural_health_grade_changed',
                    mint: address,
                    symbol: symbolFor(address),
                    old_grade: oldGrade,
                    new_grade: normalized.compositeGrade,
                    old_score: prev?.compositeScore ?? null,
                    new_score: normalized.compositeScore,
                    // Positive = downgrade (towards F); null when either side is ungraded.
                    steps: oldIndex !== null && newIndex !== null ? newIndex - oldIndex : null,
                });
            }
        }
    }

    if (latestRows.length > 0) await deps.repo.upsertStructuralHealthLatest(latestRows);
    if (dailyRows.length > 0) await deps.repo.upsertStructuralHealthDaily(dailyRows);
    result.ok = !(result.processed > 0 && result.succeeded === 0);
    log({
        ...base,
        event: 'structural_health_refreshed',
        ok: result.ok,
        targets: result.targets,
        processed: result.processed,
        succeeded: result.succeeded,
        failed: result.failed,
        grade_changes: result.gradeChanges,
        partial: result.partial ?? false,
    });
    return finish();
}

export type DepegJobHandler = (deps: DepegCronDeps, args: unknown) => Promise<CronResult>;

export const depegJobs: Record<string, DepegJobHandler> = {
    'reconcile-stablecoin-depeg': reconcileStablecoinDepeg,
    'refresh-stablecoin-structural-health': refreshStablecoinStructuralHealth,
};
