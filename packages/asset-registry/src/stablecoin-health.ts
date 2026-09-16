/**
 * Stablecoin health vocabulary shared by the jobs worker (writes), the API
 * (serves), the web app and the admin app (render). Data comes from Webacy's
 * depeg monitor (`/rwa`) and structural health grades (`/v3/rwa`).
 *
 * Pure constants and guards only; no IO.
 */

/**
 * Depeg-monitor tier, derived by Webacy from a 0-100 risk score:
 * ok <25, watch 25-49, warning 50-69, critical >=70. `premium` means the
 * token trades 2%+ above its peg with no risk signals.
 */
export const PEG_TIERS = ['ok', 'watch', 'warning', 'critical', 'premium'] as const;
export type PegTier = (typeof PEG_TIERS)[number];

export function isPegTier(value: unknown): value is PegTier {
    return typeof value === 'string' && (PEG_TIERS as readonly string[]).includes(value);
}

/** Ordering for "most severe wins" displays. `premium` is above peg, not a depeg. */
export function pegTierSeverity(tier: PegTier): number {
    switch (tier) {
        case 'ok':
            return 0;
        case 'premium':
            return 1;
        case 'watch':
            return 2;
        case 'warning':
            return 3;
        case 'critical':
            return 4;
    }
}

/** Webacy v3 composite letter grade. A+ is lowest risk, F is critical risk. */
export const STRUCTURAL_GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'] as const;
export type StructuralGrade = (typeof STRUCTURAL_GRADES)[number];

export function isStructuralGrade(value: unknown): value is StructuralGrade {
    return typeof value === 'string' && (STRUCTURAL_GRADES as readonly string[]).includes(value);
}

/** Letter band without the +/- modifier; drives badge tone. */
export function structuralGradeBand(grade: StructuralGrade): 'A' | 'B' | 'C' | 'D' | 'F' {
    return grade.charAt(0) as 'A' | 'B' | 'C' | 'D' | 'F';
}

/**
 * The five weighted categories Webacy scores today. `counterparty` and
 * `chain_infrastructure` exist in the payload with weight 0 and are not
 * surfaced.
 */
export const STRUCTURAL_CATEGORY_KEYS = [
    'asset_collateral',
    'market_liquidity',
    'smart_contract',
    'operational_governance',
    'hack_exploit_history',
] as const;
export type StructuralCategoryKey = (typeof STRUCTURAL_CATEGORY_KEYS)[number];

export const STRUCTURAL_CATEGORY_LABELS: Record<StructuralCategoryKey, string> = {
    asset_collateral: 'Asset & collateral',
    market_liquidity: 'Market liquidity',
    smart_contract: 'Smart contract',
    operational_governance: 'Operations & governance',
    hack_exploit_history: 'Exploit history',
};

export function isStructuralCategoryKey(value: unknown): value is StructuralCategoryKey {
    return typeof value === 'string' && (STRUCTURAL_CATEGORY_KEYS as readonly string[]).includes(value);
}

export const STRUCTURAL_CATEGORY_STATUSES = ['pass', 'warn', 'fail', 'unknown'] as const;
export type StructuralCategoryStatus = (typeof STRUCTURAL_CATEGORY_STATUSES)[number];

export function isStructuralCategoryStatus(value: unknown): value is StructuralCategoryStatus {
    return typeof value === 'string' && (STRUCTURAL_CATEGORY_STATUSES as readonly string[]).includes(value);
}

/** Live peg status for one mint, as served on risk payloads. */
export interface PegHealth {
    provider: 'webacy';
    tier: PegTier;
    /** Webacy 0-100 depeg risk; higher = riskier. */
    overallRisk: number | null;
    /** Signed percent from peg; negative = below peg. */
    deviationPct: number | null;
    priceUsd: number | null;
    pegUsd: number | null;
    /** Unix ms when the current tier streak started. */
    tierSince: number | null;
    /** Unix ms of the last successful observation. */
    updatedAt: number;
    /** True when `updatedAt` is older than the serving side's staleness bound. */
    stale: boolean;
}

/** Trimmed per-variant peg status carried on `GET /v1/assets/{id}` for stablecoin assets. */
export interface CompactPegHealth {
    tier: PegTier;
    deviationPct: number | null;
    updatedAt: number;
    stale: boolean;
}

export interface StructuralHealthCategory {
    key: StructuralCategoryKey;
    label: string;
    /** Webacy 0-100 category score; higher = riskier. Not meant for direct rendering. */
    score: number | null;
    /** 0-1 weight in the composite. */
    weight: number | null;
    status: StructuralCategoryStatus;
}

export interface StructuralHealth {
    provider: 'webacy';
    grade: StructuralGrade;
    /** Composite 0-100; higher = riskier. */
    score: number | null;
    categories: StructuralHealthCategory[];
    /** Unix ms of the last successful observation. */
    updatedAt: number;
    stale: boolean;
}

export interface StablecoinHealth {
    pegHealth: PegHealth | null;
    structuralHealth: StructuralHealth | null;
}
