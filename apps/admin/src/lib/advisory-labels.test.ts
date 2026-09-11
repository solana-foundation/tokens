import { describe, expect, it } from 'bun:test';

import {
    ADVISORY_REASON_MAX_LENGTH,
    ADVISORY_STATUSES,
    ADVISORY_STATUS_OPTIONS,
    advisoryActorLabel,
    advisoryBadgeVariant,
    advisorySetToastMessage,
    advisoryStatusLabel,
    describeAdvisoryEvent,
    formatRelativeTime,
    isAdvisoryStatus,
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
