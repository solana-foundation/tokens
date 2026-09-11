/**
 * Pure helpers for the variant-advisory UI (status labels, badge tones, form
 * validation, event rendering). No React so the curation UI, the dialog, and
 * `bun test` can all share them.
 */

import type { AdvisoryStatus, VariantAdvisoryEventRow } from './admin-types';

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

/** Prefer the actor's email; fall back to a shortened Clerk user id. */
export function advisoryActorLabel(event: Pick<VariantAdvisoryEventRow, 'actorClerkUserId' | 'actorEmail'>): string {
    if (event.actorEmail) return event.actorEmail;
    const id = event.actorClerkUserId;
    return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
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
