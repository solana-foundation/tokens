import { Effect } from 'effect';

import { emitEvent } from '@tokens/effect';

import { MEMOISABLE_QUERY_NAMES, CloudRunQueryMemo, cloudRunMemoKey, cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

/**
 * Speculative server batch → request-scoped query memo.
 *
 * Multi-hop routes (resolve first) decide their next Cloud Run call from the
 * previous result, so they pay 4–9 sequential round-trips of ~17 ms each for
 * ~5 ms of server work apiece. Instead of re-implementing those decision
 * trees as composites (which would drift and change responses), the server
 * walks the *same* tree in-process and hands back the raw result of every
 * single-purpose handler it ran, keyed by the exact args the route will send.
 * The route's own calls then hit the memo instead of the network.
 *
 * Safety: a memo entry is only used for the same handler with the same args,
 * and holds what that handler returns (same code, same database). If the
 * server's walk diverges from the route's, the route misses the memo and
 * pays today's call. Correctness never depends on the server guessing right;
 * the batch failing, timing out, or not existing on an older server only
 * costs latency.
 *
 * Kill switch: `TOKENS_SPECULATIVE_BATCH=off`.
 */

export type SpeculativeBatchProfile = 'resolve';

export interface SpeculativeBatchArgs {
    profile: SpeculativeBatchProfile;
    ref?: string;
    mint?: string;
}

export interface SpeculativeBatchEntry {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
}

export interface SpeculativeBatchResult {
    entries: SpeculativeBatchEntry[];
}

/** The batch is ~30–50 ms of server work; a long tail is worse than the win. */
const BATCH_TIMEOUT_MS = 750;
/** After a 404 (older server without the handler), skip the batch for a while. */
const UNAVAILABLE_BACKOFF_MS = 5 * 60_000;

let unavailableUntilMs = 0;

function enabled(): boolean {
    return process.env.TOKENS_SPECULATIVE_BATCH?.trim().toLowerCase() !== 'off';
}

function isEntry(value: unknown): value is SpeculativeBatchEntry {
    if (!value || typeof value !== 'object') return false;
    const entry = value as Partial<SpeculativeBatchEntry>;
    return typeof entry.name === 'string' && !!entry.args && typeof entry.args === 'object' && 'result' in entry;
}

function logBatchEvent(fields: Record<string, unknown>): void {
    emitEvent({ event: 'speculative_batch', ...fields });
}

/**
 * Seed the current request's memo from the server batch. Never fails and
 * never throws: every problem degrades to "no memo" with one log line.
 */
export function seedSpeculativeMemo(args: SpeculativeBatchArgs): Effect.Effect<void, never> {
    return Effect.gen(function* () {
        if (!enabled()) return;
        if (Date.now() < unavailableUntilMs) return;

        const store = yield* Effect.service(CloudRunQueryMemo);
        if (!store) return;

        const outcome = yield* cloudRunQuery<SpeculativeBatchResult>(
            'assets',
            'assetsApiSpeculativeBatchForApi',
            { ...args },
            { timeoutMs: BATCH_TIMEOUT_MS },
        ).pipe(
            Effect.map(result => ({ ok: true as const, result })),
            Effect.catch((error: CloudRunError) => Effect.succeed({ ok: false as const, error })),
        );

        if (!outcome.ok) {
            const error = outcome.error;
            if (error._tag === 'CloudRunHttpError' && error.status === 404) {
                // Older cloudrun-assets without the handler: remember per
                // process so the next requests skip straight to the live path.
                unavailableUntilMs = Date.now() + UNAVAILABLE_BACKOFF_MS;
                logBatchEvent({ profile: args.profile, status: 'unavailable', backoff_ms: UNAVAILABLE_BACKOFF_MS });
                return;
            }
            logBatchEvent({ profile: args.profile, status: 'failed', error_tag: error._tag });
            return;
        }

        const entries = Array.isArray(outcome.result?.entries) ? outcome.result.entries : [];
        let seeded = 0;
        for (const entry of entries) {
            if (!isEntry(entry)) continue;
            if (!MEMOISABLE_QUERY_NAMES.has(entry.name)) continue;
            store.put(cloudRunMemoKey('assets', entry.name, entry.args), entry.result);
            seeded += 1;
        }
        logBatchEvent({ profile: args.profile, status: 'ok', entries: entries.length, seeded });
    });
}

/** Test hook: clear the "handler unavailable" backoff. */
export function __resetSpeculativeBatchForTests(): void {
    unavailableUntilMs = 0;
}
