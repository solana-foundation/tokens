import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { CanonicalAsset } from '@tokens/asset-registry';

import { httpStatusForError, type AssetAdvisoryError } from '@tokens/effect';
import { CloudRunHttpError, type AssetAdvisoriesListResult, type AssetAdvisoryRow } from '@/lib/cloudrun';

import {
    __setAdvisoriesForTests,
    __setAdvisoriesLoaderForTests,
    annotateAssetAdvisories,
    filterHiddenVariants,
    getAdvisoriesByMint,
    getAdvisoriesByMintSync,
    getAdvisoryRevisionSync,
    loadAdvisoriesOrEmpty,
    requireTradeable,
    summarizeAssetAdvisories,
    tradeRestrictedMints,
} from './advisories';

const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkYtvdQ7BPP3Qz1n';
const MINT_C = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_D = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const rowCompromised: AssetAdvisoryRow = {
    mint: MINT_A,
    status: 'compromised',
    reason: 'Issuer exploited',
    url: 'https://example.com/incident',
    since: 1_700_000_000_000,
};
const rowBlocked: AssetAdvisoryRow = { mint: MINT_B, status: 'blocked', reason: 'Drainer', url: null, since: 1_700_000_100_000 };
const rowCaution: AssetAdvisoryRow = { mint: MINT_C, status: 'caution', reason: 'Migration', url: null, since: 1_700_000_200_000 };

function asset(mints: string[]): CanonicalAsset {
    return {
        assetId: 'silver',
        name: 'Silver',
        symbol: 'XAG',
        category: 'commodity',
        aliases: [],
        variants: mints.map((mint, index) => ({
            variantId: `silver:v${index}`,
            mint,
            kind: 'wrapped' as const,
            trustTier: 'tier2' as const,
            tags: [],
        })),
    };
}

/** Test loader: counts calls, resolves/rejects per queue entry, optionally deferred. */
function makeLoader(script: Array<AssetAdvisoriesListResult | Error>) {
    const state = { calls: 0, release: [] as Array<() => void>, auto: false };
    const loader = () =>
        Effect.tryPromise({
            try: () =>
                new Promise<AssetAdvisoriesListResult>((resolve, reject) => {
                    const index = state.calls;
                    state.calls += 1;
                    const outcome = script[Math.min(index, script.length - 1)]!;
                    const fire = () => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
                    // Once released, later starts settle immediately (the fiber
                    // may reach the executor after `releaseAll()` was called).
                    if (state.auto) fire();
                    else state.release.push(fire);
                }),
            catch: err =>
                new CloudRunHttpError({
                    message: err instanceof Error ? err.message : String(err),
                    service: 'assets',
                    kind: 'query',
                    callName: 'assetAdvisoriesList',
                    status: 503,
                }),
        });
    const releaseAll = () => {
        state.auto = true;
        const pending = state.release.splice(0);
        for (const fn of pending) fn();
    };
    return { loader, state, releaseAll };
}

async function rejectsWith(promise: Promise<unknown>): Promise<boolean> {
    try {
        await promise;
        return false;
    } catch {
        return true;
    }
}

async function settle(): Promise<void> {
    // Let promise continuations (Effect fiber completion, .finally) run.
    for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

describe('advisories cache', () => {
    beforeEach(() => {
        __setAdvisoriesForTests(null);
    });
    afterEach(() => {
        __setAdvisoriesForTests(null);
        __setAdvisoriesLoaderForTests(null);
    });

    it('cold load populates the map and revision; sync reads see it afterwards', async () => {
        const { loader, state, releaseAll } = makeLoader([{ revision: 7, advisories: [rowCompromised, rowCaution] }]);
        __setAdvisoriesLoaderForTests(loader);

        expect(getAdvisoriesByMintSync().size).toBe(0);
        expect(getAdvisoryRevisionSync()).toBe(0);

        const pending = getAdvisoriesByMint();
        releaseAll();
        const byMint = await pending;

        expect(byMint.get(MINT_A)?.status).toBe('compromised');
        expect(byMint.get(MINT_C)?.status).toBe('caution');
        expect(getAdvisoriesByMintSync().get(MINT_A)?.reason).toBe('Issuer exploited');
        expect(getAdvisoryRevisionSync()).toBe(7);
        expect(state.calls).toBe(1);
    });

    it('single-flight: concurrent cold callers share one RPC', async () => {
        const { loader, state, releaseAll } = makeLoader([{ revision: 1, advisories: [rowBlocked] }]);
        __setAdvisoriesLoaderForTests(loader);

        const a = getAdvisoriesByMint();
        const b = getAdvisoriesByMint();
        getAdvisoriesByMintSync();
        getAdvisoryRevisionSync();
        expect(state.calls).toBe(1);

        releaseAll();
        const [mapA, mapB] = await Promise.all([a, b]);
        expect(mapA).toBe(mapB);
        expect(mapA.get(MINT_B)?.status).toBe('blocked');
    });

    it('TTL: a fresh snapshot is served without refreshing; an expired one refreshes in the background', async () => {
        const { loader, state, releaseAll } = makeLoader([{ revision: 2, advisories: [rowBlocked] }]);
        __setAdvisoriesLoaderForTests(loader);

        __setAdvisoriesForTests([rowCompromised], { revision: 1 });
        expect((await getAdvisoriesByMint()).get(MINT_A)?.status).toBe('compromised');
        getAdvisoriesByMintSync();
        expect(state.calls).toBe(0);

        __setAdvisoriesForTests([rowCompromised], { revision: 1, loadedAtMs: Date.now() - 60_000 });
        const stale = getAdvisoriesByMintSync();
        expect(stale.get(MINT_A)?.status).toBe('compromised'); // last-good, no blocking
        expect(state.calls).toBe(1);

        releaseAll();
        await settle();
        expect(getAdvisoriesByMintSync().get(MINT_B)?.status).toBe('blocked');
        expect(getAdvisoriesByMintSync().has(MINT_A)).toBe(false);
        expect(getAdvisoryRevisionSync()).toBe(2);
    });

    it('stale-forever: a failed refresh keeps serving the last good set', async () => {
        const { loader, state, releaseAll } = makeLoader([new Error('upstream down')]);
        __setAdvisoriesLoaderForTests(loader);
        __setAdvisoriesForTests([rowCompromised], { revision: 5, loadedAtMs: Date.now() - 60_000 });

        const beforeFailure = await getAdvisoriesByMint();
        expect(beforeFailure.get(MINT_A)?.status).toBe('compromised');
        expect(state.calls).toBe(1);

        releaseAll();
        await settle();

        expect(getAdvisoriesByMintSync().get(MINT_A)?.status).toBe('compromised');
        expect(getAdvisoryRevisionSync()).toBe(5);
        expect((await getAdvisoriesByMint()).get(MINT_A)?.status).toBe('compromised');
    });

    it('cold failure: getAdvisoriesByMint rejects, loadAdvisoriesOrEmpty yields an empty map, then backs off', async () => {
        const { loader, state, releaseAll } = makeLoader([new Error('upstream down')]);
        __setAdvisoriesLoaderForTests(loader);

        const pending = getAdvisoriesByMint();
        releaseAll();
        expect(await rejectsWith(pending)).toBe(true);
        expect(state.calls).toBe(1);

        // Backoff window: no second RPC, immediate rejection.
        expect(await rejectsWith(getAdvisoriesByMint())).toBe(true);
        expect(state.calls).toBe(1);

        const empty = await Effect.runPromise(loadAdvisoriesOrEmpty());
        expect(empty.size).toBe(0);
        expect(getAdvisoriesByMintSync().size).toBe(0);
        expect(state.calls).toBe(1);
    });

    it('drops rows with unknown statuses instead of failing the whole set', async () => {
        __setAdvisoriesForTests([
            rowCaution,
            { mint: MINT_D, status: 'nuked' as unknown as AssetAdvisoryRow['status'], reason: '', url: null, since: 0 },
        ]);
        const byMint = getAdvisoriesByMintSync();
        expect(byMint.has(MINT_D)).toBe(false);
        expect(byMint.get(MINT_C)?.status).toBe('caution');
    });
});

describe('advisory helpers', () => {
    const byMint = new Map([
        [MINT_A, { status: 'compromised' as const, reason: 'Issuer exploited', url: 'https://x', since: 2 }],
        [MINT_B, { status: 'blocked' as const, reason: 'Drainer', url: null, since: 3 }],
        [MINT_C, { status: 'caution' as const, reason: 'Migration', url: null, since: 1 }],
    ]);

    it('tradeRestrictedMints excludes caution', () => {
        const restricted = tradeRestrictedMints(byMint);
        expect([...restricted].sort()).toEqual([MINT_A, MINT_B].sort());
    });

    it('annotateAssetAdvisories sets advisory on every variant (null when none) without mutating the input', () => {
        const input = asset([MINT_A, MINT_D]);
        const annotated = annotateAssetAdvisories(input, byMint);
        expect(annotated).not.toBe(input);
        expect('advisory' in input.variants[0]!).toBe(false);
        expect(annotated.variants[0]?.advisory?.status).toBe('compromised');
        expect(annotated.variants[1]?.advisory).toBeNull();
        expect('advisory' in annotated.variants[1]!).toBe(true);
    });

    it('filterHiddenVariants drops blocked only, returns the same asset when nothing is hidden, null when nothing remains', () => {
        const mixed = annotateAssetAdvisories(asset([MINT_A, MINT_B, MINT_C, MINT_D]), byMint);
        const filtered = filterHiddenVariants(mixed, byMint);
        expect(filtered?.variants.map(v => v.mint)).toEqual([MINT_A, MINT_C, MINT_D]);

        const clean = annotateAssetAdvisories(asset([MINT_D]), byMint);
        expect(filterHiddenVariants(clean, byMint)).toBe(clean);

        expect(filterHiddenVariants(asset([MINT_B]), byMint)).toBeNull();

        // Falls back to the variant's own advisory when the map lacks the mint.
        const preAnnotated = annotateAssetAdvisories(asset([MINT_B, MINT_D]), byMint);
        expect(filterHiddenVariants(preAnnotated, new Map())?.variants.map(v => v.mint)).toEqual([MINT_D]);
    });

    it('summarizeAssetAdvisories orders blocked > compromised > caution, then by mint, and includes variantId', () => {
        const annotated = annotateAssetAdvisories(asset([MINT_C, MINT_A, MINT_D, MINT_B]), byMint);
        const summary = summarizeAssetAdvisories(annotated);
        expect(summary.map(s => s.status)).toEqual(['blocked', 'compromised', 'caution']);
        expect(summary[0]).toEqual({
            mint: MINT_B,
            variantId: 'silver:v3',
            status: 'blocked',
            reason: 'Drainer',
            url: null,
            since: 3,
        });
        expect(summarizeAssetAdvisories(asset([MINT_D]))).toEqual([]);
    });
});

describe('requireTradeable', () => {
    afterEach(() => {
        __setAdvisoriesForTests(null);
        __setAdvisoriesLoaderForTests(null);
    });

    it('passes for unflagged and caution mints', async () => {
        __setAdvisoriesForTests([rowCaution]);
        await Effect.runPromise(requireTradeable(MINT_D));
        await Effect.runPromise(requireTradeable(MINT_C));
    });

    it('fails with AssetAdvisoryError (403 details) for compromised and blocked mints', async () => {
        __setAdvisoriesForTests([rowCompromised, rowBlocked]);

        const compromised = (await Effect.runPromise(
            requireTradeable(MINT_A).pipe(Effect.catch(err => Effect.succeed(err))),
        )) as AssetAdvisoryError;
        expect(compromised._tag).toBe('AssetAdvisoryError');
        expect(compromised.mint).toBe(MINT_A);
        expect(compromised.status).toBe('compromised');
        expect(compromised.reason).toBe('Issuer exploited');
        expect(compromised.url).toBe('https://example.com/incident');
        expect(compromised.details).toEqual({
            code: 'advisory_compromised',
            mint: MINT_A,
            status: 'compromised',
            reason: 'Issuer exploited',
            url: 'https://example.com/incident',
        });
        expect(httpStatusForError(compromised)).toBe(403);

        const blocked = (await Effect.runPromise(
            requireTradeable(MINT_B).pipe(Effect.catch(err => Effect.succeed(err))),
        )) as AssetAdvisoryError;
        expect(blocked._tag).toBe('AssetAdvisoryError');
        expect(blocked.status).toBe('blocked');
        expect((blocked.details as { code: string }).code).toBe('advisory_blocked');
    });

    it('does not fail open: a cold-cache outage propagates the CloudRunError', async () => {
        const { loader, releaseAll } = makeLoader([new Error('upstream down')]);
        __setAdvisoriesLoaderForTests(loader);
        __setAdvisoriesForTests(null);

        const pending = Effect.runPromise(requireTradeable(MINT_D).pipe(Effect.catch(err => Effect.succeed(err))));
        releaseAll();
        const err = (await pending) as { _tag?: string };
        expect(err._tag).toBe('CloudRunHttpError');
    });
});
