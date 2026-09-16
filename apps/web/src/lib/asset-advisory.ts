import {
    ADVISORY_STATUSES,
    isAdvisorySource,
    isAdvisoryStatus,
    isTradeRestrictedAdvisory,
    type AdvisorySource,
    type AdvisoryStatus,
    type VariantAdvisory,
} from '@tokens/asset-registry';

/**
 * Asset advisory helpers shared by the token page, list/table badges, the OG
 * card, and metadata. Pure TS (no React) so it is usable from server
 * components, client components, the OG route, and bun:test.
 *
 * The API annotates every serialized variant with `advisory` and every asset
 * with `advisories[]`. Deploy order may briefly leave those fields absent, so
 * every reader goes through `normalizeAdvisory` and degrades to "no advisory".
 */

export type AssetAdvisoryStatus = AdvisoryStatus;
export type AssetAdvisory = VariantAdvisory;
export const ASSET_ADVISORY_STATUSES = ADVISORY_STATUSES;

/** `asset.advisories[]` row: an advisory plus the variant it belongs to. */
export interface AssetAdvisoryEntry extends AssetAdvisory {
    mint: string;
    variantId?: string;
    /** Best-effort display symbol for the flagged variant (page-side only). */
    symbol?: string;
}

export type AssetAdvisoryTone = 'warning' | 'destructive';

export const ADVISORY_BLOCKED_EVENT = 'advisory_blocked_click';

const SEVERITY_BY_STATUS: Record<AssetAdvisoryStatus, number> = {
    caution: 1,
    compromised: 2,
    blocked: 3,
};

const LABEL_BY_STATUS: Record<AssetAdvisoryStatus, string> = {
    caution: 'Caution',
    compromised: 'Compromised',
    blocked: 'Blocked',
};

export interface AssetAdvisoryCopy {
    /** Predicate for the banner title; subject is the symbol or "This token". */
    title: string;
    /** Label of the disabled trade CTA (compromised/blocked only). */
    tradeCta: string;
    /** Sentence under the disabled trade CTA on desktop. */
    tradeExplanation: string;
    /** Title of the leaving-site dialog when trading is blocked. */
    dialogTitle: string;
    /** Sentence shown inside the leaving-site dialog. */
    dialogLine: string;
    /** Pre-uppercased plain text for the OG card strip (satori: no icons). */
    ogStrip: string;
}

export const ADVISORY_COPY: Record<AssetAdvisoryStatus, AssetAdvisoryCopy> = {
    caution: {
        title: 'has an active caution advisory',
        tradeCta: 'Buy',
        tradeExplanation: 'Review the advisory before trading this token.',
        dialogTitle: "You're leaving Tokens",
        dialogLine: 'Caution: review the advisory on this token before trading.',
        ogStrip: 'CAUTION: ADVISORY ACTIVE',
    },
    compromised: {
        title: 'has been flagged as compromised',
        tradeCta: 'Trading disabled',
        tradeExplanation: 'Trade links are disabled because this token has been flagged as compromised.',
        dialogTitle: 'Trading disabled',
        dialogLine: 'Trade links are disabled for this token because it has been flagged as compromised.',
        ogStrip: 'WARNING: FLAGGED AS COMPROMISED',
    },
    blocked: {
        title: 'has been removed from Tokens listings',
        tradeCta: 'Trading disabled',
        tradeExplanation: 'This token was removed from Tokens listings. Trade links are disabled.',
        dialogTitle: 'Trading disabled',
        dialogLine: 'Trade links are disabled because this token was removed from Tokens listings.',
        ogStrip: 'WARNING: REMOVED FROM LISTINGS',
    },
};

export const DEFAULT_ADVISORY_REASON = 'This token has been flagged by the Tokens team.';

function normalizeAdvisoryUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return trimmed;
    } catch {
        return null;
    }
}

/**
 * Defensive decode of an API `advisory` value. Unknown/missing status (or a
 * non-object) yields null so a bad payload degrades to "no advisory" instead
 * of rendering a half-populated warning.
 */
export function normalizeAdvisory(value: unknown): AssetAdvisory | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!isAdvisoryStatus(record.status)) return null;

    const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
    const since =
        typeof record.since === 'number' && Number.isFinite(record.since) && record.since > 0 ? record.since : 0;

    return {
        status: record.status,
        reason,
        url: normalizeAdvisoryUrl(record.url),
        since,
        // Older API builds omit `source`; unknown values degrade to "manual".
        ...(isAdvisorySource(record.source) ? { source: record.source } : {}),
    };
}

/** Defensive decode of an API `advisories[]` value (asset-level summary). */
export function normalizeAdvisoryEntries(value: unknown): AssetAdvisoryEntry[] {
    if (!Array.isArray(value)) return [];

    const entries: AssetAdvisoryEntry[] = [];
    for (const item of value) {
        const advisory = normalizeAdvisory(item);
        if (!advisory) continue;
        const record = item as Record<string, unknown>;
        const mint = typeof record.mint === 'string' ? record.mint.trim() : '';
        if (!mint) continue;
        const variantId = typeof record.variantId === 'string' ? record.variantId.trim() : '';
        entries.push({ ...advisory, mint, ...(variantId ? { variantId } : {}) });
    }
    return sortAdvisoryEntries(entries);
}

/** `compromised` and `blocked` disable every outbound trade link. */
export function isTradeBlocked(advisory: AssetAdvisory | null | undefined): boolean {
    return isTradeRestrictedAdvisory(advisory);
}

export function advisorySeverity(value: AssetAdvisoryStatus | AssetAdvisory | null | undefined): number {
    if (!value) return 0;
    const status = typeof value === 'string' ? value : value.status;
    return SEVERITY_BY_STATUS[status] ?? 0;
}

export function advisoryTone(status: AssetAdvisoryStatus): AssetAdvisoryTone {
    return status === 'caution' ? 'warning' : 'destructive';
}

export function advisoryLabel(status: AssetAdvisoryStatus): string {
    return LABEL_BY_STATUS[status];
}

export function advisoryReasonText(advisory: AssetAdvisory): string {
    return advisory.reason.trim() || DEFAULT_ADVISORY_REASON;
}

/** Sources written by an automated depeg monitor (Webacy or the tokens.xyz peg guard). */
export const DEPEG_ADVISORY_SOURCES: ReadonlySet<AdvisorySource> = new Set<AdvisorySource>([
    'webacy_depeg',
    'peg_guard',
]);

export function isDepegAdvisorySource(source: AdvisorySource | undefined): boolean {
    return source !== undefined && DEPEG_ADVISORY_SOURCES.has(source);
}

/** Title predicate for the auto-caution a depeg monitor sets. */
export const DEPEG_ADVISORY_TITLE = 'is trading off its peg';

/**
 * "SILV has been flagged as compromised" / "This token has an active caution
 * advisory" / "USX is trading off its peg" (depeg-monitor rows; tone and
 * status are unchanged, only the predicate is specific).
 */
export function advisoryBannerTitle(advisory: AssetAdvisory, symbol?: string | null): string {
    const subject = (symbol ?? '').trim() || 'This token';
    const predicate = isDepegAdvisorySource(advisory.source)
        ? DEPEG_ADVISORY_TITLE
        : ADVISORY_COPY[advisory.status].title;
    return `${subject} ${predicate}`;
}

/** Prefix for `<meta name="description">` so text-only previews warn. */
export function advisoryMetadataPrefix(advisory: AssetAdvisory, symbol?: string | null): string {
    const subject = (symbol ?? '').trim().toUpperCase() || 'This token';
    return `Warning: ${subject} has been flagged as ${advisoryLabel(advisory.status).toLowerCase()}.`;
}

/** The advisory the page is "about": the viewed variant, else the primary. */
export function getViewedAdvisory(model: {
    requestedVariant?: { advisory?: unknown } | null;
    primary?: { advisory?: unknown } | null;
}): AssetAdvisory | null {
    const viewed = model.requestedVariant ?? model.primary ?? null;
    return normalizeAdvisory(viewed?.advisory);
}

/** Most severe first; ties broken by most recent `since`. */
export function sortAdvisoryEntries<T extends AssetAdvisory>(entries: readonly T[]): T[] {
    return entries.slice().sort((a, b) => advisorySeverity(b) - advisorySeverity(a) || b.since - a.since);
}

/**
 * Derive the advisory list from the variants the page actually renders, then
 * union the API's `asset.advisories[]` (which also covers variants a route
 * hid). Rendered variants win on conflict so the badge and the notice agree.
 */
export function collectVariantAdvisories(
    variants: ReadonlyArray<{ mint: string; variantId?: string; displaySymbol?: string; advisory?: unknown }>,
    assetAdvisories?: unknown,
): AssetAdvisoryEntry[] {
    const byMint = new Map<string, AssetAdvisoryEntry>();

    for (const variant of variants) {
        const advisory = normalizeAdvisory(variant.advisory);
        if (!advisory) continue;
        const mint = variant.mint.trim();
        if (!mint || byMint.has(mint)) continue;
        const symbol = (variant.displaySymbol ?? '').trim();
        byMint.set(mint, {
            ...advisory,
            mint,
            ...(variant.variantId ? { variantId: variant.variantId } : {}),
            ...(symbol && symbol !== '???' ? { symbol } : {}),
        });
    }

    for (const entry of normalizeAdvisoryEntries(assetAdvisories)) {
        if (byMint.has(entry.mint)) continue;
        byMint.set(entry.mint, entry);
    }

    return sortAdvisoryEntries(Array.from(byMint.values()));
}

export function getSiblingAdvisories(
    entries: readonly AssetAdvisoryEntry[],
    activeMint: string | null | undefined,
): AssetAdvisoryEntry[] {
    const active = (activeMint ?? '').trim();
    return sortAdvisoryEntries(entries.filter(entry => entry.mint !== active));
}

export function pickMostSevere<T extends AssetAdvisory>(entries: readonly T[]): T | null {
    return sortAdvisoryEntries(entries)[0] ?? null;
}

/** One-liner for the canonical page when a non-viewed sibling variant is flagged. */
export function siblingNoticeCopy(entries: readonly AssetAdvisoryEntry[], displayName: string): string {
    const subject = displayName.trim() || 'this asset';
    if (entries.length === 0) return '';
    if (entries.length === 1) {
        const entry = entries[0]!;
        const label = advisoryLabel(entry.status).toLowerCase();
        return entry.status === 'blocked'
            ? `One ${subject} variant has been removed from listings.`
            : `One ${subject} variant has been flagged as ${label}.`;
    }
    return `${entries.length} ${subject} variants have active advisories.`;
}

const ADVISORY_SINCE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
});

/** "Sep 10, 2026" (UTC so server and client render the same string). */
export function formatAdvisorySince(since: number | null | undefined): string {
    if (typeof since !== 'number' || !Number.isFinite(since) || since <= 0) return '';
    return ADVISORY_SINCE_FORMATTER.format(new Date(since));
}

export function advisoryEventProps(advisory: AssetAdvisory, extra?: Record<string, unknown>): Record<string, unknown> {
    return {
        advisory_status: advisory.status,
        ...(advisory.since > 0 ? { advisory_since: advisory.since } : {}),
        ...(advisory.url ? { advisory_url: advisory.url } : {}),
        ...extra,
    };
}
