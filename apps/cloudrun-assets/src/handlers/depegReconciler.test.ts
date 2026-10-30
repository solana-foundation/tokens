import { describe, expect, test } from 'bun:test';

import type { PegTier } from '@tokens/asset-registry';

import {
    buildClearNote,
    buildDepegReason,
    parseReasonTier,
    reconcileDepegAdvisories,
    type ReconcilerAction,
    type ReconcilerAdvisory,
    type ReconcilerConfig,
    type ReconcilerObservation,
    type ReconcilerSkipReason,
} from './depegReconciler';

const HOUR = 60 * 60_000;
const NOW = 1_789_000_000_000;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDE = 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT';

const CONFIG: ReconcilerConfig = {
    setTiers: ['warning', 'critical'],
    criticalImmediate: true,
    warningConfirmMs: 0,
    clearTiers: ['ok', 'premium'],
    clearCooldownMs: 6 * HOUR,
    staleObservationMs: 9 * HOUR,
    maxActionsPerRun: 5,
};

function obs(
    overrides: Partial<ReconcilerObservation> & { mint: string; tier: PegTier | null },
): ReconcilerObservation {
    const bad = overrides.tier === 'warning' || overrides.tier === 'critical';
    return {
        symbol: 'USDX',
        inRegistry: true,
        ok: true,
        prevTier: null,
        overallRisk: 60,
        deviationPct: -2.4,
        priceUsd: 0.976,
        pegUsd: 1,
        tierSinceAt: NOW - 10 * 60_000,
        badSinceAt: bad ? NOW - 10 * 60_000 : null,
        lastFetchedAt: NOW - 60_000,
        ...overrides,
    };
}

function systemAdvisory(mint: string, tier: 'warning' | 'critical'): ReconcilerAdvisory {
    return {
        mint,
        status: 'caution',
        reason: buildDepegReason({ symbol: 'USDX', mint, tier, deviationPct: -1, pegUsd: 1, observedAt: NOW - HOUR }),
        source: 'webacy_depeg',
        managedBySystem: true,
        setAt: NOW - HOUR,
        updatedAt: NOW - HOUR,
    };
}

function humanAdvisory(mint: string): ReconcilerAdvisory {
    return {
        mint,
        status: 'caution',
        reason: 'Issuer paused redemptions.',
        source: 'admin',
        managedBySystem: false,
        setAt: NOW - HOUR,
        updatedAt: NOW - HOUR,
    };
}

function run(
    observations: ReconcilerObservation[],
    advisories: ReconcilerAdvisory[] = [],
    config: Partial<ReconcilerConfig> = {},
    lastAdminClearAtByMint: ReadonlyMap<string, number> = new Map(),
) {
    return reconcileDepegAdvisories({
        observations,
        advisories,
        lastAdminClearAtByMint,
        now: NOW,
        config: { ...CONFIG, ...config },
    });
}

describe('buildDepegReason (peg guard references)', () => {
    const base = { symbol: 'USDY', mint: USDE, tier: 'critical' as const, observedAt: 1_789_000_000_000, observer: 'peg_guard' as const, liquidityUsd: 3_100_000 };

    test('high-water copy names the recent high and the yield note; tier still parses', () => {
        const reason = buildDepegReason({ ...base, deviationPct: -7.89, pegUsd: 1.14, pegCurrency: 'USD', referenceKind: 'high_water' });
        expect(reason).toContain('USDY Critical: trading 7.89% below its recent high of $1.1400 on Solana DEXs');
        expect(reason).toContain('(yield-bearing token; measured against its own price history)');
        expect(reason.length).toBeLessThanOrEqual(500);
        expect(reason).not.toContain('\u2014');
        expect(parseReasonTier(reason)).toBe('critical');
    });

    test('fx copy names the currency and the rate', () => {
        const reason = buildDepegReason({ ...base, symbol: 'EURC', tier: 'warning', deviationPct: -2.4, pegUsd: 1.1556, pegCurrency: 'EUR', referenceKind: 'fx' });
        expect(reason).toContain('EURC Warning: trading 2.40% below its EUR peg (1 EUR = $1.1556) on Solana DEXs');
        expect(reason).not.toContain('yield-bearing');
        expect(parseReasonTier(reason)).toBe('warning');
    });

    test('fixed copy is unchanged', () => {
        const reason = buildDepegReason({ ...base, symbol: 'USX', deviationPct: -3.2, pegUsd: 1, pegCurrency: 'USD', referenceKind: 'fixed' });
        expect(reason).toContain('USX Critical: trading 3.20% below its $1 peg on Solana DEXs');
    });
});

describe('buildDepegReason', () => {
    test('includes tier, signed deviation direction, peg and UTC timestamp; stays under 500 chars', () => {
        const reason = buildDepegReason({
            symbol: 'USDe',
            mint: USDE,
            tier: 'warning',
            deviationPct: -2.4,
            pegUsd: 1,
            observedAt: Date.UTC(2026, 8, 13, 14, 5),
        });
        expect(reason).toBe(
            "Webacy's depeg monitor rates USDe Warning: trading 2.40% below its $1 peg as of 2026-09-13 14:05 UTC. " +
                'This is not a confirmation of lost backing. Verify redemptions and liquidity before trading.',
        );
        expect(reason.length).toBeLessThanOrEqual(500);
        expect(reason).not.toContain('—');
    });

    test('uses "above" for positive deviation and a short mint when the symbol is unknown', () => {
        const reason = buildDepegReason({
            symbol: null,
            mint: USDE,
            tier: 'critical',
            deviationPct: 3.1,
            pegUsd: 1,
            observedAt: NOW,
        });
        expect(reason).toContain('DEkq...EonT Critical: trading 3.10% above its $1 peg');
    });

    test('omits the deviation clause when the deviation is unknown', () => {
        const reason = buildDepegReason({
            symbol: 'USDX',
            mint: USDE,
            tier: 'warning',
            deviationPct: null,
            pegUsd: null,
            observedAt: Date.UTC(2026, 0, 2, 3, 4),
        });
        expect(reason).toStartWith("Webacy's depeg monitor rates USDX Warning as of 2026-01-02 03:04 UTC.");
        expect(parseReasonTier(reason)).toBe('warning');
    });

    test('parseReasonTier reads the encoded tier back and ignores human text', () => {
        expect(parseReasonTier(systemAdvisory(USDE, 'critical').reason)).toBe('critical');
        expect(parseReasonTier(systemAdvisory(USDE, 'warning').reason)).toBe('warning');
        expect(parseReasonTier('Issuer paused redemptions. Critical situation.')).toBeNull();
    });

    test('buildClearNote floors whole hours', () => {
        expect(buildClearNote('ok', 6 * HOUR + 59 * 60_000)).toBe('Webacy tier ok for 6h');
        expect(buildClearNote('premium', 30 * 60_000)).toBe('Webacy tier premium for 0h');
    });
});

describe('reconcileDepegAdvisories', () => {
    const cases: Array<{
        name: string;
        observations: ReconcilerObservation[];
        advisories?: ReconcilerAdvisory[];
        config?: Partial<ReconcilerConfig>;
        clears?: Array<[string, number]>;
        expectActions: Array<Partial<ReconcilerAction>>;
        expectSkips: Array<{ mint: string; why: ReconcilerSkipReason }>;
    }> = [
        {
            name: 'critical on first sight sets immediately',
            observations: [obs({ mint: USDE, tier: 'critical', badSinceAt: NOW })],
            expectActions: [{ kind: 'set', mint: USDE, tier: 'critical', why: 'enter_critical', url: null }],
            expectSkips: [],
        },
        {
            name: 'warning with warningConfirmMs=0 sets immediately',
            observations: [obs({ mint: USDE, tier: 'warning', badSinceAt: NOW })],
            expectActions: [{ kind: 'set', mint: USDE, tier: 'warning', why: 'enter_warning' }],
            expectSkips: [],
        },
        {
            name: 'warning with a 10 min confirm window and a fresh episode waits',
            observations: [obs({ mint: USDE, tier: 'warning', badSinceAt: NOW - 2 * 60_000 })],
            config: { warningConfirmMs: 10 * 60_000 },
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'hysteresis_pending' }],
        },
        {
            name: 'warning past the confirm window sets',
            observations: [obs({ mint: USDE, tier: 'warning', badSinceAt: NOW - 11 * 60_000 })],
            config: { warningConfirmMs: 10 * 60_000 },
            expectActions: [{ kind: 'set', mint: USDE, tier: 'warning' }],
            expectSkips: [],
        },
        {
            name: 'critical ignores the confirm window when criticalImmediate',
            observations: [obs({ mint: USDE, tier: 'critical', badSinceAt: NOW })],
            config: { warningConfirmMs: 10 * 60_000 },
            expectActions: [{ kind: 'set', mint: USDE, tier: 'critical' }],
            expectSkips: [],
        },
        {
            name: 'warning -> critical with a system row updates the reason',
            observations: [obs({ mint: USDE, tier: 'critical', prevTier: 'warning' })],
            advisories: [systemAdvisory(USDE, 'warning')],
            expectActions: [{ kind: 'update_reason', mint: USDE, tier: 'critical', why: 'tier_changed' }],
            expectSkips: [],
        },
        {
            name: 'existing system row at the same tier is unchanged (deviation and time drift never rewrite)',
            observations: [obs({ mint: USDE, tier: 'warning', deviationPct: -4.9 })],
            advisories: [systemAdvisory(USDE, 'warning')],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'unchanged' }],
        },
        {
            name: 'system row + ok for 5h waits for the cooldown',
            observations: [obs({ mint: USDE, tier: 'ok', tierSinceAt: NOW - 5 * HOUR })],
            advisories: [systemAdvisory(USDE, 'warning')],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'cooldown_pending' }],
        },
        {
            name: 'system row + ok for 6h clears with an hours note',
            observations: [obs({ mint: USDE, tier: 'ok', tierSinceAt: NOW - 6 * HOUR })],
            advisories: [systemAdvisory(USDE, 'warning')],
            expectActions: [{ kind: 'clear', mint: USDE, note: 'Webacy tier ok for 6h', why: 'recovered' }],
            expectSkips: [],
        },
        {
            name: 'system row + watch does not clear unless clearOnWatch',
            observations: [obs({ mint: USDE, tier: 'watch', tierSinceAt: NOW - 24 * HOUR })],
            advisories: [systemAdvisory(USDE, 'warning')],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'watch_tier' }],
        },
        {
            name: 'system row + watch clears when watch is in the clear set',
            observations: [obs({ mint: USDE, tier: 'watch', tierSinceAt: NOW - 24 * HOUR })],
            advisories: [systemAdvisory(USDE, 'warning')],
            config: { clearTiers: ['ok', 'premium', 'watch'] },
            expectActions: [{ kind: 'clear', mint: USDE, note: 'Webacy tier watch for 24h' }],
            expectSkips: [],
        },
        {
            name: 'human row at critical is never touched',
            observations: [obs({ mint: USDE, tier: 'critical' })],
            advisories: [humanAdvisory(USDE)],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'human_managed' }],
        },
        {
            name: 'human row at ok is never cleared',
            observations: [obs({ mint: USDE, tier: 'ok', tierSinceAt: NOW - 48 * HOUR })],
            advisories: [humanAdvisory(USDE)],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'human_managed' }],
        },
        {
            name: 'admin clear after the episode began suppresses re-flagging',
            observations: [obs({ mint: USDE, tier: 'critical', badSinceAt: NOW - 2 * HOUR })],
            clears: [[USDE, NOW - HOUR]],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'suppressed_by_human_clear' }],
        },
        {
            name: 'admin clear from a previous episode does not suppress a new one',
            observations: [obs({ mint: USDE, tier: 'critical', badSinceAt: NOW - HOUR })],
            clears: [[USDE, NOW - 2 * HOUR]],
            expectActions: [{ kind: 'set', mint: USDE, tier: 'critical' }],
            expectSkips: [],
        },
        {
            name: 'premium without an advisory is skipped',
            observations: [obs({ mint: USDE, tier: 'premium' })],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'premium_tier' }],
        },
        {
            name: 'watch without an advisory is skipped',
            observations: [obs({ mint: USDE, tier: 'watch' })],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'watch_tier' }],
        },
        {
            name: 'stale ok observation never clears',
            observations: [
                obs({ mint: USDE, tier: 'ok', tierSinceAt: NOW - 48 * HOUR, lastFetchedAt: NOW - 10 * HOUR }),
            ],
            advisories: [systemAdvisory(USDE, 'critical')],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'stale_observation' }],
        },
        {
            name: 'stale critical observation never sets',
            observations: [obs({ mint: USDE, tier: 'critical', lastFetchedAt: NOW - 10 * HOUR })],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'stale_observation' }],
        },
        {
            name: 'failed fetch (last good tier ok) never clears',
            observations: [obs({ mint: USDE, tier: 'ok', ok: false, tierSinceAt: NOW - 48 * HOUR })],
            advisories: [systemAdvisory(USDE, 'critical')],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'no_observation' }],
        },
        {
            name: 'no tier at all is no observation',
            observations: [obs({ mint: USDE, tier: null })],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'no_observation' }],
        },
        {
            name: 'tokens outside the registry are skipped before anything else',
            observations: [obs({ mint: USDE, tier: 'critical', inRegistry: false })],
            expectActions: [],
            expectSkips: [{ mint: USDE, why: 'not_in_registry' }],
        },
        {
            name: 'two usd:* variants, one warning one ok, produce exactly one action',
            observations: [
                obs({ mint: USDC, tier: 'ok', symbol: 'USDC' }),
                obs({ mint: USDE, tier: 'warning', symbol: 'USDe', badSinceAt: NOW }),
            ],
            expectActions: [{ kind: 'set', mint: USDE, tier: 'warning' }],
            expectSkips: [{ mint: USDC, why: 'unchanged' }],
        },
        {
            name: 'healthy token with no advisory is unchanged',
            observations: [obs({ mint: USDT, tier: 'ok' })],
            expectActions: [],
            expectSkips: [{ mint: USDT, why: 'unchanged' }],
        },
    ];

    for (const c of cases) {
        test(c.name, () => {
            const out = run(c.observations, c.advisories ?? [], c.config ?? {}, new Map(c.clears ?? []));
            expect(out.actions).toHaveLength(c.expectActions.length);
            c.expectActions.forEach((expected, i) => expect(out.actions[i]).toMatchObject(expected));
            expect(out.skips).toEqual(c.expectSkips);
            expect(out.overflow).toBe(0);
        });
    }

    test('8 sets with a cap of 5 keep criticals first and report 3 as max_actions_exceeded', () => {
        const mints = Array.from({ length: 8 }, (_, i) => `Mint${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`);
        const observations = mints.map((mint, i) =>
            obs({ mint, tier: i % 2 === 0 ? 'warning' : 'critical', badSinceAt: NOW }),
        );
        const out = run(observations);
        expect(out.actions).toHaveLength(5);
        expect(out.overflow).toBe(3);
        // Four criticals (odd indices) come first, then the earliest warning.
        expect(out.actions.slice(0, 4).map(a => (a.kind === 'set' ? a.tier : null))).toEqual([
            'critical',
            'critical',
            'critical',
            'critical',
        ]);
        expect(out.actions[4]).toMatchObject({ kind: 'set', tier: 'warning', mint: mints[0] });
        const overflowSkips = out.skips.filter(s => s.why === 'max_actions_exceeded');
        expect(overflowSkips.map(s => s.mint).sort()).toEqual([mints[2], mints[4], mints[6]].sort());
    });

    test('clears sort after sets when the cap bites', () => {
        const observations = [
            obs({ mint: USDC, tier: 'ok', tierSinceAt: NOW - 7 * HOUR }),
            obs({ mint: USDE, tier: 'warning', badSinceAt: NOW }),
        ];
        const out = run(observations, [systemAdvisory(USDC, 'warning')], { maxActionsPerRun: 1 });
        expect(out.actions).toHaveLength(1);
        expect(out.actions[0]).toMatchObject({ kind: 'set', mint: USDE });
        expect(out.skips).toEqual([{ mint: USDC, why: 'max_actions_exceeded' }]);
        expect(out.overflow).toBe(1);
    });

    test('is deterministic and does not read the wall clock', () => {
        const observations = [obs({ mint: USDE, tier: 'critical', badSinceAt: NOW })];
        const a = run(observations);
        const b = run(observations);
        expect(a).toEqual(b);
    });
});
