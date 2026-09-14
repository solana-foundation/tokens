import { describe, expect, test } from 'bun:test';

import {
    ADVISORY_BLOCKED_EVENT,
    ADVISORY_COPY,
    ASSET_ADVISORY_STATUSES,
    DEPEG_ADVISORY_SOURCES,
    DEPEG_ADVISORY_TITLE,
    advisoryBannerTitle,
    advisoryEventProps,
    advisoryLabel,
    advisoryMetadataPrefix,
    advisorySeverity,
    advisoryTone,
    collectVariantAdvisories,
    formatAdvisorySince,
    getSiblingAdvisories,
    getViewedAdvisory,
    isTradeBlocked,
    normalizeAdvisory,
    normalizeAdvisoryEntries,
    pickMostSevere,
    siblingNoticeCopy,
    sortAdvisoryEntries,
    type AssetAdvisory,
    type AssetAdvisoryEntry,
} from './asset-advisory';

const SILV_MINT = 'SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L';
const ONDO_MINT = 'So11111111111111111111111111111111111111112';
const THIRD_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const SINCE = Date.UTC(2026, 8, 10, 12, 0, 0);

function advisory(overrides: Partial<AssetAdvisory> = {}): AssetAdvisory {
    return {
        status: 'compromised',
        reason: 'Issuer treasury exploited; Sunrise pulled the market.',
        url: 'https://sunrise.xyz/status',
        since: SINCE,
        ...overrides,
    };
}

describe('normalizeAdvisory', () => {
    test('returns null for null, undefined, arrays, and primitives', () => {
        expect(normalizeAdvisory(null)).toBe(null);
        expect(normalizeAdvisory(undefined)).toBe(null);
        expect(normalizeAdvisory([])).toBe(null);
        expect(normalizeAdvisory('compromised')).toBe(null);
        expect(normalizeAdvisory(42)).toBe(null);
    });

    test('returns null for unknown or uppercase statuses', () => {
        expect(normalizeAdvisory({ status: 'banned', reason: 'x', url: null, since: SINCE })).toBe(null);
        expect(normalizeAdvisory({ status: 'COMPROMISED', reason: 'x', url: null, since: SINCE })).toBe(null);
        expect(normalizeAdvisory({ reason: 'x', url: null, since: SINCE })).toBe(null);
    });

    test('decodes a well-formed advisory', () => {
        expect(normalizeAdvisory(advisory())).toEqual(advisory());
    });

    test('drops non-http(s) or malformed urls', () => {
        expect(normalizeAdvisory(advisory({ url: 'javascript:alert(1)' }))?.url).toBe(null);
        expect(normalizeAdvisory(advisory({ url: 'not a url' }))?.url).toBe(null);
        expect(normalizeAdvisory(advisory({ url: '' }))?.url).toBe(null);
        expect(normalizeAdvisory({ ...advisory(), url: 123 })?.url).toBe(null);
        expect(normalizeAdvisory(advisory({ url: ' https://example.com/notice ' }))?.url).toBe(
            'https://example.com/notice',
        );
    });

    test('defaults reason and since when missing or invalid', () => {
        const result = normalizeAdvisory({ status: 'caution' });
        expect(result).toEqual({ status: 'caution', reason: '', url: null, since: 0 });
        expect(normalizeAdvisory({ status: 'caution', since: -5 })?.since).toBe(0);
        expect(normalizeAdvisory({ status: 'caution', since: Number.NaN })?.since).toBe(0);
        expect(normalizeAdvisory({ status: 'caution', reason: '  padded  ' })?.reason).toBe('padded');
    });
});

describe('normalizeAdvisoryEntries', () => {
    test('returns [] for non-arrays and skips rows without a mint or status', () => {
        expect(normalizeAdvisoryEntries(undefined)).toEqual([]);
        expect(normalizeAdvisoryEntries({})).toEqual([]);
        expect(
            normalizeAdvisoryEntries([
                { ...advisory(), mint: '' },
                { ...advisory({ status: 'nope' as never }), mint: SILV_MINT },
                { mint: SILV_MINT, status: 'caution', reason: 'r', url: null, since: 1, variantId: 'silver:silv' },
            ]),
        ).toEqual([{ mint: SILV_MINT, status: 'caution', reason: 'r', url: null, since: 1, variantId: 'silver:silv' }]);
    });
});

describe('isTradeBlocked', () => {
    test('true for compromised and blocked, false for caution and null', () => {
        expect(isTradeBlocked(advisory({ status: 'compromised' }))).toBe(true);
        expect(isTradeBlocked(advisory({ status: 'blocked' }))).toBe(true);
        expect(isTradeBlocked(advisory({ status: 'caution' }))).toBe(false);
        expect(isTradeBlocked(null)).toBe(false);
        expect(isTradeBlocked(undefined)).toBe(false);
    });
});

describe('severity ordering', () => {
    test('blocked > compromised > caution > none', () => {
        expect(advisorySeverity('blocked') > advisorySeverity('compromised')).toBe(true);
        expect(advisorySeverity('compromised') > advisorySeverity('caution')).toBe(true);
        expect(advisorySeverity('caution') > advisorySeverity(null)).toBe(true);
        expect(advisorySeverity(null)).toBe(0);
        expect(advisorySeverity(undefined)).toBe(0);
        expect(advisorySeverity(advisory({ status: 'blocked' }))).toBe(advisorySeverity('blocked'));
    });

    test('sortAdvisoryEntries orders by severity then most recent since', () => {
        const entries: AssetAdvisoryEntry[] = [
            { ...advisory({ status: 'caution', since: 300 }), mint: 'a' },
            { ...advisory({ status: 'compromised', since: 100 }), mint: 'b' },
            { ...advisory({ status: 'compromised', since: 200 }), mint: 'c' },
            { ...advisory({ status: 'blocked', since: 1 }), mint: 'd' },
        ];
        expect(sortAdvisoryEntries(entries).map(e => e.mint)).toEqual(['d', 'c', 'b', 'a']);
        expect(pickMostSevere(entries)?.mint).toBe('d');
        expect(pickMostSevere([])).toBe(null);
    });
});

describe('getViewedAdvisory', () => {
    test('prefers the requested variant, falls back to primary, tolerates missing fields', () => {
        const primary = { advisory: advisory({ status: 'caution' }) };
        const requested = { advisory: advisory({ status: 'compromised' }) };

        expect(getViewedAdvisory({ requestedVariant: requested, primary })?.status).toBe('compromised');
        expect(getViewedAdvisory({ requestedVariant: null, primary })?.status).toBe('caution');
        expect(getViewedAdvisory({ requestedVariant: { advisory: null }, primary })).toBe(null);
        expect(getViewedAdvisory({ requestedVariant: {}, primary })).toBe(null);
        expect(getViewedAdvisory({})).toBe(null);
    });
});

describe('collectVariantAdvisories / getSiblingAdvisories', () => {
    const variants = [
        { mint: ONDO_MINT, variantId: 'silver:ondo', displaySymbol: 'SLVon', advisory: null },
        { mint: SILV_MINT, variantId: 'silver:silv', displaySymbol: 'SILV', advisory: advisory() },
        { mint: THIRD_MINT, displaySymbol: '???', advisory: advisory({ status: 'caution', since: 5 }) },
    ];

    test('derives entries from rendered variants and unions hidden ones from asset.advisories', () => {
        const hiddenMint = 'HiddenMint111111111111111111111111111111111';
        const entries = collectVariantAdvisories(variants, [
            { mint: hiddenMint, variantId: 'silver:hidden', status: 'blocked', reason: 'gone', url: null, since: 9 },
            // Duplicate of a rendered variant with a different status: rendered wins.
            { mint: SILV_MINT, status: 'caution', reason: 'stale', url: null, since: 1 },
        ]);

        expect(entries.map(e => e.mint)).toEqual([hiddenMint, SILV_MINT, THIRD_MINT]);
        const silv = entries.find(e => e.mint === SILV_MINT);
        expect(silv?.status).toBe('compromised');
        expect(silv?.variantId).toBe('silver:silv');
        expect(silv?.symbol).toBe('SILV');
        // '???' placeholder symbols are dropped.
        expect(entries.find(e => e.mint === THIRD_MINT)?.symbol).toBe(undefined);
    });

    test('ignores variants with no advisory and returns [] when nothing is flagged', () => {
        expect(collectVariantAdvisories([{ mint: ONDO_MINT }])).toEqual([]);
        expect(collectVariantAdvisories([], undefined)).toEqual([]);
    });

    test('getSiblingAdvisories excludes the active mint', () => {
        const entries = collectVariantAdvisories(variants);
        expect(getSiblingAdvisories(entries, SILV_MINT).map(e => e.mint)).toEqual([THIRD_MINT]);
        expect(getSiblingAdvisories(entries, ONDO_MINT).map(e => e.mint)).toEqual([SILV_MINT, THIRD_MINT]);
        expect(getSiblingAdvisories(entries, null).map(e => e.mint)).toEqual([SILV_MINT, THIRD_MINT]);
    });
});

describe('copy helpers', () => {
    test('siblingNoticeCopy singular vs plural', () => {
        const one: AssetAdvisoryEntry[] = [{ ...advisory(), mint: SILV_MINT }];
        const blocked: AssetAdvisoryEntry[] = [{ ...advisory({ status: 'blocked' }), mint: SILV_MINT }];
        const many: AssetAdvisoryEntry[] = [...one, { ...advisory({ status: 'caution' }), mint: THIRD_MINT }];

        expect(siblingNoticeCopy(one, 'Silver')).toBe('One Silver variant has been flagged as compromised.');
        expect(siblingNoticeCopy(blocked, 'Silver')).toBe('One Silver variant has been removed from listings.');
        expect(siblingNoticeCopy(many, 'Silver')).toBe('2 Silver variants have active advisories.');
        expect(siblingNoticeCopy([], 'Silver')).toBe('');
    });

    test('banner title and metadata prefix use the symbol when present', () => {
        expect(advisoryBannerTitle(advisory(), 'SILV')).toBe('SILV has been flagged as compromised');
        expect(advisoryBannerTitle(advisory(), '')).toBe('This token has been flagged as compromised');
        expect(advisoryBannerTitle(advisory({ status: 'caution', source: 'admin' }), 'USX')).toBe(
            'USX has an active caution advisory',
        );
        expect(advisoryMetadataPrefix(advisory(), 'silv')).toBe('Warning: SILV has been flagged as compromised.');
        expect(advisoryMetadataPrefix(advisory({ status: 'blocked' }), null)).toBe(
            'Warning: This token has been flagged as blocked.',
        );
    });

    test('depeg-monitor advisories get the off-peg title while keeping caution tone', () => {
        const depeg = advisory({ status: 'caution', source: 'webacy_depeg', url: null });
        expect(DEPEG_ADVISORY_TITLE).toBe('is trading off its peg');
        expect(advisoryBannerTitle(depeg, 'USX')).toBe('USX is trading off its peg');
        expect(advisoryBannerTitle(depeg, null)).toBe('This token is trading off its peg');
        expect(advisoryTone(depeg.status)).toBe('warning');
        expect(advisoryLabel(depeg.status)).toBe('Caution');
        expect(isTradeBlocked(depeg)).toBe(false);
        // The in-house peg monitor writes the same predicate.
        const pegGuard = advisory({ status: 'caution', source: 'peg_guard', url: null });
        expect(advisoryBannerTitle(pegGuard, 'USX')).toBe('USX is trading off its peg');
        expect(DEPEG_ADVISORY_SOURCES).toEqual(new Set(['webacy_depeg', 'peg_guard']));
        // Only the source changes the predicate; a human caution keeps the generic copy.
        expect(advisoryBannerTitle(advisory({ status: 'caution' }), 'USX')).toBe('USX has an active caution advisory');
        expect(advisoryBannerTitle(advisory({ status: 'caution', source: 'admin' }), 'USX')).toBe(
            'USX has an active caution advisory',
        );
    });

    test('normalizeAdvisory keeps a known source and drops unknown ones', () => {
        expect(normalizeAdvisory(advisory({ source: 'webacy_depeg' }))?.source).toBe('webacy_depeg');
        expect(normalizeAdvisory(advisory({ source: 'peg_guard' }))?.source).toBe('peg_guard');
        expect(normalizeAdvisory(advisory({ source: 'admin' }))?.source).toBe('admin');
        expect(normalizeAdvisory({ ...advisory(), source: 'robot' })?.source).toBe(undefined);
        expect(normalizeAdvisory(advisory())?.source).toBe(undefined);
    });

    test('formatAdvisorySince renders a UTC date and empty for invalid input', () => {
        expect(formatAdvisorySince(SINCE)).toBe('Sep 10, 2026');
        expect(formatAdvisorySince(0)).toBe('');
        expect(formatAdvisorySince(null)).toBe('');
        expect(formatAdvisorySince(Number.NaN)).toBe('');
    });

    test('advisoryEventProps carries status, since, url, and extras', () => {
        expect(ADVISORY_BLOCKED_EVENT).toBe('advisory_blocked_click');
        expect(advisoryEventProps(advisory(), { surface: 'desktop_panel' })).toEqual({
            advisory_status: 'compromised',
            advisory_since: SINCE,
            advisory_url: 'https://sunrise.xyz/status',
            surface: 'desktop_panel',
        });
        expect(advisoryEventProps(advisory({ since: 0, url: null }))).toEqual({ advisory_status: 'compromised' });
    });
});

describe('exhaustiveness', () => {
    test('every status has copy, a tone, a label, and a severity', () => {
        expect(ASSET_ADVISORY_STATUSES).toEqual(['caution', 'compromised', 'blocked']);
        for (const status of ASSET_ADVISORY_STATUSES) {
            const copy = ADVISORY_COPY[status];
            expect(copy.title.length > 0).toBe(true);
            expect(copy.tradeCta.length > 0).toBe(true);
            expect(copy.tradeExplanation.length > 0).toBe(true);
            expect(copy.dialogTitle.length > 0).toBe(true);
            expect(copy.dialogLine.length > 0).toBe(true);
            expect(copy.ogStrip).toBe(copy.ogStrip.toUpperCase());
            expect(['warning', 'destructive'].includes(advisoryTone(status))).toBe(true);
            expect(advisoryLabel(status).length > 0).toBe(true);
            expect(advisorySeverity(status) > 0).toBe(true);
        }
        expect(advisoryTone('caution')).toBe('warning');
        expect(advisoryTone('compromised')).toBe('destructive');
        expect(advisoryTone('blocked')).toBe('destructive');
        expect(ADVISORY_COPY.compromised.tradeCta).toBe('Trading disabled');
        expect(ADVISORY_COPY.blocked.tradeCta).toBe('Trading disabled');
    });
});
