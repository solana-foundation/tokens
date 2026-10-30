/**
 * Admin allowlist for launchpad coins (`launchpad_mint_approvals`).
 *
 * The stonk.fun sync (cloudrun-assets, crons.launchpad.ts) keeps every
 * candidate in `launchpad_tokens_latest`; only mints approved here are served
 * by the launches API and shown on asset pages. Approval also makes the sync
 * keep the coin regardless of its volume / market-cap threshold. Revoking
 * deletes the row; every approve/revoke appends to
 * `launchpad_mint_approval_events` for audit.
 *
 * Same plumbing as `variantAdvisories.ts`: allowlist check first, args
 * validated into InvalidArgsError, one repo call per handler.
 */

import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import type { CallerIdentity } from '../server';
import { InvalidArgsError } from './errors';
import {
    asArgsObject,
    looksLikeSolanaMintAddress,
    optionalBoolean,
    optionalEnum,
    optionalNullableString,
    optionalNumber,
    requireString,
} from './shared';

export const LAUNCHPADS = ['stonkfun'] as const;
export type Launchpad = (typeof LAUNCHPADS)[number];
export const DEFAULT_LAUNCHPAD: Launchpad = 'stonkfun';
export const LAUNCH_NOTE_MAX_LENGTH = 500;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export interface LaunchpadApproval {
    note: string | null;
    /** Clerk user id of the admin who approved (last re-approve wins). */
    approvedBy: string;
    approvedByEmail: string | null;
    /** Unix ms of the first approval; kept across re-approves. */
    approvedAt: number;
    /** Unix ms of the last write. */
    updatedAt: number;
}

/**
 * One candidate row for the admin table. `synced: false` means the mint was
 * approved by address but the sync has not stored it yet (all token fields
 * null); `isActive: false` on a synced row means it is missing identity or
 * was not in the last provider response.
 */
export interface LaunchpadCandidateRow {
    launchpad: string;
    mint: string;
    synced: boolean;
    isActive: boolean;
    quoteMint: string | null;
    quoteSymbol: string | null;
    symbol: string | null;
    name: string | null;
    logoURI: string | null;
    marketCapUsd: number | null;
    volume24hUsd: number | null;
    launchedAt: number | null;
    lastSyncedAt: number | null;
    /** Canonical asset that owns the quote mint (the page the coin shows on); null when unsynced or not curated. */
    quoteAsset: LaunchpadQuoteAsset | null;
    approval: LaunchpadApproval | null;
}

export interface LaunchpadQuoteAsset {
    assetId: string;
    name: string | null;
    symbol: string | null;
    imageUrl: string | null;
}

export interface LaunchpadApprovalSnapshot {
    quoteMint: string | null;
    symbol: string | null;
    name: string | null;
    logoURI: string | null;
}

export interface LaunchpadApprovalActor {
    clerkUserId: string;
    email: string | null;
}

export interface LaunchpadApprovalsRepo {
    listCandidates(args: {
        launchpad: Launchpad;
        approvedOnly: boolean;
        limit: number;
    }): Promise<LaunchpadCandidateRow[]>;
    /** Upserts the approval (keeps the original approved_at) and records an 'approve' event. */
    approve(args: {
        launchpad: Launchpad;
        mint: string;
        note: string | null;
        /** Snapshot from the admin preview; null fields keep whatever is stored. */
        snapshot: LaunchpadApprovalSnapshot;
        actor: LaunchpadApprovalActor;
        nowMs: number;
    }): Promise<{ created: boolean; approvedAt: number }>;
    /** Deletes the approval and records a 'revoke' event; 'not_found' writes nothing. */
    revoke(args: {
        launchpad: Launchpad;
        mint: string;
        actor: LaunchpadApprovalActor;
        nowMs: number;
    }): Promise<'revoked' | 'not_found'>;
}

export interface LaunchpadApprovalsDeps {
    repo: LaunchpadApprovalsRepo;
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

function readLaunchpad(obj: Record<string, unknown>): Launchpad {
    return optionalEnum(obj, 'launchpad', LAUNCHPADS) ?? DEFAULT_LAUNCHPAD;
}

/** undefined / null / blank → null; otherwise trimmed and length-capped. */
function optionalNote(obj: Record<string, unknown>): string | null {
    const raw = optionalNullableString(obj, 'note');
    if (raw === undefined || raw === null) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.length > LAUNCH_NOTE_MAX_LENGTH) {
        throw new InvalidArgsError(`note must be at most ${LAUNCH_NOTE_MAX_LENGTH} characters`);
    }
    return trimmed;
}

const SNAPSHOT_TEXT_MAX = 120;

function optionalSnapshotText(obj: Record<string, unknown>, key: string): string | null {
    const raw = optionalNullableString(obj, key);
    if (raw === undefined || raw === null) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.length > SNAPSHOT_TEXT_MAX ? trimmed.slice(0, SNAPSHOT_TEXT_MAX) : trimmed;
}

function optionalSnapshotUrl(obj: Record<string, unknown>, key: string): string | null {
    const raw = optionalNullableString(obj, key);
    if (raw === undefined || raw === null) return null;
    const trimmed = raw.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed) || trimmed.length > 500) return null;
    return trimmed;
}

function readSnapshot(obj: Record<string, unknown>): LaunchpadApprovalSnapshot {
    const quoteRaw = optionalNullableString(obj, 'quoteMint');
    const quoteMint = quoteRaw ? quoteRaw.trim() : null;
    if (quoteMint && !looksLikeSolanaMintAddress(quoteMint)) {
        throw new InvalidArgsError('quoteMint must be a base58 Solana mint address');
    }
    return {
        quoteMint: quoteMint || null,
        symbol: optionalSnapshotText(obj, 'symbol'),
        name: optionalSnapshotText(obj, 'name'),
        logoURI: optionalSnapshotUrl(obj, 'logoURI'),
    };
}

function readLimit(obj: Record<string, unknown>): number {
    const raw = optionalNumber(obj, 'limit');
    if (raw === undefined) return DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(raw), 1), MAX_LIMIT);
}

function actorFrom(identity: CallerIdentity | null, clerkUserId: string): LaunchpadApprovalActor {
    return { clerkUserId, email: identity?.email ?? null };
}

function logMutation(mutation: string, launchpad: Launchpad, mint: string, actor: LaunchpadApprovalActor): void {
    console.log(
        JSON.stringify({
            event: 'mutation',
            mutation,
            launchpad,
            mint,
            clerkUserId: actor.clerkUserId,
            email: actor.email,
        }),
    );
}

/* ------------------------------------------------------------------------- *
 * Handlers
 * ------------------------------------------------------------------------- */

export async function listLaunchpadCandidates(
    deps: LaunchpadApprovalsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<LaunchpadCandidateRow[]> {
    requireAdmin(deps.adminAllowlist, identity);
    const a = asArgsObject(args);
    const launchpad = readLaunchpad(a);
    const approvedOnly = optionalBoolean(a, 'approvedOnly') ?? false;
    const limit = readLimit(a);
    return await deps.repo.listCandidates({ launchpad, approvedOnly, limit });
}

export interface ApproveLaunchpadMintResult {
    launchpad: Launchpad;
    mint: string;
    approved: true;
    /** False when the mint was already approved (note/actor refreshed). */
    created: boolean;
    approvedAt: number;
}

export async function approveLaunchpadMint(
    deps: LaunchpadApprovalsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<ApproveLaunchpadMintResult> {
    const { clerkUserId } = requireAdmin(deps.adminAllowlist, identity);
    const a = asArgsObject(args);
    const launchpad = readLaunchpad(a);
    const mint = requireMint(a);
    const note = optionalNote(a);
    const snapshot = readSnapshot(a);
    const actor = actorFrom(identity, clerkUserId);

    const result = await deps.repo.approve({ launchpad, mint, note, snapshot, actor, nowMs: deps.now() });
    logMutation('approveLaunchpadMint', launchpad, mint, actor);
    return { launchpad, mint, approved: true, created: result.created, approvedAt: result.approvedAt };
}

export async function revokeLaunchpadMint(
    deps: LaunchpadApprovalsDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ launchpad: Launchpad; mint: string; revoked: boolean }> {
    const { clerkUserId } = requireAdmin(deps.adminAllowlist, identity);
    const a = asArgsObject(args);
    const launchpad = readLaunchpad(a);
    const mint = requireMint(a);
    const actor = actorFrom(identity, clerkUserId);

    const outcome = await deps.repo.revoke({ launchpad, mint, actor, nowMs: deps.now() });
    const revoked = outcome === 'revoked';
    // Revoking an unapproved mint is a no-op, not an error (two admins may race).
    if (revoked) logMutation('revokeLaunchpadMint', launchpad, mint, actor);
    return { launchpad, mint, revoked };
}
