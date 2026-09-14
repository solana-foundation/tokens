/**
 * Pure normalisers for Webacy's depeg monitor (`/rwa`) and structural health
 * (`/v3/rwa`) payloads. Webacy's docs and live responses disagree on field
 * names, so these accept every documented spelling and return `null` rather
 * than guess. Tested in clients.test.ts.
 */

import {
    STRUCTURAL_CATEGORY_KEYS,
    isPegTier,
    isStructuralCategoryKey,
    isStructuralGrade,
    type PegTier,
    type StructuralCategoryKey,
    type StructuralCategoryStatus,
    type StructuralGrade,
} from '@tokens/asset-registry';

export interface WebacyDepegItem {
    address: string;
    symbol: string | null;
    tier: PegTier | null;
    overallRisk: number | null;
    /** Signed percent from peg; negative = below peg. */
    deviationPct: number | null;
    priceUsd: number | null;
    pegUsd: number | null;
    tags: string[];
    /** Original item, persisted as payload_json. */
    raw: unknown;
}

export interface NormalizedStructuralHealth {
    compositeGrade: StructuralGrade | null;
    compositeScore: number | null;
    categoryScores: Record<
        StructuralCategoryKey,
        { score: number | null; weight: number | null; status: StructuralCategoryStatus }
    >;
    failCount: number | null;
    warnCount: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
    for (const key of keys) {
        if (record[key] !== undefined && record[key] !== null) return record[key];
    }
    return undefined;
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item === 'string' && item.trim()) out.push(item.trim());
        else {
            const rec = asRecord(item);
            const name = rec ? nonEmptyString(rec.name ?? rec.tag ?? rec.key) : null;
            if (name) out.push(name);
        }
    }
    return out;
}

const PREMIUM_MARKERS = ['premium', 'above_peg', 'above-peg', 'abovepeg'];

/**
 * Webacy's tier bands over the 0-100 depeg score. `premium` is not a score
 * band: it is a tag meaning "trading above peg with no risk signals".
 */
export function tierFromOverallRisk(risk: number | null, tags: readonly string[]): PegTier | null {
    if (tags.some(tag => PREMIUM_MARKERS.includes(tag.trim().toLowerCase()))) return 'premium';
    if (risk === null || !Number.isFinite(risk)) return null;
    if (risk >= 70) return 'critical';
    if (risk >= 50) return 'warning';
    if (risk >= 25) return 'watch';
    return 'ok';
}

/** Unwraps `{ tokens: [...] }`, `{ items }`, `{ data }`, `{ data: { tokens } }` or a bare array. */
export function extractDepegListItems(payload: unknown): unknown[] {
    if (Array.isArray(payload)) return payload;
    const rec = asRecord(payload);
    if (!rec) return [];
    for (const key of ['tokens', 'items', 'data', 'results']) {
        const value = rec[key];
        if (Array.isArray(value)) return value;
        const nested = asRecord(value);
        if (nested) {
            const inner = extractDepegListItems(nested);
            if (inner.length > 0) return inner;
        }
    }
    return [];
}

export function normalizeDepegItem(raw: unknown): WebacyDepegItem | null {
    const rec = asRecord(raw);
    if (!rec) return null;
    // Single-token responses may wrap the item one level down.
    const item = asRecord(rec.token) ?? asRecord(rec.data) ?? rec;
    const address = nonEmptyString(firstDefined(item, ['address', 'token_address', 'tokenAddress', 'mint']));
    if (!address) return null;

    const metadata = asRecord(item.metadata);
    const risk = asRecord(item.risk) ?? asRecord(item.depeg) ?? item;
    const symbol =
        nonEmptyString(metadata ? firstDefined(metadata, ['symbol', 'ticker']) : undefined) ??
        nonEmptyString(firstDefined(item, ['symbol', 'ticker']));

    const overallRisk = finiteNumber(
        firstDefined(risk, ['overallRisk', 'overall_risk', 'score', 'depegScore', 'depeg_score']) ??
            firstDefined(item, ['overallRisk', 'overall_risk']),
    );
    const tags = [...stringList(risk.tags), ...(risk !== item ? stringList(item.tags) : [])];
    const explicitTier = nonEmptyString(firstDefined(risk, ['tier']) ?? firstDefined(item, ['tier']))?.toLowerCase();
    const tier = isPegTier(explicitTier) ? explicitTier : tierFromOverallRisk(overallRisk, tags);

    const numericSource = (keys: readonly string[]): number | null =>
        finiteNumber(
            firstDefined(risk, keys) ??
                firstDefined(item, keys) ??
                (metadata ? firstDefined(metadata, keys) : undefined),
        );
    const deviationPct = numericSource(['deviation_pct', 'deviationPct', 'peg_deviation_pct', 'pegDeviationPct']);
    const priceUsd = numericSource(['price_usd', 'priceUsd', 'price']);
    const pegUsd = numericSource(['peg_usd', 'pegUsd', 'peg', 'peg_price', 'pegPrice']);

    return { address, symbol, tier, overallRisk, deviationPct, priceUsd, pegUsd, tags, raw };
}

function categoryStatusFromCriteria(criteria: unknown): StructuralCategoryStatus {
    if (!Array.isArray(criteria) || criteria.length === 0) return 'unknown';
    let sawWarn = false;
    for (const criterion of criteria) {
        const rec = asRecord(criterion);
        const status = rec ? nonEmptyString(rec.status ?? rec.result)?.toLowerCase() : null;
        if (status === 'fail' || status === 'failed') return 'fail';
        if (status === 'warn' || status === 'warning') sawWarn = true;
    }
    return sawWarn ? 'warn' : 'pass';
}

function normalizeStatus(value: unknown, criteria: unknown): StructuralCategoryStatus {
    const text = nonEmptyString(value)?.toLowerCase();
    if (text === 'pass' || text === 'passed' || text === 'ok') return 'pass';
    if (text === 'warn' || text === 'warning') return 'warn';
    if (text === 'fail' || text === 'failed') return 'fail';
    return categoryStatusFromCriteria(criteria);
}

function normalizeWeight(value: unknown): number | null {
    const weight = finiteNumber(value);
    if (weight === null) return null;
    // Some payloads express weights as percentages (30), others as fractions (0.3).
    return weight > 1 ? weight / 100 : weight;
}

function normalizeCategoryKey(value: unknown): StructuralCategoryKey | null {
    const text = nonEmptyString(value);
    if (!text) return null;
    const key = text
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (isStructuralCategoryKey(key)) return key;
    // Loose aliases seen in docs; anything else is dropped rather than guessed.
    const aliases: Record<string, StructuralCategoryKey> = {
        asset_and_collateral: 'asset_collateral',
        collateral: 'asset_collateral',
        liquidity: 'market_liquidity',
        market_and_liquidity: 'market_liquidity',
        contract: 'smart_contract',
        smart_contracts: 'smart_contract',
        governance: 'operational_governance',
        operations_and_governance: 'operational_governance',
        operational_and_governance: 'operational_governance',
        hack_and_exploit_history: 'hack_exploit_history',
        exploit_history: 'hack_exploit_history',
    };
    return aliases[key] ?? null;
}

function emptyCategoryScores(): NormalizedStructuralHealth['categoryScores'] {
    const out = {} as NormalizedStructuralHealth['categoryScores'];
    for (const key of STRUCTURAL_CATEGORY_KEYS) out[key] = { score: null, weight: null, status: 'unknown' };
    return out;
}

export function normalizeStructuralHealth(raw: unknown): NormalizedStructuralHealth {
    const categoryScores = emptyCategoryScores();
    const rec = asRecord(raw);
    if (!rec) return { compositeGrade: null, compositeScore: null, categoryScores, failCount: null, warnCount: null };
    const body = asRecord(rec.data) ?? rec;
    const structural = asRecord(body.structural_health) ?? asRecord(body.structuralHealth) ?? body;
    const composite = asRecord(structural.composite) ?? structural;

    const gradeText = nonEmptyString(
        firstDefined(composite, ['composite_grade', 'compositeGrade', 'grade']) ??
            firstDefined(structural, ['composite_grade', 'compositeGrade', 'grade']),
    );
    const compositeGrade = isStructuralGrade(gradeText) ? gradeText : null;
    const compositeScore = finiteNumber(
        firstDefined(composite, ['composite_score', 'compositeScore', 'score']) ??
            firstDefined(structural, ['composite_score', 'compositeScore', 'score']),
    );

    const categoriesRaw = structural.categories ?? body.categories;
    const entries: Array<[unknown, Record<string, unknown>]> = [];
    if (Array.isArray(categoriesRaw)) {
        for (const item of categoriesRaw) {
            const catRec = asRecord(item);
            if (catRec) entries.push([catRec.key ?? catRec.name ?? catRec.category ?? catRec.id, catRec]);
        }
    } else {
        const catMap = asRecord(categoriesRaw);
        if (catMap) {
            for (const [key, value] of Object.entries(catMap)) {
                const catRec = asRecord(value);
                if (catRec) entries.push([key, catRec]);
            }
        }
    }

    let failCount: number | null = null;
    let warnCount: number | null = null;
    for (const [keyRaw, catRec] of entries) {
        const key = normalizeCategoryKey(keyRaw);
        if (!key) continue;
        const criteria = catRec.criteria ?? catRec.checks;
        categoryScores[key] = {
            score: finiteNumber(firstDefined(catRec, ['score', 'risk_score', 'riskScore'])),
            weight: normalizeWeight(firstDefined(catRec, ['weight', 'weight_pct', 'weightPct'])),
            status: normalizeStatus(catRec.status, criteria),
        };
        if (Array.isArray(criteria)) {
            for (const criterion of criteria) {
                const crit = asRecord(criterion);
                const status = crit ? nonEmptyString(crit.status ?? crit.result)?.toLowerCase() : null;
                if (status === 'fail' || status === 'failed') failCount = (failCount ?? 0) + 1;
                else if (status === 'warn' || status === 'warning') warnCount = (warnCount ?? 0) + 1;
                else if (status) {
                    failCount = failCount ?? 0;
                    warnCount = warnCount ?? 0;
                }
            }
        }
    }

    const summary = asRecord(structural.summary) ?? asRecord(body.summary);
    const explicitFail = finiteNumber(
        firstDefined(structural, ['criteria_fail_count', 'failCount', 'fail_count']) ??
            (summary ? firstDefined(summary, ['fail', 'failed', 'fail_count']) : undefined),
    );
    const explicitWarn = finiteNumber(
        firstDefined(structural, ['criteria_warn_count', 'warnCount', 'warn_count']) ??
            (summary ? firstDefined(summary, ['warn', 'warning', 'warn_count']) : undefined),
    );

    return {
        compositeGrade,
        compositeScore,
        categoryScores,
        failCount: explicitFail ?? failCount,
        warnCount: explicitWarn ?? warnCount,
    };
}
