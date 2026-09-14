/**
 * Pure helpers for the variant-advisory UI (status labels, badge tones, form
 * validation, event rendering). No React so the curation UI, the dialog, and
 * `bun test` can all share them.
 */

import {
    PEG_GUARD_ACTOR,
    WEBACY_DEPEG_ACTOR,
    type AdminPegHealth,
    type AdvisorySource,
    type AdvisoryStatus,
    type PegTier,
    type StructuralGrade,
    type VariantAdvisoryEventRow,
} from './admin-types';

export const ADVISORY_STATUSES: readonly AdvisoryStatus[] = ['caution', 'compromised', 'blocked'];

/** Mirrors the 1..500 reason bound enforced by cloudrun-admin `setVariantAdvisory`. */
export const ADVISORY_REASON_MAX_LENGTH = 500;

export interface AdvisoryStatusOption {
    value: AdvisoryStatus;
    label: string;
    /** One-line summary of what the status does across the API and web app. */
    description: string;
}

export const ADVISORY_STATUS_OPTIONS: readonly AdvisoryStatusOption[] = [
    {
        value: 'caution',
        label: 'Caution',
        description: 'Notice only: badge and banner are shown; trade links keep working.',
    },
    {
        value: 'compromised',
        label: 'Compromised',
        description: 'Visible with a red badge; trade links disabled; never selected as the primary variant.',
    },
    {
        value: 'blocked',
        label: 'Blocked',
        description: 'Everything compromised does, plus hidden from curated lists, search, trending, and v2 lists.',
    },
];

export function isAdvisoryStatus(value: unknown): value is AdvisoryStatus {
    return typeof value === 'string' && (ADVISORY_STATUSES as readonly string[]).includes(value);
}

export function advisoryStatusLabel(status: AdvisoryStatus): string {
    return ADVISORY_STATUS_OPTIONS.find(option => option.value === status)?.label ?? status;
}

export function advisoryStatusDescription(status: AdvisoryStatus): string {
    return ADVISORY_STATUS_OPTIONS.find(option => option.value === status)?.description ?? '';
}

/** Design-system Badge tone: caution is amber, the two trade-restricting statuses are red. */
export function advisoryBadgeVariant(status: AdvisoryStatus): 'warning' | 'danger' {
    return status === 'caution' ? 'warning' : 'danger';
}

export type AdvisoryReasonValidation = { ok: true; reason: string } | { ok: false; error: string };

export function validateAdvisoryReason(input: string): AdvisoryReasonValidation {
    const reason = input.trim();
    if (reason.length === 0) return { ok: false, error: 'Reason is required.' };
    if (reason.length > ADVISORY_REASON_MAX_LENGTH) {
        return { ok: false, error: `Reason must be ${ADVISORY_REASON_MAX_LENGTH} characters or fewer.` };
    }
    return { ok: true, reason };
}

export type AdvisoryUrlValidation = { ok: true; url: string | null } | { ok: false; error: string };

/** Empty input is valid and maps to `null`; otherwise the URL must parse with an http(s) scheme. */
export function validateAdvisoryUrl(input: string): AdvisoryUrlValidation {
    const url = input.trim();
    if (url.length === 0) return { ok: true, url: null };
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, error: 'Enter a full URL, including https://.' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'URL must start with http:// or https://.' };
    }
    return { ok: true, url };
}

export function advisorySetToastMessage(input: {
    symbol: string;
    status: AdvisoryStatus;
    reactivated: boolean;
}): string {
    const base = `${input.symbol} flagged as ${input.status}`;
    return input.reactivated ? `${base} (variant re-activated)` : base;
}

export function describeAdvisoryEvent(event: Pick<VariantAdvisoryEventRow, 'action' | 'status'>): string {
    if (event.action === 'clear') return 'Cleared advisory';
    return event.status ? `Set ${event.status}` : 'Set advisory';
}

const SYSTEM_ACTOR_PREFIX = 'system:';

const SYSTEM_ACTOR_LABELS: Record<string, string> = {
    [WEBACY_DEPEG_ACTOR]: 'Webacy depeg monitor (automated)',
    [PEG_GUARD_ACTOR]: 'tokens.xyz peg monitor (automated)',
};

/** True for events written by an automated actor rather than an admin. */
export function isSystemActor(event: Pick<VariantAdvisoryEventRow, 'actorClerkUserId'>): boolean {
    return event.actorClerkUserId.startsWith(SYSTEM_ACTOR_PREFIX);
}

/** Prefer the actor's email; name automated actors; fall back to a shortened Clerk user id. */
export function advisoryActorLabel(event: Pick<VariantAdvisoryEventRow, 'actorClerkUserId' | 'actorEmail'>): string {
    const id = event.actorClerkUserId;
    if (isSystemActor(event)) return SYSTEM_ACTOR_LABELS[id] ?? `Automated (${id.slice(SYSTEM_ACTOR_PREFIX.length)})`;
    if (event.actorEmail) return event.actorEmail;
    return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

/** Short provenance label for badges/tooltips; a missing source is a human write from before 0019. */
export function advisorySourceLabel(source: AdvisorySource | undefined): string {
    switch (source) {
        case 'webacy_depeg':
            return 'Auto · Webacy depeg monitor';
        case 'peg_guard':
            return 'Auto · tokens.xyz peg monitor';
        default:
            return 'Manual';
    }
}

export function isSystemManagedAdvisory(advisory: { source?: AdvisorySource } | null | undefined): boolean {
    return advisory?.source !== undefined && advisory.source !== 'admin';
}

export const SYSTEM_ADVISORY_EDIT_WARNING =
    'This advisory is managed automatically by a depeg monitor. Saving will detach it from automatic management: it will no longer be updated or cleared when the peg recovers.';

export const SYSTEM_ADVISORY_CLEAR_WARNING =
    'This caution was set automatically by a depeg monitor. Clearing it suppresses re-flagging until the peg recovers and breaks again.';

/** Who produced a peg observation; rows from builds that predate the peg guard are Webacy's. */
export function pegProviderLabel(provider: AdminPegHealth['provider'] | undefined): string {
    return provider === 'tokens' ? 'tokens.xyz peg monitor' : 'Webacy';
}

export function pegTierLabel(tier: PegTier): string {
    switch (tier) {
        case 'ok':
            return 'On peg';
        case 'watch':
            return 'Watch';
        case 'warning':
            return 'Warning';
        case 'critical':
            return 'Critical';
        case 'premium':
            return 'Above peg';
    }
}

/** Design-system Badge tone per depeg tier. */
export function pegTierBadgeVariant(tier: PegTier): 'success' | 'info' | 'warning' | 'danger' {
    switch (tier) {
        case 'ok':
            return 'success';
        case 'watch':
        case 'premium':
            return 'info';
        case 'warning':
            return 'warning';
        case 'critical':
            return 'danger';
    }
}

/** Design-system Badge tone per structural grade band (A good … D/F bad). */
export function structuralGradeBadgeVariant(grade: StructuralGrade): 'success' | 'info' | 'warning' | 'danger' {
    switch (grade.charAt(0)) {
        case 'A':
            return 'success';
        case 'B':
            return 'info';
        case 'C':
            return 'warning';
        default:
            return 'danger';
    }
}

/** Signed deviation for tooltips, e.g. "-2.40%"; null when the monitor has no price. */
export function formatPegDeviation(deviationPct: number | null): string {
    if (deviationPct === null || !Number.isFinite(deviationPct)) return 'n/a';
    const sign = deviationPct > 0 ? '+' : '';
    return `${sign}${deviationPct.toFixed(2)}%`;
}

/** Coarse relative time for audit rows; callers should put the absolute time in `title`. */
export function formatRelativeTime(timestampMs: number, nowMs: number): string {
    const diffMs = nowMs - timestampMs;
    if (diffMs < 0) return 'just now';
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(timestampMs).toLocaleDateString();
}
