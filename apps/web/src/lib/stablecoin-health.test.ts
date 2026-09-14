import { describe, expect, test } from 'bun:test';

import { PEG_TIERS, STRUCTURAL_CATEGORY_LABELS, STRUCTURAL_GRADES } from '@tokens/asset-registry';

import {
    ON_PEG_DEVIATION_PCT,
    PEG_TIER_COPY,
    STABLECOIN_HEALTH_VIEWED_EVENT,
    WEBACY_ATTRIBUTION_URL,
    advisorySourceAttribution,
    formatHealthUpdatedAt,
    isStablecoinCategory,
    normalizeCompactPegHealth,
    normalizePegHealth,
    normalizeStructuralHealth,
    pegDeviationText,
    pegPriceText,
    pegStatusTitle,
    pegTierTone,
    stablecoinHealthEventProps,
    structuralCategoryTooltip,
    structuralGradeTone,
    structuralStatusTone,
} from './stablecoin-health';

const UPDATED_AT = Date.UTC(2026, 8, 13, 14, 30, 0);
const TIER_SINCE = Date.UTC(2026, 8, 13, 12, 0, 0);

function pegHealthPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        provider: 'webacy',
        tier: 'warning',
        overallRisk: 62.5,
        deviationPct: -2.4,
        priceUsd: 0.976,
        pegUsd: 1,
        tierSince: TIER_SINCE,
        updatedAt: UPDATED_AT,
        stale: false,
        ...overrides,
    };
}

function structuralPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        provider: 'webacy',
        grade: 'B+',
        score: 31.2,
        categories: [
            { key: 'asset_collateral', label: 'Asset & collateral', score: 20, weight: 0.3, status: 'pass' },
            { key: 'market_liquidity', label: 'Market liquidity', score: 45, weight: 0.25, status: 'warn' },
            { key: 'smart_contract', label: 'Smart contract', score: 10, weight: 0.2, status: 'pass' },
            { key: 'operational_governance', label: '', score: 70, weight: 0.15, status: 'fail' },
            { key: 'hack_exploit_history', label: 'Exploit history', score: null, weight: 0.1, status: 'nope' },
        ],
        updatedAt: UPDATED_AT,
        stale: false,
        ...overrides,
    };
}

describe('normalizeCompactPegHealth', () => {
    test('returns null for null, primitives, arrays, and unknown tiers', () => {
        expect(normalizeCompactPegHealth(null)).toBe(null);
        expect(normalizeCompactPegHealth(undefined)).toBe(null);
        expect(normalizeCompactPegHealth('warning')).toBe(null);
        expect(normalizeCompactPegHealth([])).toBe(null);
        expect(normalizeCompactPegHealth({ tier: 'severe', deviationPct: -1, updatedAt: UPDATED_AT })).toBe(null);
        expect(normalizeCompactPegHealth({ tier: 'WARNING', deviationPct: -1, updatedAt: UPDATED_AT })).toBe(null);
        expect(normalizeCompactPegHealth({ deviationPct: -1, updatedAt: UPDATED_AT })).toBe(null);
    });

    test('decodes a well-formed compact payload and drops extra fields', () => {
        expect(
            normalizeCompactPegHealth({ tier: 'warning', deviationPct: -2.4, updatedAt: UPDATED_AT, stale: false }),
        ).toEqual({ tier: 'warning', deviationPct: -2.4, updatedAt: UPDATED_AT, stale: false });
        expect(normalizeCompactPegHealth(pegHealthPayload())).toEqual({
            tier: 'warning',
            deviationPct: -2.4,
            updatedAt: UPDATED_AT,
            stale: false,
        });
    });

    test('defaults deviation, updatedAt, and stale when missing or invalid', () => {
        expect(normalizeCompactPegHealth({ tier: 'ok' })).toEqual({
            tier: 'ok',
            deviationPct: null,
            updatedAt: 0,
            stale: false,
        });
        expect(normalizeCompactPegHealth({ tier: 'ok', deviationPct: Number.NaN, updatedAt: -1 })).toEqual({
            tier: 'ok',
            deviationPct: null,
            updatedAt: 0,
            stale: false,
        });
        expect(normalizeCompactPegHealth({ tier: 'ok', stale: 'yes' })?.stale).toBe(false);
        expect(normalizeCompactPegHealth({ tier: 'ok', stale: true })?.stale).toBe(true);
    });
});

describe('normalizePegHealth', () => {
    test('returns null for non-objects and unknown tiers', () => {
        expect(normalizePegHealth(null)).toBe(null);
        expect(normalizePegHealth(pegHealthPayload({ tier: 'meh' }))).toBe(null);
        expect(normalizePegHealth(pegHealthPayload({ tier: undefined }))).toBe(null);
    });

    test('decodes a well-formed payload and pins the provider', () => {
        expect(normalizePegHealth(pegHealthPayload({ provider: 'someone-else' }))).toEqual({
            provider: 'webacy',
            tier: 'warning',
            overallRisk: 62.5,
            deviationPct: -2.4,
            priceUsd: 0.976,
            pegUsd: 1,
            tierSince: TIER_SINCE,
            updatedAt: UPDATED_AT,
            stale: false,
        });
    });

    test('nulls out non-finite numerics and non-positive timestamps', () => {
        const result = normalizePegHealth(
            pegHealthPayload({
                overallRisk: 'high',
                deviationPct: Number.POSITIVE_INFINITY,
                priceUsd: null,
                pegUsd: undefined,
                tierSince: 0,
                updatedAt: 'yesterday',
                stale: 1,
            }),
        );
        expect(result).toEqual({
            provider: 'webacy',
            tier: 'warning',
            overallRisk: null,
            deviationPct: null,
            priceUsd: null,
            pegUsd: null,
            tierSince: null,
            updatedAt: 0,
            stale: false,
        });
    });
});

describe('normalizeStructuralHealth', () => {
    test('returns null for non-objects and unknown grades', () => {
        expect(normalizeStructuralHealth(null)).toBe(null);
        expect(normalizeStructuralHealth(structuralPayload({ grade: 'E' }))).toBe(null);
        expect(normalizeStructuralHealth(structuralPayload({ grade: 'b+' }))).toBe(null);
        expect(normalizeStructuralHealth(structuralPayload({ grade: undefined }))).toBe(null);
    });

    test('decodes categories, defaults labels, and maps unknown statuses to unknown', () => {
        const result = normalizeStructuralHealth(structuralPayload());
        expect(result?.provider).toBe('webacy');
        expect(result?.grade).toBe('B+');
        expect(result?.score).toBe(31.2);
        expect(result?.updatedAt).toBe(UPDATED_AT);
        expect(result?.stale).toBe(false);
        expect(result?.categories).toEqual([
            { key: 'asset_collateral', label: 'Asset & collateral', score: 20, weight: 0.3, status: 'pass' },
            { key: 'market_liquidity', label: 'Market liquidity', score: 45, weight: 0.25, status: 'warn' },
            { key: 'smart_contract', label: 'Smart contract', score: 10, weight: 0.2, status: 'pass' },
            {
                key: 'operational_governance',
                label: STRUCTURAL_CATEGORY_LABELS.operational_governance,
                score: 70,
                weight: 0.15,
                status: 'fail',
            },
            { key: 'hack_exploit_history', label: 'Exploit history', score: null, weight: 0.1, status: 'unknown' },
        ]);
    });

    test('drops unknown keys and duplicates, orders canonically, tolerates missing categories', () => {
        const result = normalizeStructuralHealth(
            structuralPayload({
                categories: [
                    { key: 'counterparty', weight: 0, status: 'pass' },
                    { key: 'smart_contract', weight: 0.2, status: 'pass' },
                    { key: 'asset_collateral', weight: 0.3, status: 'warn' },
                    { key: 'asset_collateral', weight: 0.3, status: 'fail' },
                    'garbage',
                    null,
                ],
            }),
        );
        expect(result?.categories.map(c => c.key)).toEqual(['asset_collateral', 'smart_contract']);
        expect(result?.categories[0]?.status).toBe('warn');
        expect(normalizeStructuralHealth(structuralPayload({ categories: undefined }))?.categories).toEqual([]);
        expect(normalizeStructuralHealth(structuralPayload({ categories: 'none' }))?.categories).toEqual([]);
    });
});

describe('copy helpers', () => {
    test('pegDeviationText uses a real minus sign and 2 decimals', () => {
        expect(pegDeviationText({ deviationPct: -2.4 })).toBe('−2.40% below peg');
        expect(pegDeviationText({ deviationPct: 0.35 })).toBe('+0.35% above peg');
        expect(pegDeviationText({ deviationPct: 0.01 })).toBe('±0.01%');
        expect(pegDeviationText({ deviationPct: -0.01 })).toBe('±0.01%');
        expect(pegDeviationText({ deviationPct: 0 })).toBe('±0.00%');
        expect(pegDeviationText({ deviationPct: -ON_PEG_DEVIATION_PCT })).toBe('−0.05% below peg');
        expect(pegDeviationText({ deviationPct: -12.3456 })).toBe('−12.35% below peg');
        expect(pegDeviationText({ deviationPct: null })).toBe('Deviation unavailable');
        expect(pegDeviationText(null)).toBe('Deviation unavailable');
        expect(pegDeviationText(undefined)).toBe('Deviation unavailable');
    });

    test('pegPriceText is null-safe', () => {
        expect(pegPriceText({ priceUsd: 0.976, pegUsd: 1 })).toBe('$0.9760 vs $1.00 peg');
        expect(pegPriceText({ priceUsd: 1.0004, pegUsd: 1 })).toBe('$1.0004 vs $1.00 peg');
        expect(pegPriceText({ priceUsd: 0.976, pegUsd: null })).toBe('$0.9760');
        expect(pegPriceText({ priceUsd: null, pegUsd: 1 })).toBe('');
        expect(pegPriceText(null)).toBe('');
        expect(pegPriceText(undefined)).toBe('');
    });

    test('formatHealthUpdatedAt renders absolute UTC with minutes and empty for invalid input', () => {
        expect(formatHealthUpdatedAt(UPDATED_AT)).toBe('Sep 13, 2026 14:30 UTC');
        expect(formatHealthUpdatedAt(Date.UTC(2026, 0, 2, 0, 5, 0))).toBe('Jan 2, 2026 00:05 UTC');
        expect(formatHealthUpdatedAt(0)).toBe('');
        expect(formatHealthUpdatedAt(-1)).toBe('');
        expect(formatHealthUpdatedAt(null)).toBe('');
        expect(formatHealthUpdatedAt(undefined)).toBe('');
        expect(formatHealthUpdatedAt(Number.NaN)).toBe('');
    });

    test('pegStatusTitle composes label, deviation, timestamp, source, and stale marker', () => {
        expect(pegStatusTitle({ tier: 'warning', deviationPct: -2.4, updatedAt: UPDATED_AT, stale: false })).toBe(
            'Peg status: Warning, −2.40% below peg. Updated Sep 13, 2026 14:30 UTC. Source: Webacy',
        );
        expect(pegStatusTitle({ tier: 'ok', deviationPct: null, updatedAt: 0, stale: true })).toBe(
            'Peg status: On peg, Deviation unavailable. Source: Webacy (stale)',
        );
    });

    test('structuralCategoryTooltip renders the weight as a percent', () => {
        expect(structuralCategoryTooltip({ weight: 0.3, status: 'pass' })).toBe('Weight 30% · pass');
        expect(structuralCategoryTooltip({ weight: 0.15, status: 'fail' })).toBe('Weight 15% · fail');
        expect(structuralCategoryTooltip({ weight: null, status: 'unknown' })).toBe('Weight unknown · unknown');
    });

    test('advisorySourceAttribution only fires for the depeg monitor', () => {
        expect(advisorySourceAttribution({ source: 'webacy_depeg' })).toBe(
            'Set automatically by the Webacy depeg monitor',
        );
        expect(advisorySourceAttribution({ source: 'admin' })).toBe('');
        expect(advisorySourceAttribution({})).toBe('');
        expect(advisorySourceAttribution(null)).toBe('');
        expect(advisorySourceAttribution(undefined)).toBe('');
    });

    test('isStablecoinCategory is exact', () => {
        expect(isStablecoinCategory('stablecoin')).toBe(true);
        expect(isStablecoinCategory('Stablecoin')).toBe(false);
        expect(isStablecoinCategory('token')).toBe(false);
        expect(isStablecoinCategory(undefined)).toBe(false);
        expect(isStablecoinCategory(null)).toBe(false);
    });

    test('stablecoinHealthEventProps omits missing blocks', () => {
        expect(STABLECOIN_HEALTH_VIEWED_EVENT).toBe('stablecoin_health_viewed');
        expect(stablecoinHealthEventProps({ tier: 'warning' }, { grade: 'B+' })).toEqual({
            peg_tier: 'warning',
            structural_grade: 'B+',
        });
        expect(stablecoinHealthEventProps(null, { grade: 'A' })).toEqual({ structural_grade: 'A' });
        expect(stablecoinHealthEventProps({ tier: 'ok' }, null)).toEqual({ peg_tier: 'ok' });
        expect(stablecoinHealthEventProps(null, undefined)).toEqual({});
    });
});

describe('tones', () => {
    test('structuralStatusTone', () => {
        expect(structuralStatusTone('pass')).toBe('success');
        expect(structuralStatusTone('warn')).toBe('warning');
        expect(structuralStatusTone('fail')).toBe('destructive');
        expect(structuralStatusTone('unknown')).toBe('neutral');
    });

    test('structuralGradeTone ignores the +/- modifier', () => {
        expect(structuralGradeTone('A+')).toBe('success');
        expect(structuralGradeTone('A-')).toBe('success');
        expect(structuralGradeTone('B')).toBe('neutral');
        expect(structuralGradeTone('B-')).toBe('neutral');
        expect(structuralGradeTone('C+')).toBe('warning');
        expect(structuralGradeTone('D-')).toBe('destructive');
        expect(structuralGradeTone('F')).toBe('destructive');
        for (const grade of STRUCTURAL_GRADES) {
            expect(['success', 'neutral', 'warning', 'destructive'].includes(structuralGradeTone(grade))).toBe(true);
        }
    });
});

describe('exhaustiveness', () => {
    test('every peg tier has copy with a label, tone, and description', () => {
        expect(PEG_TIERS).toEqual(['ok', 'watch', 'warning', 'critical', 'premium']);
        for (const tier of PEG_TIERS) {
            const copy = PEG_TIER_COPY[tier];
            expect(copy.label.length > 0).toBe(true);
            expect(copy.description.length > 0).toBe(true);
            expect(copy.description.includes('—')).toBe(false);
            expect(pegTierTone(tier)).toBe(copy.tone);
        }
        expect(PEG_TIER_COPY.ok.label).toBe('On peg');
        expect(PEG_TIER_COPY.watch.label).toBe('Watch');
        expect(PEG_TIER_COPY.warning.label).toBe('Warning');
        expect(PEG_TIER_COPY.critical.label).toBe('Critical');
        expect(PEG_TIER_COPY.premium.label).toBe('Above peg');
        expect(PEG_TIER_COPY.ok.tone).toBe('success');
        expect(PEG_TIER_COPY.watch.tone).toBe('neutral');
        expect(PEG_TIER_COPY.warning.tone).toBe('warning');
        expect(PEG_TIER_COPY.critical.tone).toBe('destructive');
        expect(PEG_TIER_COPY.premium.tone).toBe('info');
        expect(WEBACY_ATTRIBUTION_URL).toBe('https://dd.xyz');
    });
});
