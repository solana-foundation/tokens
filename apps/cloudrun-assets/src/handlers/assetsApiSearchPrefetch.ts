/**
 * Composite prefetch for /api/v1/assets/search.
 *
 * Runs the query-fanout reads the route would otherwise fire sequentially over
 * Vercel→Cloud Run HTTP into a single in-process fan-out. The route keeps
 * its existing assembly logic and just consumes the fields returned here in
 * lieu of doing its own per-step calls — so the response shape is preserved
 * by construction.
 *
 * Three phases, all entirely in-process:
 *   1. Sanctum resolve + tokens search (parallel — sanctum informs the
 *      effective query; tokens search is independent).
 *   2. Everything that depends on those results, in parallel:
 *      - asset search              (search with effectiveQuery)
 *      - variants by token mints   (assetVariantsListByMints)
 *      - extra asset docs          (getByAssetIds for canonical assetIds
 *        discovered via variantsByTokenMint or supplied by the caller from
 *        its registry match set)
 *   3. Batch reads keyed by the union of phase-2 universes and any
 *      registry-side hints the caller passes (`additionalAssetIds`,
 *      `additionalMints`, `additionalCoingeckoIds`), in parallel:
 *      - variant markets           (variantMarketsGetLatestByMints)
 *      - variant fill quality      (variantFillQualityGetLatestByMints)
 *      - asset aggregates          (assetMarketsGetLatestByAssetIds)
 *      - stock instruments/prices  (stockInstruments / stockPrices)
 *      - coingecko latest prices   (coingeckoGetPriceLatestByCoinIds)
 *      - tokenMarkets fallback     (tokenMarketsGetLatestByMints for mints
 *        whose variantMarkets row was thin/missing)
 *
 * We still do NOT compute the fully-hydrated response — registry merging,
 * canonical-stat selection, primary-variant selection, image-URL resolution,
 * and per-doc CoinGecko metadata backfill (`coingeckoGetCoinById`) stay in
 * apps/api. The perf regression this handler targets is round-trip latency,
 * not aggregation cost.
 */

import type { AssetCategory, AssetResult, AssetsRepo, GetByAssetIdsEntry } from './assets';
import { ASSET_CATEGORIES, InvalidArgsError } from './assets';
import { getByAssetIds, search as assetsSearch } from './assets';
import {
    listByAssetIds as assetVariantsListByAssetIds,
    listByMints as assetVariantsListByMints,
    type AssetVariantsRepo,
    type ListByAssetIdsEntry as VariantListEntry,
    type ListByMintsEntry as VariantByMintEntry,
} from './assetVariants';
import {
    resolveRef as sanctumResolveRef,
    type SanctumLstsRepo,
    type SanctumResolveRefResult,
} from './sanctumLsts';
import {
    getTokenMarketsLatestByMints,
    searchTokens as tokensSearchTokens,
    type GetTokenMarketsLatestByMintsEntry,
    type TokensReadsRepo,
    type TokenSearchToken,
} from './tokensReads';
import {
    getLatestByMints as variantMarketsGetLatestByMints,
    type GetLatestByMintsEntry as VariantMarketEntry,
    type VariantMarketsRepo,
} from './variantMarkets';
import {
    getLatestByMints as fillQualityGetLatestByMints,
    type FillQualityReadsRepo,
    type GetLatestByMintsEntry as FillQualityEntry,
} from './fillQualityReads';
import {
    getLatestByAssetIds as assetMarketsGetLatestByAssetIds,
    type AssetMarketsRepo,
    type GetLatestByAssetIdsEntry as AssetMarketEntry,
} from './assetMarkets';
import {
    getInstrumentsByAssetIds as stockGetInstrumentsByAssetIds,
    getPriceLatestByAssetIds as stockGetPriceLatestByAssetIds,
    type GetInstrumentsByAssetIdsEntry,
    type GetPricesByAssetIdsEntry,
    type StockReadsRepo,
} from './stockReads';
import {
    getPriceLatestByCoinIds as coingeckoGetPriceLatestByCoinIds,
    type CoingeckoPriceBatchEntry,
    type CoingeckoReadsRepo,
} from './coingeckoReads';

function isAssetCategory(value: unknown): value is AssetCategory {
    return typeof value === 'string' && (ASSET_CATEGORIES as readonly string[]).includes(value);
}

export interface SearchPrefetchDeps {
    assetsRepo: AssetsRepo;
    assetVariantsRepo: AssetVariantsRepo;
    sanctumLstsRepo: SanctumLstsRepo;
    tokensReadsRepo: TokensReadsRepo;
    variantMarketsRepo: VariantMarketsRepo;
    fillQualityReadsRepo: FillQualityReadsRepo;
    assetMarketsRepo: AssetMarketsRepo;
    stockReadsRepo: StockReadsRepo;
    coingeckoReadsRepo: CoingeckoReadsRepo;
}

export interface SearchPrefetchArgs {
    /** Raw user query (trimmed, non-empty required). */
    query: string;
    /** Optional category filter (constrains the assets search). */
    category?: AssetCategory;
    /** Cap for downstream results — the route uses `Math.min(limit * 2, 50)`. */
    searchLimit: number;
    /** Cap for the tokensSearchTokens call — same effective range as searchLimit. */
    tokensLimit: number;
    /** Only consider sanctum resolution when true (crypto or unspecified category). */
    includeSanctum: boolean;
    /** Only run tokens search when true (crypto or unspecified category). */
    includeTokensSearch: boolean;
    /**
     * Registry-derived assetIds the caller wants covered in the batch reads
     * (aggregates, stocks, variants) on top of whatever the assets search
     * returned. These come from the route's `registrySearchMatches` +
     * `getVariantByMint`-based singleton hydration paths, which the server
     * doesn't know about.
     */
    additionalAssetIds?: string[];
    /**
     * Registry-derived mints the caller wants covered in the batch reads
     * (variantMarkets, fillQuality, tokenMarkets fallback). Mirrors the
     * additional mint sources on the client (registry variants, token
     * singleton fallbacks not already in tokens/variantsByTokenMint).
     */
    additionalMints?: string[];
    /**
     * Registry-derived CoinGecko IDs the caller wants prices for. Same
     * pattern as `additionalAssetIds`: covers the tail from the registry
     * that the server can't see.
     */
    additionalCoingeckoIds?: string[];
    /**
     * Optional cap for the assetIds fed into the phase-3 batch reads. The
     * route effectively caps at ~limit + registrySearchMatches; passing
     * this in lets the server bound the fanout size.
     */
    combinedAssetIdsCap?: number;
}

export interface SearchPrefetchResult {
    /** Sanctum resolution for the query, if requested (null on miss or failure). */
    sanctumMatch: SanctumResolveRefResult | null;
    /** Effective query passed to the asset search after sanctum override. */
    effectiveAssetQuery: string;
    /** Rows from the assets search — mirrors `search` handler output. */
    assets: AssetResult[];
    /** Rows from tokens search — mirrors `tokensSearchTokens` handler output. */
    tokens: TokenSearchToken[];
    /** Variants by token mint — mirrors `assetVariantsListByMints` handler output. */
    variantsByTokenMint: VariantByMintEntry[];
    /**
     * Extra asset docs for canonical assetIds discovered via variantsByTokenMint
     * or supplied via `additionalAssetIds` and not already present in `assets`.
     * Mirrors per-doc `cloudRunGetByAssetId` output.
     */
    extraAssets: GetByAssetIdsEntry[];
    /** Variants keyed by assetId for the combined universe. */
    variantsByAssetId: VariantListEntry[];
    /** Latest variant_markets_latest rows per mint (combined universe). */
    variantMarkets: VariantMarketEntry[];
    /** Latest variant_fill_quality_latest rows per mint (combined universe). */
    fillQuality: FillQualityEntry[];
    /** Latest asset_markets_latest rows per assetId (combined universe). */
    assetAggregates: AssetMarketEntry[];
    /** Latest stock_instruments_latest rows for combined-universe equity assets. */
    stockInstruments: GetInstrumentsByAssetIdsEntry[];
    /** Latest stock_prices_latest rows for combined-universe equity assets. */
    stockPrices: GetPricesByAssetIdsEntry[];
    /** Latest coingecko_prices_latest rows for the requested coinIds. */
    coingeckoPrices: CoingeckoPriceBatchEntry[];
    /** DEX-market fallback docs for mints whose variantMarkets row was thin. */
    tokenMarketsDocs: GetTokenMarketsLatestByMintsEntry[];
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

function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} must be a string`);
    return value;
}

function readOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new InvalidArgsError(`${key} must be a boolean`);
    return value;
}

function readOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError(`${key} must be a finite number`);
    }
    return value;
}

function readOptionalStringArray(args: Record<string, unknown>, key: string): string[] {
    const value = args[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new InvalidArgsError(`${key} must be an array of strings`);
    }
    for (const item of value) {
        if (typeof item !== 'string') {
            throw new InvalidArgsError(`${key} must be an array of strings`);
        }
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

function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
    if (chunkSize <= 0) return [items.slice()];
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
    return chunks;
}

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/**
 * Port of apps/api's `normalizeCoinGeckoCoinIdForAsset` — kept in sync so the
 * composite and per-call paths agree on which coin IDs to fetch.
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
 * Mirrors the search route's `missingScoreForMint` — decides which mints
 * need a DEX-market fallback via `tokenMarketsGetLatestByMints`. Keep this
 * heuristic in sync with route.ts.
 */
function missingScoreForMintSearch(entry: VariantMarketEntry | undefined): number {
    if (!entry || !entry.market) return 1_000;
    const market = entry.market;
    let score = 0;
    if (!market.logoURI || !market.logoURI.trim()) score += 150;
    if (market.price == null || market.price <= 0) score += 75;
    if (market.liquidity == null || market.liquidity <= 0) score += 50;
    if (market.volume24hUSD == null || market.volume24hUSD <= 0) score += 25;
    return score;
}

export async function assetsApiSearchPrefetchForApi(
    deps: SearchPrefetchDeps,
    args: unknown,
): Promise<SearchPrefetchResult> {
    const a = asObject(args);
    const query = readString(a, 'query').trim();
    if (!query) {
        throw new InvalidArgsError('query must be a non-empty string');
    }
    const categoryRaw = readOptionalString(a, 'category');
    if (categoryRaw !== undefined && !isAssetCategory(categoryRaw)) {
        throw new InvalidArgsError('category must be a valid asset category');
    }
    const category = (categoryRaw ?? null) as AssetCategory | null;
    const searchLimit = readOptionalNumber(a, 'searchLimit') ?? 40;
    const tokensLimit = readOptionalNumber(a, 'tokensLimit') ?? 40;
    const includeSanctum = readOptionalBoolean(a, 'includeSanctum') ?? true;
    const includeTokensSearch = readOptionalBoolean(a, 'includeTokensSearch') ?? true;
    const additionalAssetIds = readOptionalStringArray(a, 'additionalAssetIds');
    const additionalMints = readOptionalStringArray(a, 'additionalMints');
    const additionalCoingeckoIds = readOptionalStringArray(a, 'additionalCoingeckoIds');
    const combinedAssetIdsCap = readOptionalNumber(a, 'combinedAssetIdsCap') ?? 250;

    // Phase 1: sanctum resolve + tokens search (parallel — independent).
    const [sanctumMatch, tokens] = await Promise.all([
        includeSanctum
            ? sanctumResolveRef(deps.sanctumLstsRepo, { ref: query }).catch(
                  (): SanctumResolveRefResult | null => null,
              )
            : Promise.resolve<SanctumResolveRefResult | null>(null),
        includeTokensSearch
            ? tokensSearchTokens(deps.tokensReadsRepo, { query, limit: tokensLimit }).catch(
                  (): TokenSearchToken[] => [],
              )
            : Promise.resolve<TokenSearchToken[]>([]),
    ]);

    const effectiveAssetQuery = sanctumMatch ? 'solana' : query;

    // Compute token mints for the variants lookup — matches the route logic.
    const tokenMints = tokens
        .map(t => t.address)
        .filter(looksLikeSolanaMintAddress)
        .slice(0, 250);

    // Phase 2: assets search (with effective query) + variants-by-token-mints
    // (parallel — depend only on Phase 1).
    const [assets, variantsByTokenMint] = await Promise.all([
        assetsSearch(deps.assetsRepo, {
            query: effectiveAssetQuery,
            ...(category ? { category } : {}),
            limit: searchLimit,
        }),
        tokenMints.length > 0
            ? assetVariantsListByMints(deps.assetVariantsRepo, { mints: tokenMints }).catch(
                  (): VariantByMintEntry[] => [],
              )
            : Promise.resolve<VariantByMintEntry[]>([]),
    ]);

    // Derive canonical assetIds surfaced by variantsByTokenMint but missing
    // from the initial search result — same shape as route.ts's
    // `missingCanonicalAssetIds` block that fires per-doc `getByAssetId` calls.
    const existingAssetIds = new Set<string>();
    for (const row of assets) existingAssetIds.add(row.assetId);
    const canonicalAssetIdsFromVariants: string[] = [];
    for (const row of variantsByTokenMint) {
        if (!row.variant) continue;
        if (looksLikeSolanaMintAddress(row.variant.assetId)) continue;
        canonicalAssetIdsFromVariants.push(row.variant.assetId);
    }
    const missingCanonicalAssetIds = uniqueStrings([
        ...canonicalAssetIdsFromVariants.filter(id => !existingAssetIds.has(id)),
        ...additionalAssetIds.filter(id => !existingAssetIds.has(id)),
    ]).slice(0, 100);

    // Phase 2b: batch-fetch the extras in one round-trip (max 500 per call).
    const extraAssets = missingCanonicalAssetIds.length > 0
        ? await getByAssetIds(deps.assetsRepo, { assetIds: missingCanonicalAssetIds }).catch(
              (): GetByAssetIdsEntry[] => [],
          )
        : [];

    // Build the combined universe. The route computes `combinedAssets` by
    // merging Convex search rows + registry-search matches + singletons, then
    // slices to `limit`. We can't know registry data server-side; we approximate
    // by unioning:
    //  - assetIds surfaced by the assets search (non-mint-shaped)
    //  - assetIds surfaced by variantsByTokenMint
    //  - additionalAssetIds passed by the caller (from registry-search)
    // then capping at combinedAssetIdsCap to bound fanout size.
    const combinedAssetIds = uniqueStrings(
        [
            ...assets.filter(a => !looksLikeSolanaMintAddress(a.assetId)).map(a => a.assetId),
            ...canonicalAssetIdsFromVariants,
            ...additionalAssetIds,
        ],
    ).slice(0, combinedAssetIdsCap);

    // Universe of mints for markets/fillQuality/tokenMarkets fallback.
    // Union of:
    //  - token search mints (already in variantsByTokenMint universe)
    //  - additionalMints supplied by caller (registry variants + tokenMatches
    //    that became singletons)
    const combinedMints = uniqueStrings([...tokenMints, ...additionalMints]);

    // Extra variants keyed by assetId — the route also needs
    // `assetVariantsListByAssetIds({ assetIds: firstPage })` for its
    // canonical merge; fold it in.
    const variantsByAssetIdPromise: Promise<VariantListEntry[]> =
        combinedAssetIds.length > 0
            ? assetVariantsListByAssetIds(deps.assetVariantsRepo, {
                  assetIds: combinedAssetIds,
              }).catch((): VariantListEntry[] => [])
            : Promise.resolve<VariantListEntry[]>([]);

    // Phase 3: batch reads over the combined universe, in parallel.
    const chunkedCombinedAssetIds = chunkArray(combinedAssetIds, 500);
    const chunkedMints = chunkArray(combinedMints, 250);
    const stockAssetIds = combinedAssetIds.slice(0, 500);

    // Coingecko coin IDs: from Convex assets (assets + extras) + additional.
    const rawCoingeckoCoinIds: string[] = [];
    for (const row of assets) {
        const normalized = normalizeCoinGeckoCoinIdForAsset({
            assetId: row.assetId,
            coinId: row.coingeckoId ?? null,
        });
        if (normalized) rawCoingeckoCoinIds.push(normalized);
    }
    for (const entry of extraAssets) {
        if (!entry.asset) continue;
        const normalized = normalizeCoinGeckoCoinIdForAsset({
            assetId: entry.assetId,
            coinId: entry.asset.coingeckoId ?? null,
        });
        if (normalized) rawCoingeckoCoinIds.push(normalized);
    }
    for (const coinId of additionalCoingeckoIds) {
        const normalized = normalizeCoinGeckoCoinIdForAsset({ assetId: coinId, coinId });
        if (normalized) rawCoingeckoCoinIds.push(normalized);
    }
    const coingeckoCoinIds = uniqueStrings(rawCoingeckoCoinIds);

    const [
        variantsByAssetId,
        variantMarketsChunks,
        fillQualityChunks,
        aggregatesChunks,
        stockInstruments,
        stockPrices,
        coingeckoPricesChunks,
    ] = await Promise.all([
        variantsByAssetIdPromise,
        Promise.all(
            chunkedMints.map(chunk =>
                variantMarketsGetLatestByMints(deps.variantMarketsRepo, { mints: chunk }).catch(
                    (): VariantMarketEntry[] => [],
                ),
            ),
        ),
        Promise.all(
            chunkedMints.map(chunk =>
                fillQualityGetLatestByMints(deps.fillQualityReadsRepo, { mints: chunk }).catch(
                    (): FillQualityEntry[] => [],
                ),
            ),
        ),
        Promise.all(
            chunkedCombinedAssetIds.map(chunk =>
                assetMarketsGetLatestByAssetIds(deps.assetMarketsRepo, { assetIds: chunk }).catch(
                    (): AssetMarketEntry[] => [],
                ),
            ),
        ),
        stockAssetIds.length > 0
            ? stockGetInstrumentsByAssetIds(deps.stockReadsRepo, { assetIds: stockAssetIds }).catch(
                  (): GetInstrumentsByAssetIdsEntry[] => [],
              )
            : Promise.resolve<GetInstrumentsByAssetIdsEntry[]>([]),
        stockAssetIds.length > 0
            ? stockGetPriceLatestByAssetIds(deps.stockReadsRepo, { assetIds: stockAssetIds }).catch(
                  (): GetPricesByAssetIdsEntry[] => [],
              )
            : Promise.resolve<GetPricesByAssetIdsEntry[]>([]),
        coingeckoCoinIds.length > 0
            ? Promise.all(
                  chunkArray(coingeckoCoinIds, 50).map(chunk =>
                      coingeckoGetPriceLatestByCoinIds(deps.coingeckoReadsRepo, { coinIds: chunk }).catch(
                          (): CoingeckoPriceBatchEntry[] => [],
                      ),
                  ),
              )
            : Promise.resolve<CoingeckoPriceBatchEntry[][]>([]),
    ]);

    const variantMarkets = variantMarketsChunks.flat();

    // DEX-market fallback: same scoring heuristic as the route so both paths
    // pick the same missing set. Scored over `combinedMints` ONLY — the
    // phase-3b variant-mint extras below must not widen this input, or the
    // server would pick a different top-25 than it does today.
    const variantMarketByMint = new Map<string, VariantMarketEntry>();
    for (const entry of variantMarkets) variantMarketByMint.set(entry.mint, entry);
    const scoredMints = combinedMints
        .map(mint => ({ mint, score: missingScoreForMintSearch(variantMarketByMint.get(mint)) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 25)
        .map(entry => entry.mint);

    // Phase 3b: the route builds its mint universe from every variant of the
    // combined assets (`variantsByAssetId`), not just `combinedMints`. Those
    // extra mints (e.g. `solana`'s ~1.5k LST variants) used to be gap-filled by
    // the route in serial 250-mint round-trips; cover them here instead, in
    // parallel, so the route's gap-fill finds nothing left to fetch. Rows are
    // appended to the same arrays, so the response shape is unchanged.
    const combinedMintSet = new Set(combinedMints);
    const extraMints = uniqueStrings(
        variantsByAssetId.flatMap(entry => entry.variants.map(variant => variant.mint)),
    ).filter(mint => !combinedMintSet.has(mint));
    const chunkedExtraMints = chunkArray(extraMints, 250);

    const [tokenMarketsDocs, extraVariantMarketsChunks, extraFillQualityChunks] = await Promise.all([
        scoredMints.length > 0
            ? getTokenMarketsLatestByMints(deps.tokensReadsRepo, { mints: scoredMints }).catch(
                  (): GetTokenMarketsLatestByMintsEntry[] => [],
              )
            : Promise.resolve<GetTokenMarketsLatestByMintsEntry[]>([]),
        Promise.all(
            chunkedExtraMints.map(chunk =>
                variantMarketsGetLatestByMints(deps.variantMarketsRepo, { mints: chunk }).catch(
                    (): VariantMarketEntry[] => [],
                ),
            ),
        ),
        Promise.all(
            chunkedExtraMints.map(chunk =>
                fillQualityGetLatestByMints(deps.fillQualityReadsRepo, { mints: chunk }).catch(
                    (): FillQualityEntry[] => [],
                ),
            ),
        ),
    ]);

    return {
        sanctumMatch,
        effectiveAssetQuery,
        assets,
        tokens,
        variantsByTokenMint,
        extraAssets,
        variantsByAssetId,
        variantMarkets: [...variantMarkets, ...extraVariantMarketsChunks.flat()],
        fillQuality: [...fillQualityChunks.flat(), ...extraFillQualityChunks.flat()],
        assetAggregates: aggregatesChunks.flat(),
        stockInstruments,
        stockPrices,
        coingeckoPrices: coingeckoPricesChunks.flat(),
        tokenMarketsDocs,
    };
}
