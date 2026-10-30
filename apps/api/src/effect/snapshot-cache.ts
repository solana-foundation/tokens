import { Cause, Effect, Fiber } from 'effect';

/**
 * Process-wide "snapshot" cache for a small table the API re-reads on most
 * requests (curated membership, advisories, asset-id renames).
 *
 * Semantics the three callers share:
 * - TTL with stale-while-revalidate: a stale value is served immediately and a
 *   refresh is kicked in the background.
 * - Stale-forever on error: a failed refresh never evicts the last good value.
 * - Cold loads are single-flight: concurrent cold readers join one load.
 * - Optional cold-retry backoff: after a failed cold load, readers fail fast
 *   with the last cause for a while instead of paying the RPC per request.
 * - Synchronous last-good reads for hot paths that cannot await.
 *
 * The load runs as a root fiber (`Effect.runFork`), not as a child of the
 * request that triggered it, so a client abort cannot interrupt a shared
 * refresh and the load sees the default Context (no request id, no request
 * memo), exactly like the detached Promise it replaces. Readers `Fiber.join`
 * it: interrupting a joiner only removes its observer.
 *
 * `Effect.cachedInvalidateWithTTL` is not used because it caches failures for
 * the TTL, blocks every reader during a refresh and has no sync read.
 */

export interface SnapshotCacheFailure<E> {
    readonly cause: Cause.Cause<E>;
    /** `Cause.squash(cause)`: the typed error or the thrown defect. */
    readonly error: unknown;
    /** Whether a last-good value existed when this attempt failed (refresh vs cold load). */
    readonly hadSnapshot: boolean;
    /** Age of the last-good value at failure time; `null` when cold. */
    readonly stalenessMs: number | null;
}

export interface SnapshotCacheOptions<A, E> {
    readonly name: string;
    /** The RPC plus its shaping; re-evaluated per attempt (wrap a swappable loader in `Effect.suspend`). */
    readonly load: Effect.Effect<A, E>;
    readonly ttlMs: number;
    /** After a failed cold load, skip the RPC for this long (default 0: retry on the next read). */
    readonly coldRetryBackoffMs?: number;
    /** Called once per failed attempt, from the loader fiber. */
    readonly onFailure: (failure: SnapshotCacheFailure<E>) => void;
    /** Time source; tests inject a counter. */
    readonly now?: () => number;
}

export interface SnapshotCache<A, E> {
    /**
     * Fresh → the value. Stale → kick a refresh, return the last-good value.
     * Cold → join the in-flight load or start one (fails with the typed error).
     * Cold and backing off → fail with the last attempt's cause.
     */
    readonly get: Effect.Effect<A, E>;
    /** `get`, failing open over the full cause (typed failure or defect). */
    readonly getOrElse: <B>(fallback: (cause: Cause.Cause<E>) => B) => Effect.Effect<A | B, never>;
    /** Synchronous last-good read; kicks a background load when stale or cold (not while backing off). */
    readonly peekSync: () => A | null;
    readonly refreshInBackground: () => void;
    /** Test seam: seed (fresh unless `loadedAtMs` is given) or clear back to cold. */
    readonly setForTests: (value: A | null, options?: { loadedAtMs?: number }) => void;
}

export function makeSnapshotCache<A, E>(options: SnapshotCacheOptions<A, E>): SnapshotCache<A, E> {
    const now = options.now ?? Date.now;
    const backoffMs = options.coldRetryBackoffMs ?? 0;

    // Plain closure state, not a Ref: `peekSync` reads without a runtime, and
    // every write happens either inside the loader fiber or in the test seam.
    let value: A | null = null;
    let loadedAtMs = 0;
    let inflight: Fiber.Fiber<A, E> | null = null;
    let lastFailure: Cause.Cause<E> | null = null;
    let lastFailureAtMs = 0;
    // Bumped by `setForTests` so a load started before a reset cannot write.
    let generation = 0;

    const isStale = (t: number): boolean => value === null || t - loadedAtMs >= options.ttlMs;
    const inColdBackoff = (t: number): boolean =>
        value === null && backoffMs > 0 && lastFailureAtMs > 0 && t - lastFailureAtMs < backoffMs;

    function startLoad(): Fiber.Fiber<A, E> {
        const gen = generation;
        const hadSnapshot = value !== null;
        // `runFork` evaluates synchronously, so a load that completes without
        // suspending runs `ensuring` before `inflight` is assigned below; the
        // `done` flag keeps a finished fiber from being left in `inflight`.
        let done = false;
        let fiber: Fiber.Fiber<A, E> | null = null;

        const attempt = options.load.pipe(
            Effect.tap(next =>
                Effect.sync(() => {
                    if (gen !== generation) return;
                    value = next;
                    loadedAtMs = now();
                    lastFailure = null;
                    lastFailureAtMs = 0;
                }),
            ),
            Effect.tapCause(cause =>
                Effect.sync(() => {
                    if (gen !== generation) return;
                    lastFailure = cause;
                    lastFailureAtMs = now();
                    options.onFailure({
                        cause,
                        error: Cause.squash(cause),
                        hadSnapshot,
                        stalenessMs: loadedAtMs > 0 ? now() - loadedAtMs : null,
                    });
                }),
            ),
            Effect.ensuring(
                Effect.sync(() => {
                    done = true;
                    if (fiber !== null && inflight === fiber) inflight = null;
                }),
            ),
        );

        fiber = Effect.runFork(attempt);
        if (!done) inflight = fiber;
        return fiber;
    }

    function refreshInBackground(): void {
        if (inflight) return;
        const t = now();
        if (!isStale(t) || inColdBackoff(t)) return;
        startLoad();
    }

    const get: Effect.Effect<A, E> = Effect.suspend(() => {
        const t = now();
        if (value !== null) {
            if (isStale(t) && !inflight) startLoad();
            return Effect.succeed(value);
        }
        if (inflight) return Fiber.join(inflight);
        if (lastFailure && inColdBackoff(t)) return Effect.failCause(lastFailure);
        return Fiber.join(startLoad());
    });

    const getOrElse = <B>(fallback: (cause: Cause.Cause<E>) => B): Effect.Effect<A | B, never> =>
        get.pipe(Effect.catchCause(cause => Effect.succeed(fallback(cause))));

    function peekSync(): A | null {
        refreshInBackground();
        return value;
    }

    function setForTests(next: A | null, o: { loadedAtMs?: number } = {}): void {
        generation += 1;
        inflight = null;
        lastFailure = null;
        lastFailureAtMs = 0;
        value = next;
        loadedAtMs = next === null ? 0 : (o.loadedAtMs ?? now());
    }

    return { get, getOrElse, peekSync, refreshInBackground, setForTests };
}
