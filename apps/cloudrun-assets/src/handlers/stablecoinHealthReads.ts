/**
 * Read RPC for stablecoin health: the latest peg observation and
 * structural-health grade per mint, from `webacy_depeg_latest`,
 * `peg_guard_latest` (migration 0020) and `webacy_structural_health_latest`
 * (migration 0019). Written by the `reconcile-stablecoin-depeg` /
 * `refresh-peg-guard` / `refresh-stablecoin-structural-health` jobs; served to
 * apps/api which attaches it to risk payloads.
 *
 * Two observers can rate the same mint. Webacy wins while it covers the mint
 * (`ok`, a known tier, `last_ok_at` within `WEBACY_PEG_COVERAGE_MS`), else the
 * in-house peg guard row is served with `provider: 'tokens'`. The same rule
 * decides advisory ownership in the worker, so the page and the banner agree.
 *
 * Staleness is NOT decided here (the API applies its own bounds). Rows whose
 * last fetch failed still return their last good tier/grade so a transient
 * provider outage does not blank the UI; `ok` / `errorMessage` say so.
 */

import {
    STRUCTURAL_CATEGORY_KEYS,
    isPegReferenceKind,
    isPegTier,
    isStructuralCategoryStatus,
    isStructuralGrade,
    type PegProvider,
    type PegReferenceKind,
    type PegTier,
    type StructuralCategoryKey,
    type StructuralCategoryStatus,
    type StructuralGrade,
} from '@tokens/asset-registry';

import { InvalidArgsError } from './assets';

export const STABLECOIN_HEALTH_MAX_MINTS = 200;

/**
 * Webacy "covers" a mint while its last successful observation is younger
 * than this. Matches the Webacy reconciler's staleness bound and the API's
 * `PEG_STALE_AFTER_MS`; the peg guard job defines the same 9h constant.
 */
export const WEBACY_PEG_COVERAGE_MS = 9 * 60 * 60_000;

/**
 * One LEFT-JOINed row per requested mint; bigint columns may arrive as string
 * or bigint. `pg_*` columns come from `peg_guard_latest` and are absent on
 * pre-0020 builds of the SELECT; `pg_peg_currency` / `pg_reference_kind`
 * are absent on builds that predate peg guard phase 2.
 */
export interface StablecoinHealthRow {
    mint: string;
    depeg_ok: boolean | null;
    depeg_tier: string | null;
    /**
     * ISO 4217 code of the Webacy peg when a build exposes it (the stored
     * `payload_json` is text and is not parsed by the SELECT today).
     */
    depeg_peg_currency?: string | null;
    depeg_overall_risk: number | string | null;
    depeg_deviation_pct: number | string | null;
    depeg_price_usd: number | string | null;
    depeg_peg_usd: number | string | null;
    depeg_tier_since_at: number | string | bigint | null;
    depeg_last_fetched_at: number | string | bigint | null;
    depeg_last_ok_at?: number | string | bigint | null;
    depeg_error_message: string | null;
    pg_ok?: boolean | null;
    pg_tier?: string | null;
    pg_peg_currency?: string | null;
    pg_reference_kind?: string | null;
    pg_deviation_pct?: number | string | null;
    pg_price_usd?: number | string | null;
    pg_peg_usd?: number | string | null;
    pg_liquidity_usd?: number | string | null;
    pg_tier_since_at?: number | string | bigint | null;
    pg_last_fetched_at?: number | string | bigint | null;
    pg_last_ok_at?: number | string | bigint | null;
    pg_error_message?: string | null;
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
    /** `webacy` while Webacy covers the mint, else `tokens` (in-house peg guard). */
    provider: PegProvider;
    /** ISO 4217 code of the peg when known (USD, EUR, ...); null when the observer does not say. */
    pegCurrency: string | null;
    /**
     * What `pegUsd` was: a fixed 1.00, a CoinGecko-implied fiat rate (`fx`), or
     * the token's own high-water price (`high_water`, yield-bearing USD
     * variants). Webacy rows are always `fixed`; null only for peg guard rows
     * written before phase 2.
     */
    referenceKind: PegReferenceKind | null;
    tier: PegTier;
    /** Webacy 0-100 depeg risk; always null for the peg guard. */
    overallRisk: number | null;
    /** Signed percent from peg; negative = below peg. */
    deviationPct: number | null;
    priceUsd: number | null;
    pegUsd: number | null;
    /** DEX liquidity behind the price; only the peg guard reports it. */
    liquidityUsd: number | null;
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

/** Upper-cased ISO 4217 code, or null for blanks and non-strings. */
function toPegCurrency(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const code = value.trim().toUpperCase();
    return code.length > 0 ? code : null;
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

function toWebacyPegHealthRead(row: StablecoinHealthRow): PegHealthRead | null {
    if (!isPegTier(row.depeg_tier)) return null;
    const updatedAt = toEpochMs(row.depeg_last_ok_at) ?? toEpochMs(row.depeg_last_fetched_at);
    if (updatedAt === null) return null;
    return {
        provider: 'webacy',
        pegCurrency: toPegCurrency(row.depeg_peg_currency),
        // Webacy's monitor judges every mint against a fixed peg unit.
        referenceKind: 'fixed',
        tier: row.depeg_tier,
        overallRisk: toFiniteNumber(row.depeg_overall_risk),
        deviationPct: toFiniteNumber(row.depeg_deviation_pct),
        priceUsd: toFiniteNumber(row.depeg_price_usd),
        pegUsd: toFiniteNumber(row.depeg_peg_usd),
        liquidityUsd: null,
        tierSince: toEpochMs(row.depeg_tier_since_at),
        updatedAt,
        ok: row.depeg_ok !== false,
        errorMessage: row.depeg_ok === false ? (row.depeg_error_message ?? null) : null,
    };
}

function toPegGuardPegHealthRead(row: StablecoinHealthRow): PegHealthRead | null {
    if (!isPegTier(row.pg_tier)) return null;
    const updatedAt = toEpochMs(row.pg_last_ok_at) ?? toEpochMs(row.pg_last_fetched_at);
    if (updatedAt === null) return null;
    return {
        provider: 'tokens',
        pegCurrency: toPegCurrency(row.pg_peg_currency),
        referenceKind: isPegReferenceKind(row.pg_reference_kind) ? row.pg_reference_kind : null,
        tier: row.pg_tier,
        overallRisk: null,
        deviationPct: toFiniteNumber(row.pg_deviation_pct),
        priceUsd: toFiniteNumber(row.pg_price_usd),
        pegUsd: toFiniteNumber(row.pg_peg_usd),
        liquidityUsd: toFiniteNumber(row.pg_liquidity_usd),
        tierSince: toEpochMs(row.pg_tier_since_at),
        updatedAt,
        ok: row.pg_ok !== false,
        errorMessage: row.pg_ok === false ? (row.pg_error_message ?? null) : null,
    };
}

/**
 * Webacy owns the mint while its row is healthy, carries a known tier and its
 * last successful observation is within `WEBACY_PEG_COVERAGE_MS`. Same rule as
 * the peg guard job's `webacyCoversMint`.
 */
export function webacyCoversRow(row: StablecoinHealthRow, nowMs: number): boolean {
    if (row.depeg_ok === false || !isPegTier(row.depeg_tier)) return false;
    const lastOkAt = toEpochMs(row.depeg_last_ok_at) ?? toEpochMs(row.depeg_last_fetched_at);
    if (lastOkAt === null) return false;
    return nowMs - lastOkAt <= WEBACY_PEG_COVERAGE_MS;
}

/**
 * Webacy when it covers the mint; else the peg guard row when it has a tier;
 * else the (stale or failing) Webacy row so a last-good tier keeps rendering
 * with `ok: false` / `stale` rather than blanking the UI.
 */
export function toPegHealthRead(row: StablecoinHealthRow, nowMs: number = Date.now()): PegHealthRead | null {
    const webacy = toWebacyPegHealthRead(row);
    if (webacy && webacyCoversRow(row, nowMs)) return webacy;
    return toPegGuardPegHealthRead(row) ?? webacy;
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
    nowMs: number = Date.now(),
): Promise<StablecoinHealthEntry[]> {
    const mints = readMints(args);
    if (mints.length === 0) return [];
    const rows = await repo.findLatestByMints(mints);
    const byMint = new Map<string, StablecoinHealthRow>();
    for (const row of rows) byMint.set(row.mint, row);
    return mints.map(mint => {
        const row = byMint.get(mint);
        if (!row) return { mint, pegHealth: null, structuralHealth: null };
        return { mint, pegHealth: toPegHealthRead(row, nowMs), structuralHealth: toStructuralHealthRead(row) };
    });
}
