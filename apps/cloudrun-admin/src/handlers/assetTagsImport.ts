/**
 * Bulk import of admin-curated `assets.region` / `assets.industry` tags
 * (migration 0032).
 *
 * `previewAssetTagsImport` (query) and `applyAssetTagsImport` (mutation) share
 * one planner: resolve each requested id to a current asset (directly, or
 * through the former-id alias an admin rename leaves behind), then decide per
 * row whether to write. Rows default to the bundled `ASSET_TAGS_INITIAL`
 * dataset; callers may pass their own `rows` for a later re-tagging.
 *
 * Modes:
 * - `fill_empty` (default): only write assets with neither tag set, so a
 *   re-run never clobbers a later hand edit in the edit dialog.
 * - `overwrite`: write every matched row whose tags differ.
 *
 * Every write also sets `admin_edited_at`, matching the edit dialog.
 */

import { isAssetIndustry, isAssetRegion, type AssetIndustry, type AssetRegion } from '@tokens/asset-registry';

import { ASSET_TAGS_INITIAL } from '../data/asset-tags-initial';
import { InvalidArgsError } from './errors';
import { asArgsObject, optionalEnum, uniqueStrings } from './shared';
import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import type { CallerIdentity } from '../server';

export const ASSET_TAGS_IMPORT_MODES = ['fill_empty', 'overwrite'] as const;
export type AssetTagsImportMode = (typeof ASSET_TAGS_IMPORT_MODES)[number];

export interface AssetTagsImportRow {
    assetId: string;
    region: AssetRegion;
    industry: AssetIndustry;
}

/** Current asset an import row resolved to. */
export interface ResolvedAssetTags {
    assetId: string;
    region: string | null;
    industry: string | null;
}

export interface AssetTagsImportRepo {
    /**
     * Map each requested id (as given, trimmed) to the current asset it resolves
     * to: an exact `asset_id` match (case-insensitive) or an `assetId`-kind
     * alias left by an admin rename. Unresolved ids are absent from the map.
     */
    resolveAssets(requestedIds: readonly string[]): Promise<Map<string, ResolvedAssetTags>>;
    /** Apply the writes in one transaction; returns the number of rows updated. */
    applyTags(rows: readonly AssetTagsImportRow[], nowMs: number): Promise<number>;
    /** Asset ids on the curated `stocks` list that still have neither tag. */
    listUntaggedStockAssetIds(): Promise<string[]>;
}

export interface AssetTagsImportDeps {
    repo: AssetTagsImportRepo;
    adminAllowlist: AdminAllowlist;
    now?: () => number;
}

export interface AssetTagsImportPlan {
    mode: AssetTagsImportMode;
    /** Rows that will be (or were) written, under their current asset id. */
    toApply: AssetTagsImportRow[];
    /** Matched assets left alone because they already carry a tag (`fill_empty` only). */
    skippedAlreadyTagged: string[];
    /** Matched assets whose stored tags already equal the requested ones. */
    unchanged: string[];
    /** Requested ids that resolve to no current asset. */
    unmatched: string[];
    /** Requested ids that were renamed; the write targets the current id. */
    renamed: Array<{ requested: string; assetId: string }>;
}

export interface AssetTagsImportPreviewResult extends AssetTagsImportPlan {
    requested: number;
    /** Curated stocks still untagged *after* this plan would run. */
    untaggedStocks: string[];
}

export interface AssetTagsImportApplyResult extends AssetTagsImportPreviewResult {
    applied: number;
}

export function defaultAssetTagsImportRows(): AssetTagsImportRow[] {
    return Object.entries(ASSET_TAGS_INITIAL).map(([assetId, row]) => ({
        assetId,
        region: row.region,
        industry: row.industry,
    }));
}

function parseRows(obj: Record<string, unknown>): AssetTagsImportRow[] {
    const raw = obj.rows;
    if (raw === undefined) return defaultAssetTagsImportRows();
    if (!Array.isArray(raw)) throw new InvalidArgsError('rows must be an array');
    if (raw.length === 0) throw new InvalidArgsError('rows must not be empty');
    const out: AssetTagsImportRow[] = [];
    const seen = new Set<string>();
    raw.forEach((entry, index) => {
        if (typeof entry !== 'object' || entry === null) {
            throw new InvalidArgsError(`rows[${index}] must be an object`);
        }
        const row = entry as Record<string, unknown>;
        const assetId = typeof row.assetId === 'string' ? row.assetId.trim() : '';
        if (!assetId) throw new InvalidArgsError(`rows[${index}].assetId is required`);
        if (!isAssetRegion(row.region))
            throw new InvalidArgsError(`rows[${index}].region must be a valid asset region`);
        if (!isAssetIndustry(row.industry)) {
            throw new InvalidArgsError(`rows[${index}].industry must be a valid asset industry`);
        }
        const key = assetId.toLowerCase();
        if (seen.has(key)) throw new InvalidArgsError(`rows[${index}].assetId duplicates an earlier row (${assetId})`);
        seen.add(key);
        out.push({ assetId, region: row.region, industry: row.industry });
    });
    return out;
}

function parseArgs(args: unknown): { rows: AssetTagsImportRow[]; mode: AssetTagsImportMode } {
    const obj = asArgsObject(args);
    const mode = optionalEnum(obj, 'mode', ASSET_TAGS_IMPORT_MODES) ?? 'fill_empty';
    return { rows: parseRows(obj), mode };
}

export async function planAssetTagsImport(
    repo: AssetTagsImportRepo,
    rows: readonly AssetTagsImportRow[],
    mode: AssetTagsImportMode,
): Promise<AssetTagsImportPlan> {
    const resolved = await repo.resolveAssets(rows.map(row => row.assetId));
    const plan: AssetTagsImportPlan = {
        mode,
        toApply: [],
        skippedAlreadyTagged: [],
        unchanged: [],
        unmatched: [],
        renamed: [],
    };
    const targeted = new Set<string>();
    for (const row of rows) {
        const current = resolved.get(row.assetId);
        if (!current) {
            plan.unmatched.push(row.assetId);
            continue;
        }
        if (current.assetId !== row.assetId) plan.renamed.push({ requested: row.assetId, assetId: current.assetId });
        // Two requested ids (old + new) can resolve to the same asset; first wins.
        if (targeted.has(current.assetId)) continue;
        targeted.add(current.assetId);

        if (current.region === row.region && current.industry === row.industry) {
            plan.unchanged.push(current.assetId);
            continue;
        }
        if (mode === 'fill_empty' && (current.region !== null || current.industry !== null)) {
            plan.skippedAlreadyTagged.push(current.assetId);
            continue;
        }
        plan.toApply.push({ assetId: current.assetId, region: row.region, industry: row.industry });
    }
    return plan;
}

async function buildPreview(
    repo: AssetTagsImportRepo,
    rows: readonly AssetTagsImportRow[],
    plan: AssetTagsImportPlan,
): Promise<AssetTagsImportPreviewResult> {
    const willBeTagged = new Set(plan.toApply.map(row => row.assetId));
    const untagged = await repo.listUntaggedStockAssetIds();
    return {
        ...plan,
        requested: rows.length,
        untaggedStocks: uniqueStrings(untagged.filter(assetId => !willBeTagged.has(assetId))),
    };
}

export async function previewAssetTagsImport(
    deps: AssetTagsImportDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<AssetTagsImportPreviewResult> {
    requireAdmin(deps.adminAllowlist, identity);
    const { rows, mode } = parseArgs(args);
    const plan = await planAssetTagsImport(deps.repo, rows, mode);
    return buildPreview(deps.repo, rows, plan);
}

export async function applyAssetTagsImport(
    deps: AssetTagsImportDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<AssetTagsImportApplyResult> {
    requireAdmin(deps.adminAllowlist, identity);
    const { rows, mode } = parseArgs(args);
    const plan = await planAssetTagsImport(deps.repo, rows, mode);
    const applied =
        plan.toApply.length > 0 ? await deps.repo.applyTags(plan.toApply, deps.now ? deps.now() : Date.now()) : 0;
    const preview = await buildPreview(deps.repo, rows, plan);
    return { ...preview, applied };
}
