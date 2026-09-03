import { isReservedListSlug } from '@tokens/asset-registry/curated-lists';

import { InvalidArgsError } from './assets';
import type { BirdeyeOverview } from './crons';

/**
 * Mutations for community token lists. Ownership is enforced here (defense in
 * depth — the API route already checks `ctx.platformAuth.projectId`): every
 * handler takes `ownerProjectId` and refuses to touch a list owned by another
 * project.
 *
 * Domain failures (conflict, forbidden, unknown mint, …) are returned as
 * structured `{ ok: false, error }` results rather than thrown: the RPC
 * dispatch layer only maps invalid-args/auth errors to statuses, and the API
 * route translates these codes to proper HTTP responses.
 */

export const TOKEN_LIST_SLUG_REGEX = /^[a-z][a-z0-9-]{2,62}$/;

/** Route segments, curated slugs, and their aliases must never become community list slugs. */
export function isReservedTokenListSlug(slug: string): boolean {
    return isReservedListSlug(slug);
}

const SOLANA_MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const TOKEN_LIST_STATUSES = ['draft', 'published', 'archived'] as const;
export type TokenListStatus = (typeof TOKEN_LIST_STATUSES)[number];

/** Infrastructure bounds (env-tunable at wiring time; see index.ts). */
export interface TokenListCaps {
    /** Max mints per addMembersBatch call. */
    batch: number;
    /** Max members a single list may hold. */
    membersPerList: number;
    /** Max Birdeye lookups a single batch call may spend on unknown mints. */
    providerLookups: number;
    /** Max non-archived lists a single project may own. */
    listsPerProject: number;
}

export const DEFAULT_TOKEN_LIST_CAPS: TokenListCaps = {
    // 250 bounds per-call wall time (~3 chunked IN-queries + inserts); large
    // imports chunk client-side. Was 1000, which let a burst of multi-second
    // calls park on the service (see the #121 review).
    batch: 250,
    membersPerList: 5000,
    providerLookups: 50,
    listsPerProject: 100,
};

/**
 * Negative cache for provider lookups: a mint Birdeye doesn't know keeps not
 * existing for a while — without this, replayed batches of the same unknown
 * mints burn the provider budget forever. FIFO-evicted, per-instance.
 */
export function withOverviewMissCache(
    inner: (mint: string) => Promise<BirdeyeOverview | null>,
    options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): (mint: string) => Promise<BirdeyeOverview | null> {
    const ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    const maxEntries = options.maxEntries ?? 50_000;
    const now = options.now ?? (() => Date.now());
    const misses = new Map<string, number>();
    return async mint => {
        const missedAt = misses.get(mint);
        if (missedAt !== undefined) {
            if (now() - missedAt < ttlMs) return null;
            misses.delete(mint);
        }
        const overview = await inner(mint);
        if (overview === null) {
            misses.set(mint, now());
            if (misses.size > maxEntries) {
                const oldest = misses.keys().next().value;
                if (oldest !== undefined) misses.delete(oldest);
            }
        }
        return overview;
    };
}

export interface TokenListMutationRow {
    id: string;
    slug: string;
    owner_project_id: string;
    name: string;
    status: string;
    /** Unix ms; set by the admin takedown lock, null otherwise. */
    admin_locked_at: number | null;
    /** Unix ms. */
    created_at: number;
    /** Unix ms. */
    updated_at: number;
}

/** Field caps for stored text served back on public reads (response-bloat guard). */
export const TOKEN_LIST_TEXT_CAPS = { name: 80, note: 500 } as const;

export interface MemberSnapshot {
    symbol: string | null;
    name: string | null;
    logoUri: string | null;
    decimals: number | null;
}

export interface TokenListsMutationsRepo {
    getListBySlug(slug: string): Promise<TokenListMutationRow | null>;
    /** Throws SlugConflictError when the unique slug index rejects the insert. */
    insertList(args: {
        slug: string;
        ownerProjectId: string;
        name: string;
        status: TokenListStatus;
        nowMs: number;
    }): Promise<TokenListMutationRow>;
    /** Throws SlugConflictError when a slug change collides with a live list. */
    updateList(
        listId: string,
        patch: { slug?: string; name?: string; status?: TokenListStatus },
        nowMs: number,
    ): Promise<TokenListMutationRow>;
    /** Hard delete in ONE transaction — members cascade, and the freed slug's hold is recorded atomically. */
    deleteList(listId: string, hold: { slug: string; ownerProjectId: string; releasedAt: number }): Promise<void>;
    /** Active hold on a freed slug, or null. */
    getSlugHold(slug: string): Promise<{ ownerProjectId: string; releasedAt: number } | null>;
    /** Upsert a hold recording who released the slug and when. */
    recordSlugHold(slug: string, ownerProjectId: string, releasedAt: number): Promise<void>;
    /** Drop a hold once the slug is claimed again. */
    clearSlugHold(slug: string): Promise<void>;
    /** Non-archived lists owned by the project (lists-per-project cap). */
    countListsByOwner(ownerProjectId: string): Promise<number>;
    /** Upsert on (list_id, mint); missing rank appends after the current max. Touches the parent list. */
    /**
     * Single upsert in ONE transaction with the list row locked (FOR UPDATE):
     * the members-per-list cap and default rank are read under the lock, same
     * guarantees as the bulk path. Returns false when a net-new insert would
     * exceed the cap (updates of existing members always succeed).
     */
    upsertMember(args: {
        listId: string;
        mint: string;
        rank: number | null;
        note: string | null;
        addedAt: number;
        snapshot: MemberSnapshot | null;
        membersPerListCap: number;
    }): Promise<boolean>;
    /** Returns false when the mint was not a member. Touches the parent list when it was. */
    removeMember(listId: string, mint: string, nowMs: number): Promise<boolean>;
    /** An active registry variant exists for the mint (tombstone-filtered). */
    hasActiveVariantForMint(mint: string): Promise<boolean>;
    /** The mint exists in the tokens table (read-time hydration will cover metadata). */
    hasTokenForAddress(mint: string): Promise<boolean>;
    /** Subset of `mints` with an active, non-tombstoned registry variant. One IN-query, chunked. */
    filterMintsWithActiveVariants(mints: readonly string[]): Promise<string[]>;
    /** Subset of `mints` present in the tokens table. One IN-query, chunked. */
    filterMintsKnownTokens(mints: readonly string[]): Promise<string[]>;
    /** Subset of `mints` already members of the list. */
    filterMintsExistingMembers(listId: string, mints: readonly string[]): Promise<string[]>;
    countMembers(listId: string): Promise<number>;
    /**
     * Multi-row upsert inside ONE transaction that locks the list row
     * (FOR UPDATE): the members-per-list cap and MAX(rank) are re-read under
     * the lock, so concurrent batches can neither overshoot the cap nor mint
     * duplicate ranks. New mints append after the current max rank in array
     * order; existing mints keep their rank and refresh note/snapshot; net-new
     * rows beyond the cap are skipped and returned as `overflowMints`.
     * Touches the parent list's updated_at ONCE.
     */
    upsertMembersBulk(
        listId: string,
        rows: Array<{ mint: string; note: string | null; addedAt: number; snapshot: MemberSnapshot | null }>,
        membersPerListCap: number,
    ): Promise<{ overflowMints: string[] }>;
}

export class SlugConflictError extends Error {
    constructor(slug: string) {
        super(`token list slug already exists: ${slug}`);
        this.name = 'SlugConflictError';
    }
}

export interface TokenListsMutationsDeps {
    repo: TokenListsMutationsRepo;
    /** Birdeye token_overview for mints unknown locally; null when the provider has nothing. */
    fetchTokenOverview(mint: string): Promise<BirdeyeOverview | null>;
    now(): number;
    caps: TokenListCaps;
    /** Freed slugs stay reclaimable only by their previous owner for this long. */
    slugHoldMs: number;
}

export type TokenListMutationErrorCode =
    | 'invalid_slug'
    | 'reserved_slug'
    | 'slug_conflict'
    | 'slug_held'
    | 'admin_locked'
    | 'not_found'
    | 'forbidden'
    | 'invalid_mint'
    | 'unknown_mint'
    | 'batch_too_large'
    | 'list_full'
    | 'project_lists_limit';

export interface TokenListResult {
    id: string;
    slug: string;
    ownerProjectId: string;
    name: string;
    status: string;
    createdAt: number;
    updatedAt: number;
}

export interface MemberResult {
    mint: string;
    verified: boolean;
    snapshot: MemberSnapshot | null;
}

export type MutationOutcome<T> = { ok: true; value: T } | { ok: false; error: TokenListMutationErrorCode };

function listResult(row: TokenListMutationRow): TokenListResult {
    return {
        id: row.id,
        slug: row.slug,
        ownerProjectId: row.owner_project_id,
        name: row.name,
        status: row.status,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}

function asObject(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    return args as Record<string, unknown>;
}

function requireString(a: Record<string, unknown>, key: string, maxLength?: number): string {
    const value = a[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw new InvalidArgsError(`${key} must be a non-empty string`);
    }
    const trimmed = value.trim();
    if (maxLength !== undefined && trimmed.length > maxLength) {
        throw new InvalidArgsError(`${key} must be at most ${maxLength} characters`);
    }
    return trimmed;
}

function optionalString(a: Record<string, unknown>, key: string, maxLength?: number): string | undefined {
    const value = a[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string when present`);
    if (maxLength !== undefined && value.length > maxLength) {
        throw new InvalidArgsError(`${key} must be at most ${maxLength} characters`);
    }
    return value;
}

function optionalStatus(a: Record<string, unknown>): TokenListStatus | undefined {
    const value = a.status;
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !(TOKEN_LIST_STATUSES as readonly string[]).includes(value)) {
        throw new InvalidArgsError(`status must be one of ${TOKEN_LIST_STATUSES.join(', ')}`);
    }
    return value as TokenListStatus;
}

/** Loads the list and enforces ownership; shared by every list-scoped mutation. */
async function requireOwnedList(
    deps: TokenListsMutationsDeps,
    slug: string,
    ownerProjectId: string,
): Promise<MutationOutcome<TokenListMutationRow>> {
    const row = await deps.repo.getListBySlug(slug);
    if (!row) return { ok: false, error: 'not_found' };
    if (row.owner_project_id !== ownerProjectId) return { ok: false, error: 'forbidden' };
    // Admin takedown lock: while set, the owner cannot mutate the list at all
    // (in particular cannot flip an archived list back to published).
    if (row.admin_locked_at !== null && row.admin_locked_at !== undefined) {
        return { ok: false, error: 'admin_locked' };
    }
    return { ok: true, value: row };
}

/** A freed slug is claimable by anyone after the hold window, and by its previous owner always. */
async function slugHeldForOther(deps: TokenListsMutationsDeps, slug: string, ownerProjectId: string): Promise<boolean> {
    const hold = await deps.repo.getSlugHold(slug);
    if (!hold) return false;
    if (hold.ownerProjectId === ownerProjectId) return false;
    return deps.now() - hold.releasedAt < deps.slugHoldMs;
}

export async function createList(
    deps: TokenListsMutationsDeps,
    args: unknown,
): Promise<MutationOutcome<TokenListResult>> {
    const a = asObject(args);
    const ownerProjectId = requireString(a, 'ownerProjectId');
    const slug = requireString(a, 'slug').toLowerCase();
    const name = requireString(a, 'name', TOKEN_LIST_TEXT_CAPS.name);
    const status = optionalStatus(a) ?? 'published';

    if (!TOKEN_LIST_SLUG_REGEX.test(slug)) return { ok: false, error: 'invalid_slug' };
    if (isReservedTokenListSlug(slug)) return { ok: false, error: 'reserved_slug' };
    if (await slugHeldForOther(deps, slug, ownerProjectId)) return { ok: false, error: 'slug_held' };
    if ((await deps.repo.countListsByOwner(ownerProjectId)) >= deps.caps.listsPerProject) {
        return { ok: false, error: 'project_lists_limit' };
    }

    try {
        const row = await deps.repo.insertList({
            slug,
            ownerProjectId,
            name,
            status,
            nowMs: deps.now(),
        });
        await deps.repo.clearSlugHold(slug);
        return { ok: true, value: listResult(row) };
    } catch (err) {
        if (err instanceof SlugConflictError) return { ok: false, error: 'slug_conflict' };
        throw err;
    }
}

/**
 * Metadata update, including renaming the slug via `newSlug`. A rename is a
 * clean cut: the old slug stops resolving immediately and returns to the pool,
 * so consumers pinned to the old path 404. Callers are expected to warn.
 */
export async function updateList(
    deps: TokenListsMutationsDeps,
    args: unknown,
): Promise<MutationOutcome<TokenListResult>> {
    const a = asObject(args);
    const ownerProjectId = requireString(a, 'ownerProjectId');
    const slug = requireString(a, 'slug');
    const newSlug = optionalString(a, 'newSlug')?.trim().toLowerCase();
    const name = optionalString(a, 'name', TOKEN_LIST_TEXT_CAPS.name);
    const status = optionalStatus(a);

    if (newSlug !== undefined && newSlug.length > 0) {
        if (!TOKEN_LIST_SLUG_REGEX.test(newSlug)) return { ok: false, error: 'invalid_slug' };
        if (isReservedTokenListSlug(newSlug)) return { ok: false, error: 'reserved_slug' };
        if (await slugHeldForOther(deps, newSlug, ownerProjectId)) return { ok: false, error: 'slug_held' };
    }

    const owned = await requireOwnedList(deps, slug, ownerProjectId);
    if (!owned.ok) return owned;

    const patch: { slug?: string; name?: string; status?: TokenListStatus } = {};
    // A no-op rename must not reach the unique index and self-conflict.
    if (newSlug !== undefined && newSlug.length > 0 && newSlug !== owned.value.slug) patch.slug = newSlug;
    if (name !== undefined) patch.name = name;
    if (status !== undefined) patch.status = status;

    try {
        const row = await deps.repo.updateList(owned.value.id, patch, deps.now());
        if (patch.slug !== undefined) {
            // The old path is freed but held for this owner; the new one is claimed.
            await deps.repo.recordSlugHold(owned.value.slug, ownerProjectId, deps.now());
            await deps.repo.clearSlugHold(patch.slug);
        }
        return { ok: true, value: listResult(row) };
    } catch (err) {
        if (err instanceof SlugConflictError) return { ok: false, error: 'slug_conflict' };
        throw err;
    }
}

/**
 * Soft archive: the list keeps its row and its slug, and drops out of
 * discovery and public reads. Equivalent to `updateList({ status: 'archived' })`
 * — kept as its own RPC for the API surface that predates slug reuse.
 */
export async function archiveList(
    deps: TokenListsMutationsDeps,
    args: unknown,
): Promise<MutationOutcome<TokenListResult>> {
    const a = asObject(args);
    const ownerProjectId = requireString(a, 'ownerProjectId');
    const slug = requireString(a, 'slug');

    const owned = await requireOwnedList(deps, slug, ownerProjectId);
    if (!owned.ok) return owned;

    const row = await deps.repo.updateList(owned.value.id, { status: 'archived' }, deps.now());
    return { ok: true, value: listResult(row) };
}

/**
 * Hard delete: drops the row and (by FK cascade) its members, releasing the
 * slug for anyone to claim again. Irreversible — the API route is the only
 * caller and it gates on ownership plus an explicit client confirmation.
 */
export async function deleteList(
    deps: TokenListsMutationsDeps,
    args: unknown,
): Promise<MutationOutcome<TokenListResult>> {
    const a = asObject(args);
    const ownerProjectId = requireString(a, 'ownerProjectId');
    const slug = requireString(a, 'slug');

    const owned = await requireOwnedList(deps, slug, ownerProjectId);
    if (!owned.ok) return owned;

    // Delete + hold in one repo transaction: a crash between the two must not
    // reopen the slug-hijack window, however briefly.
    await deps.repo.deleteList(owned.value.id, {
        slug: owned.value.slug,
        ownerProjectId,
        releasedAt: deps.now(),
    });
    return { ok: true, value: listResult(owned.value) };
}

/**
 * D4 resolution chain: registry variant → tokens table → Birdeye overview.
 * Registry/tokens-table mints hydrate at read time, so no snapshot is stored;
 * Birdeye-only mints snapshot metadata into the member row (the row is the cache).
 */
async function resolveMint(deps: TokenListsMutationsDeps, mint: string): Promise<MutationOutcome<MemberResult>> {
    if (!SOLANA_MINT_REGEX.test(mint)) return { ok: false, error: 'invalid_mint' };

    if (await deps.repo.hasActiveVariantForMint(mint)) {
        return { ok: true, value: { mint, verified: true, snapshot: null } };
    }
    if (await deps.repo.hasTokenForAddress(mint)) {
        return { ok: true, value: { mint, verified: false, snapshot: null } };
    }

    const overview = await deps.fetchTokenOverview(mint).catch(() => null);
    if (!overview) return { ok: false, error: 'unknown_mint' };
    return {
        ok: true,
        value: {
            mint,
            verified: false,
            snapshot: {
                symbol: typeof overview.symbol === 'string' ? overview.symbol : null,
                name: typeof overview.name === 'string' ? overview.name : null,
                logoUri: typeof overview.logoURI === 'string' ? overview.logoURI : null,
                decimals: typeof overview.decimals === 'number' ? overview.decimals : null,
            },
        },
    };
}

export async function upsertMember(
    deps: TokenListsMutationsDeps,
    args: unknown,
): Promise<MutationOutcome<MemberResult>> {
    const a = asObject(args);
    const ownerProjectId = requireString(a, 'ownerProjectId');
    const slug = requireString(a, 'slug');
    const mint = requireString(a, 'mint');
    const note = optionalString(a, 'note', TOKEN_LIST_TEXT_CAPS.note) ?? null;
    if (a.rank !== undefined && a.rank !== null && typeof a.rank !== 'number') {
        throw new InvalidArgsError('rank must be a number when present');
    }
    // int4 column: NaN/±Infinity/overflow must 400 here, not 500 at the insert.
    if (typeof a.rank === 'number' && (!Number.isFinite(a.rank) || a.rank < -2_147_483_648 || a.rank > 2_147_483_647)) {
        throw new InvalidArgsError('rank must be a finite 32-bit integer');
    }
    const rank = typeof a.rank === 'number' ? Math.floor(a.rank) : null;

    const owned = await requireOwnedList(deps, slug, ownerProjectId);
    if (!owned.ok) return owned;

    const resolved = await resolveMint(deps, mint);
    if (!resolved.ok) return resolved;

    // Cap enforcement happens inside the repo transaction (list row locked),
    // so a PUT racing a batch cannot overshoot or duplicate ranks.
    const inserted = await deps.repo.upsertMember({
        listId: owned.value.id,
        mint,
        rank,
        note,
        addedAt: deps.now(),
        snapshot: resolved.value.snapshot,
        membersPerListCap: deps.caps.membersPerList,
    });
    if (!inserted) return { ok: false, error: 'list_full' };
    return resolved;
}

export async function removeMember(
    deps: TokenListsMutationsDeps,
    args: unknown,
): Promise<MutationOutcome<{ mint: string }>> {
    const a = asObject(args);
    const ownerProjectId = requireString(a, 'ownerProjectId');
    const slug = requireString(a, 'slug');
    const mint = requireString(a, 'mint');

    const owned = await requireOwnedList(deps, slug, ownerProjectId);
    if (!owned.ok) return owned;

    const removed = await deps.repo.removeMember(owned.value.id, mint, deps.now());
    if (!removed) return { ok: false, error: 'not_found' };
    return { ok: true, value: { mint } };
}

export interface BatchAddResult {
    added: MemberResult[];
    failed: Array<{ mint: string; error: TokenListMutationErrorCode }>;
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep item order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index] as T);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

const PROVIDER_LOOKUP_CONCURRENCY = 5;

export async function addMembersBatch(
    deps: TokenListsMutationsDeps,
    args: unknown,
): Promise<MutationOutcome<BatchAddResult>> {
    const a = asObject(args);
    const ownerProjectId = requireString(a, 'ownerProjectId');
    const slug = requireString(a, 'slug');
    if (!Array.isArray(a.mints) || a.mints.some(m => typeof m !== 'string')) {
        throw new InvalidArgsError('mints must be an array of strings');
    }
    const mints = [...new Set((a.mints as string[]).map(m => m.trim()).filter(Boolean))];
    if (mints.length > deps.caps.batch) return { ok: false, error: 'batch_too_large' };

    const owned = await requireOwnedList(deps, slug, ownerProjectId);
    if (!owned.ok) return owned;
    const listId = owned.value.id;

    const failed: BatchAddResult['failed'] = [];

    // Format gate first — malformed strings never reach the DB or the provider.
    const wellFormed = mints.filter(mint => {
        if (SOLANA_MINT_REGEX.test(mint)) return true;
        failed.push({ mint, error: 'invalid_mint' });
        return false;
    });

    // Batched local resolution: two IN-queries instead of 2N round trips.
    const verifiedSet = new Set(await deps.repo.filterMintsWithActiveVariants(wellFormed));
    const unverifiedCandidates = wellFormed.filter(mint => !verifiedSet.has(mint));
    const knownSet = new Set(await deps.repo.filterMintsKnownTokens(unverifiedCandidates));
    const providerCandidates = unverifiedCandidates.filter(mint => !knownSet.has(mint));

    // Provider lookups are budgeted per call: a batch full of unknown mints
    // must not turn into a thousand Birdeye requests. Over-budget unknowns
    // fail individually and can be retried in a later batch.
    const withinBudget = providerCandidates.slice(0, deps.caps.providerLookups);
    for (const mint of providerCandidates.slice(deps.caps.providerLookups)) {
        failed.push({ mint, error: 'unknown_mint' });
    }
    const providerResolved = new Map<string, MemberSnapshot>();
    await mapWithConcurrency(withinBudget, PROVIDER_LOOKUP_CONCURRENCY, async mint => {
        const overview = await deps.fetchTokenOverview(mint).catch(() => null);
        if (!overview) {
            failed.push({ mint, error: 'unknown_mint' });
            return;
        }
        providerResolved.set(mint, {
            symbol: typeof overview.symbol === 'string' ? overview.symbol : null,
            name: typeof overview.name === 'string' ? overview.name : null,
            logoUri: typeof overview.logoURI === 'string' ? overview.logoURI : null,
            decimals: typeof overview.decimals === 'number' ? overview.decimals : null,
        });
    });

    const resolved: MemberResult[] = wellFormed.flatMap((mint): MemberResult[] => {
        if (verifiedSet.has(mint)) return [{ mint, verified: true, snapshot: null }];
        if (knownSet.has(mint)) return [{ mint, verified: false, snapshot: null }];
        const snapshot = providerResolved.get(mint);
        return snapshot ? [{ mint, verified: false, snapshot }] : [];
    });

    // Members-per-list cap: updates of existing members are free; net-new
    // inserts consume slots in request order, and the overflow fails as
    // list_full without sinking the rest of the batch.
    const existingSet = new Set(
        await deps.repo.filterMintsExistingMembers(
            listId,
            resolved.map(member => member.mint),
        ),
    );
    const currentCount = await deps.repo.countMembers(listId);
    let slots = Math.max(0, deps.caps.membersPerList - currentCount);
    const added: MemberResult[] = [];
    const rows: Array<{ mint: string; note: string | null; addedAt: number; snapshot: MemberSnapshot | null }> = [];
    const addedAt = deps.now();
    for (const member of resolved) {
        if (!existingSet.has(member.mint)) {
            if (slots === 0) {
                failed.push({ mint: member.mint, error: 'list_full' });
                continue;
            }
            slots -= 1;
        }
        rows.push({ mint: member.mint, note: null, addedAt, snapshot: member.snapshot });
        added.push(member);
    }

    if (rows.length > 0) {
        // The pre-check above is a fast path only; the repo re-checks the cap
        // under a row lock, so concurrent batches cannot overshoot it.
        const { overflowMints } = await deps.repo.upsertMembersBulk(listId, rows, deps.caps.membersPerList);
        if (overflowMints.length > 0) {
            const overflow = new Set(overflowMints);
            for (const mint of overflowMints) failed.push({ mint, error: 'list_full' });
            const kept = added.filter(member => !overflow.has(member.mint));
            added.length = 0;
            added.push(...kept);
        }
    }
    return { ok: true, value: { added, failed } };
}
