/**
 * Admin build tools for community token lists, called by the apps/admin proxy
 * with a Clerk-verified `x-tokens-identity` header. Two things the partner API
 * cannot do:
 *
 * - create a list on behalf of any project (`ownerProjectId` is an argument,
 *   not the caller's own project), and
 * - bulk-import members into any list regardless of owner, carrying a per-row
 *   note — the CSV path.
 *
 * Everything else (mint resolution, caps, rank-by-request-order) is the same
 * code the partner batch endpoint runs, so an admin-built list is
 * indistinguishable from a partner-built one.
 */

import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import { InvalidArgsError, type CallerIdentity } from './assets';
import {
    addMembersToList,
    createList,
    decodeMemberEntries,
    type BatchAddResult,
    type MemberEntry,
    type MutationOutcome,
    type TokenListResult,
    type TokenListsMutationsDeps,
} from './tokenListsMutations';

export interface TokenListsAdminDeps {
    adminAllowlist: AdminAllowlist;
    lists: TokenListsMutationsDeps;
}

export interface AdminImportResult extends BatchAddResult {
    slug: string;
    /** Distinct well-formed rows received after dedupe (added + failed). */
    received: number;
}

function asObject(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null) throw new InvalidArgsError('args must be an object');
    return args as Record<string, unknown>;
}

function requireString(a: Record<string, unknown>, key: string): string {
    const value = a[key];
    if (typeof value !== 'string' || !value.trim()) throw new InvalidArgsError(`${key} must be a non-empty string`);
    return value.trim();
}

/** `adminCreateTokenList({ ownerProjectId, slug, name })` — same validation as the partner POST. */
export async function adminCreateTokenList(
    deps: TokenListsAdminDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<MutationOutcome<TokenListResult>> {
    requireAdmin(deps.adminAllowlist, identity);
    const a = asObject(args);
    // Re-validated by createList; requireString here only gives a clearer message.
    requireString(a, 'ownerProjectId');
    requireString(a, 'slug');
    requireString(a, 'name');
    return createList(deps.lists, args);
}

/**
 * `adminImportTokenListMembers({ slug, members: [{ mint, note? }] })` — bulk
 * add in request order. The caller (admin UI) chunks large CSVs; each call is
 * bounded by the same batch cap as the partner endpoint.
 */
export async function adminImportTokenListMembers(
    deps: TokenListsAdminDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<MutationOutcome<AdminImportResult>> {
    requireAdmin(deps.adminAllowlist, identity);
    const a = asObject(args);
    const slug = requireString(a, 'slug').toLowerCase();

    const entries: MemberEntry[] = decodeMemberEntries(a.members);
    if (entries.length > deps.lists.caps.batch) return { ok: false, error: 'batch_too_large' };

    const list = await deps.lists.repo.getListBySlug(slug);
    if (!list) return { ok: false, error: 'not_found' };

    const result = await addMembersToList(deps.lists, list.id, entries);
    return {
        ok: true,
        value: { slug, received: result.added.length + result.failed.length, ...result },
    };
}
