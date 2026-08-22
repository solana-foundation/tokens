import { normalizeCuratedTokenListId } from '@tokens/asset-registry/compat';

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

/** Route segments + derived ids that must never become community list slugs. */
const STATIC_RESERVED_SLUGS = new Set(['all', 'lists', 'curated', 'tokens', 'search-tokens', 'check-slug']);

export function isReservedTokenListSlug(slug: string): boolean {
    if (STATIC_RESERVED_SLUGS.has(slug)) return true;
    // Curated list ids (and their aliases, e.g. 'stables') stay ours.
    return normalizeCuratedTokenListId(slug) !== null;
}

const SOLANA_MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const TOKEN_LIST_STATUSES = ['draft', 'published', 'archived'] as const;
export type TokenListStatus = (typeof TOKEN_LIST_STATUSES)[number];

export const MEMBER_BATCH_CAP = 100;

export interface TokenListMutationRow {
    id: string;
    slug: string;
    owner_project_id: string;
    name: string;
    status: string;
    /** Unix ms. */
    created_at: number;
    /** Unix ms. */
    updated_at: number;
}

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
    /** Hard delete — members cascade, and the slug goes back to the pool. */
    deleteList(listId: string): Promise<void>;
    /** Upsert on (list_id, mint); missing rank appends after the current max. Touches the parent list. */
    upsertMember(args: {
        listId: string;
        mint: string;
        rank: number | null;
        note: string | null;
        addedAt: number;
        snapshot: MemberSnapshot | null;
    }): Promise<void>;
    /** Returns false when the mint was not a member. Touches the parent list when it was. */
    removeMember(listId: string, mint: string, nowMs: number): Promise<boolean>;
    /** An active registry variant exists for the mint (tombstone-filtered). */
    hasActiveVariantForMint(mint: string): Promise<boolean>;
    /** The mint exists in the tokens table (read-time hydration will cover metadata). */
    hasTokenForAddress(mint: string): Promise<boolean>;
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
}

export type TokenListMutationErrorCode =
    | 'invalid_slug'
    | 'reserved_slug'
    | 'slug_conflict'
    | 'not_found'
    | 'forbidden'
    | 'invalid_mint'
    | 'unknown_mint'
    | 'batch_too_large';

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

function requireString(a: Record<string, unknown>, key: string): string {
    const value = a[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw new InvalidArgsError(`${key} must be a non-empty string`);
    }
    return value.trim();
}

function optionalString(a: Record<string, unknown>, key: string): string | undefined {
    const value = a[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string when present`);
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
    return { ok: true, value: row };
}

export async function createList(
    deps: TokenListsMutationsDeps,
    args: unknown,
): Promise<MutationOutcome<TokenListResult>> {
    const a = asObject(args);
    const ownerProjectId = requireString(a, 'ownerProjectId');
    const slug = requireString(a, 'slug').toLowerCase();
    const name = requireString(a, 'name');
    const status = optionalStatus(a) ?? 'published';

    if (!TOKEN_LIST_SLUG_REGEX.test(slug)) return { ok: false, error: 'invalid_slug' };
    if (isReservedTokenListSlug(slug)) return { ok: false, error: 'reserved_slug' };

    try {
        const row = await deps.repo.insertList({
            slug,
            ownerProjectId,
            name,
            status,
            nowMs: deps.now(),
        });
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
    const name = optionalString(a, 'name');
    const status = optionalStatus(a);

    if (newSlug !== undefined && newSlug.length > 0) {
        if (!TOKEN_LIST_SLUG_REGEX.test(newSlug)) return { ok: false, error: 'invalid_slug' };
        if (isReservedTokenListSlug(newSlug)) return { ok: false, error: 'reserved_slug' };
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

    await deps.repo.deleteList(owned.value.id);
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
    const note = optionalString(a, 'note') ?? null;
    if (a.rank !== undefined && a.rank !== null && typeof a.rank !== 'number') {
        throw new InvalidArgsError('rank must be a number when present');
    }
    const rank = typeof a.rank === 'number' ? Math.floor(a.rank) : null;

    const owned = await requireOwnedList(deps, slug, ownerProjectId);
    if (!owned.ok) return owned;

    const resolved = await resolveMint(deps, mint);
    if (!resolved.ok) return resolved;

    await deps.repo.upsertMember({
        listId: owned.value.id,
        mint,
        rank,
        note,
        addedAt: deps.now(),
        snapshot: resolved.value.snapshot,
    });
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
    if (mints.length > MEMBER_BATCH_CAP) return { ok: false, error: 'batch_too_large' };

    const owned = await requireOwnedList(deps, slug, ownerProjectId);
    if (!owned.ok) return owned;

    const added: MemberResult[] = [];
    const failed: BatchAddResult['failed'] = [];
    for (const mint of mints) {
        const resolved = await resolveMint(deps, mint);
        if (!resolved.ok) {
            failed.push({ mint, error: resolved.error });
            continue;
        }
        await deps.repo.upsertMember({
            listId: owned.value.id,
            mint,
            rank: null,
            note: null,
            addedAt: deps.now(),
            snapshot: resolved.value.snapshot,
        });
        added.push(resolved.value);
    }
    return { ok: true, value: { added, failed } };
}
