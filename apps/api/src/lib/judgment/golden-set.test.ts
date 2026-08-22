/**
 * Golden query set — the executable specification for v2 token search.
 *
 * Every scoring/gating/policy change must keep these green. The cases run the
 * full pure pipeline (intent → gates → score → explain → resolve) over
 * pre-enriched fixtures, offline.
 */

import { describe, expect, it } from 'bun:test';

import { classifyQuery } from './intent';
import { judgeCandidates } from './pipeline';
import { POLICIES } from './policies';
import { buildIndexFromEntries } from './protected-symbols';
import { resolveFromJudged } from './resolve';
import type { EnrichedCandidate } from './types';
import {
    BONK_MINT,
    NOW_MS,
    USDC_MINT,
    NEW_DOG_MINT,
    fakeUsdc,
    homoglyphUsdc,
    lowLiqDogToken,
    newDogToken,
    realBonk,
    realUsdc,
    tombstonedToken,
} from './fixtures';

const index = buildIndexFromEntries([
    { symbol: 'USDC', mints: [USDC_MINT], protectedBy: ['curated:currencies'] },
    { symbol: 'BONK', mints: [BONK_MINT], protectedBy: ['curated:majors'] },
]);

function run(query: string, candidates: EnrichedCandidate[], policyId: keyof typeof POLICIES, limit = 20) {
    const interpretation = classifyQuery(query);
    const policy = POLICIES[policyId];
    const output = judgeCandidates(candidates, interpretation, policy, index, { nowMs: NOW_MS, limit });
    return { interpretation, policy, ...output };
}

describe('golden: exact-ticker USDC', () => {
    const candidates = [fakeUsdc(), homoglyphUsdc(), realUsdc()];

    it('default: real USDC ranks first, both impostors are suppressed as impersonation', () => {
        const { results, suppressed } = run('USDC', candidates, 'default');
        expect(results[0]?.mint).toBe(USDC_MINT);
        expect(results.map(r => r.mint)).not.toContain(fakeUsdc().mint);

        const suppressedMints = suppressed.map(s => s.mint);
        expect(suppressedMints).toContain(fakeUsdc().mint);
        expect(suppressedMints).toContain(homoglyphUsdc().mint);
        for (const s of suppressed) expect(s.suppressedBy).toContain('gate_impersonation');
    });

    it('strict: same protection holds', () => {
        const { results, suppressed } = run('USDC', candidates, 'strict');
        expect(results[0]?.mint).toBe(USDC_MINT);
        expect(suppressed.length).toBe(2);
    });

    it('degen: impostors are shown but warned and ranked far below the real token', () => {
        const { results } = run('USDC', candidates, 'degen');
        expect(results[0]?.mint).toBe(USDC_MINT);

        const fake = results.find(r => r.mint === fakeUsdc().mint);
        expect(fake).toBeDefined();
        expect(fake!.warnings).toContain('possible_impersonation');
        expect(results[0]!.score.total - fake!.score.total).toBeGreaterThan(25);
    });

    it('homoglyph claims carry the suspicious_characters warning', () => {
        const { results } = run('USDC', [homoglyphUsdc()], 'degen');
        expect(results[0]?.warnings).toContain('suspicious_characters');
    });

    it('real USDC carries exact-match + attestation reasons', () => {
        const { results } = run('USDC', candidates, 'default');
        expect(results[0]?.reasons).toContain('exact_symbol_match');
        expect(results[0]?.reasons).toContain('curated_list_member');
        expect(results[0]?.claims.attestations.length).toBeGreaterThanOrEqual(4);
    });
});

describe('golden: homoglyph query normalizes to the real token', () => {
    it('query "USDС" (Cyrillic ES) still finds real USDC first', () => {
        const { interpretation, results } = run('USDС', [realUsdc(), fakeUsdc()], 'default');
        expect(interpretation.hadSuspiciousCharacters).toBe(true);
        expect(results[0]?.mint).toBe(USDC_MINT);
    });
});

describe('golden: name search "dog"', () => {
    const candidates = [newDogToken(), lowLiqDogToken()];

    it('default: dust is suppressed by the liquidity gate; young token shows with warnings', () => {
        const { results, suppressed } = run('dog', candidates, 'default');
        expect(results.map(r => r.mint)).toContain(NEW_DOG_MINT);
        expect(suppressed[0]?.mint).toBe(lowLiqDogToken().mint);
        expect(suppressed[0]?.suppressedBy).toContain('gate_min_liquidity');

        const dog = results.find(r => r.mint === NEW_DOG_MINT);
        expect(dog?.warnings).toContain('new_token');
        expect(dog?.warnings).toContain('unverified');
    });

    it('degen: dust is shown (no liquidity gate) but warned', () => {
        const { results } = run('dog', candidates, 'degen');
        expect(results.map(r => r.mint)).toContain(lowLiqDogToken().mint);
        const dust = results.find(r => r.mint === lowLiqDogToken().mint);
        expect(dust?.warnings).toContain('low_liquidity');
    });

    it('strict: young token survives min-age gate (4 days old > 1 day)', () => {
        const { results } = run('dog', [newDogToken()], 'strict');
        expect(results.map(r => r.mint)).toContain(NEW_DOG_MINT);
    });
});

describe('golden: tombstones', () => {
    it('tombstoned tokens are suppressed under every policy, including degen', () => {
        for (const policyId of ['strict', 'default', 'degen'] as const) {
            const { results, suppressed } = run('RUGD', [tombstonedToken()], policyId);
            expect(results).toEqual([]);
            expect(suppressed[0]?.suppressedBy).toContain('gate_tombstoned');
        }
    });
});

describe('golden: resolve', () => {
    it('resolve("USDC") → resolved to the canonical mint with high confidence', () => {
        const { interpretation, policy, results } = run('USDC', [realUsdc(), fakeUsdc(), homoglyphUsdc()], 'default');
        const outcome = resolveFromJudged(results, interpretation, policy);
        expect(outcome.status).toBe('resolved');
        expect(outcome.best?.mint).toBe(USDC_MINT);
        expect(outcome.best?.confidence ?? 0).toBeGreaterThanOrEqual(0.7);
    });

    it('resolve(mint paste) → direct lookup, confidence 1, never fuzzy', () => {
        const { interpretation, policy, results } = run(USDC_MINT, [realUsdc(), fakeUsdc()], 'default');
        const outcome = resolveFromJudged(results, interpretation, policy);
        expect(outcome.status).toBe('resolved');
        expect(outcome.best?.mint).toBe(USDC_MINT);
        expect(outcome.best?.confidence).toBe(1);
    });

    it('resolve(unknown mint paste) → no_confident_match', () => {
        const unknownMint = 'UnknownMint666666666666666666666666666666666';
        const { interpretation, policy, results } = run(unknownMint, [realUsdc()], 'default');
        const outcome = resolveFromJudged(results, interpretation, policy);
        expect(outcome.status).toBe('no_confident_match');
    });

    it('resolve(garbage) → no_confident_match, not a shrugging best-guess', () => {
        const { interpretation, policy, results } = run('zzzzqqq', [lowLiqDogToken()], 'default');
        const outcome = resolveFromJudged(results, interpretation, policy);
        expect(outcome.status).toBe('no_confident_match');
        expect(outcome.best).toBeNull();
    });

    it('resolve with two equally-credible claimers of a non-protected symbol → ambiguous', () => {
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
        const { interpretation, policy, results } = run('TWIN', [twinA, twinB], 'default');
        const outcome = resolveFromJudged(results, interpretation, policy);
        expect(outcome.status).toBe('ambiguous');
        expect(outcome.candidates.length).toBe(2);
    });

    it('resolve of a protected symbol with a colliding non-holder still resolves to the holder', () => {
        const collider: EnrichedCandidate = {
            ...realBonk(),
            mint: 'TwinBonkMint77777777777777777777777777777777',
            registry: { ...realBonk().registry!, assetId: 'bonk-two' },
        };
        const { interpretation, policy, results } = run('BONK', [realBonk(), collider], 'default');
        const outcome = resolveFromJudged(results, interpretation, policy);
        expect(outcome.status).toBe('resolved');
        expect(outcome.best?.mint).toBe(BONK_MINT);
    });

    it('resolve under strict refuses when only weak matches exist', () => {
        const { interpretation, policy, results } = run('DOGGO', [lowLiqDogToken()], 'strict');
        const outcome = resolveFromJudged(results, interpretation, policy);
        expect(outcome.status).toBe('no_confident_match');
    });
});

describe('golden: ranking sanity', () => {
    it('deep-liquidity curated token outranks a fresh unattested token for the same-quality match', () => {
        const { results } = run('bonk', [realBonk()], 'default');
        const bonkScore = results[0]!.score.total;

        const { results: dogResults } = run('dogwif', [newDogToken()], 'default');
        const dogScore = dogResults[0]!.score.total;

        expect(bonkScore).toBeGreaterThan(dogScore);
    });

    it('results are sorted by total score descending', () => {
        const { results } = run('dog', [lowLiqDogToken(), newDogToken()], 'degen');
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1]!.score.total).toBeGreaterThanOrEqual(results[i]!.score.total);
        }
    });
});

describe('golden: attested off-AMM asset (Ondo-style tokenized stock)', () => {
    // RFQ / primary-issuance assets legitimately show near-zero DEX liquidity;
    // registry attestation means identity is verified — tradability is a
    // warning, never a suppression.
    const ondoSpacex = (): EnrichedCandidate => ({
        ...realUsdc(),
        mint: 'wzAyQTorSpacexOndo11111111111111111111111111',
        symbol: 'SPCXon',
        name: 'SpaceX (Ondo Tokenized)',
        price: 401,
        liquidityUsd: 251,
        volume24hUsd: 0,
        marketCapUsd: null,
        holderCount: 1_200,
        top10HoldersPercent: null,
        tokenMintTime: null,
        risk: null,
        fillQuality: null,
        registry: {
            assetId: 'spacex',
            symbol: 'SPCXon',
            name: 'SpaceX (Ondo Tokenized)',
            kind: 'tokenized_equity',
            trustTier: 'tier3',
            curatedListIds: [],
        },
    });

    for (const policyId of ['strict', 'default'] as const) {
        it(`${policyId}: shown with a low_liquidity warning, not suppressed`, () => {
            const interpretation = classifyQuery('spacex');
            const { results, suppressed } = judgeCandidates(
                [ondoSpacex()],
                interpretation,
                POLICIES[policyId],
                buildIndexFromEntries([]),
                { nowMs: NOW_MS, limit: 10 },
            );
            expect(suppressed.length).toBe(0);
            const ondo = results.find(r => r.mint === ondoSpacex().mint);
            expect(ondo).toBeDefined();
            expect(ondo?.warnings).toContain('low_liquidity');
        });
    }

    it('unattested dust at the same liquidity is still gated (default)', () => {
        const dust = { ...ondoSpacex(), registry: null };
        const interpretation = classifyQuery('spacex');
        const { results, suppressed } = judgeCandidates(
            [dust],
            interpretation,
            POLICIES.default,
            buildIndexFromEntries([]),
            { nowMs: NOW_MS, limit: 10 },
        );
        expect(results.length).toBe(0);
        expect(suppressed[0]?.suppressedBy).toContain('gate_min_liquidity');
    });
});
