/**
 * `hardDeleteAsset` — port of the Convex mutation of the same name.
 *
 * Postgres does one transactional bulk cascade instead of Convex's budgeted
 * multi-call loop, so the response always carries `deleted: true` and
 * `pendingOhlcvDelete: false` (the admin dialog loops while `!deleted`).
 * Counter fields are identical to the Convex return validator.
 */

import { InvalidArgsError } from './errors';
import { asArgsObject, requireString, uniqueStrings } from './shared';
import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import type { CallerIdentity } from '../server';

export type TombstoneKind = 'assetId' | 'alias' | 'name' | 'symbol' | 'coingeckoId' | 'mint' | 'singletonAssetId';

export interface TombstoneRow {
    ref: string;
    normalizedRef: string;
    kind: TombstoneKind;
}

export interface DeletionRefSource {
    assetId: string;
    name: string | null;
    symbol: string | null;
    coingeckoId: string | null;
    /** `assets.aliases` jsonb column. */
    assetAliases: readonly string[];
    /** `asset_aliases.alias` values for the asset (all kinds). */
    aliasRowAliases: readonly string[];
    /** Unique variant mints. */
    mints: readonly string[];
}

/**
 * Mirrors Convex's ref list + per-ref kind classification, deduped on the
 * lowercase `normalizedRef` keeping the first occurrence (Convex inserted
 * serially and skipped refs whose normalized form already existed).
 */
export function buildDeletionTombstoneRows(source: DeletionRefSource): TombstoneRow[] {
    const name = source.name?.trim() || null;
    const symbol = source.symbol?.trim() || null;
    const coingeckoId = source.coingeckoId?.trim() || null;
    const mints = uniqueStrings(source.mints);

    const refs = uniqueStrings([
        source.assetId,
        ...source.assetAliases,
        ...(name ? [name] : []),
        ...(symbol ? [symbol] : []),
        ...(coingeckoId ? [coingeckoId] : []),
        ...source.aliasRowAliases,
        ...mints,
        ...mints.map(mint => `solana-${mint}`),
    ]);

    const rows: TombstoneRow[] = [];
    const seenNormalized = new Set<string>();
    for (const ref of refs) {
        const normalizedRef = ref.toLowerCase();
        if (seenNormalized.has(normalizedRef)) continue;
        seenNormalized.add(normalizedRef);

        let kind: TombstoneKind = 'alias';
        if (ref === source.assetId) kind = 'assetId';
        else if (coingeckoId && ref === coingeckoId) kind = 'coingeckoId';
        else if (name && ref === name) kind = 'name';
        else if (symbol && ref === symbol) kind = 'symbol';
        else if (mints.includes(ref)) kind = 'mint';
        else if (ref.startsWith('solana-')) kind = 'singletonAssetId';

        rows.push({ ref, normalizedRef, kind });
    }
    return rows;
}

export interface HardDeleteCounters {
    membershipsDeleted: number;
    aliasesDeleted: number;
    variantsDeleted: number;
    /** v2_asset_variants rows removed (all chains and origins). */
    v2VariantsDeleted: number;
    variantMarketsDeleted: number;
    tokenMarketsDeleted: number;
    tokenDocsDeleted: number;
    tokenDescriptionSummariesDeleted: number;
    assetRiskDeleted: number;
    ohlcvDeleted: number;
    webacyDeleted: number;
    rwaTokenCacheDeleted: number;
    rwaAssetCacheDeleted: number;
    assetMarketDeleted: number;
    coingeckoPricesDeleted: number;
    coingeckoTickersDeleted: number;
    coingeckoOhlcvDeleted: number;
    tombstonesCreated: number;
}

export interface HardDeleteRepo {
    /** Single transaction; returns null when the asset does not exist. */
    hardDeleteAsset(args: { assetId: string; nowMs: number }): Promise<HardDeleteCounters | null>;
}

export interface HardDeleteDeps {
    repo: HardDeleteRepo;
    adminAllowlist: AdminAllowlist;
    now?: () => number;
}

export interface HardDeleteResult extends HardDeleteCounters {
    deleted: boolean;
    assetId: string;
    pendingOhlcvDelete: boolean;
}

export async function hardDeleteAsset(
    deps: HardDeleteDeps,
    args: unknown,
    identity: CallerIdentity | null,
): Promise<HardDeleteResult> {
    requireAdmin(deps.adminAllowlist, identity);
    const obj = asArgsObject(args);
    const assetId = requireString(obj, 'assetId').trim();
    if (!assetId) throw new InvalidArgsError('assetId is required');

    const counters = await deps.repo.hardDeleteAsset({ assetId, nowMs: deps.now ? deps.now() : Date.now() });
    if (!counters) throw new InvalidArgsError('Asset not found');

    return {
        deleted: true,
        assetId,
        membershipsDeleted: counters.membershipsDeleted,
        aliasesDeleted: counters.aliasesDeleted,
        variantsDeleted: counters.variantsDeleted,
        v2VariantsDeleted: counters.v2VariantsDeleted,
        variantMarketsDeleted: counters.variantMarketsDeleted,
        tokenMarketsDeleted: counters.tokenMarketsDeleted,
        tokenDocsDeleted: counters.tokenDocsDeleted,
        tokenDescriptionSummariesDeleted: counters.tokenDescriptionSummariesDeleted,
        assetRiskDeleted: counters.assetRiskDeleted,
        ohlcvDeleted: counters.ohlcvDeleted,
        webacyDeleted: counters.webacyDeleted,
        rwaTokenCacheDeleted: counters.rwaTokenCacheDeleted,
        rwaAssetCacheDeleted: counters.rwaAssetCacheDeleted,
        assetMarketDeleted: counters.assetMarketDeleted,
        coingeckoPricesDeleted: counters.coingeckoPricesDeleted,
        coingeckoTickersDeleted: counters.coingeckoTickersDeleted,
        coingeckoOhlcvDeleted: counters.coingeckoOhlcvDeleted,
        tombstonesCreated: counters.tombstonesCreated,
        pendingOhlcvDelete: false,
    };
}
