import {
    STRUCTURAL_CATEGORY_KEYS,
    STRUCTURAL_CATEGORY_LABELS,
    isPegTier,
    isStructuralCategoryKey,
    isStructuralCategoryStatus,
    isStructuralGrade,
    structuralGradeBand,
    type CompactPegHealth,
    type PegHealth,
    type PegTier,
    type StructuralCategoryStatus,
    type StructuralGrade,
    type StructuralHealth,
    type StructuralHealthCategory,
} from '@tokens/asset-registry';

import type { AssetAdvisory } from './asset-advisory';

/**
 * Stablecoin health helpers shared by the token header pill, the variants
 * list, the Security section, and the advisory banner. Pure TS (no React) so
 * it is usable from server components, client components, and bun:test.
 *
 * The API emits a compact `pegHealth` on stablecoin variants and the full
 * `pegHealth` / `structuralHealth` blocks on risk payloads. Both come from
 * Webacy (branded dd.xyz). Deploy order may briefly leave the fields absent,
 * so every reader goes through a `normalize*` helper and degrades to "no
 * data" instead of rendering a half-populated card.
 */

export type HealthTone = 'success' | 'neutral' | 'warning' | 'destructive' | 'info';

export const WEBACY_ATTRIBUTION_URL = 'https://dd.xyz';
export const WEBACY_PROVIDER_LABEL = 'Webacy';
export const STABLECOIN_HEALTH_VIEWED_EVENT = 'stablecoin_health_viewed';

/** Deviations under this magnitude (in percent) are shown as "on peg" without a direction. */
export const ON_PEG_DEVIATION_PCT = 0.05;

export interface PegTierCopy {
    label: string;
    tone: HealthTone;
    description: string;
}

export const PEG_TIER_COPY: Record<PegTier, PegTierCopy> = {
    ok: {
        label: 'On peg',
        tone: 'success',
        description: 'Trading within the normal band around its peg.',
    },
    watch: {
        label: 'Watch',
        tone: 'neutral',
        description: 'Minor deviation from peg. No action needed, but worth monitoring.',
    },
    warning: {
        label: 'Warning',
        tone: 'warning',
        description: 'Trading noticeably off its peg. Verify redemptions and liquidity before trading.',
    },
    critical: {
        label: 'Critical',
        tone: 'destructive',
        description: 'Severe deviation from peg. Treat as a possible depeg until it recovers.',
    },
    premium: {
        label: 'Above peg',
        tone: 'info',
        description: 'Trading above its peg with no depeg risk signals.',
    },
};

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function finiteNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Unix ms; anything non-positive or non-finite degrades to 0 (renders as "no timestamp"). */
function timestampOrZero(value: unknown): number {
    const parsed = finiteNumberOrNull(value);
    return parsed !== null && parsed > 0 ? parsed : 0;
}

function timestampOrNull(value: unknown): number | null {
    const parsed = timestampOrZero(value);
    return parsed > 0 ? parsed : null;
}

/** Defensive decode of the compact per-variant `pegHealth` on `GET /v1/assets/{id}`. */
export function normalizeCompactPegHealth(value: unknown): CompactPegHealth | null {
    const record = asRecord(value);
    if (!record || !isPegTier(record.tier)) return null;

    return {
        tier: record.tier,
        deviationPct: finiteNumberOrNull(record.deviationPct),
        updatedAt: timestampOrZero(record.updatedAt),
        stale: record.stale === true,
    };
}

/** Defensive decode of the full `risk.pegHealth` block on risk payloads. */
export function normalizePegHealth(value: unknown): PegHealth | null {
    const record = asRecord(value);
    if (!record || !isPegTier(record.tier)) return null;

    return {
        provider: 'webacy',
        tier: record.tier,
        overallRisk: finiteNumberOrNull(record.overallRisk),
        deviationPct: finiteNumberOrNull(record.deviationPct),
        priceUsd: finiteNumberOrNull(record.priceUsd),
        pegUsd: finiteNumberOrNull(record.pegUsd),
        tierSince: timestampOrNull(record.tierSince),
        updatedAt: timestampOrZero(record.updatedAt),
        stale: record.stale === true,
    };
}

function normalizeStructuralCategories(value: unknown): StructuralHealthCategory[] {
    if (!Array.isArray(value)) return [];

    const byKey = new Map<StructuralHealthCategory['key'], StructuralHealthCategory>();
    for (const item of value) {
        const record = asRecord(item);
        if (!record || !isStructuralCategoryKey(record.key) || byKey.has(record.key)) continue;
        const label = typeof record.label === 'string' ? record.label.trim() : '';
        byKey.set(record.key, {
            key: record.key,
            label: label || STRUCTURAL_CATEGORY_LABELS[record.key],
            score: finiteNumberOrNull(record.score),
            weight: finiteNumberOrNull(record.weight),
            status: isStructuralCategoryStatus(record.status) ? record.status : 'unknown',
        });
    }

    // Canonical order so the five rows always render in the same sequence.
    const ordered: StructuralHealthCategory[] = [];
    for (const key of STRUCTURAL_CATEGORY_KEYS) {
        const category = byKey.get(key);
        if (category) ordered.push(category);
    }
    return ordered;
}

/** Defensive decode of the full `risk.structuralHealth` block on risk payloads. */
export function normalizeStructuralHealth(value: unknown): StructuralHealth | null {
    const record = asRecord(value);
    if (!record || !isStructuralGrade(record.grade)) return null;

    return {
        provider: 'webacy',
        grade: record.grade,
        score: finiteNumberOrNull(record.score),
        categories: normalizeStructuralCategories(record.categories),
        updatedAt: timestampOrZero(record.updatedAt),
        stale: record.stale === true,
    };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

type PegDeviationSource = Pick<CompactPegHealth, 'deviationPct'> | null | undefined;

/** "−2.40% below peg" / "+0.35% above peg" / "±0.01%" / "Deviation unavailable". */
export function pegDeviationText(pegHealth: PegDeviationSource): string {
    const deviation = pegHealth?.deviationPct;
    if (typeof deviation !== 'number' || !Number.isFinite(deviation)) return 'Deviation unavailable';

    const magnitude = Math.abs(deviation).toFixed(2);
    if (Math.abs(deviation) < ON_PEG_DEVIATION_PCT) return `±${magnitude}%`;
    return deviation < 0 ? `−${magnitude}% below peg` : `+${magnitude}% above peg`;
}

/** "$0.9760 vs $1.00 peg"; empty when the price is unknown. */
export function pegPriceText(pegHealth: Pick<PegHealth, 'priceUsd' | 'pegUsd'> | null | undefined): string {
    const price = pegHealth?.priceUsd;
    if (typeof price !== 'number' || !Number.isFinite(price)) return '';

    const priceText = `$${price.toFixed(4)}`;
    const peg = pegHealth?.pegUsd;
    if (typeof peg !== 'number' || !Number.isFinite(peg)) return priceText;
    return `${priceText} vs $${peg.toFixed(2)} peg`;
}

const HEALTH_UPDATED_AT_FORMATTER = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
});

/**
 * "Sep 13, 2026 14:30 UTC". Always UTC so server and client render the same
 * string (same reasoning as `formatAdvisorySince`). Empty for invalid input.
 */
export function formatHealthUpdatedAt(updatedAt: number | null | undefined): string {
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return '';

    const parts = new Map<string, string>();
    for (const part of HEALTH_UPDATED_AT_FORMATTER.formatToParts(new Date(updatedAt))) {
        if (part.type !== 'literal') parts.set(part.type, part.value);
    }
    const month = parts.get('month');
    const day = parts.get('day');
    const year = parts.get('year');
    const hour = parts.get('hour');
    const minute = parts.get('minute');
    if (!month || !day || !year || !hour || !minute) return '';
    return `${month} ${day}, ${year} ${hour}:${minute} UTC`;
}

/**
 * Accessible summary for the peg pill, e.g.
 * "Peg status: Warning, −2.40% below peg. Updated Sep 13, 2026 14:30 UTC. Source: Webacy".
 */
export function pegStatusTitle(pegHealth: CompactPegHealth | PegHealth): string {
    const copy = PEG_TIER_COPY[pegHealth.tier];
    const updated = formatHealthUpdatedAt(pegHealth.updatedAt);
    const sentences = [
        `Peg status: ${copy.label}, ${pegDeviationText(pegHealth)}.`,
        ...(updated ? [`Updated ${updated}.`] : []),
        `Source: ${WEBACY_PROVIDER_LABEL}`,
    ];
    return `${sentences.join(' ')}${pegHealth.stale ? ' (stale)' : ''}`;
}

export function pegTierTone(tier: PegTier): HealthTone {
    return PEG_TIER_COPY[tier].tone;
}

export function structuralStatusTone(status: StructuralCategoryStatus): HealthTone {
    switch (status) {
        case 'pass':
            return 'success';
        case 'warn':
            return 'warning';
        case 'fail':
            return 'destructive';
        case 'unknown':
            return 'neutral';
    }
}

export const STRUCTURAL_STATUS_LABELS: Record<StructuralCategoryStatus, string> = {
    pass: 'Pass',
    warn: 'Warn',
    fail: 'Fail',
    unknown: 'Unknown',
};

/** A success, B neutral, C warning, D/F destructive (the +/- modifier does not change the tone). */
export function structuralGradeTone(grade: StructuralGrade): HealthTone {
    switch (structuralGradeBand(grade)) {
        case 'A':
            return 'success';
        case 'B':
            return 'neutral';
        case 'C':
            return 'warning';
        case 'D':
        case 'F':
            return 'destructive';
    }
}

/** "Weight 30% · pass" for the structural category tooltip. */
export function structuralCategoryTooltip(category: Pick<StructuralHealthCategory, 'weight' | 'status'>): string {
    const status = STRUCTURAL_STATUS_LABELS[category.status].toLowerCase();
    const weight = category.weight;
    if (typeof weight !== 'number' || !Number.isFinite(weight)) return `Weight unknown · ${status}`;
    return `Weight ${Math.round(weight * 100)}% · ${status}`;
}

/** Only `stablecoin` assets carry peg health; everything else renders no pill. */
export function isStablecoinCategory(category: unknown): boolean {
    return category === 'stablecoin';
}

/** Footer line for advisories the Webacy depeg monitor set; empty for manual rows. */
export function advisorySourceAttribution(advisory: Pick<AssetAdvisory, 'source'> | null | undefined): string {
    return advisory?.source === 'webacy_depeg' ? 'Set automatically by the Webacy depeg monitor' : '';
}

/** Analytics properties for `stablecoin_health_viewed` (nulls are omitted). */
export function stablecoinHealthEventProps(
    pegHealth: Pick<PegHealth, 'tier'> | null | undefined,
    structuralHealth: Pick<StructuralHealth, 'grade'> | null | undefined,
): Record<string, unknown> {
    return {
        ...(pegHealth ? { peg_tier: pegHealth.tier } : {}),
        ...(structuralHealth ? { structural_grade: structuralHealth.grade } : {}),
    };
}
