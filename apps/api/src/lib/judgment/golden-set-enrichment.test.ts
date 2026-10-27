/**
 * Golden scenarios for the enrichment that used to be dead in production:
 * holder concentration, age from the stored risk row, authority flags,
 * category bands, market-row extras. Pure pipeline over fixtures.
 */

import { describe, expect, it } from 'bun:test';

import { judgeCandidates } from './pipeline';
import { POLICIES } from './policies';
import { buildIndexFromEntries } from './protected-symbols';
import { NOW_MS, USDC_MINT, realUsdc, newDogToken, realBonk } from './fixtures';
import type { EnrichedCandidate } from './types';

const index = buildIndexFromEntries([{ symbol: 'USDC', mints: [USDC_MINT], protectedBy: ['curated:currencies'] }]);
const ticker = (q: string) => ({ intent: 'ticker' as const, normalizedQuery: q, hadSuspiciousCharacters: false });
const run = (candidates: EnrichedCandidate[], policy: keyof typeof POLICIES, q = 'X') =>
    judgeCandidates(candidates, ticker(q), POLICIES[policy], index, { nowMs: NOW_MS, limit: 10 });

/** A registry-attested tokenized stock with off-AMM liquidity (the curated median is ~24K). */
function registryEquity(overrides: Partial<EnrichedCandidate> = {}): EnrichedCandidate {
    return {
        ...realBonk(),
        mint: 'EquityMint111111111111111111111111111111111',
        symbol: 'TSLAx',
        name: 'Tesla xStock',
        liquidityUsd: 24_000,
        volume24hUsd: 12_000,
        marketCapUsd: 60_000_000,
        holderCount: 5_000,
        top10HoldersPercent: 95,
        tokenMintTime: '2025-06-30T00:00:00Z',
        curatedListIds: ['stocks'],
        registry: {
            assetId: 'tesla',
            symbol: 'TSLAx',
            name: 'Tesla xStock',
            kind: 'tokenized_equity',
            trustTier: 'tier3',
        },
        category: 'equity',
        security: {
            mintable: true,
            freezable: true,
            mutableMetadata: false,
            transferTax: null,
            lpLockedPercent: null,
            devHoldingPercent: null,
            sniperHoldingPercent: null,
            bundlerHoldingPercent: null,
        },
        risk: { marketScore: 86, grade: 'A', webacyTags: [] },
        fillQuality: null,
        ...overrides,
    };
}

describe('category bands', () => {
    it('a registry equity with 24K liquidity is not thin for its market: no low_liquidity, deep_liquidity on the equity band, band badge', () => {
        const { results } = run([registryEquity()], 'default', 'TSLAX');
        const [tsla] = results;
        expect(tsla).toBeDefined();
        expect(tsla!.warnings).not.toContain('low_liquidity');
        expect(tsla!.reasons).toContain('high_activity');
        expect(tsla!.reasons).not.toContain('deep_liquidity'); // 24K < the 250K equity bar
        expect(tsla!.badges).toContain('band:equity');
        expect(tsla!.claims.attestations.map(a => a.code)).toContain('sustained_activity');
    });

    it('the same numbers on an unattested mint keep the default scale: low_liquidity under 10K, no band badge', () => {
        const longTail = registryEquity({ registry: null, curatedListIds: [], category: null, liquidityUsd: 8_000 });
        const { results } = run([longTail], 'degen', 'TSLAX');
        expect(results[0]!.warnings).toContain('low_liquidity');
        expect(results[0]!.badges.some(b => b.startsWith('band:'))).toBe(false);
    });

    it('a registry equity with 300K liquidity clears the equity deep-liquidity bar', () => {
        const { results } = run([registryEquity({ liquidityUsd: 300_000 })], 'default', 'TSLAX');
        expect(results[0]!.reasons).toContain('deep_liquidity');
    });
});

describe('holder concentration from the stored risk row', () => {
    it('an unattested token with 90% in the top-10 is warned and its market score capped', () => {
        const whale: EnrichedCandidate = {
            ...newDogToken(),
            top10HoldersPercent: 90,
            risk: null, // recompute from inputs
        };
        const { results } = run([whale], 'degen', 'DOG');
        expect(results[0]!.warnings).toContain('concentrated_holders');
        // The holder-distribution component is no longer the neutral 50: the
        // risk component reflects the cap (≤ 69 → below the old neutral read).
        expect(results[0]!.score.components.risk).toBeLessThan(70);
    });

    it('a registry asset with heavy concentration is not warned (issuer custody is expected) and keeps its exemption', () => {
        const { results } = run([registryEquity({ top10HoldersPercent: 95 })], 'default', 'TSLAX');
        expect(results[0]!.warnings).not.toContain('concentrated_holders');
    });
});

describe('age from the stored risk row', () => {
    it('a curated mint whose age is now known is no longer treated as young: a protected-symbol collider with real standing is a collision, not an impersonation', () => {
        // Unattested, deep, but age unknown → impersonation today.
        const unknownAge: EnrichedCandidate = {
            ...realBonk(),
            mint: 'BonkTwinMint1111111111111111111111111111111',
            symbol: 'USDC',
            registry: null,
            curatedListIds: [],
            liquidityUsd: 5_000_000,
            tokenMintTime: null,
        };
        const withAge: EnrichedCandidate = { ...unknownAge, tokenMintTime: '2022-01-01T00:00:00Z' };
        const a = run([realUsdc(), unknownAge], 'default', 'USDC');
        const b = run([realUsdc(), withAge], 'default', 'USDC');
        expect(a.suppressed.map(s => s.mint)).toContain(unknownAge.mint);
        expect(b.suppressed.map(s => s.mint)).not.toContain(withAge.mint);
        expect(b.results.find(r => r.mint === withAge.mint)?.warnings).toContain('symbol_collision');
    });

    it('a known-old token gets established_token and never new_token', () => {
        const { results } = run([{ ...newDogToken(), tokenMintTime: '2024-01-01T00:00:00Z' }], 'degen', 'DOG');
        expect(results[0]!.reasons).toContain('established_token');
        expect(results[0]!.warnings).not.toContain('new_token');
    });
});

describe('authority flags', () => {
    const mintableDog = (): EnrichedCandidate => ({
        ...newDogToken(),
        security: {
            mintable: true,
            freezable: false,
            mutableMetadata: true,
            transferTax: true,
            lpLockedPercent: 20,
            devHoldingPercent: 15,
            sniperHoldingPercent: 12,
            bundlerHoldingPercent: 10,
        },
    });

    it('an unattested mintable token is warned under default and suppressed under strict', () => {
        const dflt = run([mintableDog()], 'default', 'DOG');
        const warnings = dflt.results[0]?.warnings ?? dflt.suppressed[0]?.warnings ?? [];
        for (const w of [
            'mint_authority_active',
            'mutable_metadata',
            'transfer_tax',
            'low_lp_locked',
            'dev_holding_high',
            'sniper_bundle_heavy',
        ])
            expect(warnings).toContain(w);
        expect(warnings).not.toContain('freeze_authority_active');

        const strict = run(
            [{ ...mintableDog(), liquidityUsd: 50_000, tokenMintTime: '2025-01-01T00:00:00Z' }],
            'strict',
            'DOG',
        );
        expect(strict.suppressed[0]?.suppressedBy).toContain('gate_unsafe_authorities');
    });

    it('the gate can be switched on for default and off for strict per request', () => {
        const on = judgeCandidates(
            [mintableDog()],
            ticker('DOG'),
            { ...POLICIES.default, gates: { ...POLICIES.default.gates, suppressUnsafeAuthorities: true } },
            index,
            { nowMs: NOW_MS, limit: 10 },
        );
        expect(on.suppressed[0]?.suppressedBy).toContain('gate_unsafe_authorities');
        const off = judgeCandidates(
            [{ ...mintableDog(), liquidityUsd: 50_000, tokenMintTime: '2025-01-01T00:00:00Z' }],
            ticker('DOG'),
            { ...POLICIES.strict, gates: { ...POLICIES.strict.gates, suppressUnsafeAuthorities: false } },
            index,
            { nowMs: NOW_MS, limit: 10 },
        );
        expect(off.suppressed.length).toBe(0);
    });

    it('USDC keeps its freeze authority without a warning or gate (registry exempt)', () => {
        const usdc: EnrichedCandidate = {
            ...realUsdc(),
            security: {
                mintable: true,
                freezable: true,
                mutableMetadata: false,
                transferTax: false,
                lpLockedPercent: null,
                devHoldingPercent: null,
                sniperHoldingPercent: null,
                bundlerHoldingPercent: null,
            },
        };
        const { results, suppressed } = run([usdc], 'strict', 'USDC');
        expect(suppressed).toEqual([]);
        expect(results[0]!.warnings).not.toContain('freeze_authority_active');
        expect(results[0]!.warnings).not.toContain('mint_authority_active');
    });

    it('unknown flags (null) never warn', () => {
        const { results } = run(
            [
                {
                    ...newDogToken(),
                    security: {
                        mintable: null,
                        freezable: null,
                        mutableMetadata: null,
                        transferTax: null,
                        lpLockedPercent: null,
                        devHoldingPercent: null,
                        sniperHoldingPercent: null,
                        bundlerHoldingPercent: null,
                    },
                },
            ],
            'degen',
            'DOG',
        );
        expect(
            results[0]!.warnings.filter(
                w => w.endsWith('_active') || w === 'mutable_metadata' || w === 'low_lp_locked',
            ),
        ).toEqual([]);
    });

    it('locked liquidity earns an attestation and a reason', () => {
        const { results } = run(
            [
                {
                    ...realBonk(),
                    security: {
                        mintable: false,
                        freezable: false,
                        mutableMetadata: false,
                        transferTax: false,
                        lpLockedPercent: 95,
                        devHoldingPercent: 1,
                        sniperHoldingPercent: 0,
                        bundlerHoldingPercent: 0,
                    },
                },
            ],
            'default',
            'BONK',
        );
        expect(results[0]!.reasons).toContain('locked_liquidity');
        expect(results[0]!.claims.attestations.map(a => a.code)).toContain('locked_liquidity');
    });
});

describe('market-row extras', () => {
    it('distinct wallets: attestation + reason at 1,000, and a wash-only market scores lower on activity', () => {
        const busy = { ...realBonk(), uniqueWallet24h: 5_000 };
        const washed = { ...realBonk(), uniqueWallet24h: 12 };
        const a = run([busy], 'default', 'BONK').results[0]!;
        const b = run([washed], 'default', 'BONK').results[0]!;
        expect(a.reasons).toContain('active_wallets');
        expect(b.reasons).not.toContain('active_wallets');
        expect(a.score.components.activity).toBeGreaterThan(b.score.components.activity);
    });

    it('thin float, stale trades and toxic flow are named', () => {
        const c: EnrichedCandidate = {
            ...realBonk(),
            circulatingSupply: 5,
            totalSupply: 100,
            lastTradeAt: NOW_MS - 3 * 24 * 60 * 60_000,
            fillQuality: { executionScore: 80, botVolumeRatio: 0.1, flowSourceCount: 1, markoutBps: 90 },
        };
        const { results } = run([c], 'default', 'BONK');
        for (const w of ['thin_float', 'no_recent_trades', 'toxic_flow']) expect(results[0]!.warnings).toContain(w);
        // One venue cannot vouch for execution quality on its own.
        expect(results[0]!.reasons).not.toContain('strong_execution_quality');
    });

    it('every result echoes where its inputs came from', () => {
        const { results } = run([realBonk()], 'default', 'BONK');
        expect(results[0]!.dataSources).toEqual({ market: 'snapshot', holders: 'snapshot', security: 'none' });
    });
});
