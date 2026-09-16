/**
 * Pure decision engine for automated stablecoin depeg advisories.
 *
 * Given the latest Webacy depeg observation per mint, the live advisory rows,
 * and the last time a human cleared each mint, decide which `caution`
 * advisories the system should set, re-word, or clear. The same function runs
 * for a webhook-triggered targeted reconcile and for the scheduled sweep, so
 * every rule lives here exactly once.
 *
 * No IO, no clock, no logging: the caller supplies `now` and applies the
 * actions. Each mint is decided independently (a USDe warning never touches
 * USDC).
 */

import type { AdvisorySource, AdvisoryStatus, PegTier } from '@tokens/asset-registry';

export interface ReconcilerObservation {
    mint: string;
    symbol: string | null;
    /** Had an active asset_variants row at observation time. */
    inRegistry: boolean;
    /** False when the last fetch failed; `tier` is then the last good value. */
    ok: boolean;
    tier: PegTier | null;
    prevTier: PegTier | null;
    overallRisk: number | null;
    deviationPct: number | null;
    priceUsd: number | null;
    pegUsd: number | null;
    /** Unix ms when the current tier streak started. */
    tierSinceAt: number | null;
    /** Unix ms when the current warning/critical episode started. */
    badSinceAt: number | null;
    /** Unix ms of the last successful fetch. */
    lastFetchedAt: number;
}

export interface ReconcilerAdvisory {
    mint: string;
    status: AdvisoryStatus;
    reason: string;
    source: AdvisorySource;
    managedBySystem: boolean;
    setAt: number;
    updatedAt: number;
}

export interface ReconcilerConfig {
    /** Tiers that set a `caution` advisory (warning, critical). */
    setTiers: readonly PegTier[];
    /** Set on the first critical sighting regardless of `warningConfirmMs`. */
    criticalImmediate: boolean;
    /** How long a warning must persist before it sets an advisory. */
    warningConfirmMs: number;
    /** Tiers that count as healthy for the purposes of clearing. */
    clearTiers: readonly PegTier[];
    /** How long the tier must stay healthy before a system advisory clears. */
    clearCooldownMs: number;
    /** Observations older than this neither set nor clear. */
    staleObservationMs: number;
    /** Hard cap on writes per run (circuit C). */
    maxActionsPerRun: number;
}

export type ReconcilerAction =
    | {
          kind: 'set';
          mint: string;
          tier: 'warning' | 'critical';
          reason: string;
          url: null;
          why: 'enter_warning' | 'enter_critical';
      }
    | {
          kind: 'update_reason';
          mint: string;
          tier: 'warning' | 'critical';
          reason: string;
          url: null;
          why: 'tier_changed';
      }
    | { kind: 'clear'; mint: string; note: string; why: 'recovered' };

export type ReconcilerSkipReason =
    | 'not_in_registry'
    | 'no_observation'
    | 'stale_observation'
    | 'human_managed'
    | 'suppressed_by_human_clear'
    | 'hysteresis_pending'
    | 'cooldown_pending'
    | 'watch_tier'
    | 'premium_tier'
    | 'unchanged'
    | 'max_actions_exceeded';

export interface ReconcilerSkip {
    mint: string;
    why: ReconcilerSkipReason;
}

export interface ReconcilerInput {
    observations: readonly ReconcilerObservation[];
    advisories: readonly ReconcilerAdvisory[];
    lastAdminClearAtByMint: ReadonlyMap<string, number>;
    now: number;
    config: ReconcilerConfig;
}

export interface ReconcilerOutput {
    actions: ReconcilerAction[];
    skips: ReconcilerSkip[];
    /** Actions dropped by `maxActionsPerRun`; also reported as skips. */
    overflow: number;
}

const MAX_REASON_CHARS = 500;
const HOUR_MS = 60 * 60_000;

type BadTier = 'warning' | 'critical';

function isBadTier(tier: PegTier | null): tier is BadTier {
    return tier === 'warning' || tier === 'critical';
}

function tierLabel(tier: BadTier): 'Warning' | 'Critical' {
    return tier === 'warning' ? 'Warning' : 'Critical';
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/** `YYYY-MM-DD HH:mm` in UTC; the reason is public copy and must not depend on server locale. */
export function formatReasonTimestamp(unixMs: number): string {
    const d = new Date(unixMs);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function shortMint(mint: string): string {
    return mint.length <= 12 ? mint : `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function formatPeg(pegUsd: number): string {
    // Pegs are almost always 1; keep the shortest faithful decimal form.
    const fixed = pegUsd.toFixed(4).replace(/\.?0+$/, '');
    return fixed || '0';
}

/**
 * Public advisory reason. The tier word followed by ":" (or " as of" when no
 * deviation is available) is what `parseReasonTier` reads back, so the
 * reconciler can tell warning from critical without a separate column.
 */
export function buildDepegReason(input: {
    symbol: string | null;
    mint: string;
    tier: BadTier;
    deviationPct: number | null;
    pegUsd: number | null;
    observedAt: number;
}): string {
    const subject = input.symbol?.trim() ? input.symbol.trim() : shortMint(input.mint);
    const label = tierLabel(input.tier);
    const when = formatReasonTimestamp(input.observedAt);
    const tail = 'This is not a confirmation of lost backing. Verify redemptions and liquidity before trading.';
    let reason: string;
    if (input.deviationPct === null || !Number.isFinite(input.deviationPct)) {
        reason = `Webacy's depeg monitor rates ${subject} ${label} as of ${when} UTC. ${tail}`;
    } else {
        const direction = input.deviationPct < 0 ? 'below' : 'above';
        const magnitude = Math.abs(input.deviationPct).toFixed(2);
        const peg =
            input.pegUsd !== null && Number.isFinite(input.pegUsd) ? `its $${formatPeg(input.pegUsd)} peg` : 'its peg';
        reason = `Webacy's depeg monitor rates ${subject} ${label}: trading ${magnitude}% ${direction} ${peg} as of ${when} UTC. ${tail}`;
    }
    return reason.length > MAX_REASON_CHARS ? reason.slice(0, MAX_REASON_CHARS) : reason;
}

/** Reads the tier a system-written reason encodes; null for human or unrecognised text. */
export function parseReasonTier(reason: string): BadTier | null {
    const match = / (Warning|Critical)(?::| as of )/.exec(reason);
    if (!match) return null;
    return match[1] === 'Warning' ? 'warning' : 'critical';
}

export function buildClearNote(tier: PegTier, healthyForMs: number): string {
    const hours = Math.max(0, Math.floor(healthyForMs / HOUR_MS));
    return `Webacy tier ${tier} for ${hours}h`;
}

function actionRank(action: ReconcilerAction): number {
    // Criticals first (users are most exposed), clears last (least urgent).
    if (action.kind === 'set') return action.tier === 'critical' ? 0 : 2;
    if (action.kind === 'update_reason') return action.tier === 'critical' ? 1 : 3;
    return 4;
}

function decideMint(
    obs: ReconcilerObservation,
    advisory: ReconcilerAdvisory | undefined,
    lastAdminClearAt: number | undefined,
    now: number,
    config: ReconcilerConfig,
): ReconcilerAction | ReconcilerSkipReason {
    if (!obs.inRegistry) return 'not_in_registry';
    // A failed fetch carries the last good tier, which must not drive a clear
    // (the peg may have broken while the provider was down).
    if (!obs.ok || obs.tier === null) return 'no_observation';
    if (now - obs.lastFetchedAt > config.staleObservationMs) return 'stale_observation';
    if (advisory && !advisory.managedBySystem) return 'human_managed';

    const tier = obs.tier;

    if (isBadTier(tier) && config.setTiers.includes(tier)) {
        const badSince = obs.badSinceAt ?? obs.tierSinceAt ?? obs.lastFetchedAt;
        // An admin clear ends the automation's say for this episode only: a
        // fresh episode (new badSinceAt after the clear) may be flagged again.
        if (lastAdminClearAt !== undefined && lastAdminClearAt > badSince) return 'suppressed_by_human_clear';

        if (advisory) {
            const encoded = parseReasonTier(advisory.reason);
            if (encoded === tier) return 'unchanged';
            return {
                kind: 'update_reason',
                mint: obs.mint,
                tier,
                reason: buildDepegReason({
                    symbol: obs.symbol,
                    mint: obs.mint,
                    tier,
                    deviationPct: obs.deviationPct,
                    pegUsd: obs.pegUsd,
                    observedAt: obs.lastFetchedAt,
                }),
                url: null,
                why: 'tier_changed',
            };
        }

        const immediate = tier === 'critical' && config.criticalImmediate;
        if (!immediate && now - badSince < config.warningConfirmMs) return 'hysteresis_pending';
        return {
            kind: 'set',
            mint: obs.mint,
            tier,
            reason: buildDepegReason({
                symbol: obs.symbol,
                mint: obs.mint,
                tier,
                deviationPct: obs.deviationPct,
                pegUsd: obs.pegUsd,
                observedAt: obs.lastFetchedAt,
            }),
            url: null,
            why: tier === 'critical' ? 'enter_critical' : 'enter_warning',
        };
    }

    if (config.clearTiers.includes(tier)) {
        if (!advisory) {
            if (tier === 'premium') return 'premium_tier';
            if (tier === 'watch') return 'watch_tier';
            return 'unchanged';
        }
        const healthySince = obs.tierSinceAt ?? obs.lastFetchedAt;
        const healthyFor = now - healthySince;
        if (healthyFor < config.clearCooldownMs) return 'cooldown_pending';
        return { kind: 'clear', mint: obs.mint, note: buildClearNote(tier, healthyFor), why: 'recovered' };
    }

    // Neither a set nor a clear tier: an existing system advisory stays as is.
    if (tier === 'watch') return 'watch_tier';
    if (tier === 'premium') return 'premium_tier';
    return 'unchanged';
}

export function reconcileDepegAdvisories(input: ReconcilerInput): ReconcilerOutput {
    const advisoryByMint = new Map<string, ReconcilerAdvisory>();
    for (const advisory of input.advisories) advisoryByMint.set(advisory.mint, advisory);

    const candidates: ReconcilerAction[] = [];
    const skips: ReconcilerSkip[] = [];
    const seen = new Set<string>();

    for (const obs of input.observations) {
        // One decision per mint even if the caller passed duplicates.
        if (seen.has(obs.mint)) continue;
        seen.add(obs.mint);
        const decision = decideMint(
            obs,
            advisoryByMint.get(obs.mint),
            input.lastAdminClearAtByMint.get(obs.mint),
            input.now,
            input.config,
        );
        if (typeof decision === 'string') skips.push({ mint: obs.mint, why: decision });
        else candidates.push(decision);
    }

    // Stable sort: ties keep observation order so runs are reproducible.
    const ordered = candidates
        .map((action, index) => ({ action, index }))
        .sort((a, b) => actionRank(a.action) - actionRank(b.action) || a.index - b.index)
        .map(entry => entry.action);

    const cap = Math.max(0, Math.floor(input.config.maxActionsPerRun));
    const actions = ordered.slice(0, cap);
    const dropped = ordered.slice(cap);
    for (const action of dropped) skips.push({ mint: action.mint, why: 'max_actions_exceeded' });

    return { actions, skips, overflow: dropped.length };
}
