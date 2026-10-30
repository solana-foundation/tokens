import { Effect } from 'effect';

import { listDeletedRefs as listDeletedRefsRpc, type CloudRunError, type ListDeletedRefsResult } from '@/lib/cloudrun';

/**
 * Per-process memo over cloudrun-assets `listDeletedRefs` (asset deletion
 * tombstones). Nearly every asset route asks "is this ref hard-deleted?" as a
 * separate Cloud Run round-trip (~17 ms from Vercel for a 156-byte answer)
 * even though the answer only changes when an operator hard-deletes or
 * re-seeds an asset.
 *
 * Shape: the tombstone table is unbounded and has no "list all" handler, so
 * this is a bounded per-ref memo (positive *and* negative answers) rather
 * than a full snapshot like `advisories.ts` / `asset-id-renames.ts`. Known
 * refs are answered locally; only unknown or expired refs go to Cloud Run,
 * in one batch.
 *
 * Wire semantics are preserved exactly: refs are trimmed + lowercased and
 * de-duplicated (the server does the same), at most 2 000 are looked up per
 * call (the server's cap), and the result is the subset of normalized refs
 * that are deleted, in first-occurrence input order — what the server returns.
 * Failures propagate (every caller is already fail-open) and are never
 * memoised.
 *
 * Accepted delta: a hard-deleted asset stays resolvable for up to `TTL_MS`
 * on an instance holding a negative entry — the same lag admin renames and
 * curated membership already have.
 *
 * Kill switch: `TOKENS_DELETED_REFS_MEMO=off` makes this a pass-through.
 */
const TTL_MS = Number(process.env.TOKENS_DELETED_REFS_TTL_MS) || 60_000;
const MAX_ENTRIES = 10_000;
/** Mirrors the server-side cap in `handlers/assetDeletionTombstones.ts`. */
const MAX_REFS_PER_CALL = 2_000;

type DeletedRefsLoader = (args: { refs: string[] }) => Effect.Effect<ListDeletedRefsResult, CloudRunError>;

interface MemoEntry {
    deleted: boolean;
    at: number;
}

const memo = new Map<string, MemoEntry>();
let loader: DeletedRefsLoader = listDeletedRefsRpc;

function memoEnabled(): boolean {
    return process.env.TOKENS_DELETED_REFS_MEMO?.trim().toLowerCase() !== 'off';
}

function normalizeRef(ref: string): string {
    return ref.trim().toLowerCase();
}

function remember(ref: string, deleted: boolean, now: number): void {
    // Re-inserting moves the key to the end, so Map order stays "oldest first".
    memo.delete(ref);
    if (memo.size >= MAX_ENTRIES) {
        const oldest = memo.keys().next().value;
        if (oldest !== undefined) memo.delete(oldest);
    }
    memo.set(ref, { deleted, at: now });
}

function lookup(ref: string, now: number): boolean | undefined {
    const entry = memo.get(ref);
    if (!entry) return undefined;
    if (now - entry.at >= TTL_MS) {
        memo.delete(ref);
        return undefined;
    }
    return entry.deleted;
}

/**
 * Drop-in for the Cloud Run wrapper: same args, same result, same error
 * channel — but answered from the memo whenever every ref is already known.
 */
export function listDeletedRefs(args: { refs: string[] }): Effect.Effect<ListDeletedRefsResult, CloudRunError> {
    if (!memoEnabled()) return loader(args);

    return Effect.gen(function* () {
        const now = Date.now();
        const normalized: string[] = [];
        const seen = new Set<string>();
        for (const raw of args.refs) {
            if (typeof raw !== 'string') continue;
            const ref = normalizeRef(raw);
            if (!ref || seen.has(ref)) continue;
            seen.add(ref);
            normalized.push(ref);
        }
        // The server considers at most 2 000 refs; anything beyond is neither
        // checked nor memoised, exactly as before.
        const considered = normalized.slice(0, MAX_REFS_PER_CALL);

        const unknown = considered.filter(ref => lookup(ref, now) === undefined);
        if (unknown.length > 0) {
            const deletedRows = yield* loader({ refs: unknown });
            const deleted = new Set(Array.isArray(deletedRows) ? deletedRows.map(normalizeRef) : []);
            for (const ref of unknown) remember(ref, deleted.has(ref), now);
        }

        return considered.filter(ref => lookup(ref, now) === true);
    });
}

/** Test hook: clear the memo (and restore the Cloud Run loader when `resetLoader`). */
export function __resetDeletedRefsForTests(options: { resetLoader?: boolean } = {}): void {
    memo.clear();
    if (options.resetLoader !== false) loader = listDeletedRefsRpc;
}

/** Test hook: seed the memo with deleted refs (positive entries) and known-live refs (negative entries). */
export function __setDeletedRefsForTests(seed: { deleted?: string[]; live?: string[] }): void {
    const now = Date.now();
    for (const ref of seed.deleted ?? []) remember(normalizeRef(ref), true, now);
    for (const ref of seed.live ?? []) remember(normalizeRef(ref), false, now);
}

/** Test hook: swap the loader (`null` restores the Cloud Run query). */
export function __setDeletedRefsLoaderForTests(next: DeletedRefsLoader | null): void {
    loader = next ?? listDeletedRefsRpc;
}

/** Test hook: current memo size. */
export function __deletedRefsMemoSizeForTests(): number {
    return memo.size;
}
