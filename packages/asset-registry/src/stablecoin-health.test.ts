import { describe, expect, it } from 'bun:test';

import {
    PEG_TIERS,
    STRUCTURAL_CATEGORY_KEYS,
    STRUCTURAL_CATEGORY_LABELS,
    STRUCTURAL_GRADES,
    isPegProvider,
    isPegTier,
    isStructuralCategoryKey,
    isStructuralCategoryStatus,
    isStructuralGrade,
    pegTierSeverity,
    structuralGradeBand,
} from './stablecoin-health';
import {
    PEG_GUARD_ACTOR,
    SYSTEM_ACTOR_BY_SOURCE,
    WEBACY_DEPEG_ACTOR,
    isAdvisorySource,
    isSystemActorId,
    isSystemAdvisorySource,
    isSystemManagedAdvisory,
} from './types';

describe('peg tiers', () => {
    it('guards the five tiers only', () => {
        for (const tier of PEG_TIERS) expect(isPegTier(tier)).toBe(true);
        expect(isPegTier('OK')).toBe(false);
        expect(isPegTier('')).toBe(false);
        expect(isPegTier(undefined)).toBe(false);
    });

    it('orders severity ok < premium < watch < warning < critical', () => {
        const ordered = [...PEG_TIERS].sort((a, b) => pegTierSeverity(a) - pegTierSeverity(b));
        expect(ordered).toEqual(['ok', 'premium', 'watch', 'warning', 'critical']);
    });
});

describe('structural grades', () => {
    it('guards the 13 grades and bands them by letter', () => {
        expect(STRUCTURAL_GRADES).toHaveLength(14);
        expect(isStructuralGrade('E')).toBe(true);
        for (const grade of STRUCTURAL_GRADES) expect(isStructuralGrade(grade)).toBe(true);
        expect(isStructuralGrade('E')).toBe(false);
        expect(isStructuralGrade('a+')).toBe(false);
        expect(structuralGradeBand('A+')).toBe('A');
        expect(structuralGradeBand('D-')).toBe('D');
        expect(structuralGradeBand('F')).toBe('F');
    });

    it('labels every scored category', () => {
        for (const key of STRUCTURAL_CATEGORY_KEYS) {
            expect(isStructuralCategoryKey(key)).toBe(true);
            expect(STRUCTURAL_CATEGORY_LABELS[key].length).toBeGreaterThan(0);
        }
        expect(isStructuralCategoryKey('counterparty')).toBe(false);
        expect(isStructuralCategoryStatus('pass')).toBe(true);
        expect(isStructuralCategoryStatus('PASS')).toBe(false);
    });
});

describe('advisory provenance', () => {
    it('recognises sources and system actors', () => {
        expect(isAdvisorySource('admin')).toBe(true);
        expect(isAdvisorySource('webacy_depeg')).toBe(true);
        expect(isAdvisorySource('system')).toBe(false);
        expect(isSystemActorId(WEBACY_DEPEG_ACTOR)).toBe(true);
        expect(isSystemActorId('user_2abc')).toBe(false);
    });

    it('knows both automated sources and their actors', () => {
        expect(isAdvisorySource('peg_guard')).toBe(true);
        expect(isSystemAdvisorySource('peg_guard')).toBe(true);
        expect(isSystemAdvisorySource('admin')).toBe(false);
        expect(isSystemActorId(PEG_GUARD_ACTOR)).toBe(true);
        expect(SYSTEM_ACTOR_BY_SOURCE.peg_guard).toBe(PEG_GUARD_ACTOR);
        expect(isPegProvider('tokens')).toBe(true);
        expect(isPegProvider('birdeye')).toBe(false);
    });

    it('treats a missing source as human-managed', () => {
        expect(isSystemManagedAdvisory({ source: 'webacy_depeg' })).toBe(true);
        expect(isSystemManagedAdvisory({ source: 'admin' })).toBe(false);
        expect(isSystemManagedAdvisory({})).toBe(false);
        expect(isSystemManagedAdvisory(null)).toBe(false);
    });
});
