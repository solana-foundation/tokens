/**
 * Read RPC for stablecoin health: the latest Webacy depeg observation and
 * structural-health grade per mint, from `webacy_depeg_latest` and
 * `webacy_structural_health_latest` (migration 0019). Written by the
 * `reconcile-stablecoin-depeg` / `refresh-stablecoin-structural-health` jobs
 * in `crons.depeg.ts`; served to apps/api which attaches it to risk payloads.
 *
 * Staleness is NOT decided here (the API applies its own bounds). Rows whose
 * last fetch failed still return their last good tier/grade so a transient
 * provider outage does not blank the UI; `ok` / `errorMessage` say so.
 */

import {
    STRUCTURAL_CATEGORY_KEYS,
    isPegTier,
    isStructuralCategoryStatus,
    isStructuralGrade,
    type PegTier,
    type StructuralCategoryKey,
    type StructuralCategoryStatus,
    type StructuralGrade,
} from '@tokens/asset-registry';

import { InvalidArgsError } from './assets';

export const STABLECOIN_HEALTH_MAX_MINTS = 200;

/** One LEFT-JOINed row per requested mint; bigint columns may arrive as string or bigint. */
export interface StablecoinHealthRow {
    mint: string;
    depeg_ok: boolean | null;
    depeg_tier: string | null;
    depeg_overall_risk: number | string | null;
    depeg_deviation_pct: number | string | null;
    depeg_price_usd: number | string | null;
    depeg_peg_usd: number | string | null;
    depeg_tier_since_at: number | string | bigint | null;
    depeg_last_fetched_at: number | string | bigint | null;
    depeg_last_ok_at?: number | string | bigint | null;
    depeg_error_message: string | null;
    sh_ok: boolean | null;
    sh_composite_grade: string | null;
    sh_composite_score: number | string | null;
    sh_category_scores: unknown;
    sh_last_fetched_at: number | string | bigint | null;
    sh_last_ok_at?: number | string | bigint | null;
}

export interface StablecoinHealthReadsRepo {
    findLatestByMints(mints: readonly string[]): Promise<StablecoinHealthRow[]>;
}

export interface PegHealthRead {
    tier: PegTier;
    overallRisk: number | null;
    /** Signed percent from peg; negative = below peg. */
    deviationPct: number | null;
    priceUsd: number | null;
    pegUsd: number | null;
    /** Unix ms when the current tier streak began. */
    tierSince: number | null;
    /** Unix ms of the last SUCCESSFUL fetch (falls back to the last attempt for pre-last_ok_at rows). */
    updatedAt: number;
    /** False when the last fetch failed; the tier is then the last good value. */
    ok: boolean;
    errorMessage: string | null;
}

export interface StructuralHealthCategoryRead {
    key: StructuralCategoryKey;
    score: number | null;
    /** 0-1 weight in the composite. */
    weight: number | null;
    status: StructuralCategoryStatus;
}

export interface StructuralHealthRead {
    grade: StructuralGrade;
    /** Composite 0-100; higher = riskier. */
    score: number | null;
    categories: StructuralHealthCategoryRead[];
    /** Unix ms of the last SUCCESSFUL fetch (falls back to the last attempt for pre-last_ok_at rows). */
    updatedAt: number;
    ok: boolean;
}

export interface StablecoinHealthEntry {
    mint: string;
    pegHealth: PegHealthRead | null;
    structuralHealth: StructuralHealthRead | null;
}

function toEpochMs(value: number | string | bigint | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value: number | string | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `category_scores` is `{ [key]: { score, weight, status } }` as written by the
 * structural-health job. Unknown keys are dropped, missing keys are emitted with
 * nulls and `unknown` status so the UI always has the five rows.
 */
export function parseCategoryScores(value: unknown): StructuralHealthCategoryRead[] {
    const record =
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    return STRUCTURAL_CATEGORY_KEYS.map(key => {
        const raw = record[key];
        const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
        const score = toFiniteNumber(entry.score as number | string | null | undefined);
        const weight = toFiniteNumber(entry.weight as number | string | null | undefined);
        const status: StructuralCategoryStatus = isStructuralCategoryStatus(entry.status) ? entry.status : 'unknown';
        return { key, score, weight, status };
    });
}

export function toPegHealthRead(row: StablecoinHealthRow): PegHealthRead | null {
    if (!isPegTier(row.depeg_tier)) return null;
    const updatedAt = toEpochMs(row.depeg_last_ok_at) ?? toEpochMs(row.depeg_last_fetched_at);
    if (updatedAt === null) return null;
    return {
        tier: row.depeg_tier,
        overallRisk: toFiniteNumber(row.depeg_overall_risk),
        deviationPct: toFiniteNumber(row.depeg_deviation_pct),
        priceUsd: toFiniteNumber(row.depeg_price_usd),
        pegUsd: toFiniteNumber(row.depeg_peg_usd),
        tierSince: toEpochMs(row.depeg_tier_since_at),
        updatedAt,
        ok: row.depeg_ok !== false,
        errorMessage: row.depeg_ok === false ? (row.depeg_error_message ?? null) : null,
    };
}

export function toStructuralHealthRead(row: StablecoinHealthRow): StructuralHealthRead | null {
    if (!isStructuralGrade(row.sh_composite_grade)) return null;
    const updatedAt = toEpochMs(row.sh_last_ok_at) ?? toEpochMs(row.sh_last_fetched_at);
    if (updatedAt === null) return null;
    return {
        grade: row.sh_composite_grade,
        score: toFiniteNumber(row.sh_composite_score),
        categories: parseCategoryScores(row.sh_category_scores),
        updatedAt,
        ok: row.sh_ok !== false,
    };
}

function readMints(args: unknown): string[] {
    if (!args || typeof args !== 'object') throw new InvalidArgsError('args must be an object');
    const raw = (args as Record<string, unknown>).mints;
    if (!Array.isArray(raw)) throw new InvalidArgsError('mints must be an array of strings');
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (typeof item !== 'string') throw new InvalidArgsError('mints must be an array of strings');
        const mint = item.trim();
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        out.push(mint);
    }
    if (out.length > STABLECOIN_HEALTH_MAX_MINTS) {
        throw new InvalidArgsError(`mints must contain at most ${STABLECOIN_HEALTH_MAX_MINTS} entries`);
    }
    return out;
}

/** One entry per requested mint, in input order; both blocks null when unmonitored. */
export async function stablecoinHealthGetByMints(
    repo: StablecoinHealthReadsRepo,
    args: unknown,
): Promise<StablecoinHealthEntry[]> {
    const mints = readMints(args);
    if (mints.length === 0) return [];
    const rows = await repo.findLatestByMints(mints);
    const byMint = new Map<string, StablecoinHealthRow>();
    for (const row of rows) byMint.set(row.mint, row);
    return mints.map(mint => {
        const row = byMint.get(mint);
        if (!row) return { mint, pegHealth: null, structuralHealth: null };
        return { mint, pegHealth: toPegHealthRead(row), structuralHealth: toStructuralHealthRead(row) };
    });
}
