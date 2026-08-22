import type { Effect } from 'effect';

import { cloudRunMutation, cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

/**
 * Community token lists ("lists as plugins"): project-owned, mint-keyed lists
 * managed through /api/v2/lists. Reads are public (assets:read); mutations
 * carry the caller's project id and are re-checked against list ownership on
 * the Cloud Run side.
 */

export type TokenListSummary = {
    slug: string;
    name: string;
    ownerProjectId: string;
    tokenCount: number;
    updatedAt: number;
};

export type TokenListDetail = TokenListSummary & {
    status: string;
    createdAt: number;
};

export type TokenListMember = {
    mint: string;
    rank: number;
    note: string | null;
    addedAt: number;
    symbol: string | null;
    name: string | null;
    logoUri: string | null;
    decimals: number | null;
    verified: boolean;
};

export function tokenListsList(args: {
    limit?: number;
    offset?: number;
}): Effect.Effect<TokenListSummary[], CloudRunError> {
    return cloudRunQuery<TokenListSummary[]>('assets', 'tokenListsList', { ...args }, { maxRetries: 1 });
}

export function tokenListsGetBySlug(args: { slug: string }): Effect.Effect<TokenListDetail | null, CloudRunError> {
    return cloudRunQuery<TokenListDetail | null>('assets', 'tokenListsGetBySlug', { ...args }, { maxRetries: 1 });
}

export function tokenListsGetMembers(args: {
    slug: string;
    limit?: number;
    offset?: number;
}): Effect.Effect<TokenListMember[], CloudRunError> {
    return cloudRunQuery<TokenListMember[]>('assets', 'tokenListsGetMembers', { ...args }, { maxRetries: 1 });
}

export function tokenListsGetSlugsByMints(args: {
    mints: string[];
}): Effect.Effect<Array<{ mint: string; slugs: string[] }>, CloudRunError> {
    return cloudRunQuery('assets', 'tokenListsGetSlugsByMints', { ...args }, { maxRetries: 1 });
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

export type TokenListMutationOutcome<T> = { ok: true; value: T } | { ok: false; error: TokenListMutationErrorCode };

export type TokenListMutationResult = {
    id: string;
    slug: string;
    ownerProjectId: string;
    name: string;
    status: string;
    createdAt: number;
    updatedAt: number;
};

export type TokenListMemberResult = {
    mint: string;
    verified: boolean;
    snapshot: { symbol: string | null; name: string | null; logoUri: string | null; decimals: number | null } | null;
};

export function tokenListsCreate(args: {
    ownerProjectId: string;
    slug: string;
    name: string;
    status?: string;
}): Effect.Effect<TokenListMutationOutcome<TokenListMutationResult>, CloudRunError> {
    return cloudRunMutation('assets', 'tokenListsCreate', { ...args });
}

export function tokenListsUpdate(args: {
    ownerProjectId: string;
    slug: string;
    /** Rename: the old slug stops resolving and returns to the pool. */
    newSlug?: string;
    name?: string;
    status?: string;
}): Effect.Effect<TokenListMutationOutcome<TokenListMutationResult>, CloudRunError> {
    return cloudRunMutation('assets', 'tokenListsUpdate', { ...args });
}

/** Soft archive: keeps the row and the slug, hides the list from reads. */
export function tokenListsArchive(args: {
    ownerProjectId: string;
    slug: string;
}): Effect.Effect<TokenListMutationOutcome<TokenListMutationResult>, CloudRunError> {
    return cloudRunMutation('assets', 'tokenListsArchive', { ...args });
}

/** Hard delete: drops the list and its members, freeing the slug for reuse. */
export function tokenListsDelete(args: {
    ownerProjectId: string;
    slug: string;
}): Effect.Effect<TokenListMutationOutcome<TokenListMutationResult>, CloudRunError> {
    return cloudRunMutation('assets', 'tokenListsDelete', { ...args });
}

export function tokenListsUpsertMember(args: {
    ownerProjectId: string;
    slug: string;
    mint: string;
    rank?: number;
    note?: string;
}): Effect.Effect<TokenListMutationOutcome<TokenListMemberResult>, CloudRunError> {
    return cloudRunMutation('assets', 'tokenListsUpsertMember', { ...args });
}

export function tokenListsRemoveMember(args: {
    ownerProjectId: string;
    slug: string;
    mint: string;
}): Effect.Effect<TokenListMutationOutcome<{ mint: string }>, CloudRunError> {
    return cloudRunMutation('assets', 'tokenListsRemoveMember', { ...args });
}

export type TokenListBatchAddResult = {
    added: TokenListMemberResult[];
    failed: Array<{ mint: string; error: TokenListMutationErrorCode }>;
};

export function tokenListsAddMembersBatch(args: {
    ownerProjectId: string;
    slug: string;
    mints: string[];
}): Effect.Effect<TokenListMutationOutcome<TokenListBatchAddResult>, CloudRunError> {
    return cloudRunMutation('assets', 'tokenListsAddMembersBatch', { ...args });
}
