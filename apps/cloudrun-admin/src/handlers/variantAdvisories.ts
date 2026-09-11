/**
 * Admin advisories on individual mints (`asset_variant_advisories`).
 *
 * An advisory is the off-switch we lacked when SILV was exploited: an admin
 * flags a mint in seconds, the API exposes it, the web app warns/disables
 * trade links, execution refuses it, and (for `blocked`) lists hide it — no
 * deploy. At most one ACTIVE advisory per mint; clearing deletes the row and
 * every set/clear appends to `asset_variant_advisory_events` for audit.
 *
 * Same plumbing as `tokenListsAdmin.ts`: allowlist check first, args
 * validated into InvalidArgsError, one repo call per handler.
 */

import { ADVISORY_STATUSES, isAdvisoryStatus, type AdvisoryStatus } from '@tokens/asset-registry';

import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import type { CallerIdentity } from '../server';
import { InvalidArgsError } from './errors';
import {
    asArgsObject,
    looksLikeSolanaMintAddress,
    optionalBoolean,
    optionalNullableString,
    optionalNumber,
    optionalString,
    requireString,
} from './shared';

export const ADVISORY_REASON_MAX_LENGTH = 500;
const DEFAULT_EVENTS_LIMIT = 20;
const MAX_EVENTS_LIMIT = 100;

export interface VariantAdvisoryRow {
    mint: string;
    status: AdvisoryStatus;
    reason: string;
    url: string | null;
    /** Clerk user id of the last admin to set/edit the advisory. */
    setBy: string;
    setByEmail: string | null;
    /** Unix ms; reset when status changes, kept when only reason/url change. */
    setAt: number;
    /** Unix ms of the last write. */
    updatedAt: number;
}

export interface VariantAdvisoryEventRow {
    id: string;
    mint: string;
    action: 'set' | 'clear';
    status: AdvisoryStatus | null;
    reason: string | null;
    url: string | null;
    /** True when the same transaction flipped asset_variants.is_active back on. */
    reactivatedVariant: boolean;
    actorClerkUserId: string;
    actorEmail: string | null;
    /** Unix ms. */
    createdAt: number;
}

export interface AdvisoryActor {
    clerkUserId: string;
    email: string | null;
}

export type SetVariantAdvisoryOutcome = { outcome: 'set'; reactivated: boolean } | { outcome: 'variant_not_found' };

export interface VariantAdvisoriesRepo {
    /**
     * Upserts the advisory for `mint` in one transaction. Refuses (without
     * writing) when no asset_variants row has the mint. `activateVariant`
     * re-enables an inactive variant in the same transaction so a flagged
     * mint can be shown with its warning instead of vanishing.
     */
    set(args: {
        mint: string;
        status: AdvisoryStatus;
        reason: string;
        url: string | null;
        activateVariant: boolean;
        actor: AdvisoryActor;
        nowMs: number;
    }): Promise<SetVariantAdvisoryOutcome>;
    /** Deletes the active advisory and records a 'clear' event; 'not_found' writes nothing. */
    clear(args: { mint: string; actor: AdvisoryActor; nowMs: number }): Promise<'cleared' | 'not_found'>;
    listActive(): Promise<VariantAdvisoryRow[]>;
    /** Newest first. */
    listEventsByMint(mint: string, limit: number): Promise<VariantAdvisoryEventRow[]>;
}

export interface VariantAdvisoriesDeps {
    repo: VariantAdvisoriesRepo;
    adminAllowlist: AdminAllowlist;
    now: () => number;
}

/* ------------------------------------------------------------------------- *
 * Validation
 * ------------------------------------------------------------------------- */

function requireMint(obj: Record<string, unknown>): string {
    const mint = requireString(obj, 'mint').trim();
    if (!looksLikeSolanaMintAddress(mint)) {
        throw new InvalidArgsError('mint must be a base58 Solana mint address');
    }
    return mint;
}

function requireAdvisoryStatus(obj: Record<string, unknown>): AdvisoryStatus {
    const status = obj.status;
    if (!isAdvisoryStatus(status)) {
        throw new InvalidArgsError(`status must be one of: ${ADVISORY_STATUSES.join(', ')}`);
    }
    return status;
}

function requireReason(obj: Record<string, unknown>): string {
    const reason = requireString(obj, 'reason').trim();
    if (reason.length === 0) throw new InvalidArgsError('reason must not be empty');
    if (reason.length > ADVISORY_REASON_MAX_LENGTH) {
        throw new InvalidArgsError(`reason must be at most ${ADVISORY_REASON_MAX_LENGTH} characters`);
    }
    return reason;
}

/** undefined / null / blank → null; otherwise must parse as an http(s) URL. */
function optionalHttpUrl(obj: Record<string, unknown>): string | null {
    const raw = optionalNullableString(obj, 'url');
    if (raw === undefined || raw === null) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new InvalidArgsError('url must be a valid http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new InvalidArgsError('url must be a valid http(s) URL');
    }
    return trimmed;
}

function actorFrom(identity: CallerIdentity | null, clerkUserId: string): AdvisoryActor {
    return { clerkUserId, email: identity?.email ?? null };
}

function logMutation(mutation: string, mint: string, status: AdvisoryStatus | null, actor: AdvisoryActor): void {
    console.log(
        JSON.stringify({
            event: 'mutation',
            mutation,
            mint,
            status,
            clerkUserId: actor.clerkUserId,
            email: actor.email,
        }),
    );
}

/* ------------------------------------------------------------------------- *
 * Handlers
 * ------------------------------------------------------------------------- */

export interface SetVariantAdvisoryResult {
    mint: string;
    status: AdvisoryStatus;
    updated: true;
    reactivated: boolean;
}

export async function setVariantAdvisory(
    deps: VariantAdvisoriesDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<SetVariantAdvisoryResult> {
    const { clerkUserId } = requireAdmin(deps.adminAllowlist, identity);
    const a = asArgsObject(args);
    const mint = requireMint(a);
    const status = requireAdvisoryStatus(a);
    const reason = requireReason(a);
    const url = optionalHttpUrl(a);
    const activateVariant = optionalBoolean(a, 'activateVariant') ?? false;
    const actor = actorFrom(identity, clerkUserId);

    const result = await deps.repo.set({ mint, status, reason, url, activateVariant, actor, nowMs: deps.now() });
    if (result.outcome === 'variant_not_found') {
        throw new InvalidArgsError('Variant not found');
    }
    logMutation('setVariantAdvisory', mint, status, actor);
    return { mint, status, updated: true, reactivated: result.reactivated };
}

export async function clearVariantAdvisory(
    deps: VariantAdvisoriesDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ mint: string; cleared: boolean }> {
    const { clerkUserId } = requireAdmin(deps.adminAllowlist, identity);
    const a = asArgsObject(args);
    const mint = requireMint(a);
    const actor = actorFrom(identity, clerkUserId);

    const outcome = await deps.repo.clear({ mint, actor, nowMs: deps.now() });
    const cleared = outcome === 'cleared';
    // Clearing an already-clear mint is a no-op, not an error: the UI may race
    // two admins. Only log when something changed.
    if (cleared) logMutation('clearVariantAdvisory', mint, null, actor);
    return { mint, cleared };
}

export interface ListVariantAdvisoriesResult {
    /** Every active advisory, or just the one for `mint` when given. */
    advisories: VariantAdvisoryRow[];
    /** Audit trail for `mint` (newest first); [] when no mint was given. */
    events: VariantAdvisoryEventRow[];
}

export async function listVariantAdvisories(
    deps: VariantAdvisoriesDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<ListVariantAdvisoriesResult> {
    requireAdmin(deps.adminAllowlist, identity);
    const a = asArgsObject(args);
    const rawMint = optionalString(a, 'mint');
    const mint = rawMint === undefined ? undefined : requireMint(a);
    const rawLimit = optionalNumber(a, 'eventsLimit');
    const eventsLimit = Math.min(Math.max(rawLimit === undefined ? DEFAULT_EVENTS_LIMIT : Math.floor(rawLimit), 1), MAX_EVENTS_LIMIT);

    const active = await deps.repo.listActive();
    if (mint === undefined) return { advisories: active, events: [] };
    const events = await deps.repo.listEventsByMint(mint, eventsLimit);
    return { advisories: active.filter(row => row.mint === mint), events };
}
