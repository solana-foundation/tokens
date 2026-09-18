import { describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

mock.module('server-only', () => ({}));

const { parseJudgedSearchParams, policyEnvelope } = await import('./_judged-search');
const { POLICIES } = await import('@/lib/judgment/policies');

type ParseOptions = Parameters<typeof parseJudgedSearchParams>[1];

function url(query: string) {
    return new URL(`https://api.example.test/api/v2/search?${query}`);
}

async function parse(query: string, options: ParseOptions = { defaultPolicy: 'default' }) {
    return Effect.runPromise(parseJudgedSearchParams(url(query), options));
}

async function failure(query: string, options: ParseOptions = { defaultPolicy: 'default' }) {
    // `flip` turns the typed failure into the success channel — no Cause spelunking.
    const typed = (await Effect.runPromise(Effect.flip(parseJudgedSearchParams(url(query), options)))) as {
        _tag: string;
        message: string;
        details?: unknown;
    };
    expect(typed._tag).toBe('BadRequestError');
    return typed;
}

describe('parseJudgedSearchParams: q + policy', () => {
    it('requires q', async () => {
        expect((await failure('')).message).toBe('Missing required query param: q');
        expect((await failure('q=%20%20')).message).toBe('Missing required query param: q');
    });

    it('rejects queries over 100 chars', async () => {
        expect((await failure(`q=${'a'.repeat(101)}`)).message).toBe('Query too long (max 100 characters)');
    });

    it('trims q', async () => {
        expect((await parse('q=%20USDC%20')).q).toBe('USDC');
    });

    it('uses the caller-supplied default policy', async () => {
        expect((await parse('q=USDC', { defaultPolicy: 'strict' })).policyId).toBe('strict');
        expect((await parse('q=USDC&policy=', { defaultPolicy: 'strict' })).policyId).toBe('strict');
        expect((await parse('q=USDC')).policyId).toBe('default');
    });

    it('accepts presets case-insensitively', async () => {
        expect((await parse('q=USDC&policy=DEGEN')).policyId).toBe('degen');
    });

    it('rejects unknown policies with the preset list in details', async () => {
        const error = await failure('q=USDC&policy=yolo');
        expect(error.message).toBe('Invalid policy: yolo');
        expect(error.details).toEqual({ policies: ['strict', 'default', 'degen'] });
    });

    it('no overrides → the preset object itself, empty overrides', async () => {
        const params = await parse('q=USDC&policy=strict');
        expect(params.policy).toBe(POLICIES.strict);
        expect(params.overrides).toEqual([]);
        expect(policyEnvelope(params)).toEqual({ id: 'strict', gates: POLICIES.strict.gates, overrides: [] });
    });
});

describe('parseJudgedSearchParams: gate overrides', () => {
    it('minLiquidityUsd: number, none, and rejects garbage / negatives', async () => {
        expect((await parse('q=x&minLiquidityUsd=2500.5')).policy.gates.minLiquidityUsd).toBe(2500.5);
        expect((await parse('q=x&minLiquidityUsd=none')).policy.gates.minLiquidityUsd).toBeNull();
        expect((await parse('q=x&minLiquidityUsd=NONE')).overrides).toEqual(['minLiquidityUsd']);
        expect((await failure('q=x&minLiquidityUsd=abc')).message).toContain('Invalid minLiquidityUsd');
        expect((await failure('q=x&minLiquidityUsd=-1')).message).toContain('Invalid minLiquidityUsd');
    });

    it('minAgeDays: integer ≥ 0 or none', async () => {
        expect((await parse('q=x&minAgeDays=0')).policy.gates.minAgeDays).toBe(0);
        expect((await parse('q=x&minAgeDays=30')).policy.gates.minAgeDays).toBe(30);
        expect((await parse('q=x&policy=strict&minAgeDays=none')).policy.gates.minAgeDays).toBeNull();
        expect((await failure('q=x&minAgeDays=1.5')).message).toContain('Invalid minAgeDays');
        expect((await failure('q=x&minAgeDays=-2')).message).toContain('Invalid minAgeDays');
    });

    it('minMarketScore: integer 0–100 or none', async () => {
        expect((await parse('q=x&minMarketScore=0')).policy.gates.minMarketScore).toBe(0);
        expect((await parse('q=x&minMarketScore=100')).policy.gates.minMarketScore).toBe(100);
        expect((await parse('q=x&minMarketScore=off')).policy.gates.minMarketScore).toBeNull();
        expect((await failure('q=x&minMarketScore=101')).message).toContain('between 0 and 100');
        expect((await failure('q=x&minMarketScore=abc')).message).toContain('Invalid minMarketScore');
    });

    it('boolean gates accept true/false (and 1/0), reject anything else', async () => {
        expect((await parse('q=x&policy=strict&requireMarketData=false')).policy.gates.requireMarketData).toBe(false);
        expect((await parse('q=x&policy=degen&suppressImpersonation=1')).policy.gates.suppressImpersonation).toBe(true);
        expect((await failure('q=x&requireMarketData=maybe')).message).toBe(
            'Invalid requireMarketData: expected true or false',
        );
        expect((await failure('q=x&suppressImpersonation=2')).message).toContain('Invalid suppressImpersonation');
    });

    it('verifiedOnly maps to the requireRegistry gate', async () => {
        const params = await parse('q=x&verifiedOnly=true');
        expect(params.policy.gates.requireRegistry).toBe(true);
        expect(params.overrides).toEqual(['requireRegistry']);
        expect((await failure('q=x&verifiedOnly=yep')).message).toContain('Invalid verifiedOnly');
    });

    it('only keys that differ from the preset are reported as overrides', async () => {
        const params = await parse('q=x&policy=strict&minLiquidityUsd=10000&minAgeDays=7&verifiedOnly=false');
        expect(params.overrides).toEqual(['minAgeDays']);
        expect(params.policy.gates.minLiquidityUsd).toBe(10_000);
    });

    it('weights and refusal are inherited from the preset regardless of overrides', async () => {
        const params = await parse('q=x&policy=degen&minLiquidityUsd=1');
        expect(params.policy.weights).toEqual(POLICIES.degen.weights);
        expect(params.policy.refusal).toEqual(POLICIES.degen.refusal);
    });
});

describe('parseJudgedSearchParams: limit + includeSuppressed', () => {
    it('limit defaults to 10 and clamps to 50', async () => {
        expect((await parse('q=x')).limit).toBe(10);
        expect((await parse('q=x&limit=5')).limit).toBe(5);
        expect((await parse('q=x&limit=500')).limit).toBe(50);
    });

    it('rejects non-positive or non-integer limits', async () => {
        await failure('q=x&limit=0');
        await failure('q=x&limit=abc');
    });

    it('includeSuppressed defaults to true and is only parsed when allowed', async () => {
        expect((await parse('q=x', { defaultPolicy: 'default', allowIncludeSuppressed: true })).includeSuppressed).toBe(
            true,
        );
        expect(
            (await parse('q=x&includeSuppressed=false', { defaultPolicy: 'default', allowIncludeSuppressed: true }))
                .includeSuppressed,
        ).toBe(false);
        await failure('q=x&includeSuppressed=nah', { defaultPolicy: 'default', allowIncludeSuppressed: true });

        // Curator endpoint: the flag is ignored entirely, never validated.
        expect((await parse('q=x&includeSuppressed=false')).includeSuppressed).toBe(true);
        expect((await parse('q=x&includeSuppressed=nah')).includeSuppressed).toBe(true);
    });
});
