/**
 * Team oversight for community token lists: read-only listing of every list
 * (any status, with owner project) plus an emergency archive. Partner
 * self-service lives on the public v2 API (cloudrun-assets); this exists so
 * the team can see and take down abusive lists without SQL.
 */

import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import type { CallerIdentity } from '../server';
import { asArgsObject, requireString } from './shared';

export interface TokenListAdminRow {
    id: string;
    slug: string;
    ownerProjectId: string;
    name: string;
    description: string | null;
    status: string;
    /** Unix ms; set while the admin takedown lock is active. */
    adminLockedAt: number | null;
    memberCount: number;
    /** Unix ms. */
    createdAt: number;
    /** Unix ms. */
    updatedAt: number;
}

export interface TokenListsAdminRepo {
    listAll(limit: number, offset: number): Promise<TokenListAdminRow[]>;
    /** Archives AND locks (admin_locked_at) in one write. Returns false when no list has the slug. */
    archiveBySlug(slug: string, nowMs: number): Promise<boolean>;
    /** Clears the takedown lock (list stays archived; the owner may then restore it). */
    unlockBySlug(slug: string, nowMs: number): Promise<boolean>;
}

export interface TokenListsAdminDeps {
    repo: TokenListsAdminRepo;
    adminAllowlist: AdminAllowlist;
    now: () => number;
}

export async function adminListTokenLists(
    deps: TokenListsAdminDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<TokenListAdminRow[]> {
    requireAdmin(deps.adminAllowlist, identity);
    const a = asArgsObject(args);
    const limit = Math.min(Math.max(typeof a.limit === 'number' ? Math.floor(a.limit) : 200, 1), 500);
    const offset = Math.max(typeof a.offset === 'number' ? Math.floor(a.offset) : 0, 0);
    return deps.repo.listAll(limit, offset);
}

export async function adminArchiveTokenList(
    deps: TokenListsAdminDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ archived: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const a = asArgsObject(args);
    const slug = requireString(a, 'slug');
    const archived = await deps.repo.archiveBySlug(slug, deps.now());
    return { archived };
}

/**
 * Releases the takedown lock set by `adminArchiveTokenList`. The list remains
 * archived — the owner regains the ability to mutate it (including restoring
 * status) through the normal v2 API.
 */
export async function adminUnlockTokenList(
    deps: TokenListsAdminDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<{ unlocked: boolean }> {
    requireAdmin(deps.adminAllowlist, identity);
    const a = asArgsObject(args);
    const slug = requireString(a, 'slug');
    const unlocked = await deps.repo.unlockBySlug(slug, deps.now());
    return { unlocked };
}
