import { describe, expect, it } from 'bun:test';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';

import { makeSnapshotCache, type SnapshotCacheFailure } from './snapshot-cache';

class LoadError extends Error {
    readonly _tag = 'LoadError';
}

/** A loader whose attempts are released by the test, one gate per call. */
function gatedLoader<A>() {
    const gates: Array<Deferred.Deferred<A, LoadError>> = [];
    const load = Effect.suspend(() => {
        const gate = Deferred.makeUnsafe<A, LoadError>();
        gates.push(gate);
        return Deferred.await(gate);
    });
    return {
        load,
        calls: () => gates.length,
        release: (index: number, outcome: Exit.Exit<A, LoadError>) =>
            Effect.runPromise(Deferred.done(gates[index]!, outcome)),
    };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

function harness(opts: { ttlMs?: number; coldRetryBackoffMs?: number } = {}) {
    let t = 1_000_000;
    const failures: Array<SnapshotCacheFailure<LoadError>> = [];
    const loader = gatedLoader<string>();
    const cache = makeSnapshotCache<string, LoadError>({
        name: 'test',
        load: loader.load,
        ttlMs: opts.ttlMs ?? 1_000,
        ...(opts.coldRetryBackoffMs !== undefined ? { coldRetryBackoffMs: opts.coldRetryBackoffMs } : {}),
        onFailure: failure => failures.push(failure),
        now: () => t,
    });
    return { cache, loader, failures, advance: (ms: number) => (t += ms) };
}

describe('makeSnapshotCache', () => {
    it('serves a fresh value without loading', async () => {
        const { cache, loader } = harness();
        cache.setForTests('seed');
        expect(await Effect.runPromise(cache.get)).toBe('seed');
        expect(cache.peekSync()).toBe('seed');
        expect(loader.calls()).toBe(0);
    });

    it('serves a stale value immediately and refreshes once in the background', async () => {
        const { cache, loader, advance } = harness({ ttlMs: 1_000 });
        cache.setForTests('old');
        advance(1_000);

        expect(await Effect.runPromise(cache.get)).toBe('old');
        expect(cache.peekSync()).toBe('old');
        expect(loader.calls()).toBe(1);

        await loader.release(0, Exit.succeed('new'));
        await settle();
        expect(cache.peekSync()).toBe('new');
        expect(await Effect.runPromise(cache.get)).toBe('new');
        expect(loader.calls()).toBe(1);
    });

    it('keeps the last good value when a refresh fails (stale-forever)', async () => {
        const { cache, loader, failures, advance } = harness({ ttlMs: 1_000 });
        cache.setForTests('old');
        advance(5_000);

        expect(cache.peekSync()).toBe('old');
        await loader.release(0, Exit.fail(new LoadError('down')));
        await settle();

        expect(cache.peekSync()).toBe('old');
        expect(await Effect.runPromise(cache.get)).toBe('old');
        expect(failures.length).toBe(1);
        expect(failures[0]!.hadSnapshot).toBe(true);
        expect(failures[0]!.stalenessMs).toBe(5_000);
        expect(failures[0]!.error).toBeInstanceOf(LoadError);
    });

    it('cold readers share one in-flight load', async () => {
        const { cache, loader } = harness();
        const a = Effect.runPromise(cache.get);
        const b = Effect.runPromise(cache.get);
        cache.peekSync();
        expect(loader.calls()).toBe(1);

        await loader.release(0, Exit.succeed('value'));
        expect(await Promise.all([a, b])).toEqual(['value', 'value']);
    });

    it('a cold failure fails every joiner with the typed error, then backs off', async () => {
        const { cache, loader, failures, advance } = harness({ coldRetryBackoffMs: 5_000 });
        const a = Effect.runPromise(Effect.flip(cache.get));
        const b = Effect.runPromise(Effect.flip(cache.get));
        await loader.release(0, Exit.fail(new LoadError('down')));
        const [errA, errB] = await Promise.all([a, b]);
        expect(errA).toBeInstanceOf(LoadError);
        expect(errB).toBe(errA);
        expect(failures.length).toBe(1);
        expect(failures[0]!.hadSnapshot).toBe(false);
        expect(failures[0]!.stalenessMs).toBeNull();

        // Backoff window: no second RPC, immediate rejection with the same error.
        expect(await Effect.runPromise(Effect.flip(cache.get))).toBe(errA);
        expect(cache.peekSync()).toBeNull();
        expect(loader.calls()).toBe(1);

        advance(5_000);
        const retry = Effect.runPromise(cache.get);
        expect(loader.calls()).toBe(2);
        await loader.release(1, Exit.succeed('recovered'));
        expect(await retry).toBe('recovered');
    });

    it('getOrElse fails open over defects too and records the backoff', async () => {
        let calls = 0;
        const failures: Array<SnapshotCacheFailure<never>> = [];
        const cache = makeSnapshotCache<string, never>({
            name: 'test',
            load: Effect.suspend(() => {
                calls += 1;
                return Effect.die(new Error('boom'));
            }),
            ttlMs: 1_000,
            coldRetryBackoffMs: 5_000,
            onFailure: failure => failures.push(failure),
        });
        expect(await Effect.runPromise(cache.getOrElse(() => 'fallback'))).toBe('fallback');
        expect(
            await Effect.runPromise(cache.getOrElse(cause => (Cause.hasInterruptsOnly(cause) ? 'x' : 'fallback'))),
        ).toBe('fallback');
        expect(calls).toBe(1);
        expect(failures[0]!.error).toBeInstanceOf(Error);
    });

    it('interrupting a joiner does not kill the shared load', async () => {
        const { cache, loader } = harness();
        const joiner = Effect.runFork(cache.get);
        expect(loader.calls()).toBe(1);
        await Effect.runPromise(Fiber.interrupt(joiner));

        const controller = new AbortController();
        const aborted = Effect.runPromise(cache.get, { signal: controller.signal }).catch(() => 'aborted');
        controller.abort();
        expect(await aborted).toBe('aborted');
        expect(loader.calls()).toBe(1);

        await loader.release(0, Exit.succeed('value'));
        await settle();
        expect(cache.peekSync()).toBe('value');
    });

    it('peekSync kicks a cold load but not while backing off', async () => {
        const { cache, loader } = harness({ coldRetryBackoffMs: 5_000 });
        expect(cache.peekSync()).toBeNull();
        expect(loader.calls()).toBe(1);
        await loader.release(0, Exit.fail(new LoadError('down')));
        await settle();
        expect(cache.peekSync()).toBeNull();
        expect(loader.calls()).toBe(1);
    });

    it('setForTests discards a load started before the reset', async () => {
        const { cache, loader } = harness();
        const pending = Effect.runPromise(cache.get);
        cache.setForTests(null);
        await loader.release(0, Exit.succeed('late'));
        expect(await pending).toBe('late');
        expect(cache.peekSync()).toBeNull();
        expect(loader.calls()).toBe(2);
    });
});
