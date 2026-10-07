import { describe, expect, it } from 'bun:test';

import {
    ADVISORY_REASON_MAX_LENGTH,
    ADVISORY_STATUSES,
    ADVISORY_STATUS_OPTIONS,
    advisoryActorLabel,
    advisoryBadgeVariant,
    advisorySetToastMessage,
    advisorySourceLabel,
    advisoryStatusLabel,
    describeAdvisoryEvent,
    formatPegDeviation,
    formatRelativeTime,
    isAdvisoryStatus,
    isSystemActor,
    isSystemManagedAdvisory,
    pegProviderLabel,
    pegReferenceLabel,
    pegTierBadgeVariant,
    pegTierLabel,
    structuralGradeBadgeVariant,
    SYSTEM_ADVISORY_CLEAR_WARNING,
    SYSTEM_ADVISORY_EDIT_WARNING,
    validateAdvisoryReason,
    validateAdvisoryUrl,
} from './advisory-labels';

describe('advisory status options', () => {
    it('covers every status exactly once, with a label and description', () => {
        expect(ADVISORY_STATUS_OPTIONS.map(option => option.value)).toEqual([...ADVISORY_STATUSES]);
        for (const option of ADVISORY_STATUS_OPTIONS) {
            expect(option.label.length).toBeGreaterThan(0);
            expect(option.description.length).toBeGreaterThan(0);
            expect(advisoryStatusLabel(option.value)).toBe(option.label);
        }
    });

    it('maps caution to the amber badge and the trade-restricting statuses to red', () => {
        expect(advisoryBadgeVariant('caution')).toBe('warning');
        expect(advisoryBadgeVariant('compromised')).toBe('danger');
        expect(advisoryBadgeVariant('blocked')).toBe('danger');
    });

    it('recognises only the three known statuses', () => {
        expect(isAdvisoryStatus('caution')).toBe(true);
        expect(isAdvisoryStatus('blocked')).toBe(true);
        expect(isAdvisoryStatus('COMPROMISED')).toBe(false);
        expect(isAdvisoryStatus('')).toBe(false);
        expect(isAdvisoryStatus(null)).toBe(false);
    });
});

describe('validateAdvisoryReason', () => {
    it('requires a non-blank reason and trims it', () => {
        expect(validateAdvisoryReason('')).toEqual({ ok: false, error: 'Reason is required.' });
        expect(validateAdvisoryReason('   \n')).toEqual({ ok: false, error: 'Reason is required.' });
        expect(validateAdvisoryReason('  Treasury exploited  ')).toEqual({ ok: true, reason: 'Treasury exploited' });
    });

    it('enforces the 500-character server bound', () => {
        expect(validateAdvisoryReason('x'.repeat(ADVISORY_REASON_MAX_LENGTH)).ok).toBe(true);
        const tooLong = validateAdvisoryReason('x'.repeat(ADVISORY_REASON_MAX_LENGTH + 1));
        expect(tooLong.ok).toBe(false);
        if (!tooLong.ok) expect(tooLong.error).toContain('500');
    });
});

describe('validateAdvisoryUrl', () => {
    it('treats an empty field as "no url"', () => {
        expect(validateAdvisoryUrl('')).toEqual({ ok: true, url: null });
        expect(validateAdvisoryUrl('   ')).toEqual({ ok: true, url: null });
    });

    it('accepts http(s) URLs and trims whitespace', () => {
        expect(validateAdvisoryUrl(' https://x.com/sunrise/status/1 ')).toEqual({
            ok: true,
            url: 'https://x.com/sunrise/status/1',
        });
        expect(validateAdvisoryUrl('http://example.com')).toEqual({ ok: true, url: 'http://example.com' });
    });

    it('rejects non-http schemes and unparsable input', () => {
        expect(validateAdvisoryUrl('javascript:alert(1)').ok).toBe(false);
        expect(validateAdvisoryUrl('ftp://example.com/notice').ok).toBe(false);
        expect(validateAdvisoryUrl('x.com/sunrise').ok).toBe(false);
        expect(validateAdvisoryUrl('not a url').ok).toBe(false);
    });
});

describe('event and toast copy', () => {
    it('builds the success toast, appending the re-activation note only when it happened', () => {
        expect(advisorySetToastMessage({ symbol: 'SILV', status: 'compromised', reactivated: false })).toBe(
            'SILV flagged as compromised',
        );
        expect(advisorySetToastMessage({ symbol: 'SILV', status: 'compromised', reactivated: true })).toBe(
            'SILV flagged as compromised (variant re-activated)',
        );
    });

    it('describes set and clear events', () => {
        expect(describeAdvisoryEvent({ action: 'set', status: 'blocked' })).toBe('Set blocked');
        expect(describeAdvisoryEvent({ action: 'set', status: null })).toBe('Set advisory');
        expect(describeAdvisoryEvent({ action: 'clear', status: null })).toBe('Cleared advisory');
    });

    it('prefers the actor email and shortens bare Clerk ids', () => {
        expect(advisoryActorLabel({ actorClerkUserId: 'user_2abc', actorEmail: 'ops@solana.org' })).toBe(
            'ops@solana.org',
        );
        expect(advisoryActorLabel({ actorClerkUserId: 'user_2abcdefghijklmnopqrstuv', actorEmail: null })).toBe(
            'user_2abcd…stuv',
        );
        expect(advisoryActorLabel({ actorClerkUserId: 'user_short', actorEmail: null })).toBe('user_short');
    });

    it('names automated actors instead of truncating the sentinel', () => {
        expect(advisoryActorLabel({ actorClerkUserId: 'system:webacy_depeg', actorEmail: null })).toBe(
            'Webacy depeg monitor (automated)',
        );
        expect(advisoryActorLabel({ actorClerkUserId: 'system:peg_guard', actorEmail: null })).toBe(
            'tokens.xyz peg monitor (automated)',
        );
        expect(advisoryActorLabel({ actorClerkUserId: 'system:other_bot', actorEmail: null })).toBe(
            'Automated (other_bot)',
        );
        expect(isSystemActor({ actorClerkUserId: 'system:webacy_depeg' })).toBe(true);
        expect(isSystemActor({ actorClerkUserId: 'user_2abc' })).toBe(false);
    });
});

describe('advisory provenance and stablecoin health labels', () => {
    it('labels sources and treats a missing source as manual', () => {
        expect(advisorySourceLabel(undefined)).toBe('Manual');
        expect(advisorySourceLabel('admin')).toBe('Manual');
        expect(advisorySourceLabel('webacy_depeg')).toBe('Auto · Webacy depeg monitor');
        expect(advisorySourceLabel('peg_guard')).toBe('Auto · tokens.xyz peg monitor');
        expect(isSystemManagedAdvisory({ source: 'webacy_depeg' })).toBe(true);
        expect(isSystemManagedAdvisory({ source: 'peg_guard' })).toBe(true);
        expect(isSystemManagedAdvisory({ source: 'admin' })).toBe(false);
        expect(isSystemManagedAdvisory({})).toBe(false);
        expect(isSystemManagedAdvisory(null)).toBe(false);
    });

    it('keeps the system-advisory warnings generic across observers', () => {
        for (const warning of [SYSTEM_ADVISORY_EDIT_WARNING, SYSTEM_ADVISORY_CLEAR_WARNING]) {
            expect(warning).toContain('a depeg monitor');
            expect(warning).not.toContain('Webacy');
            expect(warning).not.toContain('\u2014');
        }
    });

    it('labels the peg observer and defaults rows without one to Webacy', () => {
        expect(pegProviderLabel('webacy')).toBe('Webacy');
        expect(pegProviderLabel('tokens')).toBe('tokens.xyz peg monitor');
        expect(pegProviderLabel(undefined)).toBe('Webacy');
    });

    it('labels yield-bearing tiers against their recent high and everything else against the peg', () => {
        expect(pegTierLabel('ok')).toBe('On peg');
        expect(pegTierLabel('ok', 'fixed')).toBe('On peg');
        expect(pegTierLabel('ok', 'fx')).toBe('On peg');
        expect(pegTierLabel('ok', null)).toBe('On peg');
        expect(pegTierLabel('ok', 'high_water')).toBe('Holding value');
        expect(pegTierLabel('watch', 'high_water')).toBe('Slipping');
        expect(pegTierLabel('warning', 'high_water')).toBe('Warning');
        expect(pegTierLabel('critical', 'high_water')).toBe('Critical');
        expect(pegTierLabel('premium', 'high_water')).toBe('Above peg');
    });

    it('labels the peg reference with its currency or the yield high-water mark', () => {
        expect(pegReferenceLabel('fixed', 'USD')).toBe('USD peg');
        expect(pegReferenceLabel('fixed', null)).toBe('USD peg');
        expect(pegReferenceLabel(undefined, undefined)).toBe('USD peg');
        expect(pegReferenceLabel(null, 'usd')).toBe('USD peg');
        expect(pegReferenceLabel('fx', 'EUR')).toBe('EUR peg (fx)');
        expect(pegReferenceLabel('fx', 'gbp')).toBe('GBP peg (fx)');
        expect(pegReferenceLabel('fx', null)).toBe('fiat peg (fx)');
        expect(pegReferenceLabel('high_water', 'USD')).toBe('recent high (yield)');
        expect(pegReferenceLabel('high_water', null)).toBe('recent high (yield)');
    });

    it('maps peg tiers and grades to badge tones', () => {
        expect(pegTierBadgeVariant('ok')).toBe('success');
        expect(pegTierBadgeVariant('watch')).toBe('info');
        expect(pegTierBadgeVariant('premium')).toBe('info');
        expect(pegTierBadgeVariant('warning')).toBe('warning');
        expect(pegTierBadgeVariant('critical')).toBe('danger');
        expect(pegTierLabel('premium')).toBe('Above peg');
        expect(structuralGradeBadgeVariant('A-')).toBe('success');
        expect(structuralGradeBadgeVariant('B+')).toBe('info');
        expect(structuralGradeBadgeVariant('C')).toBe('warning');
        expect(structuralGradeBadgeVariant('D+')).toBe('danger');
        expect(structuralGradeBadgeVariant('F')).toBe('danger');
    });

    it('formats signed deviation', () => {
        expect(formatPegDeviation(-2.4)).toBe('-2.40%');
        expect(formatPegDeviation(0.351)).toBe('+0.35%');
        expect(formatPegDeviation(0)).toBe('0.00%');
        expect(formatPegDeviation(null)).toBe('n/a');
    });
});

describe('formatRelativeTime', () => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);

    it('buckets recent timestamps coarsely', () => {
        expect(formatRelativeTime(now - 5_000, now)).toBe('just now');
        expect(formatRelativeTime(now + 5_000, now)).toBe('just now');
        expect(formatRelativeTime(now - 3 * 60_000, now)).toBe('3m ago');
        expect(formatRelativeTime(now - 5 * 3_600_000, now)).toBe('5h ago');
        expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    });

    it('falls back to an absolute date after a month', () => {
        const old = now - 45 * 86_400_000;
        expect(formatRelativeTime(old, now)).toBe(new Date(old).toLocaleDateString());
    });
});
