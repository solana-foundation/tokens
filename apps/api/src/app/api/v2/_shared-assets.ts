/**
 * Shared contract + assembly for the v2 multichain asset surface:
 * GET /v2/chains, /v2/assets, /v2/assets/{assetId}, /v2/assets/{assetId}/variants,
 * /v2/variants/{chain}/{address}, /v2/variants?keys=.
 *
 * Two nouns. An **asset** is the curated, chain-agnostic thing (`usd`,
 * `bitcoin`, `tesla`). A **variant** is one token on one chain that represents
 * it, addressed by exactly one key `<chain>:<address>` (EVM lowercase, Solana
 * base58). Every response includes every chain; `chain=` narrows what is
 * listed, never what is summed. There are no singleton ids and no bare-address
 * inputs, so a `0x` address never has to guess its chain.
 *
 * `buildV2Asset` is the one assembly path for list and detail so the two can
 * never drift. The numeric helpers are reused from v1 (`_asset-helpers.ts`)
 * through a key adapter: the registry's mint-keyed ranking / aggregation is fed
 * variants whose `mint` is the variant key, so nothing in the package changes.
 */
import {
    INCLUDED_MARKET_QUALITY,
    assessMarkets,
    countExcludedReasons,
    emptyExcludedByQuality,
    type ExcludedByQuality,
    type MarketQuality,
    type MarketQualityInput,
} from '../v1/assets/_market-quality';
import { Effect } from 'effect';

import {
    ASSET_CATEGORIES,
    STOCK_VARIANT_TIERS,
    VARIANT_KINDS,
    getVariantByMint,
    hasPrimaryActivity,
    isAdvisorySource,
    isHiddenAdvisory,
    pickPrimaryVariantWithRanking,
    type AssetCategory,
    type AssetVariant,
    type CanonicalAsset,
    type CompactPegHealth,
    type LiquidityTier,
    type StablecoinHealth,
    type PrimaryVariantSelectionReason,
    type PrimaryVariantStrategy,
    type StockVariantTier,
    type TrustTier,
    type VariantAdvisory,
    type VariantKind,
    isPrimaryEligibleVariant,
    resolveAssetIssuance,
    resolveVariantIssuance,
    type VariantIssuance,
} from '@tokens/asset-registry';
import {
    CHAINS,
    CHAIN_KINDS,
    chainAddressKey,
    chainSupports,
    explorerTokenUrl,
    isChainKind,
    looksLikeEvmAddress,
    looksLikeSolanaAddress,
    normalizeAddressForChain,
    type ChainCapabilities,
    type ChainKind,
} from '@tokens/asset-registry/chains';
import {
    CURATED_LIST_ORDER,
    normalizeCuratedListSlug,
    type CuratedListSlug,
} from '@tokens/asset-registry/curated-lists';
import { BadRequestError } from '@tokens/effect';

import { getAdvisoriesByMintSync, tradeRestrictedMints } from '@/lib/advisories';
import { toCompactPegHealth } from '@/lib/stablecoin-health';
import type { V2ChainRollupResult, V2MarketResult, V2VariantResult } from '@/lib/cloudrun';
import type { PrestocksPriceResult } from '@/lib/cloudrun/prestocksReads';
import type { AssetResult } from '../../../../../cloudrun-assets/src/handlers/assets';
import type { CoingeckoPriceSnapshot } from '../../../../../cloudrun-assets/src/handlers/coingeckoReads';
import type { StockInstrumentResult, StockPriceResult } from '../../../../../cloudrun-assets/src/handlers/stockReads';
import type { VariantMarketSnapshotResult } from '../../../../../cloudrun-assets/src/handlers/variantMarkets';

import {
    buildCuratedMintRank,
    computeCompanyMarketCapUsd,
    computePreStocksDerived,
    deriveVariantTierFields,
    isCanonicalPublicEquityAsset,
    optionalText,
    parsePrimaryVariantStrategy,
    resolveAssetImageUrl,
    resolveVariantSymbol,
    toFiniteNumberOrNull,
    tokenMarketSnapshotFromConvexMarket,
    type AssetStats,
    type TokenMarketSnapshot,
    type VariantExecutionQualitySnapshot,
} from '../v1/assets/_asset-helpers';
import type { PreStocksMintSnapshot } from '../v1/assets/_asset-detail-response';
import { normalizeCoinGeckoCoinIdForAsset } from '../v1/assets/_coingecko-id';
import {
    buildPreStocksCanonicalMarket,
    freshPreStocksByMint,
    selectPreStocksMints,
} from '../v1/assets/_prestocks-canonical';

// ---------------------------------------------------------------------------
// Public types (the docs' source of truth). Type aliases, not interfaces, so
// payloads satisfy withStaleFallback's Record<string, unknown> bound.
// Every documented key is always present; `null` means unknown / n.a.
// Timestamps are unix milliseconds (`*At`); numbers are JSON numbers.
// ---------------------------------------------------------------------------

export type ChainId = ChainKind;
export type ChainFamily = 'svm' | 'evm';
/** `<chain>:<address>` — the one identifier for a token. */
export type VariantKey = string;

export type V2Chain = {
    id: ChainId;
    caip2: string;
    family: ChainFamily;
    evmChainId: number | null;
    label: string;
    explorer: { name: string; tokenUrlTemplate: string };
    capabilities: ChainCapabilities;
    /** Active variants / assets with ≥1 active variant on the chain; null when the data layer is unreachable. */
    variantCount: number | null;
    assetCount: number | null;
};

export type V2ChainsResponse = { chains: V2Chain[]; total: number };

export type V2MarketSource = 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';

export type V2Market = {
    source: V2MarketSource;
    metricsSource: V2MarketSource | null;
    price: number | null;
    liquidity: number | null;
    volume1hUSD: number | null;
    volume24hUSD: number | null;
    trade1h: number | null;
    trade24h: number | null;
    uniqueWallet1h: number | null;
    uniqueWallet24h: number | null;
    marketCap: number | null;
    fdv: number | null;
    holder: number | null;
    totalSupply: number | null;
    circulatingSupply: number | null;
    priceChange1hPercent: number | null;
    priceChange24hPercent: number | null;
    lastTradeAt: number | null;
    /** Provider timestamp. */
    asOf: number | null;
    /** Our fetch. */
    lastFetchedAt: number | null;
    /** Whether this row entered the asset's sums and averages, and why not (stale / dust / price_outlier). */
    quality: MarketQuality;
};

export type V2Advisory = {
    status: VariantAdvisory['status'];
    reason: string;
    url: string | null;
    since: number;
    source: NonNullable<VariantAdvisory['source']>;
};

export type { VariantIssuance };

export type V2Variant = {
    key: VariantKey;
    chain: ChainId;
    address: string;
    assetId: string;
    variantId: string;
    kind: VariantKind;
    /** `issuance:<x>` tag, else the curated override for this deployment, else from kind (bridged / wrapped / derivative kinds), else native. Drives supply and market-cap counting. */
    issuance: VariantIssuance;
    symbol: string | null;
    name: string | null;
    label: string | null;
    decimals: number | null;
    logoURI: string | null;
    issuer: string | null;
    issuerUrl: string | null;
    trustTier: TrustTier;
    liquidityTier: LiquidityTier;
    stockVariantTier: StockVariantTier | null;
    tags: string[];
    advisory: V2Advisory | null;
    /** 0-based liquidity rank within the asset across chains; null when the asset's full variant set was not loaded (batch lookups). */
    rank: number | null;
    explorerUrl: string;
    market: V2Market | null;
    /** The CoinGecko coin this deployment is (an issuer's, an LST's, a wrapper's); null when unlinked. */
    coingeckoId: string | null;
    /** CoinGecko's own figures for that coin (per-issuer / per-wrapper supply and cap); null when unlinked or not loaded. */
    reference: V2CoinGeckoReference | null;
} & V2VariantEnrichments;

/** `GET /v2/assets/{id}?include=` values. Each adds one key to EVERY variant in the response. */
export type V2AssetDetailInclude = 'executionQuality' | 'pegHealth' | 'preStocks';
export const V2_ASSET_DETAIL_INCLUDES: readonly V2AssetDetailInclude[] = ['executionQuality', 'pegHealth', 'preStocks'];

/** Fill-quality snapshot (ClickHouse, 24h / 5s horizon); chains without `executionQuality` get `null`. */
export type V2ExecutionQuality = Omit<VariantExecutionQualitySnapshot, 'quoteMint'> & { quoteKey: VariantKey };

/** Compact peg status for stablecoin variants; chains without `risk` get `null`. */
export type V2PegHealth = Required<Pick<CompactPegHealth, 'provider' | 'referenceKind'>> &
    Omit<CompactPegHealth, 'provider' | 'referenceKind'>;

/** PreStocks reference mark for a tokenized pre-IPO variant. */
export type V2VariantPreStocks = {
    symbol: string;
    markPriceUsd: number | null;
    markValuationUsd: number | null;
    impliedValuationUsd: number | null;
    premiumToMarkPercent: number | null;
    lastFetchedAt: number;
};

/**
 * Per-variant enrichments. A key is present on every variant only when its
 * `include=` value was requested; `null` means the chain lacks the capability
 * or there is no data for the variant.
 */
export type V2VariantEnrichments = {
    executionQuality?: V2ExecutionQuality | null;
    pegHealth?: V2PegHealth | null;
    preStocks?: V2VariantPreStocks | null;
};

/** Where each headline figure came from: the off-chain reference or the guarded on-chain aggregate. */
export type V2StatsSourceKind = 'coingecko' | 'stock' | 'onchain';
export type V2StatsSource = Partial<Record<keyof AssetStats, V2StatsSourceKind>>;

/** Which chains `volume30dUSD` covers: every chain with volume, Solana only, or none (window incomplete). */
export type V2Volume30dScope = 'all' | 'solana' | null;

export type V2AssetStats = AssetStats & {
    /** Provenance per figure; a key is absent when the figure is null. */
    source: V2StatsSource;
    volume30dScope: V2Volume30dScope;
};

/** Days a computed EVM rollup row needs before its 30d figure is served. */
export const VOLUME_30D_MIN_DAYS = 28;
/** A computed rollup older than this is not served: the daily job stopped while the 24h refresh went on. */
export const VOLUME_30D_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * 30d volume across chains: the sum of each chain's rollup when every chain
 * that traded in the last 24h has a complete window (`solana_v1` rows come
 * from a 30-day candle series; `computed` EVM rows need ≥ 28 sampled days),
 * else null. `scope` says what the number covers so an asset whose only
 * volume is on Solana is still served as `solana`.
 */
export function selectVolume30d(
    chainStats: Partial<Record<ChainId, V2ChainStats>>,
    rollupByChain: ReadonlyMap<ChainId, V2ChainRollupResult> | null,
    /** A computed row whose `lastComputedAt` is more than `VOLUME_30D_MAX_AGE_MS` before this is treated as missing. */
    nowMs: number = Date.now(),
): { volume30dUSD: number | null; scope: V2Volume30dScope } {
    const tradedChains = CHAIN_KINDS.filter(chain => (chainStats[chain]?.volume24hUSD ?? 0) > 0);
    if (tradedChains.length === 0) return { volume30dUSD: null, scope: null };
    let sum = 0;
    let any = false;
    for (const chain of tradedChains) {
        const rollup = rollupByChain?.get(chain);
        if (!rollup || rollup.volume30dUSD === null) return { volume30dUSD: null, scope: null };
        const fresh =
            rollup.origin === 'solana_v1' ||
            (rollup.lastComputedAt !== null && nowMs - rollup.lastComputedAt <= VOLUME_30D_MAX_AGE_MS);
        const complete = rollup.origin === 'solana_v1' || (rollup.volume30dDays ?? 0) >= VOLUME_30D_MIN_DAYS;
        if (!fresh || !complete) return { volume30dUSD: null, scope: null };
        sum += rollup.volume30dUSD;
        any = true;
    }
    if (!any) return { volume30dUSD: null, scope: null };
    return { volume30dUSD: sum, scope: tradedChains.length === 1 && tradedChains[0] === 'solana' ? 'solana' : 'all' };
}

/** Variants left out of supply / market cap, by why. */
export type V2ExcludedByIssuance = {
    bridged: number;
    wrapped: number;
    derivative: number;
};

export type V2ChainStats = {
    /**
     * Average over the chain's included rows priced in the asset's units
     * (derivatives such as ETF shares or LSTs only stand in when there is no
     * other priced row), each weighted by its liquidity (else 24h volume);
     * when no such row has either, the plain mean, so a lone fresh pool with
     * no activity yet still reports its price.
     */
    price: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
    liquidity: number | null;
    volume24hUSD: number | null;
    /** Sum of the chain's variant 24h trade counts. */
    trade24h: number | null;
    /** Sum over this chain's issued (`issuance: native`) variants. */
    marketCap: number | null;
    fdv: number | null;
    circulatingSupply: number | null;
    totalSupply: number | null;
    variantCount: number;
    /** Variants counted toward supply / market cap. */
    issuedVariantCount: number;
    /** Variants left out of supply / market cap on this chain, by issuance class. */
    excludedByIssuance: V2ExcludedByIssuance;
    /** Variants whose market row failed the quality guard and left every sum on this chain. */
    excludedCount: number;
    excludedByQuality: ExcludedByQuality;
};

export type V2Aggregate = V2ChainStats & {
    chainCount: number;
    /** Bridged / wrapped / derivative variants left out of supply and market cap (= the sum of `excludedByIssuance`). */
    excludedFromSupplyCount: number;
};

export type V2CoinGeckoReference = Extract<V2ReferenceMarket, { source: 'coingecko' }>;

export function toCoinGeckoReference(coinId: string, snapshot: CoingeckoPriceSnapshot | null): V2CoinGeckoReference {
    return {
        source: 'coingecko',
        coinId,
        price: snapshot?.priceUsd ?? null,
        marketCap: snapshot?.marketCapUsd ?? null,
        volume24hUSD: snapshot?.volume24hUsd ?? null,
        priceChange24hPercent: snapshot?.priceChange24hPercent ?? null,
        circulatingSupply: snapshot?.circulatingSupply ?? null,
        totalSupply: snapshot?.totalSupply ?? null,
        maxSupply: snapshot?.maxSupply ?? null,
        asOf: snapshot?.providerLastUpdatedAt ?? null,
        lastFetchedAt: snapshot?.lastFetchedAt ?? null,
    };
}

export type V2ReferenceMarket =
    | {
          source: 'coingecko';
          coinId: string;
          price: number | null;
          marketCap: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          circulatingSupply: number | null;
          totalSupply: number | null;
          maxSupply: number | null;
          asOf: number | null;
          lastFetchedAt: number | null;
      }
    | {
          source: 'stock';
          symbol: string;
          price: number | null;
          marketCap: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          asOf: number | null;
          lastFetchedAt: number | null;
      }
    | {
          source: 'prestocks';
          symbol: string;
          key: VariantKey;
          price: number | null;
          marketCap: number | null;
          markPriceUsd: number | null;
          markValuationUsd: number | null;
          impliedValuationUsd: number | null;
          premiumToMarkPercent: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          asOf: number | null;
          lastFetchedAt: number | null;
      };

export type V2AssetAdvisory = V2Advisory & { key: VariantKey; chain: ChainId; address: string; variantId: string };

export type V2PrimaryVariantStrategy = PrimaryVariantStrategy;

/**
 * Which variants compete for `primaryVariant`. `executable` (default): variants on
 * chains with the `swap` capability, i.e. the best variant you can trade through
 * us. `global`: every chain, so the cross-chain liquidity winner.
 */
export type V2PrimaryScope = 'executable' | 'global';
export const V2_PRIMARY_SCOPES: readonly V2PrimaryScope[] = ['executable', 'global'];

/**
 * The candidate pool the primary was ranked in, first non-empty wins.
 * executable: executable_active → active → executable → all; global: active → all.
 * `active` = market data clearing the activity minimums (`hasPrimaryActivity`).
 */
export type V2PrimaryVariantPool = 'executable_active' | 'active' | 'executable' | 'all';

export type V2PrimaryVariantSelection = {
    pool: V2PrimaryVariantPool;
    /** The ranking rule that decided between the last two candidates. */
    reason: PrimaryVariantSelectionReason | null;
};

export type V2Asset = {
    assetId: string;
    name: string | null;
    symbol: string | null;
    description: string | null;
    category: AssetCategory;
    aliases: string[];
    symbols: string[];
    imageUrl: string | null;
    coingeckoId: string | null;
    /** Every chain with ≥1 variant, canonical order, from the unfiltered set. */
    chains: ChainId[];
    /** Headline numbers: v1's selection logic fed the cross-chain aggregate. */
    stats: V2AssetStats | null;
    /** Per-chain on-chain stats from the unfiltered set; `chainStats.solana` is v1's on-Solana number. */
    chainStats: Partial<Record<ChainId, V2ChainStats>>;
    aggregate: V2Aggregate;
    /** The off-chain reference (CoinGecko / stock benchmark / PreStocks mark); v1 called it `canonicalMarket`. */
    referenceMarket: V2ReferenceMarket | null;
    /** Most severe first; names hidden (blocked) siblings too. */
    advisories: V2AssetAdvisory[];
    primaryVariantStrategy: V2PrimaryVariantStrategy;
    primaryScope: V2PrimaryScope;
    primaryVariantSelection: V2PrimaryVariantSelection | null;
    primaryVariant: V2Variant | null;
    primaryVariantByChain: Partial<Record<ChainId, V2Variant>>;
    /** 0-based position in the requested curated list; null outside a list context. */
    rank: number | null;
    variants?: V2Variant[];
};

export type V2AssetSummary = Pick<V2Asset, 'assetId' | 'name' | 'symbol' | 'category' | 'imageUrl' | 'chains'>;

export type V2AssetsResponse = {
    assets: V2Asset[];
    total: number;
    list: string;
    primaryVariantStrategy: V2PrimaryVariantStrategy;
    primaryScope: V2PrimaryScope;
};

export type V2AssetResponse = V2Asset & { resolvedBy: 'assetId' | 'alias' | 'rename' };

export type V2AssetVariantsResponse = { assetId: string; variants: V2Variant[]; total: number; sort: V2VariantSort };

export type V2VariantResponse = { variant: V2Variant; asset: V2AssetSummary };

export type V2VariantsBatchResponse = {
    variants: V2Variant[];
    missing: Array<{ key: VariantKey; chain: ChainId; address: string }>;
    total: number;
};

export type V2VariantSort = 'liquidity' | 'execution_quality' | 'stock_redeemability';
export const V2_VARIANT_SORTS: readonly V2VariantSort[] = ['liquidity', 'execution_quality', 'stock_redeemability'];

export const V2_MAX_BATCH_KEYS = 50;

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

export function toV2Chain(chain: ChainId, counts: { variantCount: number | null; assetCount: number | null }): V2Chain {
    const config = CHAINS[chain];
    return {
        id: chain,
        caip2: config.caip2,
        family: config.family,
        evmChainId: config.evmChainId ?? null,
        label: config.label,
        explorer: { name: config.explorer.name, tokenUrlTemplate: config.explorer.tokenUrl('{address}') },
        capabilities: { ...config.capabilities },
        variantCount: counts.variantCount,
        assetCount: counts.assetCount,
    };
}

// ---------------------------------------------------------------------------
// Param decoding (machine-readable `details.code` on every 400)
// ---------------------------------------------------------------------------

function badRequest(message: string, details: Record<string, unknown>): BadRequestError {
    return new BadRequestError({ message, details });
}

export function invalidChainError(raw: string): BadRequestError {
    return badRequest(`Invalid chain: ${raw}`, { code: 'invalid_chain', chain: raw, chains: [...CHAIN_KINDS] });
}

export function invalidAddressError(chain: ChainId, raw: string): BadRequestError {
    const expected = CHAINS[chain].family === 'evm' ? '0x40hex' : 'base58';
    return badRequest(`\`${raw}\` is not a valid ${CHAINS[chain].label} address`, {
        code: 'invalid_address',
        chain,
        address: raw,
        expected,
    });
}

/** `chain=<id>` — optional single chain. */
export function decodeChainParam(params: URLSearchParams): Effect.Effect<ChainId | null, BadRequestError> {
    const raw = (params.get('chain') ?? '').trim();
    if (!raw) return Effect.succeed(null);
    return isChainKind(raw) ? Effect.succeed(raw) : Effect.fail(invalidChainError(raw));
}

export type DecodedChainAddress = { chain: ChainId; address: string; key: VariantKey };

/** `/{chain}/{address}` path segments: chain must be known, address valid for its family (EVM lowercased). */
export function decodeChainAddressPath(raw: {
    chain: string;
    address: string;
}): Effect.Effect<DecodedChainAddress, BadRequestError> {
    const chainRaw = raw.chain.trim();
    if (!isChainKind(chainRaw)) return Effect.fail(invalidChainError(chainRaw));
    const addressRaw = raw.address.trim();
    const address = normalizeAddressForChain(chainRaw, addressRaw);
    if (!address) return Effect.fail(invalidAddressError(chainRaw, addressRaw));
    return Effect.succeed({ chain: chainRaw, address, key: chainAddressKey(chainRaw, address) });
}

/** `keys=<chain>:<address>,…` — required, ≤ max, deduped, request order kept. */
export function decodeKeysParam(
    params: URLSearchParams,
    options: { max: number } = { max: V2_MAX_BATCH_KEYS },
): Effect.Effect<DecodedChainAddress[], BadRequestError> {
    const raw = params.getAll('keys').flatMap(value => value.split(','));
    const items = raw.map(item => item.trim()).filter(Boolean);
    if (items.length === 0) {
        return Effect.fail(
            badRequest('`keys` is required: a comma-separated list of <chain>:<address>', { code: 'invalid_key' }),
        );
    }
    if (items.length > options.max) {
        return Effect.fail(
            badRequest(`Too many keys: max ${options.max} per request`, {
                code: 'too_many_keys',
                max: options.max,
                count: items.length,
            }),
        );
    }
    const out: DecodedChainAddress[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        const colon = item.indexOf(':');
        if (colon <= 0) {
            return Effect.fail(
                badRequest(`Invalid key: ${item} (expected <chain>:<address>)`, { code: 'invalid_key', key: item }),
            );
        }
        const chain = item.slice(0, colon);
        if (!isChainKind(chain)) return Effect.fail(invalidChainError(chain));
        const addressRaw = item.slice(colon + 1);
        const address = normalizeAddressForChain(chain, addressRaw);
        if (!address) return Effect.fail(invalidAddressError(chain, addressRaw));
        const key = chainAddressKey(chain, address);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ chain, address, key });
    }
    return Effect.succeed(out);
}

/**
 * `{assetId}` path segment: an asset id or alias. Address-shaped values and
 * `<chain>:<address>` keys are rejected — tokens live under /v2/variants.
 */
export function decodeAssetIdPath(raw: string): Effect.Effect<string, BadRequestError> {
    const value = raw.trim();
    if (!value) return Effect.fail(badRequest('assetId is required', { code: 'invalid_asset_id' }));
    const looksLikeKey = value.includes(':') && isChainKind(value.slice(0, value.indexOf(':')));
    if (looksLikeKey || looksLikeSolanaAddress(value) || looksLikeEvmAddress(value)) {
        return Effect.fail(
            badRequest('assetId must be an asset id or alias, not a token address', {
                code: 'invalid_asset_id',
                assetId: value,
                hint: 'Look up a token with GET /v2/variants/{chain}/{address}',
            }),
        );
    }
    if (value.length > 120) return Effect.fail(badRequest('assetId is too long', { code: 'invalid_asset_id' }));
    return Effect.succeed(value);
}

/** `list=all|<curated slug>`; absent = `all`. Unknown slugs are rejected (v1 silently coerced). */
export function decodeListParam(params: URLSearchParams): Effect.Effect<'all' | CuratedListSlug, BadRequestError> {
    const raw = (params.get('list') ?? '').trim();
    if (!raw || raw === 'all') return Effect.succeed('all');
    const slug = normalizeCuratedListSlug(raw);
    if (!slug)
        return Effect.fail(
            badRequest(`Invalid list: ${raw}`, {
                code: 'invalid_list',
                list: raw,
                lists: ['all', ...CURATED_LIST_ORDER],
            }),
        );
    return Effect.succeed(slug);
}

export function decodeEnumParam<T extends string>(
    params: URLSearchParams,
    name: string,
    values: readonly T[],
    code: string,
): Effect.Effect<T | null, BadRequestError> {
    const raw = (params.get(name) ?? '').trim();
    if (!raw) return Effect.succeed(null);
    return (values as readonly string[]).includes(raw)
        ? Effect.succeed(raw as T)
        : Effect.fail(badRequest(`Invalid ${name}: ${raw}`, { code, [name]: raw, values: [...values] }));
}

export function decodeCategoryParam(params: URLSearchParams): Effect.Effect<AssetCategory | null, BadRequestError> {
    return decodeEnumParam(params, 'category', ASSET_CATEGORIES, 'invalid_category');
}

export function decodeIncludeParam(
    params: URLSearchParams,
    allowed: readonly string[],
): Effect.Effect<Set<string>, BadRequestError> {
    const raw = params.getAll('include').flatMap(value => value.split(','));
    const out = new Set<string>();
    for (const item of raw) {
        const value = item.trim();
        if (!value) continue;
        if (!allowed.includes(value)) {
            return Effect.fail(
                badRequest(`Invalid include: ${value}`, {
                    code: 'invalid_include',
                    include: value,
                    values: [...allowed],
                }),
            );
        }
        out.add(value);
    }
    return Effect.succeed(out);
}

export function decodeQueryParam(params: URLSearchParams, max = 100): Effect.Effect<string | null, BadRequestError> {
    const raw = (params.get('q') ?? '').trim();
    if (!raw) return Effect.succeed(null);
    if (raw.length > max)
        return Effect.fail(badRequest(`q must be at most ${max} characters`, { code: 'invalid_query', max }));
    return Effect.succeed(raw);
}

export function decodePrimaryVariantStrategyParam(
    params: URLSearchParams,
): Effect.Effect<V2PrimaryVariantStrategy | null, BadRequestError> {
    const raw = params.get('primaryVariantStrategy');
    if (raw === null || raw.trim() === '') return Effect.succeed(null);
    const values: readonly V2PrimaryVariantStrategy[] = ['liquidity', 'execution_quality', 'stock_redeemability'];
    return (values as readonly string[]).includes(raw.trim())
        ? Effect.succeed(parsePrimaryVariantStrategy(raw))
        : Effect.fail(
              badRequest(`Invalid primaryVariantStrategy: ${raw}`, {
                  code: 'invalid_primary_variant_strategy',
                  values: [...values],
              }),
          );
}

export function decodePrimaryScopeParam(params: URLSearchParams): Effect.Effect<V2PrimaryScope, BadRequestError> {
    const raw = (params.get('primaryScope') ?? '').trim();
    if (raw === '') return Effect.succeed('executable');
    return (V2_PRIMARY_SCOPES as readonly string[]).includes(raw)
        ? Effect.succeed(raw as V2PrimaryScope)
        : Effect.fail(
              badRequest(`Invalid primaryScope: ${raw}`, {
                  code: 'invalid_primary_scope',
                  values: [...V2_PRIMARY_SCOPES],
              }),
          );
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function isVariantKind(value: string): value is VariantKind {
    return (VARIANT_KINDS as readonly string[]).includes(value);
}

function toTrustTier(value: string): TrustTier {
    return value === 'tier1' || value === 'tier2' ? value : 'tier3';
}

function toStockVariantTier(value: string | null): StockVariantTier | null {
    return value !== null && (STOCK_VARIANT_TIERS as readonly string[]).includes(value)
        ? (value as StockVariantTier)
        : null;
}

/**
 * Tag > curated override > kind for one variant on its own; see
 * `resolveVariantIssuance` in the registry. Prefer `variantIssuanceByKey`
 * whenever the asset's variant set is at hand: a yield / ETF / leveraged /
 * basket token is only a derivative *of the asset* when the asset has some
 * other deployment, so a standalone fund's single variant is its supply.
 */
export function variantIssuance(variant: {
    chain: ChainId;
    address: string;
    kind: string;
    tags: readonly string[];
}): VariantIssuance {
    return resolveVariantIssuance(variant);
}

/** Issuance per variant key over one asset's variants (`resolveAssetIssuance` in the registry). */
export function variantIssuanceByKey(
    variants: ReadonlyArray<Pick<V2VariantResult, 'chain' | 'address' | 'key' | 'kind' | 'tags'>>,
    /** The asset's category: a commodity's ETF-share tokens are never promoted to its supply. */
    category?: string | null,
): Map<VariantKey, VariantIssuance> {
    const resolved = resolveAssetIssuance(variants, { category });
    const out = new Map<VariantKey, VariantIssuance>();
    variants.forEach((variant, index) => out.set(variant.key, resolved[index]!));
    return out;
}

export function toV2Market(
    snapshot: VariantMarketSnapshotResult | null | undefined,
    quality: MarketQuality = INCLUDED_MARKET_QUALITY,
): V2Market | null {
    if (!snapshot) return null;
    const metricsSource = snapshot.metricsSource ?? null;
    return {
        source: snapshot.source,
        metricsSource,
        price: toFiniteNumberOrNull(snapshot.price),
        liquidity: toFiniteNumberOrNull(snapshot.liquidity),
        volume1hUSD: toFiniteNumberOrNull(snapshot.volume1hUSD),
        volume24hUSD: toFiniteNumberOrNull(snapshot.volume24hUSD),
        trade1h: toFiniteNumberOrNull(snapshot.trade1h),
        trade24h: toFiniteNumberOrNull(snapshot.trade24h),
        uniqueWallet1h: toFiniteNumberOrNull(snapshot.uniqueWallet1h),
        uniqueWallet24h: toFiniteNumberOrNull(snapshot.uniqueWallet24h),
        marketCap: toFiniteNumberOrNull(snapshot.marketCap),
        fdv: toFiniteNumberOrNull(snapshot.fdv),
        holder: toFiniteNumberOrNull(snapshot.holder),
        totalSupply: toFiniteNumberOrNull(snapshot.totalSupply),
        circulatingSupply: toFiniteNumberOrNull(snapshot.circulatingSupply),
        priceChange1hPercent: toFiniteNumberOrNull(snapshot.priceChange1hPercent),
        priceChange24hPercent: toFiniteNumberOrNull(snapshot.priceChange24hPercent),
        lastTradeAt: toFiniteNumberOrNull(snapshot.lastTradeAt),
        asOf: toFiniteNumberOrNull(snapshot.asOf),
        lastFetchedAt: toFiniteNumberOrNull(snapshot.lastFetchedAt),
        quality: { included: quality.included, reasons: [...quality.reasons] },
    };
}

/** Quality verdict per variant key for an asset's market rows (see `_market-quality.ts`). */
export function assessVariantMarkets(
    variants: ReadonlyArray<Pick<V2VariantResult, 'key' | 'chain' | 'address' | 'kind' | 'tags'>>,
    marketByKey: ReadonlyMap<VariantKey, VariantMarketSnapshotResult>,
    reference: { priceUsd: number | null | undefined } | null,
    nowMs: number,
    /** From `variantIssuanceByKey(variants, asset.category)`; derivatives skip the price check. Computed category-blind when absent. */
    issuanceByKey?: ReadonlyMap<VariantKey, VariantIssuance>,
): Map<VariantKey, MarketQuality> {
    const issuance = issuanceByKey ?? variantIssuanceByKey(variants);
    const rows: MarketQualityInput[] = [];
    const seen = new Set<VariantKey>();
    for (const variant of variants) {
        if (seen.has(variant.key)) continue;
        seen.add(variant.key);
        const market = marketByKey.get(variant.key);
        if (!market) continue;
        rows.push({
            key: variant.key,
            chain: variant.chain,
            price: market.price,
            liquidity: market.liquidity,
            volume24hUSD: market.volume24hUSD,
            lastFetchedAt: market.lastFetchedAt,
            // An LST or ETF share is not priced in the asset's units; the reference says nothing about it.
            priceChecked: (issuance.get(variant.key) ?? variantIssuance(variant)) !== 'derivative',
        });
    }
    return assessMarkets(rows, reference, nowMs) as Map<VariantKey, MarketQuality>;
}

export function toV2Advisory(advisory: VariantAdvisory | null | undefined): V2Advisory | null {
    if (!advisory) return null;
    return {
        status: advisory.status,
        reason: advisory.reason,
        url: advisory.url ?? null,
        since: advisory.since,
        source: isAdvisorySource(advisory.source) ? advisory.source : 'admin',
    };
}

/** Advisories are mint-keyed (Solana only) today; EVM variants never carry one. */
export function advisoryForVariant(
    variant: Pick<V2VariantResult, 'chain' | 'address'>,
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>,
): VariantAdvisory | null {
    return variant.chain === 'solana' ? (advisoriesByMint.get(variant.address) ?? null) : null;
}

export function marketByKeyFrom(markets: readonly V2MarketResult[]): Map<VariantKey, VariantMarketSnapshotResult> {
    const out = new Map<VariantKey, VariantMarketSnapshotResult>();
    for (const row of markets) if (row.market) out.set(row.key, row.market);
    return out;
}

export function rollupsByAssetFrom(
    rollups: readonly V2ChainRollupResult[],
): Map<string, Map<ChainId, V2ChainRollupResult>> {
    const out = new Map<string, Map<ChainId, V2ChainRollupResult>>();
    for (const row of rollups) {
        const byChain = out.get(row.assetId) ?? new Map<ChainId, V2ChainRollupResult>();
        byChain.set(row.chain, row);
        out.set(row.assetId, byChain);
    }
    return out;
}

/** Variants whose advisory hides them from list surfaces (`blocked`). */
export function isHiddenVariant(
    variant: Pick<V2VariantResult, 'chain' | 'address'>,
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>,
): boolean {
    return isHiddenAdvisory(advisoryForVariant(variant, advisoriesByMint));
}

/**
 * List surfaces qualify an asset for `chain=` by its *visible* variants: a
 * chain whose only variants are hidden (blocked) must not list the asset with
 * an empty `variants[]` and no entry in `chains`.
 */
export function hasVisibleVariantOnChain(
    variants: readonly Pick<V2VariantResult, 'chain' | 'address'>[],
    chain: ChainId,
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>,
): boolean {
    return variants.some(v => v.chain === chain && !isHiddenVariant(v, advisoriesByMint));
}

// ---------------------------------------------------------------------------
// Chain stats
// ---------------------------------------------------------------------------

function addFinite(total: number | null, value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? (total ?? 0) + value : total;
}

/**
 * Per-chain stats over `variants` (pass the UNFILTERED set so the numbers do
 * not depend on `chain=`), canonical chain order. Liquidity and 24h volume
 * are summed over every variant (pools are distinct); supply and market cap
 * only over issued variants (bridged / wrapped are claims on supply issued
 * elsewhere). For Solana the worker rollup (v1's `asset_markets_latest`)
 * supplies liquidity / volume when present, so `chainStats.solana` equals v1.
 */
/** Supply figures a native coin's home-chain row carries although it has no market row (from the asset's reference). */
export interface NativeHomeSupply {
    marketCap: number | null;
    fdv: number | null;
    circulatingSupply: number | null;
    totalSupply: number | null;
}

export const NATIVE_HOME_TAG = 'native-home';

/**
 * One weighted mean in progress. `sum` / `weight` carry only rows with a
 * positive weight; `plainSum` / `count` carry every finite value so a figure
 * survives when no row has any activity (a fresh single pool with no
 * liquidity or volume yet still has a price).
 */
interface MeanAccumulator {
    sum: number;
    weight: number;
    plainSum: number;
    count: number;
}

/** Per-field accumulators; a row missing one field contributes nothing to that field's weight. */
export interface WeightedAccumulator {
    price: MeanAccumulator;
    change24h: MeanAccumulator;
    change1h: MeanAccumulator;
}

/** A chain's accumulators: rows priced in the asset's units, and derivative rows (ETF shares, LSTs) kept apart. */
export interface ChainAccumulators {
    own: WeightedAccumulator;
    derivative: WeightedAccumulator;
}

function emptyMean(): MeanAccumulator {
    return { sum: 0, weight: 0, plainSum: 0, count: 0 };
}

function emptyAccumulator(): WeightedAccumulator {
    return { price: emptyMean(), change24h: emptyMean(), change1h: emptyMean() };
}

function accumulate(acc: MeanAccumulator, value: number | null | undefined, weight: number): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    acc.plainSum += value;
    acc.count += 1;
    if (weight <= 0) return;
    acc.sum += value * weight;
    acc.weight += weight;
}

/** Fold `other` into `acc` (both already weighted the same way). */
function merge(acc: MeanAccumulator, other: MeanAccumulator): void {
    acc.sum += other.sum;
    acc.weight += other.weight;
    acc.plainSum += other.plainSum;
    acc.count += other.count;
}

/** The weighted mean, else the plain mean of the values seen, else null. */
function weighted(acc: MeanAccumulator): number | null {
    if (acc.weight > 0) return acc.sum / acc.weight;
    return acc.count > 0 ? acc.plainSum / acc.count : null;
}

/** The weight a row carries in the price averages: liquidity, else 24h volume, else nothing. */
function activityWeight(market: VariantMarketSnapshotResult | undefined): number {
    const liquidity = market?.liquidity;
    if (typeof liquidity === 'number' && Number.isFinite(liquidity) && liquidity > 0) return liquidity;
    const volume = market?.volume24hUSD;
    if (typeof volume === 'number' && Number.isFinite(volume) && volume > 0) return volume;
    return 0;
}

export function computeChainStats(
    variants: ReadonlyArray<Pick<V2VariantResult, 'chain' | 'address' | 'key' | 'kind' | 'tags'>>,
    marketByKey: ReadonlyMap<VariantKey, VariantMarketSnapshotResult>,
    /** Kept for the Solana 30d rollup only; liquidity and volume are the guarded variant sums on every chain. */
    rollupByChain: ReadonlyMap<ChainId, V2ChainRollupResult> | null,
    /** From `assessVariantMarkets`; excluded rows leave every sum (they still count in `variantCount`). */
    qualityByKey?: ReadonlyMap<VariantKey, MarketQuality>,
    /** Supply for a `native-home` row without a market (the asset's reference figures). */
    nativeHomeSupply?: NativeHomeSupply | null,
    /** From `variantIssuanceByKey(variants, asset.category)`; computed category-blind when absent. */
    issuanceByKey?: ReadonlyMap<VariantKey, VariantIssuance>,
): Partial<Record<ChainId, V2ChainStats>> {
    return computeChainStatsDetailed(variants, marketByKey, rollupByChain, qualityByKey, nativeHomeSupply, issuanceByKey).chainStats;
}

/**
 * `computeChainStats` plus each chain's per-field accumulators, which
 * `aggregateChainStats` folds into the cross-chain averages so a row missing
 * a field does not lend its liquidity to that field's mean.
 */
export function computeChainStatsDetailed(
    variants: ReadonlyArray<Pick<V2VariantResult, 'chain' | 'address' | 'key' | 'kind' | 'tags'>>,
    marketByKey: ReadonlyMap<VariantKey, VariantMarketSnapshotResult>,
    _rollupByChain: ReadonlyMap<ChainId, V2ChainRollupResult> | null,
    qualityByKey?: ReadonlyMap<VariantKey, MarketQuality>,
    nativeHomeSupply?: NativeHomeSupply | null,
    /** From `variantIssuanceByKey(variants, asset.category)`; computed category-blind when absent. */
    issuanceByKey?: ReadonlyMap<VariantKey, VariantIssuance>,
): { chainStats: Partial<Record<ChainId, V2ChainStats>>; accumulatorsByChain: ReadonlyMap<ChainId, ChainAccumulators> } {
    const byChain = new Map<ChainId, V2ChainStats>();
    const issuance = issuanceByKey ?? variantIssuanceByKey(variants);
    const accByChain = new Map<ChainId, WeightedAccumulator>();
    // Derivative rows (an ETF share next to spot gold, an LST next to SOL) are
    // priced in other units; their liquidity and volume count, their prices
    // only stand in when a chain has no other priced row (a commodity whose
    // only token is a fund share).
    const derivativeAccByChain = new Map<ChainId, WeightedAccumulator>();
    const seen = new Set<VariantKey>();
    for (const variant of variants) {
        if (seen.has(variant.key)) continue;
        seen.add(variant.key);
        const entry = byChain.get(variant.chain) ?? {
            price: null,
            priceChange24hPercent: null,
            priceChange1hPercent: null,
            liquidity: null,
            volume24hUSD: null,
            trade24h: null,
            marketCap: null,
            fdv: null,
            circulatingSupply: null,
            totalSupply: null,
            variantCount: 0,
            issuedVariantCount: 0,
            excludedByIssuance: { bridged: 0, wrapped: 0, derivative: 0 },
            excludedCount: 0,
            excludedByQuality: emptyExcludedByQuality(),
        };
        entry.variantCount += 1;
        byChain.set(variant.chain, entry);
        const acc = accByChain.get(variant.chain) ?? emptyAccumulator();
        accByChain.set(variant.chain, acc);
        const quality = qualityByKey?.get(variant.key);
        if (quality && !quality.included) {
            entry.excludedCount += 1;
            countExcludedReasons(entry.excludedByQuality, quality);
            continue;
        }
        const market = marketByKey.get(variant.key);
        const variantIssuanceClass = issuance.get(variant.key) ?? variantIssuance(variant);
        if (!market && nativeHomeSupply && variantIssuanceClass === 'native' && variant.tags.includes(NATIVE_HOME_TAG)) {
            // The native coin's row on its issuing chain: no pool to read, so the
            // reference's supply is the chain's issued supply.
            entry.issuedVariantCount += 1;
            entry.marketCap = addFinite(entry.marketCap, nativeHomeSupply.marketCap);
            entry.fdv = addFinite(entry.fdv, nativeHomeSupply.fdv);
            entry.circulatingSupply = addFinite(entry.circulatingSupply, nativeHomeSupply.circulatingSupply);
            entry.totalSupply = addFinite(entry.totalSupply, nativeHomeSupply.totalSupply);
            continue;
        }
        entry.liquidity = addFinite(entry.liquidity, market?.liquidity);
        entry.volume24hUSD = addFinite(entry.volume24hUSD, market?.volume24hUSD);
        entry.trade24h = addFinite(entry.trade24h, market?.trade24h);
        const weight = activityWeight(market);
        const price = market?.price;
        const priceAcc =
            variantIssuanceClass === 'derivative'
                ? (derivativeAccByChain.get(variant.chain) ?? (derivativeAccByChain.set(variant.chain, emptyAccumulator()), derivativeAccByChain.get(variant.chain)!))
                : acc;
        if (typeof price === 'number' && Number.isFinite(price) && price > 0) accumulate(priceAcc.price, price, weight);
        accumulate(priceAcc.change24h, market?.priceChange24hPercent, weight);
        accumulate(priceAcc.change1h, market?.priceChange1hPercent, weight);
        if (variantIssuanceClass === 'native') {
            entry.issuedVariantCount += 1;
            entry.marketCap = addFinite(entry.marketCap, market?.marketCap);
            entry.fdv = addFinite(entry.fdv, market?.fdv);
            entry.circulatingSupply = addFinite(entry.circulatingSupply, market?.circulatingSupply);
            entry.totalSupply = addFinite(entry.totalSupply, market?.totalSupply);
        } else {
            entry.excludedByIssuance[variantIssuanceClass] += 1;
        }
    }
    const out: Partial<Record<ChainId, V2ChainStats>> = {};
    const accumulators = new Map<ChainId, ChainAccumulators>();
    for (const chain of CHAIN_KINDS) {
        const entry = byChain.get(chain);
        if (!entry) continue;
        const own = accByChain.get(chain) ?? emptyAccumulator();
        const derivative = derivativeAccByChain.get(chain) ?? emptyAccumulator();
        // Derivative prices only when nothing on the chain is priced in the asset's units.
        const acc = own.price.count > 0 ? own : derivative;
        accumulators.set(chain, { own, derivative });
        entry.price = weighted(acc.price);
        entry.priceChange24hPercent = weighted(acc.change24h);
        entry.priceChange1hPercent = weighted(acc.change1h);
        out[chain] = entry;
    }
    return { chainStats: out, accumulatorsByChain: accumulators };
}

/**
 * Cross-chain totals and averages. With `accumulatorsByChain` (from
 * `computeChainStatsDetailed`) each average carries exactly the weight of the
 * rows that had the field; without it the chain averages are weighted by the
 * chain's liquidity (else volume), which overstates a chain whose rows lack
 * the field, so callers with the variants at hand should pass it.
 */
export function aggregateChainStats(
    chainStats: Partial<Record<ChainId, V2ChainStats>>,
    accumulatorsByChain?: ReadonlyMap<ChainId, ChainAccumulators>,
): V2Aggregate {
    const out: V2Aggregate = {
        price: null,
        priceChange24hPercent: null,
        priceChange1hPercent: null,
        liquidity: null,
        volume24hUSD: null,
        trade24h: null,
        marketCap: null,
        fdv: null,
        circulatingSupply: null,
        totalSupply: null,
        variantCount: 0,
        issuedVariantCount: 0,
        excludedByIssuance: { bridged: 0, wrapped: 0, derivative: 0 },
        excludedCount: 0,
        excludedByQuality: emptyExcludedByQuality(),
        chainCount: 0,
        excludedFromSupplyCount: 0,
    };
    // Same rule as per chain: derivative rows (ETF shares, LSTs) only price the
    // asset when no chain has a row priced in its units, so an ETF-only chain
    // cannot mix its share price into another chain's spot price.
    const acc = emptyAccumulator();
    const derivativeAcc = emptyAccumulator();
    for (const [chain, entry] of Object.entries(chainStats) as Array<[ChainId, V2ChainStats | undefined]>) {
        if (!entry) continue;
        const chainAcc = accumulatorsByChain?.get(chain);
        if (chainAcc) {
            merge(acc.price, chainAcc.own.price);
            merge(acc.change24h, chainAcc.own.change24h);
            merge(acc.change1h, chainAcc.own.change1h);
            merge(derivativeAcc.price, chainAcc.derivative.price);
            merge(derivativeAcc.change24h, chainAcc.derivative.change24h);
            merge(derivativeAcc.change1h, chainAcc.derivative.change1h);
        } else {
            const weight = (entry.liquidity ?? 0) > 0 ? (entry.liquidity as number) : (entry.volume24hUSD ?? 0) > 0 ? (entry.volume24hUSD as number) : 0;
            accumulate(acc.price, entry.price, weight);
            accumulate(acc.change24h, entry.priceChange24hPercent, weight);
            accumulate(acc.change1h, entry.priceChange1hPercent, weight);
        }
        out.totalSupply = addFinite(out.totalSupply, entry.totalSupply);
        out.chainCount += 1;
        out.variantCount += entry.variantCount;
        out.issuedVariantCount += entry.issuedVariantCount;
        // Issuance only: rows the quality guard dropped are in excludedCount, not here.
        out.excludedFromSupplyCount +=
            entry.excludedByIssuance.bridged + entry.excludedByIssuance.wrapped + entry.excludedByIssuance.derivative;
        out.excludedByIssuance.bridged += entry.excludedByIssuance.bridged;
        out.excludedByIssuance.wrapped += entry.excludedByIssuance.wrapped;
        out.excludedByIssuance.derivative += entry.excludedByIssuance.derivative;
        out.excludedCount += entry.excludedCount;
        out.excludedByQuality.stale += entry.excludedByQuality.stale;
        out.excludedByQuality.dust += entry.excludedByQuality.dust;
        out.excludedByQuality.priceOutlier += entry.excludedByQuality.priceOutlier;
        out.liquidity = addFinite(out.liquidity, entry.liquidity);
        out.volume24hUSD = addFinite(out.volume24hUSD, entry.volume24hUSD);
        out.trade24h = addFinite(out.trade24h, entry.trade24h);
        out.marketCap = addFinite(out.marketCap, entry.marketCap);
        out.fdv = addFinite(out.fdv, entry.fdv);
        out.circulatingSupply = addFinite(out.circulatingSupply, entry.circulatingSupply);
    }
    const chosen = acc.price.count > 0 ? acc : derivativeAcc;
    out.price = weighted(chosen.price);
    out.priceChange24hPercent = weighted(chosen.change24h);
    out.priceChange1hPercent = weighted(chosen.change1h);
    return out;
}

export interface V2HeadlineReference {
    coingecko: CoingeckoPriceSnapshot | null;
    /** Stock snapshot plus the company market cap; only when one token is one share. */
    stock: (StockPriceResult & { marketCapUsd: number | null }) | null;
}

/**
 * Reference-first headline. Price, market cap, FDV, 24h change and supply come
 * from the off-chain reference when there is one (CoinGecko for crypto, the
 * stock feed for one-share-per-token equities); on-chain figures are reserved
 * for liquidity, DEX volume, trades and the 1h change, and for whatever the
 * reference does not carry. Every figure says where it came from in `source`.
 *
 * For an equity the company market cap is the headline and FDV is null (a
 * company has none; the tokenized float lives in `aggregate`), while supply is
 * the tokenized issued supply, labelled on-chain. Without a reference every
 * figure is the guarded, issuance-aware on-chain aggregate.
 */
export function selectV2HeadlineStats(args: {
    reference: V2HeadlineReference;
    onChain: V2Aggregate;
    volume30dUSD: number | null;
    volume30dScope?: V2Volume30dScope;
}): V2AssetStats | null {
    const { onChain } = args;
    const cg = args.reference.coingecko;
    const stock = args.reference.stock;
    const source: V2StatsSource = {};
    const pick = (
        key: keyof AssetStats,
        candidates: ReadonlyArray<[V2StatsSourceKind, number | null | undefined]>,
    ): number | null => {
        for (const [kind, value] of candidates) {
            const number = toFiniteNumberOrNull(value);
            if (number === null) continue;
            source[key] = kind;
            return number;
        }
        return null;
    };

    const stats: AssetStats = stock
        ? {
              price: pick('price', [['stock', stock.priceUsd], ['onchain', onChain.price]]),
              liquidity: pick('liquidity', [['onchain', onChain.liquidity]]),
              volume24hUSD: pick('volume24hUSD', [['onchain', onChain.volume24hUSD]]),
              volume30dUSD: pick('volume30dUSD', [['onchain', args.volume30dUSD]]),
              marketCap: pick('marketCap', [['stock', stock.marketCapUsd], ['onchain', onChain.marketCap]]),
              fdv: null,
              priceChange24hPercent: pick('priceChange24hPercent', [
                  ['stock', stock.priceChange24hPercent],
                  ['onchain', onChain.priceChange24hPercent],
              ]),
              priceChange1hPercent: pick('priceChange1hPercent', [['onchain', onChain.priceChange1hPercent]]),
              totalSupply: pick('totalSupply', [['onchain', onChain.totalSupply]]),
              circulatingSupply: pick('circulatingSupply', [['onchain', onChain.circulatingSupply]]),
          }
        : {
              price: pick('price', [['coingecko', cg?.priceUsd], ['onchain', onChain.price]]),
              liquidity: pick('liquidity', [['onchain', onChain.liquidity]]),
              volume24hUSD: pick('volume24hUSD', [['onchain', onChain.volume24hUSD]]),
              volume30dUSD: pick('volume30dUSD', [['onchain', args.volume30dUSD]]),
              marketCap: pick('marketCap', [['coingecko', cg?.marketCapUsd], ['onchain', onChain.marketCap]]),
              fdv: pick('fdv', [['coingecko', cg?.fdvUsd], ['onchain', onChain.fdv]]),
              priceChange24hPercent: pick('priceChange24hPercent', [
                  ['coingecko', cg?.priceChange24hPercent],
                  ['onchain', onChain.priceChange24hPercent],
              ]),
              priceChange1hPercent: pick('priceChange1hPercent', [['onchain', onChain.priceChange1hPercent]]),
              totalSupply: pick('totalSupply', [['coingecko', cg?.totalSupply], ['onchain', onChain.totalSupply]]),
              circulatingSupply: pick('circulatingSupply', [
                  ['coingecko', cg?.circulatingSupply],
                  ['onchain', onChain.circulatingSupply],
              ]),
          };
    const hasAny = Object.values(stats).some(value => typeof value === 'number' && Number.isFinite(value));
    return hasAny ? { ...stats, source, volume30dScope: stats.volume30dUSD === null ? null : (args.volume30dScope ?? 'solana') } : null;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface V2AssetBuildContext {
    request: Request;
    asset: AssetResult;
    /** Every variant of the asset on every chain (active only). */
    variants: readonly V2VariantResult[];
    marketByKey: ReadonlyMap<VariantKey, VariantMarketSnapshotResult>;
    rollupByChain: ReadonlyMap<ChainId, V2ChainRollupResult> | null;
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>;
    coingeckoPrice: CoingeckoPriceSnapshot | null;
    /** Prices of the coins variants link to, by coin id (detail surfaces); absent = `variant.reference` null. */
    variantCoingeckoPriceByCoinId?: ReadonlyMap<string, CoingeckoPriceSnapshot | null>;
    stockInstrument: StockInstrumentResult | null;
    stockPrice: StockPriceResult | null;
    preStocksByMint: ReadonlyMap<string, PreStocksMintSnapshot>;
    /** Requested strategy, or null for the per-asset default (equities → stock_redeemability). */
    requestedStrategy: V2PrimaryVariantStrategy | null;
    /** Primary candidate pool; absent = `executable`. */
    primaryScope?: V2PrimaryScope;
    /** Drop `blocked` variants before assembling (list surfaces). Detail keeps them. */
    hideBlocked: boolean;
    /** Narrow `variants[]` to one chain (stats stay cross-chain). */
    listChain: ChainId | null;
    includeVariants: boolean;
    rank: number | null;
    /** Requested `include=` enrichments; absent = no enrichment keys on the variants. */
    enrichments?: V2EnrichmentInputs;
    /** Clock for the freshness guard; absent = Date.now(). */
    nowMs?: number;
}

/** Inputs for the `include=` enrichments (mint-keyed: these pipelines are Solana-only today). */
export interface V2EnrichmentInputs {
    executionQualityByMint: ReadonlyMap<string, VariantExecutionQualitySnapshot> | null;
    stablecoinHealthByMint: ReadonlyMap<string, StablecoinHealth> | null;
    preStocks: boolean;
}

export function toV2ExecutionQuality(
    snapshot: VariantExecutionQualitySnapshot | null | undefined,
): V2ExecutionQuality | null {
    if (!snapshot) return null;
    const { quoteMint, ...rest } = snapshot;
    const out: V2ExecutionQuality = { ...rest, quoteKey: chainAddressKey('solana', quoteMint) };
    for (const [key, value] of Object.entries(out)) {
        if (typeof value === 'number' && !Number.isFinite(value)) (out as Record<string, unknown>)[key] = null;
    }
    return out;
}

export function toV2PegHealth(health: StablecoinHealth | null | undefined): V2PegHealth | null {
    const compact = toCompactPegHealth(health?.pegHealth);
    if (!compact) return null;
    return {
        provider: compact.provider ?? 'webacy',
        referenceKind: compact.referenceKind ?? 'fixed',
        tier: compact.tier,
        deviationPct: compact.deviationPct,
        updatedAt: compact.updatedAt,
        stale: compact.stale,
    };
}

export function toV2VariantPreStocks(
    snapshot: PreStocksMintSnapshot | null | undefined,
    onChainPriceUsd: number | null | undefined,
): V2VariantPreStocks | null {
    if (!snapshot) return null;
    const derived = computePreStocksDerived(snapshot, onChainPriceUsd);
    return {
        symbol: snapshot.symbol,
        markPriceUsd: snapshot.markPriceUsd,
        markValuationUsd: snapshot.markValuationUsd,
        impliedValuationUsd: derived.impliedValuationUsd,
        premiumToMarkPercent: derived.premiumToMarkPercent,
        lastFetchedAt: snapshot.lastFetchedAt,
    };
}

/** The enrichment keys for one variant (only the requested ones, `null` off-capability). */
export function variantEnrichments(
    variant: Pick<V2VariantResult, 'chain' | 'address'>,
    inputs: V2EnrichmentInputs | undefined,
    preStocksByMint: ReadonlyMap<string, PreStocksMintSnapshot>,
    onChainPriceUsd: number | null | undefined,
): V2VariantEnrichments {
    if (!inputs) return {};
    const out: V2VariantEnrichments = {};
    const solanaMint = variant.chain === 'solana' ? variant.address : null;
    if (inputs.executionQualityByMint) {
        out.executionQuality =
            chainSupports(variant.chain, 'executionQuality') && solanaMint
                ? toV2ExecutionQuality(inputs.executionQualityByMint.get(solanaMint))
                : null;
    }
    if (inputs.stablecoinHealthByMint) {
        out.pegHealth =
            chainSupports(variant.chain, 'risk') && solanaMint
                ? toV2PegHealth(inputs.stablecoinHealthByMint.get(solanaMint))
                : null;
    }
    if (inputs.preStocks) {
        out.preStocks = solanaMint ? toV2VariantPreStocks(preStocksByMint.get(solanaMint), onChainPriceUsd) : null;
    }
    return out;
}

/** Registry-keyed adapter: the ranking / aggregation helpers see the variant key as `mint`. */
function toRegistryVariant(
    variant: V2VariantResult,
    advisory: VariantAdvisory | null,
    symbol: string | null,
    name: string | null,
): AssetVariant {
    return {
        variantId: variant.variantId,
        mint: variant.key,
        ...(symbol ? { symbol } : {}),
        ...(name ? { name } : {}),
        kind: isVariantKind(variant.kind) ? variant.kind : 'spot',
        ...(variant.issuer ? { issuer: variant.issuer } : {}),
        ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
        trustTier: toTrustTier(variant.trustTier),
        tags: [...variant.tags],
        ...(variant.label ? { label: variant.label } : {}),
        ...(toStockVariantTier(variant.stockVariantTier)
            ? { stockVariantTier: toStockVariantTier(variant.stockVariantTier)! }
            : {}),
        advisory,
    };
}

function toCanonicalAsset(asset: AssetResult, variants: readonly AssetVariant[]): CanonicalAsset {
    return {
        assetId: asset.assetId,
        ...(asset.name ? { name: asset.name } : {}),
        ...(asset.symbol ? { symbol: asset.symbol } : {}),
        category: asset.category,
        aliases: asset.aliases,
        ...(asset.coingeckoId ? { coingeckoId: asset.coingeckoId } : {}),
        variants: [...variants],
    };
}

/** Compiled-registry identity (symbol / name / issuer) for a Solana mint, as v1 merges at read time. */
function registryIdentity(variant: V2VariantResult): {
    symbol?: string;
    name?: string;
    issuer?: string;
    issuerUrl?: string;
} {
    if (variant.chain !== 'solana') return {};
    const match = getVariantByMint(variant.address);
    if (!match) return {};
    const { symbol, name, issuer, issuerUrl } = match.variant;
    return {
        ...(symbol ? { symbol } : {}),
        ...(name ? { name } : {}),
        ...(issuer ? { issuer } : {}),
        ...(issuerUrl ? { issuerUrl } : {}),
    };
}

const ASSET_IDS_PREFERRING_REDEEMABLE_VARIANT_PRICE: ReadonlySet<string> = new Set(['tesla', 'nvidia', 'spacex']);

export function buildV2Asset(ctx: V2AssetBuildContext): V2Asset | null {
    const { asset, request } = ctx;
    const visible = ctx.hideBlocked
        ? ctx.variants.filter(v => !isHiddenVariant(v, ctx.advisoriesByMint))
        : [...ctx.variants];
    if (ctx.hideBlocked && visible.length === 0 && ctx.variants.length > 0) return null;

    const stockInstrument = ctx.stockInstrument;
    const responseSymbol = stockInstrument?.symbol ?? asset.symbol ?? null;
    const imageUrl = resolveAssetImageUrl(request, {
        assetId: asset.assetId,
        symbol: responseSymbol,
        imageUrl: asset.imageUrl ?? null,
    });

    // Identity per variant: registry (Solana) → market → label; same fallbacks as v1.
    const identityByKey = new Map<
        VariantKey,
        { symbol: string | null; name: string | null; issuer: string | null; issuerUrl: string | null }
    >();
    for (const variant of visible) {
        const registry = registryIdentity(variant);
        const market = ctx.marketByKey.get(variant.key);
        const symbol = resolveVariantSymbol({
            variantSymbol: registry.symbol,
            marketSymbol: market?.symbol,
            label: variant.label,
            canonicalSymbol: responseSymbol,
        });
        const name =
            optionalText(registry.name) ??
            optionalText(market?.name) ??
            optionalText(variant.label) ??
            (symbol || null);
        identityByKey.set(variant.key, {
            symbol: symbol || null,
            name,
            issuer: registry.issuer ?? variant.issuer,
            issuerUrl: registry.issuerUrl ?? variant.issuerUrl,
        });
    }

    const registryVariants = visible.map(variant => {
        const identity = identityByKey.get(variant.key)!;
        return toRegistryVariant(
            variant,
            advisoryForVariant(variant, ctx.advisoriesByMint),
            identity.symbol,
            identity.name,
        );
    });
    const canonical = toCanonicalAsset(asset, registryVariants);

    const tokenByKey = new Map<VariantKey, TokenMarketSnapshot>();
    for (const variant of ctx.variants) {
        const market = ctx.marketByKey.get(variant.key);
        if (!market) continue;
        tokenByKey.set(variant.key, tokenMarketSnapshotFromConvexMarket(variant.address, market));
    }
    const keyRank = new Map<string, number>();
    for (const [mint, rank] of buildCuratedMintRank()) keyRank.set(chainAddressKey('solana', mint), rank);
    const excludeKeys = new Set<string>();
    for (const mint of tradeRestrictedMints(getAdvisoriesByMintSync()))
        excludeKeys.add(chainAddressKey('solana', mint));

    const strategy: V2PrimaryVariantStrategy =
        ctx.requestedStrategy ?? (asset.category === 'equity' ? 'stock_redeemability' : 'liquidity');
    const rank = (pool: CanonicalAsset) =>
        pickPrimaryVariantWithRanking({
            asset: pool,
            mintRank: keyRank,
            marketByMint: tokenByKey,
            excludeMints: excludeKeys,
            options: { strategy, missingActivity: 'fail' },
        });
    const pick = (pool: CanonicalAsset) => rank(pool).variant;

    const priceSelectionAsset = ASSET_IDS_PREFERRING_REDEEMABLE_VARIANT_PRICE.has(asset.assetId)
        ? (() => {
              const redeemable = canonical.variants.filter(
                  v => v.stockVariantTier === 'share_redeemable' || v.stockVariantTier === 'cash_redeemable',
              );
              return redeemable.length > 0 ? { ...canonical, variants: redeemable } : canonical;
          })()
        : canonical;
    const scope = ctx.primaryScope ?? 'executable';
    const selection = selectPrimaryVariant(priceSelectionAsset, scope, tokenByKey, rank, v =>
        isPrimaryEligibleVariant(v, excludeKeys),
    );
    const primary = selection?.variant ?? null;
    const primaryByChain: Partial<Record<ChainId, AssetVariant>> = {};
    for (const chain of CHAIN_KINDS) {
        const pool = canonical.variants.filter(v => v.mint.startsWith(`${chain}:`));
        if (pool.length === 0) continue;
        const winner = pick({ ...canonical, variants: pool });
        if (winner) primaryByChain[chain] = winner;
    }

    const preStocksMints = selectPreStocksMints(visible.filter(v => v.chain === 'solana').map(v => v.address));
    const preStocksMarket =
        preStocksMints.length > 0
            ? buildPreStocksCanonicalMarket({
                  variantMints: preStocksMints,
                  preStocksByMint: ctx.preStocksByMint,
                  onChainPriceUsd: mint => tokenByKey.get(chainAddressKey('solana', mint))?.price,
              })
            : null;
    // The stock feed is a reference only when one token is one share: public
    // equities and exchange-traded funds. A commodity's ETF mapping (gold → GLD)
    // is a different instrument and never the headline.
    const stockUnitsMatchToken = isCanonicalPublicEquityAsset(canonical) || canonical.category === 'etf';
    const usesStockMarket = stockUnitsMatchToken && (stockInstrument !== null || !preStocksMarket);
    const coinId = normalizeCoinGeckoCoinIdForAsset({ assetId: asset.assetId, coinId: asset.coingeckoId }) ?? '';
    const stockSnapshot = usesStockMarket ? ctx.stockPrice : null;
    const coingeckoSnapshot = !usesStockMarket && coinId ? ctx.coingeckoPrice : null;

    // Quality guard: which rows may enter the sums and averages. The anchor is the
    // reference price in the token's units, else the rows' weighted median.
    const qualityReference = usesStockMarket
        ? { priceUsd: stockSnapshot?.priceUsd ?? null }
        : coingeckoSnapshot
          ? { priceUsd: coingeckoSnapshot.priceUsd }
          : null;
    // Sums, averages and the primary are computed from the FULL variant set so a
    // list (hideBlocked) and the detail of the same asset agree; hiding only
    // narrows what is listed.
    const issuanceByKey = variantIssuanceByKey(ctx.variants, asset.category);
    const qualityByKey = assessVariantMarkets(ctx.variants, ctx.marketByKey, qualityReference, ctx.nowMs ?? Date.now(), issuanceByKey);
    const nativeHomeSupply: NativeHomeSupply | null = coingeckoSnapshot
        ? {
              marketCap: coingeckoSnapshot.marketCapUsd,
              fdv: coingeckoSnapshot.fdvUsd,
              circulatingSupply: coingeckoSnapshot.circulatingSupply,
              totalSupply: coingeckoSnapshot.totalSupply,
          }
        : null;
    const { chainStats, accumulatorsByChain } = computeChainStatsDetailed(
        ctx.variants,
        ctx.marketByKey,
        ctx.rollupByChain,
        qualityByKey,
        nativeHomeSupply,
        issuanceByKey,
    );
    const aggregate = aggregateChainStats(chainStats, accumulatorsByChain);
    const volume30d = selectVolume30d(chainStats, ctx.rollupByChain, ctx.nowMs ?? Date.now());
    const stats = selectV2HeadlineStats({
        reference: {
            coingecko: coingeckoSnapshot,
            stock: stockSnapshot
                ? { ...stockSnapshot, marketCapUsd: computeCompanyMarketCapUsd(canonical, stockSnapshot) }
                : null,
        },
        onChain: aggregate,
        volume30dUSD: volume30d.volume30dUSD,
        volume30dScope: volume30d.scope,
    });

    const referenceMarket: V2ReferenceMarket | null = stockSnapshot
        ? {
              source: 'stock',
              symbol: stockInstrument?.symbol ?? asset.symbol ?? asset.assetId.toUpperCase(),
              price: stockSnapshot.priceUsd ?? null,
              marketCap: computeCompanyMarketCapUsd(canonical, stockSnapshot),
              volume24hUSD: stockSnapshot.volume24hUsd ?? null,
              priceChange24hPercent: stockSnapshot.priceChange24hPercent ?? null,
              asOf: stockSnapshot.asOf ?? null,
              lastFetchedAt: stockSnapshot.lastFetchedAt ?? null,
          }
        : preStocksMarket
          ? {
                source: 'prestocks',
                symbol: preStocksMarket.symbol,
                key: chainAddressKey('solana', preStocksMarket.mint),
                price: preStocksMarket.price,
                marketCap: preStocksMarket.marketCap,
                markPriceUsd: preStocksMarket.markPriceUsd,
                markValuationUsd: preStocksMarket.markValuationUsd,
                impliedValuationUsd: preStocksMarket.impliedValuationUsd,
                premiumToMarkPercent: preStocksMarket.premiumToMarkPercent,
                volume24hUSD: null,
                priceChange24hPercent: null,
                asOf: preStocksMarket.asOf,
                lastFetchedAt: preStocksMarket.lastFetchedAt,
            }
          : coingeckoSnapshot
            ? toCoinGeckoReference(coinId, coingeckoSnapshot)
            : null;
    const variantReference = (variant: V2VariantResult): V2CoinGeckoReference | null => {
        if (!variant.coingeckoId) return null;
        // The asset's own coin: its snapshot is loaded whether or not it is the
        // headline reference (an equity's referenceMarket is the stock feed, but
        // the chosen issuer's CoinGecko supply and cap are still this variant's).
        if (variant.coingeckoId === coinId) return ctx.coingeckoPrice ? toCoinGeckoReference(coinId, ctx.coingeckoPrice) : null;
        const snapshot = ctx.variantCoingeckoPriceByCoinId?.get(variant.coingeckoId);
        return snapshot === undefined ? null : toCoinGeckoReference(variant.coingeckoId, snapshot);
    };

    // Liquidity rank across chains (0-based), then the public variant objects.
    const ordered = [...visible].sort(
        (a, b) => (ctx.marketByKey.get(b.key)?.liquidity ?? 0) - (ctx.marketByKey.get(a.key)?.liquidity ?? 0),
    );
    const rankByKey = new Map<VariantKey, number>(ordered.map((v, index) => [v.key, index] as const));
    const publicByKey = new Map<VariantKey, V2Variant>();
    for (const variant of ordered) {
        const identity = identityByKey.get(variant.key)!;
        const market = ctx.marketByKey.get(variant.key) ?? null;
        const tiers = deriveVariantTierFields(market?.liquidity);
        publicByKey.set(variant.key, {
            key: variant.key,
            chain: variant.chain,
            address: variant.address,
            assetId: asset.assetId,
            variantId: variant.variantId,
            kind: isVariantKind(variant.kind) ? variant.kind : 'spot',
            issuance: issuanceByKey.get(variant.key) ?? variantIssuance(variant),
            symbol: identity.symbol,
            name: identity.name,
            label: variant.label,
            decimals: variant.decimals ?? toFiniteNumberOrNull(market?.decimals),
            logoURI: optionalText(market?.logoURI) ?? imageUrl,
            issuer: identity.issuer,
            issuerUrl: identity.issuerUrl,
            trustTier: tiers.trustTier,
            liquidityTier: tiers.liquidityTier,
            stockVariantTier: toStockVariantTier(variant.stockVariantTier),
            tags: [...variant.tags],
            advisory: toV2Advisory(advisoryForVariant(variant, ctx.advisoriesByMint)),
            rank: rankByKey.get(variant.key) ?? 0,
            explorerUrl: explorerTokenUrl(variant.chain, variant.address),
            market: toV2Market(market, qualityByKey.get(variant.key)),
            coingeckoId: variant.coingeckoId,
            reference: variantReference(variant),
            ...variantEnrichments(variant, ctx.enrichments, ctx.preStocksByMint, market?.price),
        });
    }

    // Advisories: from the full (unhidden) set so hidden siblings are still named.
    const advisories: V2AssetAdvisory[] = [];
    for (const variant of ctx.variants) {
        const advisory = toV2Advisory(advisoryForVariant(variant, ctx.advisoriesByMint));
        if (!advisory) continue;
        advisories.push({
            ...advisory,
            key: variant.key,
            chain: variant.chain,
            address: variant.address,
            variantId: variant.variantId,
        });
    }
    const severity = { blocked: 0, compromised: 1, caution: 2 } as const;
    advisories.sort((a, b) => severity[a.status] - severity[b.status] || a.key.localeCompare(b.key));

    const chains = CHAIN_KINDS.filter(chain => visible.some(v => v.chain === chain));
    const primaryVariantByChain: Partial<Record<ChainId, V2Variant>> = {};
    for (const chain of chains) {
        const winner = primaryByChain[chain];
        const out = winner ? publicByKey.get(winner.mint) : undefined;
        if (out) primaryVariantByChain[chain] = out;
    }
    const listed = ctx.listChain ? ordered.filter(v => v.chain === ctx.listChain) : ordered;
    const symbols = uniqueStrings([responseSymbol ?? '', ...ordered.map(v => identityByKey.get(v.key)?.symbol ?? '')]);

    return {
        assetId: asset.assetId,
        name: asset.name ?? null,
        symbol: responseSymbol,
        description: optionalText(asset.description),
        category: asset.category,
        aliases: [...asset.aliases],
        symbols,
        imageUrl,
        coingeckoId: coinId || null,
        chains,
        stats,
        chainStats,
        aggregate,
        referenceMarket,
        advisories,
        primaryVariantStrategy: strategy,
        primaryScope: scope,
        primaryVariantSelection: selection ? { pool: selection.pool, reason: selection.reason } : null,
        primaryVariant: primary ? (publicByKey.get(primary.mint) ?? null) : null,
        primaryVariantByChain,
        rank: ctx.rank,
        ...(ctx.includeVariants ? { variants: listed.map(v => publicByKey.get(v.key)!) } : {}),
    };
}

const PRIMARY_POOLS: Record<V2PrimaryScope, readonly V2PrimaryVariantPool[]> = {
    executable: ['executable_active', 'active', 'executable', 'all'],
    global: ['active', 'all'],
};

/**
 * Ranks the primary inside the first non-empty pool for `scope`. Executable
 * chains come from `CHAINS` capabilities (`swap`), never a chain literal, so a
 * chain gains primary eligibility by config. Pools only narrow the candidates;
 * ranking inside a pool is the registry's (liquidity / redeemability / …).
 */
function selectPrimaryVariant(
    asset: CanonicalAsset,
    scope: V2PrimaryScope,
    marketByKey: ReadonlyMap<VariantKey, TokenMarketSnapshot>,
    rank: (pool: CanonicalAsset) => ReturnType<typeof pickPrimaryVariantWithRanking>,
    isEligible: (variant: AssetVariant) => boolean,
): (ReturnType<typeof pickPrimaryVariantWithRanking> & { pool: V2PrimaryVariantPool }) | null {
    const executable = (v: AssetVariant) => {
        const chain = v.mint.slice(0, v.mint.indexOf(':'));
        return isChainKind(chain) && chainSupports(chain, 'swap');
    };
    const active = (v: AssetVariant) => hasPrimaryActivity(marketByKey.get(v.mint));
    const filters: Record<V2PrimaryVariantPool, (v: AssetVariant) => boolean> = {
        executable_active: v => executable(v) && active(v),
        active,
        executable,
        all: () => true,
    };
    // `rank` only demotes advisory-flagged variants within the pool it is handed, so a pool whose
    // sole member is flagged would win outright. A flagged winner is remembered but the later
    // pools still get a chance to produce a safe sibling; it is returned only if none does.
    let flaggedFallback: (ReturnType<typeof pickPrimaryVariantWithRanking> & { pool: V2PrimaryVariantPool }) | null =
        null;
    for (const pool of PRIMARY_POOLS[scope]) {
        const variants = asset.variants.filter(filters[pool]);
        if (variants.length === 0) continue;
        const result = rank({ ...asset, variants });
        if (!result.variant) continue;
        if (isEligible(result.variant)) return { ...result, pool };
        flaggedFallback ??= { ...result, pool };
    }
    return flaggedFallback;
}

/**
 * A variant on its own, without its asset's full variant set (batch lookups):
 * same identity / market / advisory rules as `buildV2Asset`, `rank` null.
 */
export function buildStandaloneV2Variant(ctx: {
    request: Request;
    variant: V2VariantResult;
    market: VariantMarketSnapshotResult | null;
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>;
    canonicalSymbol: string | null;
    /** Price of the variant's own CoinGecko coin, when loaded; absent = `reference` null. */
    coingeckoPrice?: CoingeckoPriceSnapshot | null;
    /** Clock for the staleness check; defaults to `Date.now()`. */
    nowMs?: number;
}): V2Variant {
    const { variant, market } = ctx;
    const registry = registryIdentity(variant);
    const symbol = resolveVariantSymbol({
        variantSymbol: registry.symbol,
        marketSymbol: market?.symbol,
        label: variant.label,
        canonicalSymbol: ctx.canonicalSymbol,
    });
    const name =
        optionalText(registry.name) ?? optionalText(market?.name) ?? optionalText(variant.label) ?? (symbol || null);
    const tiers = deriveVariantTierFields(market?.liquidity);
    return {
        key: variant.key,
        chain: variant.chain,
        address: variant.address,
        assetId: variant.assetId,
        variantId: variant.variantId,
        kind: isVariantKind(variant.kind) ? variant.kind : 'spot',
        // On its own: without the siblings a standalone fund's yield token reads
        // as derivative here; the asset detail (`variantIssuanceByKey`) is authoritative.
        issuance: variantIssuance(variant),
        symbol: symbol || null,
        name,
        label: variant.label,
        decimals: variant.decimals ?? toFiniteNumberOrNull(market?.decimals),
        logoURI: optionalText(market?.logoURI),
        issuer: registry.issuer ?? variant.issuer,
        issuerUrl: registry.issuerUrl ?? variant.issuerUrl,
        trustTier: tiers.trustTier,
        liquidityTier: tiers.liquidityTier,
        stockVariantTier: toStockVariantTier(variant.stockVariantTier),
        tags: [...variant.tags],
        advisory: toV2Advisory(advisoryForVariant(variant, ctx.advisoriesByMint)),
        rank: null,
        explorerUrl: explorerTokenUrl(variant.chain, variant.address),
        // The row's own verdict (stale; dust is relative and a lone row is kept):
        // the asset-level outlier pass needs the siblings, which a batch lookup does not load.
        market: toV2Market(
            market,
            assessVariantMarkets([variant], new Map(market ? [[variant.key, market]] : []), null, ctx.nowMs ?? Date.now()).get(variant.key),
        ),
        coingeckoId: variant.coingeckoId,
        reference:
            variant.coingeckoId && ctx.coingeckoPrice !== undefined
                ? toCoinGeckoReference(variant.coingeckoId, ctx.coingeckoPrice)
                : null,
    };
}

export function toV2AssetSummary(asset: V2Asset): V2AssetSummary {
    return {
        assetId: asset.assetId,
        name: asset.name,
        symbol: asset.symbol,
        category: asset.category,
        imageUrl: asset.imageUrl,
        chains: asset.chains,
    };
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

/** PreStocks reference rows for the Solana variants of `variants`, fresh ones only. */
export function preStocksMintsOf(variants: readonly V2VariantResult[]): string[] {
    return selectPreStocksMints(variants.filter(v => v.chain === 'solana').map(v => v.address));
}

export function preStocksMapFrom(entries: ReadonlyArray<{ mint: string; snapshot: PrestocksPriceResult | null }>) {
    return freshPreStocksByMint(entries);
}

/** Stale-fallback health: a list is hollow when fewer than half the rows carry stats. */
export function assetsResponseLooksHealthy(payload: V2AssetsResponse): boolean {
    if (payload.assets.length === 0) return payload.total === 0;
    const withStats = payload.assets.filter(asset => asset.stats !== null).length;
    return withStats * 2 >= payload.assets.length;
}
