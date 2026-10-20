import { CURATED_LIST_ORDER, normalizeCuratedListSlug } from '@tokens/asset-registry/curated-lists';
import {
    CHAIN_KINDS,
    CHAINS,
    chainAddressKey,
    explorerTokenUrl,
    isChainKind,
    normalizeAddressForChain,
    type ChainKind,
} from '@tokens/asset-registry/chains';

import { createConcurrencyLimiter } from '../concurrencyLimiter';
import { isTransientDatabaseError } from '../transientDb';
import {
    InvalidArgsError,
    getByAssetId,
    getByAssetIds,
    resolveAssetRefForApi,
    type AssetResult,
    type AssetsRepo,
    type GetByAssetIdsEntry,
} from './assets';
import { getMembers, type AssetCollectionsReadsRepo } from './assetCollectionsReads';
import { listDeletedRefs, type AssetDeletionTombstonesRepo } from './assetDeletionTombstones';
import {
    getPriceLatestByCoinIds as coingeckoGetPriceLatestByCoinIds,
    type CoingeckoPriceBatchEntry,
    type CoingeckoReadsRepo,
} from './coingeckoReads';
import {
    getInstrumentsByAssetIds as stockGetInstrumentsByAssetIds,
    getPriceLatestByAssetIds as stockGetPriceLatestByAssetIds,
    type GetInstrumentsByAssetIdsEntry,
    type GetPricesByAssetIdsEntry,
    type StockReadsRepo,
} from './stockReads';
import { buildVariantMarketSnapshot, type VariantMarketRow, type VariantMarketSnapshotResult } from './variantMarkets';

// Read side of the v2 multichain tables (migration 0033; writers in
// crons.v2Assets.ts). Served over the cloudrun RPC as `v2Assets*` and exposed
// by apps/api under /api/v2/{chains,assets,variants}.
//
// Every variant is addressed by (chain, address); the public key is
// `<chain>:<address>`. Chains are validated against the registry's CHAINS
// table and addresses normalized per the chain's family, so a caller can
// never read EVM rows with checksummed casing or Solana rows under 0x.

/** One `v2_asset_variants` row. */
export interface V2VariantDbRow {
    chain: string;
    address: string;
    asset_id: string;
    variant_id: string;
    kind: string;
    trust_tier: string;
    stock_variant_tier: string | null;
    tags: unknown;
    label: string | null;
    issuer: string | null;
    issuer_url: string | null;
    decimals: number | null;
    origin: string;
    source: string | null;
    is_active: boolean;
}

/** One `v2_variant_markets_latest` row, selected with `address AS mint` so the v1 snapshot builder applies. */
export interface V2MarketDbRow extends VariantMarketRow {
    chain: string;
    address: string;
    origin: string;
}

/** One `v2_asset_chain_markets_latest` row. */
export interface V2ChainRollupDbRow {
    asset_id: string;
    chain: string;
    liquidity: number | null;
    volume_24h_usd: number | null;
    volume_30d_usd: number | null;
    primary_address: string | null;
    variant_count: number | null;
    last_computed_at: number | string | bigint | null;
}

export interface V2ChainSummaryDbRow {
    chain: string;
    active_variants: number | string | bigint;
    asset_count: number | string | bigint;
    with_markets: number | string | bigint;
    max_market_fetched_at: number | string | bigint | null;
}

export interface V2VariantKey {
    chain: ChainKind;
    address: string;
}

export interface V2AssetsReadsRepo {
    chainSummary(): Promise<V2ChainSummaryDbRow[]>;
    findVariantsByAssetIds(
        assetIds: readonly string[],
        options: { chain: ChainKind | null; includeInactive: boolean },
    ): Promise<V2VariantDbRow[]>;
    /** Every row for one (chain, address): one per asset that claims it, active or not. */
    findVariantsByKey(chain: ChainKind, address: string): Promise<V2VariantDbRow[]>;
    findVariantsByKeys(keys: readonly V2VariantKey[]): Promise<V2VariantDbRow[]>;
    findMarketsByKeys(keys: readonly V2VariantKey[]): Promise<V2MarketDbRow[]>;
    findRollupsByAssetIds(assetIds: readonly string[]): Promise<V2ChainRollupDbRow[]>;
}

export interface V2AssetsReadsDeps {
    v2: V2AssetsReadsRepo;
    assetsRepo: AssetsRepo;
    assetCollectionsReadsRepo: AssetCollectionsReadsRepo;
    deletionTombstonesRepo: AssetDeletionTombstonesRepo;
    stockReadsRepo: StockReadsRepo;
    coingeckoReadsRepo: CoingeckoReadsRepo;
}

export interface V2VariantResult {
    chain: ChainKind;
    address: string;
    /** `<chain>:<address>` */
    key: string;
    assetId: string;
    variantId: string;
    kind: string;
    trustTier: string;
    stockVariantTier: string | null;
    tags: string[];
    label: string | null;
    issuer: string | null;
    issuerUrl: string | null;
    decimals: number | null;
    origin: string;
    isActive: boolean;
    explorerUrl: string;
}

export interface V2MarketResult {
    chain: ChainKind;
    address: string;
    key: string;
    market: VariantMarketSnapshotResult | null;
}

export interface V2ChainRollupResult {
    assetId: string;
    chain: ChainKind;
    liquidity: number;
    volume24hUSD: number;
    volume30dUSD: number | null;
    primaryAddress: string | null;
    variantCount: number;
    lastComputedAt: number | null;
}

export interface V2ChainSummaryResult {
    id: ChainKind;
    activeVariants: number;
    assetCount: number;
    withMarkets: number;
    maxMarketFetchedAt: number | null;
}

export interface V2ChainsResult {
    chains: V2ChainSummaryResult[];
}

export interface V2CuratedPrefetchResult {
    listId: string;
    /** Member asset ids per list slug, in CURATED_LIST_ORDER (or the one requested slug). */
    collectionAssetIds: string[][];
    /** Tombstoned refs (normalized lowercase) among the members; already excluded from `assets`. */
    deletedAssetRefs: string[];
    assets: GetByAssetIdsEntry[];
    variants: V2VariantResult[];
    markets: V2MarketResult[];
    chainRollups: V2ChainRollupResult[];
    stockInstruments: GetInstrumentsByAssetIdsEntry[];
    stockPrices: GetPricesByAssetIdsEntry[];
    coingeckoPrices: CoingeckoPriceBatchEntry[];
}

export interface V2AssetDetailResult {
    asset: AssetResult;
    resolvedBy: 'assetId' | 'alias';
    variants: V2VariantResult[];
    markets: V2MarketResult[];
    chainRollups: V2ChainRollupResult[];
    stockInstrument: GetInstrumentsByAssetIdsEntry | null;
    stockPrice: GetPricesByAssetIdsEntry | null;
    coingeckoPrice: CoingeckoPriceBatchEntry | null;
}

export interface V2VariantsByAssetIdsEntry {
    assetId: string;
    variants: V2VariantResult[];
}

export interface V2VariantLookupResult {
    /** One row per asset that claims the (chain, address); canonical owner first. */
    variants: V2VariantResult[];
    assets: AssetResult[];
    market: VariantMarketSnapshotResult | null;
}

export interface V2MarketsByKeysEntry {
    chain: ChainKind;
    address: string;
    key: string;
    variants: V2VariantResult[];
    market: VariantMarketSnapshotResult | null;
}

export const V2_MAX_KEYS_PER_CALL = 250;
export const V2_MAX_ASSET_IDS_PER_CALL = 250;
/** CoinGecko price lookups are capped per call by coingeckoReads. */
const COINGECKO_PRICE_CHUNK = 50;

function asObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null) throw new InvalidArgsError('args must be an object');
    return value as Record<string, unknown>;
}

function readOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new InvalidArgsError(`${key} must be a boolean`);
    return value;
}

function readOptionalChain(args: Record<string, unknown>, key = 'chain'): ChainKind | null {
    const value = args[key];
    if (value === undefined || value === null) return null;
    if (!isChainKind(value)) throw new InvalidArgsError(`${key} must be one of: ${CHAIN_KINDS.join(', ')}`);
    return value;
}

function readChainAddress(args: Record<string, unknown>): V2VariantKey {
    const chain = readOptionalChain(args);
    if (!chain) throw new InvalidArgsError('chain is required');
    const raw = args.address;
    if (typeof raw !== 'string') throw new InvalidArgsError('address must be a string');
    const address = normalizeAddressForChain(chain, raw);
    if (!address) throw new InvalidArgsError(`address is not a valid ${CHAINS[chain].family} address for ${chain}`);
    return { chain, address };
}

function readKeys(args: Record<string, unknown>): V2VariantKey[] {
    const raw = args.keys;
    if (!Array.isArray(raw)) throw new InvalidArgsError('keys must be an array of { chain, address }');
    if (raw.length > V2_MAX_KEYS_PER_CALL) throw new InvalidArgsError(`keys: max ${V2_MAX_KEYS_PER_CALL} per call`);
    const out: V2VariantKey[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            throw new InvalidArgsError('keys must be an array of { chain, address }');
        const key = readChainAddress(item as Record<string, unknown>);
        const id = chainAddressKey(key.chain, key.address);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(key);
    }
    return out;
}

function readAssetIds(args: Record<string, unknown>): string[] {
    const raw = args.assetIds;
    if (!Array.isArray(raw)) throw new InvalidArgsError('assetIds must be an array of strings');
    for (const item of raw) {
        if (typeof item !== 'string') throw new InvalidArgsError('assetIds must be an array of strings');
    }
    return uniqueStrings(raw as string[]).slice(0, V2_MAX_ASSET_IDS_PER_CALL);
}

function uniqueStrings(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function toCount(value: number | string | bigint | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const n = typeof value === 'bigint' ? Number(value) : Number(value);
    return Number.isFinite(n) ? n : 0;
}

function toEpochMs(value: number | string | bigint | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'bigint' ? Number(value) : Number(value);
    return Number.isFinite(n) ? n : null;
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
}

/** Best-effort reads keep their fallback unless the failure is transport-level (then the whole call fails). */
function recoverOptional<T>(fallback: T): (error: unknown) => T {
    return error => {
        if (isTransientDatabaseError(error)) throw error;
        return fallback;
    };
}

export function rowToVariantResult(row: V2VariantDbRow): V2VariantResult | null {
    if (!isChainKind(row.chain)) return null;
    return {
        chain: row.chain,
        address: row.address,
        key: chainAddressKey(row.chain, row.address),
        assetId: row.asset_id,
        variantId: row.variant_id,
        kind: row.kind,
        trustTier: row.trust_tier,
        stockVariantTier: row.stock_variant_tier,
        tags: toStringArray(row.tags),
        label: row.label,
        issuer: row.issuer,
        issuerUrl: row.issuer_url,
        decimals: typeof row.decimals === 'number' && Number.isFinite(row.decimals) ? row.decimals : null,
        origin: row.origin,
        isActive: row.is_active,
        explorerUrl: explorerTokenUrl(row.chain, row.address),
    };
}

export function rowToMarketResult(row: V2MarketDbRow): V2MarketResult | null {
    if (!isChainKind(row.chain)) return null;
    // A `touch` row only records that the refresh tried (so the key leaves the
    // stale set); it carries no metrics and must not read as an empty market.
    const market =
        row.source === 'touch' ? null : buildVariantMarketSnapshot(row.address, { ...row, mint: row.address });
    return { chain: row.chain, address: row.address, key: chainAddressKey(row.chain, row.address), market };
}

export function rowToRollupResult(row: V2ChainRollupDbRow): V2ChainRollupResult | null {
    if (!isChainKind(row.chain)) return null;
    return {
        assetId: row.asset_id,
        chain: row.chain,
        liquidity: typeof row.liquidity === 'number' && Number.isFinite(row.liquidity) ? row.liquidity : 0,
        volume24hUSD:
            typeof row.volume_24h_usd === 'number' && Number.isFinite(row.volume_24h_usd) ? row.volume_24h_usd : 0,
        volume30dUSD:
            typeof row.volume_30d_usd === 'number' && Number.isFinite(row.volume_30d_usd) ? row.volume_30d_usd : null,
        primaryAddress: row.primary_address,
        variantCount: toCount(row.variant_count),
        lastComputedAt: toEpochMs(row.last_computed_at),
    };
}

function variantResults(rows: readonly V2VariantDbRow[]): V2VariantResult[] {
    return rows.flatMap(row => {
        const out = rowToVariantResult(row);
        return out ? [out] : [];
    });
}

function marketResults(rows: readonly V2MarketDbRow[]): V2MarketResult[] {
    return rows.flatMap(row => {
        const out = rowToMarketResult(row);
        return out ? [out] : [];
    });
}

function rollupResults(rows: readonly V2ChainRollupDbRow[]): V2ChainRollupResult[] {
    return rows.flatMap(row => {
        const out = rowToRollupResult(row);
        return out ? [out] : [];
    });
}

function keysOf(variants: readonly V2VariantResult[]): V2VariantKey[] {
    const seen = new Set<string>();
    const out: V2VariantKey[] = [];
    for (const v of variants) {
        if (seen.has(v.key)) continue;
        seen.add(v.key);
        out.push({ chain: v.chain, address: v.address });
    }
    return out;
}

async function loadMarketsForKeys(
    repo: V2AssetsReadsRepo,
    keys: readonly V2VariantKey[],
    runDb: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<V2MarketResult[]> {
    if (keys.length === 0) return [];
    const chunks = chunkArray(keys, V2_MAX_KEYS_PER_CALL);
    const rows = await Promise.all(chunks.map(chunk => runDb(() => repo.findMarketsByKeys(chunk))));
    return marketResults(rows.flat());
}

/** CoinGecko coin ids an asset set needs prices for (the API applies the same normalization on its side). */
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

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------

/** `v2AssetsChains`: per-chain counts for every registry chain (zeros when a chain has no rows yet). */
export async function v2AssetsChains(deps: V2AssetsReadsDeps, args: unknown): Promise<V2ChainsResult> {
    asObject(args ?? {});
    const rows = await deps.v2.chainSummary();
    const byChain = new Map(rows.map(row => [row.chain, row] as const));
    return {
        chains: CHAIN_KINDS.map(id => {
            const row = byChain.get(id);
            return {
                id,
                activeVariants: toCount(row?.active_variants),
                assetCount: toCount(row?.asset_count),
                withMarkets: toCount(row?.with_markets),
                maxMarketFetchedAt: toEpochMs(row?.max_market_fetched_at),
            };
        }),
    };
}

/**
 * `v2AssetsCuratedPrefetch`: everything /api/v2/assets needs for one curated
 * list (or `all`) in one round trip. Membership → tombstones → assets,
 * variants (all chains unless `chain` narrows), rollups, stock → markets and
 * CoinGecko prices. Paging, filtering and ranking stay in the API, as in v1.
 */
export async function v2AssetsCuratedPrefetch(
    deps: V2AssetsReadsDeps,
    args: unknown,
): Promise<V2CuratedPrefetchResult> {
    const runDb = createConcurrencyLimiter(4);
    const a = asObject(args);
    const rawListId = typeof a.listId === 'string' ? a.listId.trim() : '';
    if (!rawListId) throw new InvalidArgsError('listId must be a non-empty string');
    const listId = rawListId === 'all' ? 'all' : (normalizeCuratedListSlug(rawListId) ?? null);
    if (!listId) throw new InvalidArgsError(`listId must be "all" or one of: ${CURATED_LIST_ORDER.join(', ')}`);
    const chain = readOptionalChain(a);
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;

    const memberListIds: string[] = listId === 'all' ? [...CURATED_LIST_ORDER] : [listId];
    const collectionAssetIds = await Promise.all(
        memberListIds.map(slug => runDb(() => getMembers(deps.assetCollectionsReadsRepo, { slug, limit: 2000 }))),
    );
    const rawAssetIds = uniqueStrings(collectionAssetIds.flat());

    const deletedAssetRefs = (
        await Promise.all(
            chunkArray(rawAssetIds, 500).map(chunk =>
                runDb(() => listDeletedRefs(deps.deletionTombstonesRepo, { refs: chunk })).catch(
                    recoverOptional<string[]>([]),
                ),
            ),
        )
    ).flat();
    const deletedSet = new Set(deletedAssetRefs.map(ref => ref.trim().toLowerCase()));
    const assetIds = rawAssetIds.filter(id => !deletedSet.has(id.toLowerCase()));

    const [assetsChunks, variantRows, rollupRows, stockInstrumentsChunks, stockPricesChunks] = await Promise.all([
        Promise.all(
            chunkArray(assetIds, 500).map(chunk =>
                runDb(() => getByAssetIds(deps.assetsRepo, { assetIds: chunk, includeInactive })),
            ),
        ),
        Promise.all(
            chunkArray(assetIds, V2_MAX_ASSET_IDS_PER_CALL).map(chunk =>
                runDb(() => deps.v2.findVariantsByAssetIds(chunk, { chain, includeInactive })),
            ),
        ).then(rows => rows.flat()),
        Promise.all(
            chunkArray(assetIds, V2_MAX_ASSET_IDS_PER_CALL).map(chunk =>
                runDb(() => deps.v2.findRollupsByAssetIds(chunk)),
            ),
        ).then(rows => rows.flat()),
        Promise.all(
            chunkArray(assetIds, 500).map(chunk =>
                runDb(() => stockGetInstrumentsByAssetIds(deps.stockReadsRepo, { assetIds: chunk })).catch(
                    recoverOptional<GetInstrumentsByAssetIdsEntry[]>([]),
                ),
            ),
        ),
        Promise.all(
            chunkArray(assetIds, 500).map(chunk =>
                runDb(() => stockGetPriceLatestByAssetIds(deps.stockReadsRepo, { assetIds: chunk })).catch(
                    recoverOptional<GetPricesByAssetIdsEntry[]>([]),
                ),
            ),
        ),
    ]);

    const assets = assetsChunks.flat();
    const variants = variantResults(variantRows);
    const coinIds = uniqueStrings(
        assets.flatMap(entry =>
            entry.asset
                ? [normalizeCoinGeckoCoinIdForAsset({ assetId: entry.assetId, coinId: entry.asset.coingeckoId }) ?? '']
                : [],
        ),
    );

    const [markets, coingeckoPricesChunks] = await Promise.all([
        loadMarketsForKeys(deps.v2, keysOf(variants), runDb),
        Promise.all(
            chunkArray(coinIds, COINGECKO_PRICE_CHUNK).map(chunk =>
                runDb(() => coingeckoGetPriceLatestByCoinIds(deps.coingeckoReadsRepo, { coinIds: chunk })).catch(
                    recoverOptional<CoingeckoPriceBatchEntry[]>([]),
                ),
            ),
        ),
    ]);

    return {
        listId,
        collectionAssetIds,
        deletedAssetRefs,
        assets,
        variants,
        markets,
        chainRollups: rollupResults(rollupRows),
        stockInstruments: stockInstrumentsChunks.flat(),
        stockPrices: stockPricesChunks.flat(),
        coingeckoPrices: coingeckoPricesChunks.flat(),
    };
}

/**
 * `v2AssetsGetDetail`: one asset by id or alias (tombstones excluded) with its
 * variants on every chain, their markets, per-chain rollups and the off-chain
 * reference (stock / CoinGecko) inputs. Null when unknown.
 */
export async function v2AssetsGetDetail(deps: V2AssetsReadsDeps, args: unknown): Promise<V2AssetDetailResult | null> {
    const a = asObject(args);
    const ref = typeof a.ref === 'string' ? a.ref.trim() : '';
    if (!ref) throw new InvalidArgsError('ref must be a non-empty string');
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;

    const resolved = await resolveAssetRefForApi(deps.assetsRepo, { ref, includeInactive });
    if (!resolved || resolved.resolvedBy === 'mint') return null;
    const asset = await getByAssetId(deps.assetsRepo, { assetId: resolved.assetId, includeInactive });
    if (!asset) return null;

    const runDb = createConcurrencyLimiter(4);
    const coinId = normalizeCoinGeckoCoinIdForAsset({ assetId: asset.assetId, coinId: asset.coingeckoId });
    const [variantRows, rollupRows, stockInstruments, stockPrices, coingeckoPrices] = await Promise.all([
        runDb(() => deps.v2.findVariantsByAssetIds([asset.assetId], { chain: null, includeInactive })),
        runDb(() => deps.v2.findRollupsByAssetIds([asset.assetId])),
        runDb(() => stockGetInstrumentsByAssetIds(deps.stockReadsRepo, { assetIds: [asset.assetId] })).catch(
            recoverOptional<GetInstrumentsByAssetIdsEntry[]>([]),
        ),
        runDb(() => stockGetPriceLatestByAssetIds(deps.stockReadsRepo, { assetIds: [asset.assetId] })).catch(
            recoverOptional<GetPricesByAssetIdsEntry[]>([]),
        ),
        coinId
            ? runDb(() => coingeckoGetPriceLatestByCoinIds(deps.coingeckoReadsRepo, { coinIds: [coinId] })).catch(
                  recoverOptional<CoingeckoPriceBatchEntry[]>([]),
              )
            : Promise.resolve<CoingeckoPriceBatchEntry[]>([]),
    ]);
    const variants = variantResults(variantRows);
    const markets = await loadMarketsForKeys(deps.v2, keysOf(variants), runDb);

    return {
        asset,
        resolvedBy: resolved.resolvedBy === 'alias' ? 'alias' : 'assetId',
        variants,
        markets,
        chainRollups: rollupResults(rollupRows),
        stockInstrument: stockInstruments[0] ?? null,
        stockPrice: stockPrices[0] ?? null,
        coingeckoPrice: coingeckoPrices[0] ?? null,
    };
}

/** `v2AssetsListVariantsByAssetIds`: variants grouped by asset id (≤250 ids), optionally one chain. */
export async function v2AssetsListVariantsByAssetIds(
    deps: V2AssetsReadsDeps,
    args: unknown,
): Promise<V2VariantsByAssetIdsEntry[]> {
    const a = asObject(args);
    const assetIds = readAssetIds(a);
    const chain = readOptionalChain(a);
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;
    if (assetIds.length === 0) return [];
    const rows = await deps.v2.findVariantsByAssetIds(assetIds, { chain, includeInactive });
    const byAsset = new Map<string, V2VariantResult[]>(assetIds.map(id => [id, []]));
    for (const row of variantResults(rows)) byAsset.get(row.assetId)?.push(row);
    return assetIds.map(assetId => ({ assetId, variants: byAsset.get(assetId) ?? [] }));
}

/**
 * `v2AssetsGetVariant`: one (chain, address) → every active asset that claims
 * it (canonical owner first: registry MINT_HOME_OVERRIDES let one Solana mint
 * sit under two assets) plus its market. Null when no active row exists.
 */
export async function v2AssetsGetVariant(
    deps: V2AssetsReadsDeps,
    args: unknown,
): Promise<V2VariantLookupResult | null> {
    const a = asObject(args);
    const { chain, address } = readChainAddress(a);
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;

    const rows = await deps.v2.findVariantsByKey(chain, address);
    const variants = variantResults(rows).filter(v => includeInactive || v.isActive);
    if (variants.length === 0) return null;

    const assetIds = uniqueStrings(variants.map(v => v.assetId));
    const [assetEntries, marketRows] = await Promise.all([
        getByAssetIds(deps.assetsRepo, { assetIds, includeInactive }),
        deps.v2.findMarketsByKeys([{ chain, address }]),
    ]);
    const assetById = new Map(
        assetEntries.flatMap(entry => (entry.asset ? [[entry.assetId, entry.asset] as const] : [])),
    );
    // Keep only variants whose asset is live (inactive / missing assets are not public).
    const liveVariants = variants.filter(v => assetById.has(v.assetId));
    if (liveVariants.length === 0) return null;
    const market = marketResults(marketRows)[0]?.market ?? null;
    return {
        variants: liveVariants,
        assets: liveVariants.flatMap(v => {
            const asset = assetById.get(v.assetId);
            return asset ? [asset] : [];
        }),
        market,
    };
}

/** `v2AssetsGetMarketsByKeys`: batch identity + market lookup for ≤250 keys, request order preserved. */
export async function v2AssetsGetMarketsByKeys(
    deps: V2AssetsReadsDeps,
    args: unknown,
): Promise<V2MarketsByKeysEntry[]> {
    const a = asObject(args);
    const keys = readKeys(a);
    if (keys.length === 0) return [];
    const [variantRows, marketRows] = await Promise.all([
        deps.v2.findVariantsByKeys(keys),
        deps.v2.findMarketsByKeys(keys),
    ]);
    const active = variantResults(variantRows).filter(v => v.isActive);
    // As v2AssetsGetVariant: a variant whose asset is inactive or missing is not
    // public, even while the Solana mirror still carries the variant as active.
    const assetIds = uniqueStrings(active.map(v => v.assetId));
    const liveAssetIds = new Set(
        assetIds.length === 0
            ? []
            : (await getByAssetIds(deps.assetsRepo, { assetIds, includeInactive: false })).flatMap(entry =>
                  entry.asset ? [entry.assetId] : [],
              ),
    );
    const variantsByKey = new Map<string, V2VariantResult[]>();
    for (const v of active) {
        if (!liveAssetIds.has(v.assetId)) continue;
        const list = variantsByKey.get(v.key) ?? [];
        list.push(v);
        variantsByKey.set(v.key, list);
    }
    const marketByKey = new Map(marketResults(marketRows).map(m => [m.key, m.market] as const));
    return keys.map(({ chain, address }) => {
        const key = chainAddressKey(chain, address);
        return { chain, address, key, variants: variantsByKey.get(key) ?? [], market: marketByKey.get(key) ?? null };
    });
}
