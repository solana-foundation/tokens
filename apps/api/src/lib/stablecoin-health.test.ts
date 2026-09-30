import { afterEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import { CloudRunHttpError, type PegHealthRead, type StructuralHealthRead } from '@/lib/cloudrun';

import {
    __setStablecoinHealthLoaderForTests,
    loadStablecoinHealthOrEmpty,
    PEG_STALE_AFTER_MS,
    STABLECOIN_HEALTH_RPC_MAX_MINTS,
    STRUCTURAL_STALE_AFTER_MS,
    toCompactPegHealth,
    toPegHealth,
    toStructuralHealth,
} from './stablecoin-health';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkYtvdQ7BPP3Qz1n';
const NOW = 1_800_000_000_000;

const pegRead: PegHealthRead = {
    provider: 'webacy',
    pegCurrency: null,
    referenceKind: 'fixed',
    tier: 'warning',
    overallRisk: 62.5,
    deviationPct: -2.4,
    priceUsd: 0.976,
    pegUsd: 1,
    liquidityUsd: null,
    tierSince: NOW - 60_000,
    updatedAt: NOW - 1_000,
    ok: true,
    errorMessage: null,
};

const structuralRead: StructuralHealthRead = {
    grade: 'B+',
    score: 31.2,
    categories: [
        { key: 'asset_collateral', score: 20, weight: 0.3, status: 'pass' },
        { key: 'market_liquidity', score: 45, weight: 0.25, status: 'warn' },
        { key: 'smart_contract', score: 10, weight: 0.2, status: 'pass' },
        { key: 'operational_governance', score: null, weight: 0.15, status: 'unknown' },
        { key: 'hack_exploit_history', score: 80, weight: 0.1, status: 'fail' },
    ],
    updatedAt: NOW - 5_000,
    ok: true,
};

afterEach(() => {
    __setStablecoinHealthLoaderForTests(null);
});

describe('toPegHealth', () => {
    it('returns null for null input', () => {
        expect(toPegHealth(null, NOW)).toBeNull();
        expect(toPegHealth(undefined, NOW)).toBeNull();
    });

    it('carries provider, computes stale, and strips worker-internal fields', () => {
        const peg = toPegHealth(pegRead, NOW);
        expect(peg).toEqual({
            provider: 'webacy',
            pegCurrency: null,
            referenceKind: 'fixed',
            tier: 'warning',
            overallRisk: 62.5,
            deviationPct: -2.4,
            priceUsd: 0.976,
            pegUsd: 1,
            liquidityUsd: null,
            tierSince: NOW - 60_000,
            updatedAt: NOW - 1_000,
            stale: false,
        });
        expect('ok' in peg!).toBe(false);
        expect('errorMessage' in peg!).toBe(false);
    });

    it('passes the peg guard provider and liquidity through', () => {
        const peg = toPegHealth({ ...pegRead, provider: 'tokens', overallRisk: null, liquidityUsd: 1_250_000 }, NOW);
        expect(peg?.provider).toBe('tokens');
        expect(peg?.overallRisk).toBeNull();
        expect(peg?.liquidityUsd).toBe(1_250_000);
    });

    it('defaults provider to webacy for worker builds that predate the peg guard', () => {
        const legacy = { ...pegRead } as Partial<PegHealthRead>;
        delete legacy.provider;
        delete legacy.liquidityUsd;
        const peg = toPegHealth(legacy as PegHealthRead, NOW);
        expect(peg?.provider).toBe('webacy');
        expect(peg?.liquidityUsd).toBeNull();
        expect(toPegHealth({ ...pegRead, provider: 'someone-else' as PegHealthRead['provider'] }, NOW)?.provider).toBe(
            'webacy',
        );
    });

    it('copies the peg currency and reference kind, defaulting unknown or missing kinds to fixed', () => {
        const yieldPeg = toPegHealth(
            { ...pegRead, provider: 'tokens', pegCurrency: 'USD', referenceKind: 'high_water', pegUsd: 1.14 },
            NOW,
        );
        expect(yieldPeg?.pegCurrency).toBe('USD');
        expect(yieldPeg?.referenceKind).toBe('high_water');

        const fxPeg = toPegHealth({ ...pegRead, provider: 'tokens', pegCurrency: 'EUR', referenceKind: 'fx' }, NOW);
        expect(fxPeg?.pegCurrency).toBe('EUR');
        expect(fxPeg?.referenceKind).toBe('fx');

        expect(toPegHealth({ ...pegRead, referenceKind: null }, NOW)?.referenceKind).toBe('fixed');
        expect(
            toPegHealth({ ...pegRead, referenceKind: 'ema' as PegHealthRead['referenceKind'] }, NOW)?.referenceKind,
        ).toBe('fixed');
        expect(toPegHealth({ ...pegRead, pegCurrency: '' }, NOW)?.pegCurrency).toBeNull();

        const legacy = { ...pegRead } as Partial<PegHealthRead>;
        delete legacy.pegCurrency;
        delete legacy.referenceKind;
        const peg = toPegHealth(legacy as PegHealthRead, NOW);
        expect(peg?.pegCurrency).toBeNull();
        expect(peg?.referenceKind).toBe('fixed');
    });

    it('flags stale strictly past the 9h bound', () => {
        const atBound = toPegHealth({ ...pegRead, updatedAt: NOW - PEG_STALE_AFTER_MS }, NOW);
        const pastBound = toPegHealth({ ...pegRead, updatedAt: NOW - PEG_STALE_AFTER_MS - 1 }, NOW);
        expect(atBound?.stale).toBe(false);
        expect(pastBound?.stale).toBe(true);
    });

    it('keeps the last good tier when the worker reports a failed refresh', () => {
        const peg = toPegHealth({ ...pegRead, ok: false, errorMessage: 'HTTP 502' }, NOW);
        expect(peg?.tier).toBe('warning');
        expect(peg?.stale).toBe(false);
    });
});

describe('toStructuralHealth', () => {
    it('returns null for null input', () => {
        expect(toStructuralHealth(null, NOW)).toBeNull();
    });

    it('attaches labels to every category and stamps provider', () => {
        const structural = toStructuralHealth(structuralRead, NOW);
        expect(structural?.provider).toBe('webacy');
        expect(structural?.grade).toBe('B+');
        expect(structural?.score).toBe(31.2);
        expect(structural?.stale).toBe(false);
        expect(structural?.categories.map(c => c.label)).toEqual([
            'Asset & collateral',
            'Market liquidity',
            'Smart contract',
            'Operations & governance',
            'Exploit history',
        ]);
        expect(structural?.categories[4]).toEqual({
            key: 'hack_exploit_history',
            label: 'Exploit history',
            score: 80,
            weight: 0.1,
            status: 'fail',
        });
    });

    it('flags stale strictly past the 3d bound', () => {
        const atBound = toStructuralHealth({ ...structuralRead, updatedAt: NOW - STRUCTURAL_STALE_AFTER_MS }, NOW);
        const pastBound = toStructuralHealth(
            { ...structuralRead, updatedAt: NOW - STRUCTURAL_STALE_AFTER_MS - 1 },
            NOW,
        );
        expect(atBound?.stale).toBe(false);
        expect(pastBound?.stale).toBe(true);
    });
});

describe('toCompactPegHealth', () => {
    it('projects to the per-variant fields and keeps the provider', () => {
        expect(toCompactPegHealth(toPegHealth(pegRead, NOW))).toEqual({
            provider: 'webacy',
            referenceKind: 'fixed',
            tier: 'warning',
            deviationPct: -2.4,
            updatedAt: NOW - 1_000,
            stale: false,
        });
        expect(toCompactPegHealth(toPegHealth({ ...pegRead, provider: 'tokens' }, NOW))?.provider).toBe('tokens');
        expect(toCompactPegHealth(null)).toBeNull();
    });

    it('carries the reference kind and defaults a missing one to fixed', () => {
        const yieldPeg = toPegHealth({ ...pegRead, provider: 'tokens', referenceKind: 'high_water' }, NOW);
        expect(toCompactPegHealth(yieldPeg)?.referenceKind).toBe('high_water');
        const compact = toCompactPegHealth({ ...yieldPeg!, referenceKind: undefined });
        expect(compact?.referenceKind).toBe('fixed');
        expect('pegCurrency' in compact!).toBe(false);
    });
});

describe('loadStablecoinHealthOrEmpty', () => {
    it('short-circuits to an empty map without calling the RPC for zero mints', async () => {
        let calls = 0;
        __setStablecoinHealthLoaderForTests(() => {
            calls += 1;
            return Effect.succeed([]);
        });
        const result = await Effect.runPromise(loadStablecoinHealthOrEmpty([]));
        expect(result.size).toBe(0);
        expect(calls).toBe(0);

        const blank = await Effect.runPromise(loadStablecoinHealthOrEmpty(['', '  ']));
        expect(blank.size).toBe(0);
        expect(calls).toBe(0);
    });

    it('maps entries by mint with null passthrough for unmonitored mints', async () => {
        __setStablecoinHealthLoaderForTests(({ mints }) =>
            Effect.succeed(
                mints.map(mint =>
                    mint === USDC
                        ? { mint, pegHealth: pegRead, structuralHealth: structuralRead }
                        : { mint, pegHealth: null, structuralHealth: null },
                ),
            ),
        );
        const result = await Effect.runPromise(loadStablecoinHealthOrEmpty([USDC, USDT, USDC], { nowMs: NOW }));
        expect(result.size).toBe(2);
        expect(result.get(USDC)?.pegHealth?.tier).toBe('warning');
        expect(result.get(USDC)?.pegHealth?.provider).toBe('webacy');
        expect(result.get(USDC)?.structuralHealth?.categories[0]?.label).toBe('Asset & collateral');
        expect(result.get(USDT)).toEqual({ pegHealth: null, structuralHealth: null });
    });

    it('fails open to an empty map on a CloudRunError and logs the failure', async () => {
        const original = console.error;
        const lines: string[] = [];
        console.error = (line: unknown) => {
            lines.push(String(line));
        };
        try {
            __setStablecoinHealthLoaderForTests(() =>
                Effect.fail(
                    new CloudRunHttpError({
                        message: 'boom',
                        service: 'assets',
                        kind: 'query',
                        callName: 'stablecoinHealthGetByMints',
                        status: 503,
                    }),
                ),
            );
            const result = await Effect.runPromise(loadStablecoinHealthOrEmpty([USDC, USDT]));
            expect(result.size).toBe(0);
            const logged = lines.map(line => JSON.parse(line) as Record<string, unknown>);
            expect(logged.length).toBe(1);
            expect(logged[0]?.event).toBe('stablecoin_health_load_failed');
            expect(logged[0]?.mints).toBe(2);
            expect(typeof logged[0]?.error).toBe('string');
        } finally {
            console.error = original;
        }
    });

    it('chunks requests above the upstream cap and merges the results', async () => {
        const mints = Array.from({ length: STABLECOIN_HEALTH_RPC_MAX_MINTS * 2 + 5 }, (_, i) => `mint${i}`);
        const seen: number[] = [];
        __setStablecoinHealthLoaderForTests(({ mints: part }) => {
            seen.push(part.length);
            return Effect.succeed(part.map(mint => ({ mint, pegHealth: pegRead, structuralHealth: null })));
        });
        const result = await Effect.runPromise(loadStablecoinHealthOrEmpty(mints, { nowMs: NOW }));
        expect(seen).toEqual([STABLECOIN_HEALTH_RPC_MAX_MINTS, STABLECOIN_HEALTH_RPC_MAX_MINTS, 5]);
        expect(result.size).toBe(mints.length);
        expect(result.get('mint404')?.pegHealth?.tier).toBe('warning');
    });
});
