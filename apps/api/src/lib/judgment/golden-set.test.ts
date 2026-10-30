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
import { applyGateOverrides, POLICIES, type PolicyDocument } from './policies';
import { buildIndexFromEntries } from './protected-symbols';
import { resolveFromJudged } from './resolve';
import type { EnrichedCandidate } from './types';
import {
    BLOCKED_MINT,
    BONK_MINT,
    CAUTION_MINT,
    COMPROMISED_MINT,
    NOW_MS,
    USDC_MINT,
    NEW_DOG_MINT,
    blockedToken,
    cautionToken,
    compromisedToken,
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

function runWithPolicy(query: string, candidates: EnrichedCandidate[], policy: PolicyDocument, limit = 20) {
    const interpretation = classifyQuery(query);
    const output = judgeCandidates(candidates, interpretation, policy, index, { nowMs: NOW_MS, limit });
    return { interpretation, policy, ...output };
}

function run(query: string, candidates: EnrichedCandidate[], policyId: keyof typeof POLICIES, limit = 20) {
    return runWithPolicy(query, candidates, POLICIES[policyId], limit);
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

describe('golden: advisories', () => {
    it('compromised tokens are suppressed under every policy with gate_advisory_compromised, despite top-tier standing', () => {
        for (const policyId of ['strict', 'default', 'degen'] as const) {
            const { results, suppressed } = run('SILV', [compromisedToken()], policyId);
            expect(results).toEqual([]);
            expect(suppressed[0]?.mint).toBe(COMPROMISED_MINT);
            expect(suppressed[0]?.suppressedBy).toEqual(['gate_advisory_compromised']);
        }
    });

    it('blocked tokens are suppressed under every policy with gate_advisory_blocked (not both codes)', () => {
        for (const policyId of ['strict', 'default', 'degen'] as const) {
            const { results, suppressed } = run('BLKD', [blockedToken()], policyId);
            expect(results).toEqual([]);
            expect(suppressed[0]?.mint).toBe(BLOCKED_MINT);
            expect(suppressed[0]?.suppressedBy).toEqual(['gate_advisory_blocked']);
        }
    });

    it('caution tokens are shown with the advisory_caution warning and an advisory badge, never gated', () => {
        for (const policyId of ['strict', 'default', 'degen'] as const) {
            const { results, suppressed } = run('CAUT', [cautionToken()], policyId);
            expect(suppressed).toEqual([]);
            const caut = results.find(r => r.mint === CAUTION_MINT);
            expect(caut).toBeDefined();
            expect(caut?.warnings).toContain('advisory_caution');
            expect(caut?.badges).toContain('advisory:caution');
        }
    });

    it('unflagged tokens carry neither the warning nor the badge', () => {
        const { results } = run('BONK', [realBonk()], 'default');
        expect(results[0]?.warnings).not.toContain('advisory_caution');
        expect(results[0]?.badges.some(b => b.startsWith('advisory:'))).toBe(false);
    });

    it('a compromised sibling never displaces the healthy token in a mixed result set', () => {
        const { results, suppressed } = run('silver', [compromisedToken(), realBonk()], 'default');
        expect(results.map(r => r.mint)).not.toContain(COMPROMISED_MINT);
        expect(suppressed.map(s => s.mint)).toContain(COMPROMISED_MINT);
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
        curatedListIds: [],
        registry: {
            assetId: 'spacex',
            symbol: 'SPCXon',
            name: 'SpaceX (Ondo Tokenized)',
            kind: 'tokenized_equity',
            trustTier: 'tier3',
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

describe('golden: per-gate overrides (public /v2/search flags)', () => {
    it('verifiedOnly: unattested tokens are suppressed with gate_unverified, registry tokens survive', () => {
        const policy = applyGateOverrides(POLICIES.degen, { requireRegistry: true }).policy;
        const { results, suppressed } = runWithPolicy('dog', [newDogToken(), realBonk()], policy);
        expect(results.map(r => r.mint)).toEqual([BONK_MINT]);
        expect(suppressed[0]?.mint).toBe(NEW_DOG_MINT);
        expect(suppressed[0]?.suppressedBy).toEqual(['gate_unverified']);
    });

    it('verifiedOnly is off in every preset', () => {
        for (const policyId of ['strict', 'default', 'degen'] as const) {
            const { suppressed } = run('dogwif', [newDogToken()], policyId);
            expect(suppressed.flatMap(s => s.suppressedBy)).not.toContain('gate_unverified');
        }
    });

    it('minMarketScore: a weak-metrics token is suppressed once the gate is set', () => {
        const weak: EnrichedCandidate = { ...newDogToken(), risk: { marketScore: 30, grade: 'C', webacyTags: [] } };

        const shown = run('dogwif', [weak], 'degen');
        expect(shown.results[0]?.mint).toBe(NEW_DOG_MINT);
        expect(shown.results[0]?.warnings).toContain('weak_market_score');
        expect(shown.results[0]?.badges).toContain('grade:C');

        const policy = applyGateOverrides(POLICIES.degen, { minMarketScore: 40 }).policy;
        const gated = runWithPolicy('dogwif', [weak], policy);
        expect(gated.results).toEqual([]);
        expect(gated.suppressed[0]?.suppressedBy).toEqual(['gate_min_market_score']);
    });

    it('minMarketScore never gates a token whose score is unknown', () => {
        const policy = applyGateOverrides(POLICIES.degen, { minMarketScore: 90 }).policy;
        const { results, suppressed } = runWithPolicy('dogwif', [{ ...newDogToken(), risk: null }], policy);
        expect(results.length).toBe(1);
        expect(suppressed).toEqual([]);
    });

    it('minLiquidityUsd=none lets dust through the default policy (still warned)', () => {
        const policy = applyGateOverrides(POLICIES.default, { minLiquidityUsd: null }).policy;
        const { results, suppressed } = runWithPolicy('dog', [newDogToken(), lowLiqDogToken()], policy);
        expect(suppressed).toEqual([]);
        const dust = results.find(r => r.mint === lowLiqDogToken().mint);
        expect(dust?.warnings).toContain('low_liquidity');
    });

    it('suppressImpersonation=false on default shows impostors ranked below the real token', () => {
        const policy = applyGateOverrides(POLICIES.default, { suppressImpersonation: false }).policy;
        const { results } = runWithPolicy('USDC', [fakeUsdc(), realUsdc()], policy);
        expect(results[0]?.mint).toBe(USDC_MINT);
        expect(results.map(r => r.mint)).toContain(fakeUsdc().mint);
    });

    it('overrides never relax the advisory and tombstone gates', () => {
        const policy = applyGateOverrides(POLICIES.degen, {
            minLiquidityUsd: null,
            requireMarketData: false,
            suppressImpersonation: false,
            minMarketScore: null,
            minAgeDays: null,
            requireRegistry: false,
        }).policy;
        const { results, suppressed } = runWithPolicy('x', [compromisedToken(), blockedToken(), tombstonedToken()], policy);
        expect(results).toEqual([]);
        expect(suppressed.map(s => s.suppressedBy[0])).toEqual([
            'gate_advisory_compromised',
            'gate_advisory_blocked',
            'gate_tombstoned',
        ]);
    });

    it('resolve: relaxing the liquidity gate flips a gated exact-ticker match from refusal to an answer', () => {
        const refused = run('DOGGO', [lowLiqDogToken()], 'default');
        expect(resolveFromJudged(refused.results, refused.interpretation, refused.policy).status).toBe(
            'no_confident_match',
        );

        const policy = applyGateOverrides(POLICIES.degen, { minLiquidityUsd: null }).policy;
        const relaxed = runWithPolicy('DOGGO', [lowLiqDogToken()], policy);
        expect(relaxed.suppressed).toEqual([]);
        const outcome = resolveFromJudged(relaxed.results, relaxed.interpretation, relaxed.policy);
        expect(outcome.status).toBe('resolved');
        expect(outcome.best?.mint).toBe(lowLiqDogToken().mint);
    });
});
