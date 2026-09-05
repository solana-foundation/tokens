/**
 * Composite prefetch for /api/v1/assets/curated.
 *
 * Runs all the reads that route.ts would otherwise fire sequentially over
 * Vercel→Cloud Run HTTP into a single in-process fan-out. The route keeps
 * its existing assembly logic and just consumes the fields returned here in
 * lieu of doing its own per-step calls — so the response shape is preserved
 * by construction.
 *
 * Three phases, all entirely in-process:
 *   1. Collection membership + sanctum active list (needed to derive the
 *      universe of assetIds / mints).
 *   2. Everything that depends on that universe, in parallel:
 *      - assets rows              (getByAssetIds)
 *      - variants                 (assetVariantsListByAssetIds)
 *      - variant markets          (variantMarketsGetLatestByMints)
 *      - fill quality             (variantFillQualityGetLatestByMints)
 *      - asset aggregates         (assetMarketsGetLatestByAssetIds)
 *      - stock instruments/prices (stockInstruments / stockPrices)
 *      - deletion tombstones      (listDeletedRefs)
 *   3. Reads that depend on phase-2 output, in parallel:
 *      - coingecko latest prices  (coingeckoGetPriceLatestByCoinIds) —
 *        coinIds derived from phase-2 assets + caller-supplied additions
 *      - tokenMarkets latest      (tokenMarketsGetLatestByMints) — for
 *        mints where phase-2 variantMarkets returned nothing useful
 *
 * We do NOT compute the fully-hydrated response here — the registry merging,
 * canonical-stat selection, primary-variant selection, and image-URL
 * resolution still live in the apps/api route. Porting the ~800 lines of
 * downstream helpers would be a much larger change; the perf regression this
 * handler targets is round-trip latency, not aggregation cost.
 */

import { CURATED_LIST_ORDER, type CuratedListSlug } from '@tokens/asset-registry/curated-lists';

import { createConcurrencyLimiter } from '../concurrencyLimiter';
import { isTransientDatabaseError } from '../transientDb';
import { InvalidArgsError } from './assets';
import { getByAssetIds, type GetByAssetIdsEntry } from './assets';
import { getMembers } from './assetCollectionsReads';
import {
    listByAssetIds as assetVariantsListByAssetIds,
    type ListByAssetIdsEntry as VariantListEntry,
} from './assetVariants';
import {
    getLatestByMints as variantMarketsGetLatestByMints,
    type GetLatestByMintsEntry as VariantMarketEntry,
} from './variantMarkets';
import {
    getLatestByMints as fillQualityGetLatestByMints,
    type GetLatestByMintsEntry as FillQualityEntry,
} from './fillQualityReads';
import {
    getLatestByAssetIds as assetMarketsGetLatestByAssetIds,
    type GetLatestByAssetIdsEntry as AssetMarketEntry,
} from './assetMarkets';
import { listActive as sanctumListActive, type SanctumLstsRepo, type SanctumLstResult } from './sanctumLsts';
import { listDeletedRefs, type AssetDeletionTombstonesRepo } from './assetDeletionTombstones';
import {
    getInstrumentsByAssetIds as stockGetInstrumentsByAssetIds,
    getPriceLatestByAssetIds as stockGetPriceLatestByAssetIds,
    type StockReadsRepo,
    type GetInstrumentsByAssetIdsEntry,
    type GetPricesByAssetIdsEntry,
} from './stockReads';
import {
    getPriceLatestByCoinIds as coingeckoGetPriceLatestByCoinIds,
    type CoingeckoPriceBatchEntry,
    type CoingeckoReadsRepo,
} from './coingeckoReads';
import {
    getTokenMarketsLatestByMints,
    type GetTokenMarketsLatestByMintsEntry,
    type TokensReadsRepo,
} from './tokensReads';
import type { AssetsRepo } from './assets';
import type { AssetCollectionsReadsRepo } from './assetCollectionsReads';
import type { AssetVariantsRepo } from './assetVariants';
import type { VariantMarketsRepo } from './variantMarkets';
import type { FillQualityReadsRepo } from './fillQualityReads';
import type { AssetMarketsRepo } from './assetMarkets';

const KNOWN_LIST_IDS: readonly CuratedListSlug[] = CURATED_LIST_ORDER;

export interface CuratedPrefetchDeps {
    assetsRepo: AssetsRepo;
    assetCollectionsReadsRepo: AssetCollectionsReadsRepo;
    assetVariantsRepo: AssetVariantsRepo;
    variantMarketsRepo: VariantMarketsRepo;
    fillQualityReadsRepo: FillQualityReadsRepo;
    assetMarketsRepo: AssetMarketsRepo;
    sanctumLstsRepo: SanctumLstsRepo;
    deletionTombstonesRepo: AssetDeletionTombstonesRepo;
    stockReadsRepo: StockReadsRepo;
    coingeckoReadsRepo: CoingeckoReadsRepo;
    tokensReadsRepo: TokensReadsRepo;
}

export interface CuratedPrefetchResult {
    /** Collection member assetIds per list slug (order preserved for stable merging). */
    collectionAssetIds: string[][];
    /** Deleted asset refs (normalized lowercase) — used to filter membership. */
    deletedAssetRefs: string[];
    /** Sanctum active LST rows (empty unless list needs them). */
    sanctumLsts: SanctumLstResult[];
    /** The listId echoed back. */
    listId: string;
    /** Rows from the assets table for the deduped/filtered assetIds set. */
    assets: GetByAssetIdsEntry[];
    /** Variant rows grouped by assetId. */
    variants: VariantListEntry[];
    /** Latest variant_markets_latest rows per mint. */
    variantMarkets: VariantMarketEntry[];
    /** Latest variant_fill_quality_latest rows per mint. */
    fillQuality: FillQualityEntry[];
    /** Latest asset_markets_latest rows per assetId. */
    assetAggregates: AssetMarketEntry[];
    /** Latest stock_instruments_latest rows per equity assetId. */
    stockInstruments: GetInstrumentsByAssetIdsEntry[];
    /** Latest stock_prices_latest rows per equity assetId. */
    stockPrices: GetPricesByAssetIdsEntry[];
    /** Latest coingecko_prices_latest rows keyed by the requested coinId. */
    coingeckoPrices: CoingeckoPriceBatchEntry[];
    /**
     * Fallback DEX-market docs for mints whose variantMarkets row was missing
     * or thin — mirrors the route's `tokenMarketsGetLatestByMints` call.
     */
    tokenMarketsDocs: GetTokenMarketsLatestByMintsEntry[];
}

export interface CuratedPrefetchArgs {
    /**
     * The list to prefetch. `all` fans out across CURATED_LIST_ORDER; a
     * specific slug (e.g. `majors`) fetches only that list's members.
     */
    listId: string;
    /**
     * Universe of mints derived by the caller from the static registry
     * (`getEffectiveCuratedAddresses`). Cloud Run isn't the source of truth
     * for these — the registry is a compiled artifact shared with the FE.
     */
    memberMints: string[];
    /** AssetIds derived from those mints (via registry lookups on the caller). */
    memberAssetIds: string[];
    /** Whether to load sanctum active list (only needed for `all` and `lsts`). */
    includeSanctum: boolean;
    /** Whether to load stock instrument/price rows (only when `equity` category is possible). */
    includeStock: boolean;
    /**
     * Registry-derived CoinGecko IDs that the caller wants prices for on top
     * of the ones present on Convex asset rows (route.ts merges the registry
     * with Convex assets, so it knows about IDs the server doesn't). Passed
     * pre-normalized (`normalizeCoinGeckoCoinIdForAsset` applied on the
     * caller side). The composite still applies its own back-compat and
     * de-dup pass.
     */
    additionalCoingeckoIds?: string[];
}

/**
 * Port of apps/api's normalizeCoinGeckoCoinIdForAsset — kept in sync with
 * the caller so composite-driven and per-call paths agree on which coin
 * IDs to fetch. Applied to every candidate coin id before batching.
 */
function normalizeCoinGeckoCoinIdForAsset(params: {
    assetId: string;
    coinId: string | null | undefined;
}): string | null {
    const rawCoinId = (params.coinId ?? '').trim();
    if (!rawCoinId) return null;
    const assetId = params.assetId.trim();
    if (assetId === 'bnb' && rawCoinId === 'bnb') return 'binancecoin';
    if (assetId === 'tron' && rawCoinId === 'tron-xstock') return 'tron';
    if (assetId === 'spacex' && rawCoinId === 'spacex-prestocks-2') return null;
    return rawCoinId;
}

/**
 * Port of apps/api's missingScoreForMint (curated variant). Callers use it
 * to pick which mints deserve a DEX-market fallback. Kept in sync with the
 * route's heuristic so the two paths agree on the same "missing" set.
 */
function missingScoreForMintCurated(entry: VariantMarketEntry | undefined): number {
    if (!entry || !entry.market) return 1_000;
    const market = entry.market;
    let score = 0;
    if (!market.symbol || !market.symbol.trim()) score += 250;
    if (!market.name || !market.name.trim()) score += 250;
    if (market.decimals == null || !Number.isFinite(market.decimals) || market.decimals <= 0) score += 250;
    if (!market.logoURI || !market.logoURI.trim()) score += 150;
    if (market.price == null || market.price <= 0) score += 75;
    if (market.liquidity == null || market.liquidity <= 0) score += 50;
    if (market.volume24hUSD == null || market.volume24hUSD <= 0) score += 25;
    return score;
}

function asObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
        throw new InvalidArgsError('args must be an object');
    }
    return value as Record<string, unknown>;
}

function readString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') {
        throw new InvalidArgsError(`${key} must be a string`);
    }
    return value;
}

function readOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new InvalidArgsError(`${key} must be a boolean`);
    return value;
}

function readStringArray(args: Record<string, unknown>, key: string): string[] {
    const value = args[key];
    if (!Array.isArray(value)) throw new InvalidArgsError(`${key} must be an array of strings`);
    for (const item of value) {
        if (typeof item !== 'string') throw new InvalidArgsError(`${key} must be an array of strings`);
    }
    return value as string[];
}

function uniqueStrings(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function normalizeRef(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Chunk helper — deletion refs are checked up to 500 at a time to match
 * the underlying handler's cap.
 */
function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
    if (chunkSize <= 0) return [items.slice()];
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
    return chunks;
}

/** Preserve existing best-effort reads without hiding transport failures from last-good fallback. */
function recoverOptional<T>(fallback: T): (error: unknown) => T {
    return error => {
        if (isTransientDatabaseError(error)) throw error;
        return fallback;
    };
}

export async function assetsApiCuratedPrefetchForApi(
    deps: CuratedPrefetchDeps,
    args: unknown,
): Promise<CuratedPrefetchResult> {
    // Keep one broad request from monopolizing the process-wide postgres pool.
    // This limiter is shared by every phase and every chunk in this request.
    const runDb = createConcurrencyLimiter(4);
    const a = asObject(args);
    const listId = readString(a, 'listId').trim();
    const memberMints = readStringArray(a, 'memberMints');
    const memberAssetIds = readStringArray(a, 'memberAssetIds');
    const includeSanctum = readOptionalBoolean(a, 'includeSanctum') ?? false;
    const includeStock = readOptionalBoolean(a, 'includeStock') ?? true;
    const additionalCoingeckoIdsRaw = a.additionalCoingeckoIds;
    let additionalCoingeckoIds: string[] = [];
    if (additionalCoingeckoIdsRaw !== undefined) {
        if (!Array.isArray(additionalCoingeckoIdsRaw)) {
            throw new InvalidArgsError('additionalCoingeckoIds must be an array of strings');
        }
        for (const item of additionalCoingeckoIdsRaw) {
            if (typeof item !== 'string') {
                throw new InvalidArgsError('additionalCoingeckoIds must be an array of strings');
            }
        }
        additionalCoingeckoIds = additionalCoingeckoIdsRaw as string[];
    }

    const memberListIds: string[] = listId === 'all' ? [...KNOWN_LIST_IDS] : [listId];

    // Phase 1: collection membership + sanctum (parallel).
    const [collectionAssetIds, sanctumLsts] = await Promise.all([
        Promise.all(
            memberListIds.map(slug =>
                runDb(() =>
                    getMembers(deps.assetCollectionsReadsRepo, {
                        slug,
                        limit: 2000,
                    }),
                ),
            ),
        ),
        includeSanctum
            ? runDb(() => sanctumListActive(deps.sanctumLstsRepo, { limit: 5000 })).catch(
                  recoverOptional<SanctumLstResult[]>([]),
              )
            : Promise.resolve<SanctumLstResult[]>([]),
    ]);

    const rawAssetIds = uniqueStrings([...memberAssetIds, ...collectionAssetIds.flat()]);

    // Tombstone lookup (parallel chunks) — we still filter here so downstream
    // fetches don't waste rows on refs that were tombstoned.
    const deletedRefRows =
        rawAssetIds.length > 0
            ? (
                  await Promise.all(
                      chunkArray(rawAssetIds, 500).map(chunk =>
                          runDb(() =>
                              listDeletedRefs(deps.deletionTombstonesRepo, {
                                  refs: chunk,
                              }),
                          ).catch(recoverOptional<string[]>([])),
                      ),
                  )
              ).flat()
            : [];
    const deletedRefSet = new Set(deletedRefRows.map(normalizeRef));
    const filteredAssetIds = rawAssetIds.filter(id => !deletedRefSet.has(normalizeRef(id)));

    // Universe of mints from BOTH the caller's registry-derived mint list AND
    // whatever variants Cloud Run knows about for filtered assets (needed for
    // markets/fillQuality — the route re-derives mints post-fetch).
    // We cover the caller's known mints eagerly; route.ts will still find
    // additional mints from the variants payload we return.
    const knownMints = uniqueStrings(memberMints);

    // Phase 2: all remaining reads in parallel. Each is chunked to respect
    // the underlying handler caps (assetIds=500, mints=250).
    const chunkedAssetIds = chunkArray(filteredAssetIds, 500);
    const chunkedMints = chunkArray(knownMints, 250);
    const stockAssetIds = includeStock ? filteredAssetIds : [];
    const chunkedStockAssetIds = chunkArray(stockAssetIds, 500);

    const [
        assetsChunks,
        variantsChunks,
        variantMarketsChunks,
        fillQualityChunks,
        aggregatesChunks,
        stockInstrumentsChunks,
        stockPricesChunks,
    ] = await Promise.all([
        Promise.all(chunkedAssetIds.map(chunk => runDb(() => getByAssetIds(deps.assetsRepo, { assetIds: chunk })))),
        Promise.all(
            chunkArray(filteredAssetIds, 250).map(chunk =>
                runDb(() =>
                    assetVariantsListByAssetIds(deps.assetVariantsRepo, {
                        assetIds: chunk,
                    }),
                ),
            ),
        ),
        Promise.all(
            chunkedMints.map(chunk =>
                runDb(() =>
                    variantMarketsGetLatestByMints(deps.variantMarketsRepo, {
                        mints: chunk,
                    }),
                ),
            ),
        ),
        Promise.all(
            chunkedMints.map(chunk =>
                runDb(() =>
                    fillQualityGetLatestByMints(deps.fillQualityReadsRepo, {
                        mints: chunk,
                    }),
                ).catch(recoverOptional<FillQualityEntry[]>([])),
            ),
        ),
        Promise.all(
            chunkedAssetIds.map(chunk =>
                runDb(() =>
                    assetMarketsGetLatestByAssetIds(deps.assetMarketsRepo, {
                        assetIds: chunk,
                    }),
                ),
            ),
        ),
        includeStock
            ? Promise.all(
                  chunkedStockAssetIds.map(chunk =>
                      runDb(() =>
                          stockGetInstrumentsByAssetIds(deps.stockReadsRepo, {
                              assetIds: chunk,
                          }),
                      ).catch(recoverOptional<GetInstrumentsByAssetIdsEntry[]>([])),
                  ),
              )
            : Promise.resolve<GetInstrumentsByAssetIdsEntry[][]>([]),
        includeStock
            ? Promise.all(
                  chunkedStockAssetIds.map(chunk =>
                      runDb(() =>
                          stockGetPriceLatestByAssetIds(deps.stockReadsRepo, {
                              assetIds: chunk,
                          }),
                      ).catch(recoverOptional<GetPricesByAssetIdsEntry[]>([])),
                  ),
              )
            : Promise.resolve<GetPricesByAssetIdsEntry[][]>([]),
    ]);

    const assets = assetsChunks.flat();
    const variantMarkets = variantMarketsChunks.flat();

    // Phase 3: reads that depend on phase-2 output — in parallel.
    //
    // 3a. Latest CoinGecko prices for every coinId either (a) referenced by a
    //     Convex asset row, or (b) passed in by the caller from its
    //     registry-side normalization pass. Same coin ID cap (50 per call) as
    //     the underlying handler; we chunk to be safe.
    const rawCoingeckoCoinIds: string[] = [];
    for (const entry of assets) {
        if (!entry.asset) continue;
        const normalized = normalizeCoinGeckoCoinIdForAsset({
            assetId: entry.assetId,
            coinId: entry.asset.coingeckoId ?? null,
        });
        if (normalized) rawCoingeckoCoinIds.push(normalized);
    }
    for (const coinId of additionalCoingeckoIds) {
        const normalized = normalizeCoinGeckoCoinIdForAsset({
            assetId: coinId,
            coinId,
        });
        if (normalized) rawCoingeckoCoinIds.push(normalized);
    }
    const coingeckoCoinIds = uniqueStrings(rawCoingeckoCoinIds);

    // 3b. DEX-market fallback docs for the "missing" mints — mirrors the
    //     route's `tokenMarketsGetLatestByMints({ mints: uniqueMissing })` call
    //     using the same scoring heuristic so both paths agree on the set.
    const variantMarketByMint = new Map<string, VariantMarketEntry>();
    for (const entry of variantMarkets) variantMarketByMint.set(entry.mint, entry);
    const scoredMints = knownMints
        .map(mint => ({
            mint,
            score: missingScoreForMintCurated(variantMarketByMint.get(mint)),
        }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 25)
        .map(entry => entry.mint);

    const [coingeckoPricesChunks, tokenMarketsDocs] = await Promise.all([
        coingeckoCoinIds.length > 0
            ? Promise.all(
                  chunkArray(coingeckoCoinIds, 50).map(chunk =>
                      runDb(() => coingeckoGetPriceLatestByCoinIds(deps.coingeckoReadsRepo, { coinIds: chunk })).catch(
                          recoverOptional<CoingeckoPriceBatchEntry[]>([]),
                      ),
                  ),
              )
            : Promise.resolve<CoingeckoPriceBatchEntry[][]>([]),
        scoredMints.length > 0
            ? runDb(() =>
                  getTokenMarketsLatestByMints(deps.tokensReadsRepo, {
                      mints: scoredMints,
                  }),
              ).catch(recoverOptional<GetTokenMarketsLatestByMintsEntry[]>([]))
            : Promise.resolve<GetTokenMarketsLatestByMintsEntry[]>([]),
    ]);

    return {
        listId,
        collectionAssetIds,
        deletedAssetRefs: Array.from(deletedRefSet),
        sanctumLsts,
        assets,
        variants: variantsChunks.flat(),
        variantMarkets,
        fillQuality: fillQualityChunks.flat(),
        assetAggregates: aggregatesChunks.flat(),
        stockInstruments: stockInstrumentsChunks.flat(),
        stockPrices: stockPricesChunks.flat(),
        coingeckoPrices: coingeckoPricesChunks.flat(),
        tokenMarketsDocs,
    };
}
