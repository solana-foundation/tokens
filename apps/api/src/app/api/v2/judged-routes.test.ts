/**
 * Route-level tests for the judged-search family (`/v2/search`, `/v2/resolve`)
 * through the real `route()` wrapper: auth, param validation, response shape.
 * Candidate gathering and the protected-symbol index are stubbed with the
 * offline fixtures so no provider / Cloud Run I/O happens.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

import type { EnrichedCandidate } from '@/lib/judgment/types';

mock.module('server-only', () => ({}));

const fixtures = await import('@/lib/judgment/fixtures');
const { USDC_MINT, BONK_MINT, FAKE_USDC_MINT, NEW_DOG_MINT, fakeUsdc, homoglyphUsdc, newDogToken, realBonk, realUsdc } =
    fixtures;

let nextCandidates: EnrichedCandidate[] = [];
let gatherCalls = 0;
mock.module('@/lib/judgment/candidates', () => ({
    gatherCandidates: () => {
        gatherCalls += 1;
        return Effect.succeed({
            candidates: nextCandidates,
            sources: { provider: 'ok', db: 'ok', registry: 'ok' },
        });
    },
}));

const protectedSymbols = await import('@/lib/judgment/protected-symbols');
const testIndex = protectedSymbols.buildIndexFromEntries([
    { symbol: 'USDC', mints: [USDC_MINT], protectedBy: ['curated:currencies'] },
    { symbol: 'BONK', mints: [BONK_MINT], protectedBy: ['curated:majors'] },
]);
mock.module('@/lib/judgment/protected-symbols', () => ({
    ...protectedSymbols,
    getProtectedSymbolIndex: async () => testIndex,
}));

const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
const { signPlaygroundProxyAuthPayload } = await import('@/effect/playground-proxy-auth');
const { GET: searchGet } = await import('./search/route');
const { GET: resolveGet } = await import('./resolve/route');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_ERROR = console.error;
const ENV_KEYS = [
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'TOKENS_REDIS_TARGET',
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_PLAYGROUND_PROXY_SECRET',
    'TOKENS_USAGE_LOG_MODE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    process.env.TOKENS_CLOUDRUN_AUTH_TOKEN = 'tok';
    process.env.TOKENS_CLOUDRUN_ASSETS_URL = 'https://assets.example.run.app';
    process.env.TOKENS_CLOUDRUN_PRICES_URL = 'https://prices.example.run.app';
    process.env.TOKENS_CLOUDRUN_USAGE_URL = 'https://usage.example.run.app';
    process.env.TOKENS_PLAYGROUND_PROXY_SECRET = 'test-playground-secret';
    process.env.TOKENS_USAGE_LOG_MODE = 'off';
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    // Any stray network call fails loudly instead of reaching a real service.
    globalThis.fetch = (async (input: string | URL | Request) => {
        throw new Error(`unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
    console.log = () => undefined;
    console.error = () => undefined;
    nextCandidates = [];
    gatherCalls = 0;
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.log = ORIGINAL_LOG;
    console.error = ORIGINAL_ERROR;
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    resetEnvForTests();
    __resetCloudRunClientForTesting();
});

async function authHeader(scopes: string[] = ['assets:read']): Promise<Record<string, string>> {
    const now = Date.now();
    const header = await signPlaygroundProxyAuthPayload({
        apiKeyId: 'k',
        keyPrefix: 'tk_test',
        projectId: 'p',
        ownerClerkUserId: 'u',
        scopes,
        iat: now,
        exp: now + 60_000,
    });
    return { 'x-tokens-playground-auth': header };
}

function request(path: string, headers: Record<string, string> = {}): Request {
    return new Request(`https://api.example.test/api/v2/${path}`, { headers });
}

type Envelope = { error: { _tag: string; message: string; details?: unknown } };

type SearchBody = {
    query: string;
    interpretation: { intent: string };
    policy: { id: string; gates: Record<string, unknown>; overrides: string[] };
    policyVersion: string;
    scoringVersion: string;
    sources: Record<string, string>;
    results: Array<{ mint: string; verified: boolean; warnings: string[]; badges: string[] }>;
    suppressed?: Array<{ mint: string; suppressedBy: string[] }>;
};

type ResolveBody = {
    status: 'resolved' | 'ambiguous' | 'no_confident_match';
    policy: { id: string; overrides: string[] };
    best: { mint: string; verified: boolean; confidence: number } | null;
    candidates: Array<{ mint: string; verified: boolean }>;
};

describe('GET /v2/search', () => {
    it('401 without credentials and never gathers candidates', async () => {
        const res = await searchGet(request('search?q=USDC'), {} as never);
        expect(res.status).toBe(401);
        expect(gatherCalls).toBe(0);
    });

    it('403 when the key lacks assets:read', async () => {
        const res = await searchGet(request('search?q=USDC', await authHeader(['tokens:read'])), {} as never);
        expect(res.status).toBe(403);
    });

    it('400 when q is missing', async () => {
        const res = await searchGet(request('search', await authHeader()), {} as never);
        expect(res.status).toBe(400);
        const body = (await res.json()) as Envelope;
        expect(body.error._tag).toBe('BadRequestError');
        expect(body.error.message).toBe('Missing required query param: q');
    });

    it('400 on a malformed gate override', async () => {
        const res = await searchGet(request('search?q=USDC&minMarketScore=abc', await authHeader()), {} as never);
        expect(res.status).toBe(400);
        const body = (await res.json()) as Envelope;
        expect(body.error.message).toContain('Invalid minMarketScore');
        expect(gatherCalls).toBe(0);
    });

    it('400 on an unknown policy, listing the presets', async () => {
        const res = await searchGet(request('search?q=USDC&policy=yolo', await authHeader()), {} as never);
        expect(res.status).toBe(400);
        const body = (await res.json()) as Envelope;
        expect(body.error.details).toEqual({ policies: ['strict', 'default', 'degen'] });
    });

    it('200: default policy ranks the real token first, suppresses impostors, marks verified', async () => {
        nextCandidates = [fakeUsdc(), homoglyphUsdc(), realUsdc()];
        const res = await searchGet(request('search?q=USDC', await authHeader()), {} as never);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toContain('max-age=30');
        const body = (await res.json()) as SearchBody;

        expect(body.query).toBe('USDC');
        expect(body.interpretation.intent).toBe('ticker');
        expect(body.policy.id).toBe('default');
        expect(body.policy.overrides).toEqual([]);
        expect(typeof body.policy.gates.minLiquidityUsd).toBe('number');
        expect(body.policyVersion.startsWith('v2-policy-')).toBe(true);
        expect(body.scoringVersion.startsWith('v2-scoring-')).toBe(true);
        expect(body.sources).toEqual({ provider: 'ok', db: 'ok', registry: 'ok' });

        expect(body.results.map(r => r.mint)).toEqual([USDC_MINT]);
        expect(body.results[0]?.verified).toBe(true);
        expect('inLists' in body.results[0]!).toBe(false);

        const suppressedMints = body.suppressed!.map(s => s.mint).sort();
        expect(suppressedMints).toEqual([FAKE_USDC_MINT, homoglyphUsdc().mint].sort());
        for (const s of body.suppressed!) expect(s.suppressedBy).toContain('gate_impersonation');
    });

    it('200: gate overrides are applied and echoed', async () => {
        nextCandidates = [newDogToken(), realBonk()];
        const res = await searchGet(
            request('search?q=dog&policy=degen&minLiquidityUsd=100000&verifiedOnly=true', await authHeader()),
            {} as never,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as SearchBody;

        expect(body.policy.id).toBe('degen');
        expect(body.policy.gates.minLiquidityUsd).toBe(100_000);
        expect(body.policy.gates.requireRegistry).toBe(true);
        expect(body.policy.overrides).toEqual(['minLiquidityUsd', 'requireRegistry']);

        expect(body.results.map(r => r.mint)).toEqual([BONK_MINT]);
        const dog = body.suppressed!.find(s => s.mint === NEW_DOG_MINT);
        expect(dog?.suppressedBy).toEqual(['gate_min_liquidity', 'gate_unverified']);
    });

    it('200: includeSuppressed=false omits the suppressed array', async () => {
        nextCandidates = [fakeUsdc(), realUsdc()];
        const res = await searchGet(request('search?q=USDC&includeSuppressed=false', await authHeader()), {} as never);
        const body = (await res.json()) as SearchBody;
        expect(body.results.map(r => r.mint)).toEqual([USDC_MINT]);
        expect('suppressed' in body).toBe(false);
    });

    it('200: limit bounds the ranked results but not the suppressed set', async () => {
        nextCandidates = [realBonk(), realUsdc(), newDogToken(), fakeUsdc()];
        const res = await searchGet(request('search?q=o&policy=degen&limit=1', await authHeader()), {} as never);
        const body = (await res.json()) as SearchBody;
        expect(body.results.length).toBe(1);
    });

    it('200: empty candidate set is an empty answer, not an error', async () => {
        const res = await searchGet(request('search?q=zzzz', await authHeader()), {} as never);
        expect(res.status).toBe(200);
        const body = (await res.json()) as SearchBody;
        expect(body.results).toEqual([]);
        expect(body.suppressed).toEqual([]);
    });
});

describe('GET /v2/resolve', () => {
    it('401 without credentials', async () => {
        const res = await resolveGet(request('resolve?q=USDC'), {} as never);
        expect(res.status).toBe(401);
    });

    it('400 on bad params', async () => {
        expect((await resolveGet(request('resolve', await authHeader()), {} as never)).status).toBe(400);
        expect(
            (await resolveGet(request('resolve?q=USDC&verifiedOnly=maybe', await authHeader()), {} as never)).status,
        ).toBe(400);
    });

    it('resolved: canonical USDC with confidence, verified, no contenders', async () => {
        nextCandidates = [fakeUsdc(), homoglyphUsdc(), realUsdc()];
        const res = await resolveGet(request('resolve?q=USDC', await authHeader()), {} as never);
        expect(res.status).toBe(200);
        const body = (await res.json()) as ResolveBody;
        expect(body.status).toBe('resolved');
        expect(body.best?.mint).toBe(USDC_MINT);
        expect(body.best?.verified).toBe(true);
        expect(body.best?.confidence ?? 0).toBeGreaterThanOrEqual(0.7);
        expect(body.candidates).toEqual([]);
        expect(body.policy.id).toBe('default');
        expect(body.policy.overrides).toEqual([]);
    });

    it('resolved: mint paste is a direct lookup with confidence 1', async () => {
        nextCandidates = [realUsdc(), fakeUsdc()];
        const res = await resolveGet(request(`resolve?q=${USDC_MINT}`, await authHeader()), {} as never);
        const body = (await res.json()) as ResolveBody;
        expect(body.status).toBe('resolved');
        expect(body.best?.confidence).toBe(1);
    });

    it('ambiguous: two equally-credible claimers return contenders, no best', async () => {
        const twinA: EnrichedCandidate = {
            ...realBonk(),
            symbol: 'TWIN',
            name: 'Twin Token',
            registry: { ...realBonk().registry!, assetId: 'twin-one', symbol: 'TWIN', name: 'Twin Token' },
        };
        const twinB: EnrichedCandidate = {
            ...twinA,
            mint: 'TwinBonkMint77777777777777777777777777777777',
            registry: { ...twinA.registry!, assetId: 'twin-two' },
        };
        nextCandidates = [twinA, twinB];
        const res = await resolveGet(request('resolve?q=TWIN', await authHeader()), {} as never);
        expect(res.status).toBe(200);
        const body = (await res.json()) as ResolveBody;
        expect(body.status).toBe('ambiguous');
        expect(body.best).toBeNull();
        expect(body.candidates.map(c => c.mint).sort()).toEqual([twinA.mint, twinB.mint].sort());
        for (const c of body.candidates) expect(c.verified).toBe(true);
    });

    it('no_confident_match: nothing clears the bar → 200 with an explicit refusal', async () => {
        nextCandidates = [];
        const res = await resolveGet(request('resolve?q=zzzzqqq', await authHeader()), {} as never);
        expect(res.status).toBe(200);
        const body = (await res.json()) as ResolveBody;
        expect(body.status).toBe('no_confident_match');
        expect(body.best).toBeNull();
        expect(body.candidates).toEqual([]);
    });

    it('overrides flow through: the liquidity gate decides between refusal and an answer', async () => {
        nextCandidates = [fixtures.lowLiqDogToken()];
        const refused = (await (
            await resolveGet(
                request('resolve?q=DOGGO&policy=degen&minLiquidityUsd=1000', await authHeader()),
                {} as never,
            )
        ).json()) as ResolveBody;
        expect(refused.status).toBe('no_confident_match');
        expect(refused.policy.overrides).toEqual(['minLiquidityUsd']);

        const relaxed = (await (
            await resolveGet(
                request('resolve?q=DOGGO&policy=degen&minLiquidityUsd=100', await authHeader()),
                {} as never,
            )
        ).json()) as ResolveBody;
        expect(relaxed.status).toBe('resolved');
        expect(relaxed.best?.mint).toBe(fixtures.LOW_LIQ_DOG_MINT);
        expect(relaxed.best?.verified).toBe(false);
        expect(relaxed.policy.overrides).toEqual(['minLiquidityUsd']);
    });
});
