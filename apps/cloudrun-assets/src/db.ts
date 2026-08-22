import postgres, { type Sql } from 'postgres';

import type { AssetAliasRow, AssetRow, AssetVariantRow, AssetsRepo } from './handlers/assets';
import type {
    ApiRequestEvent,
    AssetVariantSummary,
    AssetVariantsForRollup,
    CuratedMintsSource,
    JobsRepo,
    OhlcvCandle,
    OhlcvUpsertResult,
} from './handlers/crons';
import type {
    CoingeckoCuratedSource,
    CoingeckoOhlcvCandle,
    CoingeckoOhlcvInterval,
    CoingeckoOhlcvUpsertResult,
    CoingeckoRepo,
} from './handlers/crons.coingecko';
import type { ActiveStockMapping, ClickhouseRepo } from './handlers/crons.clickhouse';
import type { MiscJobsRepo } from './handlers/crons.misc';
import type { AssetDeletionTombstonesRepo } from './handlers/assetDeletionTombstones';
import type { SanctumLstRow, SanctumLstsRepo } from './handlers/sanctumLsts';
import type { AssetMarketRow, AssetMarketsRepo } from './handlers/assetMarkets';
import type { VariantMarketRow, VariantMarketsRepo } from './handlers/variantMarkets';
import type { AssetVariantDocRow, AssetVariantsRepo, TokenMarketRow } from './handlers/assetVariants';
import type { StockInstrumentRow, StockPriceRow, StockReadsRepo } from './handlers/stockReads';
import type { OhlcvCandleRow, OhlcvReadsRepo, TimeInterval } from './handlers/ohlcvReads';
import type { PrestocksPriceRow, PrestocksReadsRepo } from './handlers/prestocksReads';
import type { PrestocksRepo } from './handlers/crons.prestocks';
import type {
    AssetsApiAssetMarketRow,
    AssetsApiAssetRow,
    AssetsApiCoingeckoCoinRow,
    AssetsApiFillQualityRow,
    AssetsApiRepo,
    AssetsApiStockInstrumentRow,
    AssetsApiStockPriceRow,
    AssetsApiVariantMarketRow,
    AssetsApiVariantRow,
} from './handlers/assetsApi';
import type {
    CoingeckoCoinRow,
    CoingeckoCoinSearchRow,
    CoingeckoOhlcvRow,
    CoingeckoPriceLatestRow,
    CoingeckoReadsRepo,
    CoingeckoTickersLatestRow,
} from './handlers/coingeckoReads';
import type {
    TokenRow,
    TokenMarketsLatestRow,
    TokenDescriptionSummaryRow,
    TokensReadsRepo,
} from './handlers/tokensReads';
import type { TrendingMarketRow, FreshTrendingMarketRow, TrendingReadsRepo } from './handlers/trendingReads';
import type { FillQualityRow, FillQualityReadsRepo } from './handlers/fillQualityReads';
import type { AssetCollectionMemberRow, AssetCollectionsReadsRepo } from './handlers/assetCollectionsReads';
import type {
    TokenListMemberRow,
    TokenListRow,
    TokenListSummaryRow,
    TokenListsReadsRepo,
} from './handlers/tokenListsReads';
import {
    SlugConflictError,
    type TokenListMutationRow,
    type TokenListsMutationsRepo,
} from './handlers/tokenListsMutations';
import type { CacheWarmAssetsRepo } from './handlers/cacheWarm';
import { MintConflictError, VariantIdConflictError, type AdminActionsRepo } from './handlers/adminActions';
import type { SeedRepo } from './handlers/crons.seed';
import type { TrendingRepo } from './handlers/crons.trending';
import type { ClickhouseExtrasRepo } from './handlers/crons.clickhouse.extras';

let cached: Sql | null = null;

function positiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
        console.warn(
            JSON.stringify({
                event: 'env_invalid_value',
                name,
                raw,
                used: fallback,
            }),
        );
        return fallback;
    }
    return parsed;
}

export function getSql(): Sql {
    if (cached) return cached;
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error('DATABASE_URL must be set');
    const serviceRole = process.env.SERVICE_ROLE?.trim() === 'worker' ? 'worker' : 'api';
    cached = postgres(url, {
        max: positiveIntegerEnv('PG_POOL_MAX', serviceRole === 'worker' ? 8 : 16),
        idle_timeout: positiveIntegerEnv('PG_IDLE_TIMEOUT', 240),
        connect_timeout: positiveIntegerEnv('PG_CONNECT_TIMEOUT', 3),
        connection: {
            application_name: serviceRole === 'worker' ? 'cloudrun-assets-jobs' : 'cloudrun-assets',
        },
        types: {
            bigint: {
                to: 20,
                from: [20],
                serialize: (x: number | bigint) => String(x),
                parse: (x: string) => Number(x),
            },
        },
    });
    return cached;
}

export function buildPrefixTsQuery(query: string): string | null {
    const tokens = query
        .trim()
        .split(/\s+/)
        .map(t => t.replace(/[^a-zA-Z0-9]/g, ''))
        .filter(t => t.length > 0);
    if (tokens.length === 0) return null;
    return tokens.map(t => `${t}:*`).join(' & ');
}

export function makePostgresAssetsRepo(sql: Sql): AssetsRepo {
    return {
        async findByAssetId(assetId) {
            const rows = await sql<AssetRow[]>`
                SELECT id, asset_id, category, name, symbol, aliases,
                       coingecko_id, description, image_url, is_active,
                       created_at, updated_at
                FROM assets
                WHERE asset_id = ${assetId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },

        async findByAssetIds(assetIds) {
            if (assetIds.length === 0) return [];
            const rows = await sql<AssetRow[]>`
                SELECT id, asset_id, category, name, symbol, aliases,
                       coingecko_id, description, image_url, is_active,
                       created_at, updated_at
                FROM assets
                WHERE asset_id IN ${sql(assetIds)}
            `;
            return rows;
        },

        async findAliasesByNormalized(normalized, limit) {
            const rows = await sql<AssetAliasRow[]>`
                SELECT alias, normalized, asset_id, priority
                FROM asset_aliases
                WHERE normalized = ${normalized}
                LIMIT ${limit}
            `;
            return rows;
        },

        async findAliasesByFuzzy(query, limit) {
            const tsq = buildPrefixTsQuery(query) ?? 'noresultsentinel:*';
            const pattern = `%${query}%`;
            const rows = await sql<AssetAliasRow[]>`
                SELECT alias, normalized, asset_id, priority
                FROM asset_aliases
                WHERE to_tsvector('english', alias) @@ to_tsquery('english', ${tsq})
                   OR alias ILIKE ${pattern}
                ORDER BY ts_rank_cd(to_tsvector('english', alias), to_tsquery('english', ${tsq})) DESC,
                         priority DESC,
                         length(alias) ASC,
                         alias ASC
                LIMIT ${limit}
            `;
            return rows;
        },

        async findAssetsByNameFuzzy(query, limit) {
            const tsq = buildPrefixTsQuery(query) ?? 'noresultsentinel:*';
            const pattern = `%${query}%`;
            const rows = await sql<AssetRow[]>`
                SELECT id, asset_id, category, name, symbol, aliases,
                       coingecko_id, description, image_url, is_active,
                       created_at, updated_at
                FROM assets
                WHERE to_tsvector('english', coalesce(name, '')) @@ to_tsquery('english', ${tsq})
                   OR coalesce(name, '') ILIKE ${pattern}
                ORDER BY ts_rank_cd(to_tsvector('english', coalesce(name, '')), to_tsquery('english', ${tsq})) DESC,
                         length(coalesce(name, '')) ASC,
                         asset_id ASC
                LIMIT ${limit}
            `;
            return rows;
        },

        async findAssetsBySymbolFuzzy(query, limit) {
            const tsq = buildPrefixTsQuery(query) ?? 'noresultsentinel:*';
            const pattern = `%${query}%`;
            const rows = await sql<AssetRow[]>`
                SELECT id, asset_id, category, name, symbol, aliases,
                       coingecko_id, description, image_url, is_active,
                       created_at, updated_at
                FROM assets
                WHERE to_tsvector('english', coalesce(symbol, '')) @@ to_tsquery('english', ${tsq})
                   OR coalesce(symbol, '') ILIKE ${pattern}
                ORDER BY ts_rank_cd(to_tsvector('english', coalesce(symbol, '')), to_tsquery('english', ${tsq})) DESC,
                         length(coalesce(symbol, '')) ASC,
                         asset_id ASC
                LIMIT ${limit}
            `;
            return rows;
        },

        async findVariantByMint(mint) {
            const rows = await sql<AssetVariantRow[]>`
                SELECT asset_id, mint, is_active
                FROM asset_variants
                WHERE mint = ${mint}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },

        async isDeletedRef(normalizedRef) {
            if (!normalizedRef) return false;
            const rows = await sql<{ exists: boolean }[]>`
                SELECT 1 AS exists
                FROM asset_deletion_tombstones
                WHERE normalized_ref = ${normalizedRef}
                LIMIT 1
            `;
            return rows.length > 0;
        },

        async listByCategory(category, includeInactive, limit) {
            if (includeInactive) {
                const rows = await sql<AssetRow[]>`
                    SELECT id, asset_id, category, name, symbol, aliases,
                           coingecko_id, description, image_url, is_active,
                           created_at, updated_at
                    FROM assets
                    WHERE category = ${category}
                    ORDER BY asset_id ASC
                    LIMIT ${limit}
                `;
                return rows;
            }
            const rows = await sql<AssetRow[]>`
                SELECT id, asset_id, category, name, symbol, aliases,
                       coingecko_id, description, image_url, is_active,
                       created_at, updated_at
                FROM assets
                WHERE category = ${category} AND is_active = true
                ORDER BY asset_id ASC
                LIMIT ${limit}
            `;
            return rows;
        },

        async listActiveWithCoinGecko(limit) {
            const rows = await sql<AssetRow[]>`
                SELECT id, asset_id, category, name, symbol, aliases,
                       coingecko_id, description, image_url, is_active,
                       created_at, updated_at
                FROM assets
                WHERE is_active = true
                  AND coingecko_id IS NOT NULL
                  AND length(trim(coingecko_id)) > 0
                ORDER BY asset_id ASC
                LIMIT ${limit}
            `;
            return rows;
        },

        async setDescriptionByAssetId(assetId, description, updatedAt) {
            const rows = await sql<{ asset_id: string }[]>`
                UPDATE assets
                SET description = ${description},
                    updated_at = ${updatedAt}
                WHERE asset_id = ${assetId}
                  AND description IS DISTINCT FROM ${description}
                RETURNING asset_id
            `;
            return rows.length > 0;
        },
    };
}

export function makePostgresCacheWarmAssetsRepo(sql: Sql): CacheWarmAssetsRepo {
    return {
        async setImageUrlByAssetId(assetId, imageUrl, updatedAt) {
            const rows = await sql<{ asset_id: string }[]>`
                UPDATE assets
                SET image_url = ${imageUrl},
                    updated_at = ${updatedAt}
                WHERE asset_id = ${assetId}
                  AND image_url IS DISTINCT FROM ${imageUrl}
                RETURNING asset_id
            `;
            return rows.length > 0;
        },
    };
}

function randomId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const CURATED_COLLECTION_SLUGS: readonly string[] = [
    'majors',
    'currencies',
    'lsts',
    'rwas',
    'etfs',
    'stocks',
    'metals',
];
const CURATED_COLLECTION_SLUGS_SQL_LITERAL = `ARRAY[${CURATED_COLLECTION_SLUGS.map(s => `'${s}'`).join(',')}]::text[]`;

const CURATED_MINTS_TTL_MS = Number(process.env.CURATED_MINTS_TTL_MS) || 60 * 60_000;

export function makePostgresCuratedMintsSource(sql: Sql): CuratedMintsSource & { warmup(): Promise<void> } {
    let cachedMints: string[] | null = null;
    let cachedRank: Map<string, number> | null = null;
    let loadedAtMs = 0;
    let inflight: Promise<void> | null = null;

    async function load(): Promise<void> {
        const rows = await sql<{ mint: string; slug: string; rank: number }[]>`
            SELECT av.mint AS mint, acm.collection_slug AS slug, acm.rank AS rank
            FROM asset_collection_members acm
            JOIN asset_variants av
                ON av.asset_id = acm.asset_id
               AND av.is_active = true
            WHERE acm.collection_slug IN ${sql(CURATED_COLLECTION_SLUGS)}
            ORDER BY
                -- Yield variants (LSTs) last: the solana asset alone has >1400 of
                -- them, which would otherwise exhaust downstream maxMints caps
                -- before any other curated asset is reached.
                (av.kind = 'yield') ASC,
                array_position(
                    ${sql.unsafe(CURATED_COLLECTION_SLUGS_SQL_LITERAL)},
                    acm.collection_slug
                ),
                acm.rank ASC, av.mint ASC
        `;
        const seen = new Set<string>();
        const out: string[] = [];
        const rank = new Map<string, number>();
        for (const row of rows) {
            const mint = row.mint.trim();
            if (!mint || seen.has(mint)) continue;
            seen.add(mint);
            rank.set(mint, out.length);
            out.push(mint);
        }
        cachedMints = out;
        cachedRank = rank;
        loadedAtMs = Date.now();
    }

    function refreshIfStale(): void {
        if (inflight) return;
        if (cachedMints && Date.now() - loadedAtMs < CURATED_MINTS_TTL_MS) return;
        inflight = load()
            .catch(err => {
                console.error('[cloudrun-assets] curated mints refresh failed', err);
            })
            .finally(() => {
                inflight = null;
            });
    }

    return {
        async warmup() {
            if (!cachedMints) await load();
        },
        getAllCuratedMintsInOrder(): string[] {
            refreshIfStale();
            return cachedMints ?? [];
        },
        getCuratedMintRank(): Map<string, number> {
            refreshIfStale();
            return cachedRank ?? new Map();
        },
    };
}

interface VariantRollupRow {
    asset_id: string;
    mint: string;
    chain: string;
    kind: string;
    trust_tier: string;
    liquidity: number | null;
    volume_24h_usd: number | null;
    last_fetched_at: number | null;
}

async function findRwaXyzAssetLatestByAssetIdImpl(
    sql: Sql,
    assetId: number,
): Promise<import('./handlers/crons').RwaXyzAssetLatestExisting | null> {
    const rows = await sql<
        {
            asset_id: number;
            name: string | null;
            ticker: string | null;
            slug: string | null;
            icon_url: string | null;
            website: string | null;
            issuer_id: string | null;
            issuer_name: string | null;
            asset_class_id: number | null;
            asset_class_name: string | null;
            asset_class_slug: string | null;
            payload_json: string | null;
            last_fetched_at: number;
        }[]
    >`
        SELECT asset_id, name, ticker, slug, icon_url, website, issuer_id, issuer_name,
               asset_class_id, asset_class_name, asset_class_slug, payload_json, last_fetched_at
        FROM rwa_xyz_assets_latest
        WHERE asset_id = ${assetId}
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        assetId: row.asset_id,
        name: row.name,
        ticker: row.ticker,
        slug: row.slug,
        iconUrl: row.icon_url,
        website: row.website,
        issuerId: row.issuer_id,
        issuerName: row.issuer_name,
        assetClassId: row.asset_class_id,
        assetClassName: row.asset_class_name,
        assetClassSlug: row.asset_class_slug,
        payloadJson: row.payload_json,
        lastFetchedAt: row.last_fetched_at,
    };
}

async function findRwaXyzTokenLatestByNetworkAndAddressImpl(
    sql: Sql,
    networkSlug: string,
    address: string,
): Promise<import('./handlers/crons').RwaXyzTokenLatestExisting | null> {
    const trimmed = address.trim();
    if (!trimmed) return null;
    const rows = await sql<
        {
            network_slug: string;
            address: string;
            rwa_id: number | null;
            rwa_token_id: number | null;
            asset_id: number | null;
            name: string | null;
            decimals: number | null;
            price_dollar: number | null;
            market_value_dollar: number | null;
            net_asset_value_dollar: number | null;
            total_asset_value_dollar: number | null;
            circulating_asset_value_dollar: number | null;
            circulating_market_value_dollar: number | null;
            apy_7_day: number | null;
            apy_30_day: number | null;
            total_supply_token: number | null;
            circulating_supply_token: number | null;
            holding_addresses_count: number | null;
            payload_json: string | null;
            last_fetched_at: number;
        }[]
    >`
        SELECT network_slug, address, rwa_id, rwa_token_id, asset_id, name, decimals,
               price_dollar, market_value_dollar, net_asset_value_dollar, total_asset_value_dollar,
               circulating_asset_value_dollar, circulating_market_value_dollar,
               apy_7_day, apy_30_day, total_supply_token, circulating_supply_token,
               holding_addresses_count, payload_json, last_fetched_at
        FROM rwa_xyz_tokens_latest
        WHERE network_slug = ${networkSlug}
          AND address = ${trimmed}
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        networkSlug: row.network_slug,
        address: row.address,
        rwaId: row.rwa_id,
        rwaTokenId: row.rwa_token_id,
        assetId: row.asset_id,
        name: row.name,
        decimals: row.decimals,
        priceDollar: row.price_dollar,
        marketValueDollar: row.market_value_dollar,
        netAssetValueDollar: row.net_asset_value_dollar,
        totalAssetValueDollar: row.total_asset_value_dollar,
        circulatingAssetValueDollar: row.circulating_asset_value_dollar,
        circulatingMarketValueDollar: row.circulating_market_value_dollar,
        apy7Day: row.apy_7_day,
        apy30Day: row.apy_30_day,
        totalSupplyToken: row.total_supply_token,
        circulatingSupplyToken: row.circulating_supply_token,
        holdingAddressesCount: row.holding_addresses_count,
        payloadJson: row.payload_json,
        lastFetchedAt: row.last_fetched_at,
    };
}

export function makePostgresJobsRepo(sql: Sql): JobsRepo {
    return {
        async upsertVariantMarketFromBirdeye(args) {
            const birdeyeJson = {
                source: 'birdeye',
                symbol: args.symbol,
                name: args.name,
                decimals: args.decimals,
                ...(args.logoURI ? { logoURI: args.logoURI } : {}),
                ...(args.price !== undefined ? { price: args.price } : {}),
                ...(args.priceChange24hPercent !== undefined
                    ? { priceChange24hPercent: args.priceChange24hPercent }
                    : {}),
                ...(args.priceChange1hPercent !== undefined ? { priceChange1hPercent: args.priceChange1hPercent } : {}),
                ...(args.volume1hUSD !== undefined ? { volume1hUSD: args.volume1hUSD } : {}),
                ...(args.volume24hUSD !== undefined ? { volume24hUSD: args.volume24hUSD } : {}),
                ...(args.trade1h !== undefined ? { trade1h: args.trade1h } : {}),
                ...(args.trade24h !== undefined ? { trade24h: args.trade24h } : {}),
                ...(args.uniqueWallet1h !== undefined ? { uniqueWallet1h: args.uniqueWallet1h } : {}),
                ...(args.uniqueWallet24h !== undefined ? { uniqueWallet24h: args.uniqueWallet24h } : {}),
                ...(args.liquidity !== undefined ? { liquidity: args.liquidity } : {}),
                ...(args.marketCap !== undefined ? { marketCap: args.marketCap } : {}),
                ...(args.fdv !== undefined ? { fdv: args.fdv } : {}),
                ...(args.holder !== undefined ? { holder: args.holder } : {}),
                ...(args.totalSupply !== undefined ? { totalSupply: args.totalSupply } : {}),
                ...(args.circulatingSupply !== undefined ? { circulatingSupply: args.circulatingSupply } : {}),
                ...(args.lastTradeHumanTime !== undefined ? { lastTradeHumanTime: args.lastTradeHumanTime } : {}),
                ...(args.lastTradeAt !== undefined ? { lastTradeAt: args.lastTradeAt } : {}),
                ...(args.extensions !== undefined ? { extensions: args.extensions } : {}),
                lastFetchedAt: args.lastFetchedAt,
            };
            await sql`
                INSERT INTO variant_markets_latest (
                    id, mint, source, metrics_source,
                    birdeye_metrics,
                    symbol, name, decimals, logo_uri,
                    price, liquidity,
                    volume_1h_usd, volume_24h_usd,
                    trade_1h, trade_24h,
                    unique_wallet_1h, unique_wallet_24h,
                    market_cap, fdv,
                    price_change_24h_percent, price_change_1h_percent,
                    holder, total_supply, circulating_supply,
                    last_trade_human_time, extensions,
                    last_trade_at, last_fetched_at, overview_last_fetched_at
                )
                VALUES (
                    ${randomId('vml')}, ${args.mint}, 'birdeye', 'birdeye',
                    ${sql.json(birdeyeJson)},
                    ${args.symbol}, ${args.name}, ${args.decimals}, ${args.logoURI ?? null},
                    ${args.price ?? null}, ${args.liquidity ?? null},
                    ${args.volume1hUSD ?? null}, ${args.volume24hUSD ?? null},
                    ${args.trade1h ?? null}, ${args.trade24h ?? null},
                    ${args.uniqueWallet1h ?? null}, ${args.uniqueWallet24h ?? null},
                    ${args.marketCap ?? null}, ${args.fdv ?? null},
                    ${args.priceChange24hPercent ?? null}, ${args.priceChange1hPercent ?? null},
                    ${args.holder ?? null}, ${args.totalSupply ?? null}, ${args.circulatingSupply ?? null},
                    ${args.lastTradeHumanTime ?? null},
                    ${args.extensions ? sql.json(args.extensions) : null},
                    ${args.lastTradeAt ?? null}, ${args.lastFetchedAt}, ${args.lastFetchedAt}
                )
                ON CONFLICT (mint) DO UPDATE SET
                    source = EXCLUDED.source,
                    metrics_source = EXCLUDED.metrics_source,
                    birdeye_metrics = EXCLUDED.birdeye_metrics,
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    decimals = EXCLUDED.decimals,
                    logo_uri = EXCLUDED.logo_uri,
                    price = EXCLUDED.price,
                    liquidity = EXCLUDED.liquidity,
                    volume_1h_usd = EXCLUDED.volume_1h_usd,
                    volume_24h_usd = EXCLUDED.volume_24h_usd,
                    trade_1h = EXCLUDED.trade_1h,
                    trade_24h = EXCLUDED.trade_24h,
                    unique_wallet_1h = EXCLUDED.unique_wallet_1h,
                    unique_wallet_24h = EXCLUDED.unique_wallet_24h,
                    market_cap = EXCLUDED.market_cap,
                    fdv = EXCLUDED.fdv,
                    price_change_24h_percent = EXCLUDED.price_change_24h_percent,
                    price_change_1h_percent = EXCLUDED.price_change_1h_percent,
                    holder = EXCLUDED.holder,
                    total_supply = EXCLUDED.total_supply,
                    circulating_supply = EXCLUDED.circulating_supply,
                    last_trade_human_time = EXCLUDED.last_trade_human_time,
                    extensions = EXCLUDED.extensions,
                    last_trade_at = EXCLUDED.last_trade_at,
                    last_fetched_at = EXCLUDED.last_fetched_at,
                    overview_last_fetched_at = EXCLUDED.overview_last_fetched_at
            `;
        },

        async touchVariantMarket(mint, lastFetchedAt) {
            await sql`
                INSERT INTO variant_markets_latest (id, mint, source, last_fetched_at, overview_last_fetched_at)
                VALUES (${randomId('vml')}, ${mint}, 'touch', ${lastFetchedAt}, ${lastFetchedAt})
                ON CONFLICT (mint) DO UPDATE SET
                    last_fetched_at = EXCLUDED.last_fetched_at,
                    overview_last_fetched_at = EXCLUDED.overview_last_fetched_at
            `;
        },

        async getOverviewLastFetchedAtByMint(mint) {
            const rows = await sql<{ overview_last_fetched_at: number | null }[]>`
                SELECT overview_last_fetched_at
                FROM variant_markets_latest
                WHERE mint = ${mint}
                LIMIT 1
            `;
            return rows[0]?.overview_last_fetched_at ?? null;
        },

        async listStaleVariantMints(beforeLastFetchedAt, limit) {
            const rows = await sql<{ mint: string }[]>`
                SELECT mint
                FROM variant_markets_latest
                WHERE overview_last_fetched_at IS NULL
                   OR overview_last_fetched_at < ${beforeLastFetchedAt}
                ORDER BY overview_last_fetched_at NULLS FIRST, mint ASC
                LIMIT ${Math.min(Math.max(limit, 1), 250)}
            `;
            return rows.map(r => r.mint);
        },

        async listCuratedAssetIds() {
            const rows = await sql<{ asset_id: string }[]>`
                SELECT DISTINCT acm.asset_id
                FROM asset_collection_members acm
                WHERE acm.collection_slug IN ${sql(CURATED_COLLECTION_SLUGS)}
                ORDER BY acm.asset_id ASC
            `;
            return rows.map(r => r.asset_id);
        },

        async listVariantsForRollup(assetIds) {
            if (assetIds.length === 0) return [];
            const rows = await sql<VariantRollupRow[]>`
                SELECT av.asset_id, av.mint, av.chain, av.kind, av.trust_tier,
                       vml.liquidity, vml.volume_24h_usd, vml.last_fetched_at
                FROM asset_variants av
                LEFT JOIN variant_markets_latest vml ON vml.mint = av.mint
                WHERE av.asset_id IN ${sql(assetIds)}
                  AND av.is_active = true
            `;
            const byAsset = new Map<string, AssetVariantSummary[]>();
            for (const row of rows) {
                const summary: AssetVariantSummary = {
                    mint: row.mint,
                    assetId: row.asset_id,
                    chain: row.chain,
                    kind: row.kind,
                    trustTier: row.trust_tier,
                    liquidity: row.liquidity ?? 0,
                    volume24hUSD: row.volume_24h_usd ?? 0,
                    lastFetchedAt: row.last_fetched_at,
                };
                const list = byAsset.get(row.asset_id) ?? [];
                list.push(summary);
                byAsset.set(row.asset_id, list);
            }
            const out: AssetVariantsForRollup[] = [];
            for (const assetId of assetIds) {
                out.push({ assetId, variants: byAsset.get(assetId) ?? [] });
            }
            return out;
        },

        async listVariantLastComputedByAssetIds(assetIds) {
            if (assetIds.length === 0) return new Map();
            const rows = await sql<{ asset_id: string; last_computed_at: number | null }[]>`
                SELECT asset_id, last_computed_at
                FROM asset_markets_latest
                WHERE asset_id IN ${sql(assetIds)}
            `;
            const out = new Map<string, number | null>();
            for (const row of rows) out.set(row.asset_id, row.last_computed_at);
            return out;
        },

        async sumDailyOhlcvVolumeByAddresses(addresses, fromSeconds, toSeconds) {
            if (addresses.length === 0) return new Map();
            const rows = await sql<{ address: string; volume30d: number | null }[]>`
                SELECT address, SUM(volume)::float8 AS volume30d
                FROM ohlcv_candles
                WHERE interval = '1D'
                  AND address IN ${sql(addresses)}
                  AND time >= ${fromSeconds}
                  AND time <= ${toSeconds}
                GROUP BY address
            `;
            const out = new Map<string, number | null>();
            for (const addr of addresses) out.set(addr, null);
            for (const row of rows) out.set(row.address, row.volume30d);
            return out;
        },

        async upsertAssetAggregate(args) {
            await sql`
                INSERT INTO asset_markets_latest (
                    id, asset_id, liquidity, volume_24h_usd, volume_30d_usd,
                    primary_mint, last_computed_at,
                    min_variant_last_fetched_at, max_variant_last_fetched_at
                )
                VALUES (
                    ${randomId('aml')}, ${args.assetId},
                    ${args.liquidity}, ${args.volume24hUSD}, ${args.volume30dUSD},
                    ${args.primaryMint ?? null}, ${args.lastComputedAt},
                    ${args.minVariantLastFetchedAt ?? null}, ${args.maxVariantLastFetchedAt ?? null}
                )
                ON CONFLICT (asset_id) DO UPDATE SET
                    liquidity = EXCLUDED.liquidity,
                    volume_24h_usd = EXCLUDED.volume_24h_usd,
                    volume_30d_usd = EXCLUDED.volume_30d_usd,
                    primary_mint = EXCLUDED.primary_mint,
                    last_computed_at = EXCLUDED.last_computed_at,
                    min_variant_last_fetched_at = EXCLUDED.min_variant_last_fetched_at,
                    max_variant_last_fetched_at = EXCLUDED.max_variant_last_fetched_at
            `;
        },

        async listActiveSanctumLstCount() {
            const rows = await sql<{ count: number }[]>`
                SELECT COUNT(*)::int AS count
                FROM sanctum_lsts_latest
                WHERE is_active = true
            `;
            return rows[0]?.count ?? 0;
        },

        async listSanctumSourceRanks(mints) {
            if (mints.length === 0) return new Map();
            const rows = await sql<{ mint: string; source_rank: number }[]>`
                SELECT mint, source_rank
                FROM sanctum_lsts_latest
                WHERE mint IN ${sql(mints)}
            `;
            const out = new Map<string, number>();
            for (const row of rows) out.set(row.mint, row.source_rank);
            return out;
        },

        async upsertSanctumLstLatest(args) {
            const symbolLower = (args.symbol ?? '').trim().toLowerCase();
            await sql`
                INSERT INTO sanctum_lsts_latest (
                    id, mint, symbol, symbol_lower, name, logo_uri, website_url,
                    tvl_usd, apy, source_rank, raw_json, is_active,
                    last_seen_at, last_synced_at, updated_at
                )
                VALUES (
                    ${randomId('sll')}, ${args.mint},
                    ${args.symbol ?? null}, ${symbolLower},
                    ${args.name ?? null}, ${args.logoURI ?? null}, ${args.websiteUrl ?? null},
                    ${args.tvlUsd ?? null}, ${args.apy ?? null},
                    ${args.sourceRank}, ${args.rawJson}, ${args.isActive},
                    ${args.lastSeenAt}, ${args.lastSyncedAt}, NOW()
                )
                ON CONFLICT (mint) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    symbol_lower = EXCLUDED.symbol_lower,
                    name = EXCLUDED.name,
                    logo_uri = EXCLUDED.logo_uri,
                    website_url = EXCLUDED.website_url,
                    tvl_usd = EXCLUDED.tvl_usd,
                    apy = EXCLUDED.apy,
                    source_rank = EXCLUDED.source_rank,
                    raw_json = EXCLUDED.raw_json,
                    is_active = EXCLUDED.is_active,
                    last_seen_at = EXCLUDED.last_seen_at,
                    last_synced_at = EXCLUDED.last_synced_at,
                    updated_at = NOW()
            `;
        },

        async deactivateMissingSanctumLsts(activeMints, lastSyncedAt) {
            if (activeMints.length === 0) {
                const rows = await sql<{ count: number }[]>`
                    WITH updated AS (
                        UPDATE sanctum_lsts_latest
                        SET is_active = false, last_synced_at = ${lastSyncedAt}, updated_at = NOW()
                        WHERE is_active = true
                        RETURNING 1
                    )
                    SELECT COUNT(*)::int AS count FROM updated
                `;
                return rows[0]?.count ?? 0;
            }
            const rows = await sql<{ count: number }[]>`
                WITH updated AS (
                    UPDATE sanctum_lsts_latest
                    SET is_active = false, last_synced_at = ${lastSyncedAt}, updated_at = NOW()
                    WHERE is_active = true
                      AND mint NOT IN ${sql(activeMints)}
                    RETURNING 1
                )
                SELECT COUNT(*)::int AS count FROM updated
            `;
            return rows[0]?.count ?? 0;
        },

        async findVariantByMint(mint) {
            const rows = await sql<{ asset_id: string; chain: string }[]>`
                SELECT asset_id, chain
                FROM asset_variants
                WHERE mint = ${mint}
                  AND is_active = true
                LIMIT 1
            `;
            const row = rows[0];
            return row ? { assetId: row.asset_id, chain: row.chain } : null;
        },

        async getAssetRiskLastFetchedAtByMint(mint) {
            const rows = await sql<{ last_fetched_at: number | null }[]>`
                SELECT last_fetched_at
                FROM asset_risk_latest
                WHERE mint = ${mint}
                ORDER BY last_fetched_at DESC NULLS LAST
                LIMIT 1
            `;
            return rows[0]?.last_fetched_at ?? null;
        },

        async upsertAssetRiskLatest(args) {
            await sql`
                INSERT INTO asset_risk_latest (
                    id, asset_id, chain, mint, ok, reason, message,
                    market_score_input, market_score, tags,
                    risk_score_10, safety_score_10, lp_locked_percent,
                    top_10_holders_percent, holder_count, token_mint_time,
                    last_fetched_at
                )
                VALUES (
                    ${randomId('arl')}, ${args.assetId}, ${args.chain}, ${args.mint},
                    ${args.ok}, ${args.reason ?? null}, ${args.message ?? null},
                    ${args.marketScoreInput !== undefined ? sql.json(args.marketScoreInput as never) : null},
                    ${args.marketScore !== undefined ? sql.json(args.marketScore as never) : null},
                    ${args.tags !== undefined ? sql.json(args.tags as never) : null},
                    ${args.riskScore10 ?? null}, ${args.safetyScore10 ?? null}, ${args.lpLockedPercent ?? null},
                    ${args.top10HoldersPercent ?? null}, ${args.holderCount ?? null}, ${args.tokenMintTime ?? null},
                    ${args.lastFetchedAt}
                )
                ON CONFLICT (asset_id, mint) DO UPDATE SET
                    chain = EXCLUDED.chain,
                    ok = EXCLUDED.ok,
                    reason = EXCLUDED.reason,
                    message = EXCLUDED.message,
                    market_score_input = EXCLUDED.market_score_input,
                    market_score = EXCLUDED.market_score,
                    tags = EXCLUDED.tags,
                    risk_score_10 = EXCLUDED.risk_score_10,
                    safety_score_10 = EXCLUDED.safety_score_10,
                    lp_locked_percent = EXCLUDED.lp_locked_percent,
                    top_10_holders_percent = EXCLUDED.top_10_holders_percent,
                    holder_count = EXCLUDED.holder_count,
                    token_mint_time = EXCLUDED.token_mint_time,
                    last_fetched_at = EXCLUDED.last_fetched_at
            `;
        },

        async findVariantMarketForRiskByMint(mint) {
            const rows = await sql<
                {
                    liquidity: number | null;
                    market_cap: number | null;
                    volume_24h_usd: number | null;
                    holder: number | null;
                }[]
            >`
                SELECT liquidity, market_cap, volume_24h_usd, holder
                FROM variant_markets_latest
                WHERE mint = ${mint}
                LIMIT 1
            `;
            const row = rows[0];
            if (!row) return null;
            return {
                liquidity: row.liquidity,
                marketCap: row.market_cap,
                volume24hUSD: row.volume_24h_usd,
                holder: row.holder,
            };
        },

        async upsertWebacyTokenLatest(args) {
            await sql`
                INSERT INTO webacy_token_latest (
                    id, chain, address, ok, status, payload_json, error_message, last_fetched_at
                )
                VALUES (
                    ${randomId('wtl')}, ${args.chain}, ${args.address},
                    ${args.ok}, ${args.status},
                    ${args.payloadJson ?? null}, ${args.errorMessage ?? null},
                    ${args.lastFetchedAt}
                )
                ON CONFLICT (chain, address) DO UPDATE SET
                    ok = EXCLUDED.ok,
                    status = EXCLUDED.status,
                    payload_json = EXCLUDED.payload_json,
                    error_message = EXCLUDED.error_message,
                    last_fetched_at = EXCLUDED.last_fetched_at
            `;
        },

        async upsertWebacyTradingLiteLatest(args) {
            await sql`
                INSERT INTO webacy_trading_lite_latest (
                    id, chain, address, ok, status, payload_json, error_message, last_fetched_at
                )
                VALUES (
                    ${randomId('wtl')}, ${args.chain}, ${args.address},
                    ${args.ok}, ${args.status},
                    ${args.payloadJson ?? null}, ${args.errorMessage ?? null},
                    ${args.lastFetchedAt}
                )
                ON CONFLICT (chain, address) DO UPDATE SET
                    ok = EXCLUDED.ok,
                    status = EXCLUDED.status,
                    payload_json = EXCLUDED.payload_json,
                    error_message = EXCLUDED.error_message,
                    last_fetched_at = EXCLUDED.last_fetched_at
            `;
        },

        async upsertWebacyHolderAnalysisLatest(args) {
            await sql`
                INSERT INTO webacy_holder_analysis_latest (
                    id, chain, address, ok, status, payload_json, error_message, last_fetched_at
                )
                VALUES (
                    ${randomId('whl')}, ${args.chain}, ${args.address},
                    ${args.ok}, ${args.status},
                    ${args.payloadJson ?? null}, ${args.errorMessage ?? null},
                    ${args.lastFetchedAt}
                )
                ON CONFLICT (chain, address) DO UPDATE SET
                    ok = EXCLUDED.ok,
                    status = EXCLUDED.status,
                    payload_json = EXCLUDED.payload_json,
                    error_message = EXCLUDED.error_message,
                    last_fetched_at = EXCLUDED.last_fetched_at
            `;
        },

        async findRwaXyzAssetLatestByAssetId(assetId) {
            return findRwaXyzAssetLatestByAssetIdImpl(sql, assetId);
        },

        async findRwaXyzTokenLatestByNetworkAndAddress(networkSlug, address) {
            return findRwaXyzTokenLatestByNetworkAndAddressImpl(sql, networkSlug, address);
        },

        async upsertRwaXyzAssetLatest(args) {
            const assetId = Math.floor(args.assetId);
            if (!Number.isFinite(assetId)) throw new Error('assetId must be a finite number');

            const existing = await findRwaXyzAssetLatestByAssetIdImpl(sql, assetId);
            const nowMs = Date.now();
            const shouldRefreshTimestamp = !existing || nowMs - existing.lastFetchedAt >= 60_000;

            const normalize = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '');

            const nextName = (() => {
                const v = normalize(args.name);
                if (args.name !== undefined && v && existing?.name !== v) return v;
                return existing?.name ?? null;
            })();
            const nextTicker = (() => {
                const v = normalize(args.ticker);
                if (args.ticker !== undefined && v && existing?.ticker !== v) return v;
                return existing?.ticker ?? null;
            })();
            const nextSlug = (() => {
                const v = normalize(args.slug);
                if (args.slug !== undefined && v && existing?.slug !== v) return v;
                return existing?.slug ?? null;
            })();
            const nextIconUrl = (() => {
                const v = normalize(args.iconUrl);
                if (args.iconUrl !== undefined && v && existing?.iconUrl !== v) return v;
                return existing?.iconUrl ?? null;
            })();
            const nextWebsite = (() => {
                const v = normalize(args.website);
                if (args.website !== undefined && v && existing?.website !== v) return v;
                return existing?.website ?? null;
            })();
            const nextIssuerId = (() => {
                const v = normalize(args.issuerId);
                if (args.issuerId !== undefined && v && existing?.issuerId !== v) return v;
                return existing?.issuerId ?? null;
            })();
            const nextIssuerName = (() => {
                const v = normalize(args.issuerName);
                if (args.issuerName !== undefined && v && existing?.issuerName !== v) return v;
                return existing?.issuerName ?? null;
            })();
            const nextAssetClassId =
                args.assetClassId !== undefined && existing?.assetClassId !== args.assetClassId
                    ? args.assetClassId
                    : (existing?.assetClassId ?? null);
            const nextAssetClassName = (() => {
                const v = normalize(args.assetClassName);
                if (args.assetClassName !== undefined && v && existing?.assetClassName !== v) return v;
                return existing?.assetClassName ?? null;
            })();
            const nextAssetClassSlug = (() => {
                const v = normalize(args.assetClassSlug);
                if (args.assetClassSlug !== undefined && v && existing?.assetClassSlug !== v) return v;
                return existing?.assetClassSlug ?? null;
            })();

            const fieldsChanged =
                nextName !== (existing?.name ?? null) ||
                nextTicker !== (existing?.ticker ?? null) ||
                nextSlug !== (existing?.slug ?? null) ||
                nextIconUrl !== (existing?.iconUrl ?? null) ||
                nextWebsite !== (existing?.website ?? null) ||
                nextIssuerId !== (existing?.issuerId ?? null) ||
                nextIssuerName !== (existing?.issuerName ?? null) ||
                nextAssetClassId !== (existing?.assetClassId ?? null) ||
                nextAssetClassName !== (existing?.assetClassName ?? null) ||
                nextAssetClassSlug !== (existing?.assetClassSlug ?? null) ||
                args.payloadJson !== (existing?.payloadJson ?? null);

            if (!existing) {
                await sql`
                    INSERT INTO rwa_xyz_assets_latest (
                        id, asset_id, name, ticker, slug, icon_url, website,
                        issuer_id, issuer_name, asset_class_id, asset_class_name, asset_class_slug,
                        payload_json, last_fetched_at
                    )
                    VALUES (
                        ${randomId('rxa')}, ${assetId},
                        ${nextName}, ${nextTicker}, ${nextSlug}, ${nextIconUrl}, ${nextWebsite},
                        ${nextIssuerId}, ${nextIssuerName}, ${nextAssetClassId},
                        ${nextAssetClassName}, ${nextAssetClassSlug},
                        ${args.payloadJson}, ${args.lastFetchedAt}
                    )
                `;
                return;
            }

            if (!fieldsChanged && !shouldRefreshTimestamp) return;

            await sql`
                UPDATE rwa_xyz_assets_latest
                SET name = ${nextName},
                    ticker = ${nextTicker},
                    slug = ${nextSlug},
                    icon_url = ${nextIconUrl},
                    website = ${nextWebsite},
                    issuer_id = ${nextIssuerId},
                    issuer_name = ${nextIssuerName},
                    asset_class_id = ${nextAssetClassId},
                    asset_class_name = ${nextAssetClassName},
                    asset_class_slug = ${nextAssetClassSlug},
                    payload_json = ${args.payloadJson},
                    last_fetched_at = ${args.lastFetchedAt}
                WHERE asset_id = ${assetId}
            `;
        },

        async upsertRwaXyzTokenLatest(args) {
            const trimmedAddress = args.address.trim();
            if (!trimmedAddress) return;

            const existing = await findRwaXyzTokenLatestByNetworkAndAddressImpl(sql, args.networkSlug, trimmedAddress);
            const nowMs = Date.now();
            const shouldRefreshTimestamp = !existing || nowMs - existing.lastFetchedAt >= 60_000;

            const normalize = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '');

            const nextRwaId =
                args.rwaId !== undefined && existing?.rwaId !== args.rwaId ? args.rwaId : (existing?.rwaId ?? null);
            const nextRwaTokenId =
                args.rwaTokenId !== undefined && existing?.rwaTokenId !== args.rwaTokenId
                    ? args.rwaTokenId
                    : (existing?.rwaTokenId ?? null);
            const nextAssetId =
                args.assetId !== undefined && existing?.assetId !== args.assetId
                    ? args.assetId
                    : (existing?.assetId ?? null);
            const nextName = (() => {
                const v = normalize(args.name);
                if (args.name !== undefined && v && existing?.name !== v) return v;
                return existing?.name ?? null;
            })();
            const nextDecimals =
                args.decimals !== undefined && existing?.decimals !== args.decimals
                    ? args.decimals
                    : (existing?.decimals ?? null);
            const nextPriceDollar =
                args.priceDollar !== undefined && existing?.priceDollar !== args.priceDollar
                    ? args.priceDollar
                    : (existing?.priceDollar ?? null);
            const nextMarketValueDollar =
                args.marketValueDollar !== undefined && existing?.marketValueDollar !== args.marketValueDollar
                    ? args.marketValueDollar
                    : (existing?.marketValueDollar ?? null);
            const nextNetAssetValueDollar =
                args.netAssetValueDollar !== undefined && existing?.netAssetValueDollar !== args.netAssetValueDollar
                    ? args.netAssetValueDollar
                    : (existing?.netAssetValueDollar ?? null);
            const nextTotalAssetValueDollar =
                args.totalAssetValueDollar !== undefined &&
                existing?.totalAssetValueDollar !== args.totalAssetValueDollar
                    ? args.totalAssetValueDollar
                    : (existing?.totalAssetValueDollar ?? null);
            const nextCirculatingAssetValueDollar =
                args.circulatingAssetValueDollar !== undefined &&
                existing?.circulatingAssetValueDollar !== args.circulatingAssetValueDollar
                    ? args.circulatingAssetValueDollar
                    : (existing?.circulatingAssetValueDollar ?? null);
            const nextCirculatingMarketValueDollar =
                args.circulatingMarketValueDollar !== undefined &&
                existing?.circulatingMarketValueDollar !== args.circulatingMarketValueDollar
                    ? args.circulatingMarketValueDollar
                    : (existing?.circulatingMarketValueDollar ?? null);
            const nextApy7Day =
                args.apy7Day !== undefined && existing?.apy7Day !== args.apy7Day
                    ? args.apy7Day
                    : (existing?.apy7Day ?? null);
            const nextApy30Day =
                args.apy30Day !== undefined && existing?.apy30Day !== args.apy30Day
                    ? args.apy30Day
                    : (existing?.apy30Day ?? null);
            const nextTotalSupplyToken =
                args.totalSupplyToken !== undefined && existing?.totalSupplyToken !== args.totalSupplyToken
                    ? args.totalSupplyToken
                    : (existing?.totalSupplyToken ?? null);
            const nextCirculatingSupplyToken =
                args.circulatingSupplyToken !== undefined &&
                existing?.circulatingSupplyToken !== args.circulatingSupplyToken
                    ? args.circulatingSupplyToken
                    : (existing?.circulatingSupplyToken ?? null);
            const nextHoldingAddressesCount =
                args.holdingAddressesCount !== undefined &&
                existing?.holdingAddressesCount !== args.holdingAddressesCount
                    ? args.holdingAddressesCount
                    : (existing?.holdingAddressesCount ?? null);

            const fieldsChanged =
                nextRwaId !== (existing?.rwaId ?? null) ||
                nextRwaTokenId !== (existing?.rwaTokenId ?? null) ||
                nextAssetId !== (existing?.assetId ?? null) ||
                nextName !== (existing?.name ?? null) ||
                nextDecimals !== (existing?.decimals ?? null) ||
                nextPriceDollar !== (existing?.priceDollar ?? null) ||
                nextMarketValueDollar !== (existing?.marketValueDollar ?? null) ||
                nextNetAssetValueDollar !== (existing?.netAssetValueDollar ?? null) ||
                nextTotalAssetValueDollar !== (existing?.totalAssetValueDollar ?? null) ||
                nextCirculatingAssetValueDollar !== (existing?.circulatingAssetValueDollar ?? null) ||
                nextCirculatingMarketValueDollar !== (existing?.circulatingMarketValueDollar ?? null) ||
                nextApy7Day !== (existing?.apy7Day ?? null) ||
                nextApy30Day !== (existing?.apy30Day ?? null) ||
                nextTotalSupplyToken !== (existing?.totalSupplyToken ?? null) ||
                nextCirculatingSupplyToken !== (existing?.circulatingSupplyToken ?? null) ||
                nextHoldingAddressesCount !== (existing?.holdingAddressesCount ?? null) ||
                args.payloadJson !== (existing?.payloadJson ?? null);

            if (!existing) {
                await sql`
                    INSERT INTO rwa_xyz_tokens_latest (
                        id, network_slug, address, rwa_id, rwa_token_id, asset_id, name, decimals,
                        price_dollar, market_value_dollar, net_asset_value_dollar, total_asset_value_dollar,
                        circulating_asset_value_dollar, circulating_market_value_dollar,
                        apy_7_day, apy_30_day, total_supply_token, circulating_supply_token,
                        holding_addresses_count, payload_json, last_fetched_at
                    )
                    VALUES (
                        ${randomId('rxt')}, ${args.networkSlug}, ${trimmedAddress},
                        ${nextRwaId}, ${nextRwaTokenId}, ${nextAssetId}, ${nextName}, ${nextDecimals},
                        ${nextPriceDollar}, ${nextMarketValueDollar}, ${nextNetAssetValueDollar},
                        ${nextTotalAssetValueDollar}, ${nextCirculatingAssetValueDollar},
                        ${nextCirculatingMarketValueDollar},
                        ${nextApy7Day}, ${nextApy30Day}, ${nextTotalSupplyToken},
                        ${nextCirculatingSupplyToken}, ${nextHoldingAddressesCount},
                        ${args.payloadJson}, ${args.lastFetchedAt}
                    )
                `;
                return;
            }

            if (!fieldsChanged && !shouldRefreshTimestamp) return;

            await sql`
                UPDATE rwa_xyz_tokens_latest
                SET rwa_id = ${nextRwaId},
                    rwa_token_id = ${nextRwaTokenId},
                    asset_id = ${nextAssetId},
                    name = ${nextName},
                    decimals = ${nextDecimals},
                    price_dollar = ${nextPriceDollar},
                    market_value_dollar = ${nextMarketValueDollar},
                    net_asset_value_dollar = ${nextNetAssetValueDollar},
                    total_asset_value_dollar = ${nextTotalAssetValueDollar},
                    circulating_asset_value_dollar = ${nextCirculatingAssetValueDollar},
                    circulating_market_value_dollar = ${nextCirculatingMarketValueDollar},
                    apy_7_day = ${nextApy7Day},
                    apy_30_day = ${nextApy30Day},
                    total_supply_token = ${nextTotalSupplyToken},
                    circulating_supply_token = ${nextCirculatingSupplyToken},
                    holding_addresses_count = ${nextHoldingAddressesCount},
                    payload_json = ${args.payloadJson},
                    last_fetched_at = ${args.lastFetchedAt}
                WHERE network_slug = ${args.networkSlug}
                  AND address = ${trimmedAddress}
            `;
        },

        async listRecentActiveProjects(sinceCreationTime, maxScanEvents, maxProjects) {
            const scanLimit = Math.min(Math.max(maxScanEvents, 1), 50_000);
            const projectLimit = Math.min(Math.max(maxProjects, 1), 500);
            const sinceTimestamp = new Date(sinceCreationTime).toISOString();
            const rows = await sql<{ project_id: string }[]>`
                SELECT DISTINCT project_id
                FROM (
                    SELECT project_id
                    FROM api_request_events
                    WHERE created_at > ${sinceTimestamp}::timestamptz
                    ORDER BY created_at DESC
                    LIMIT ${scanLimit}
                ) AS recent
                LIMIT ${projectLimit}
            `;
            return rows.map(r => r.project_id);
        },

        async getRollupStateForProject(projectId) {
            const rows = await sql<{ cursor_creation_time: number; locked_until: number }[]>`
                SELECT cursor_creation_time, locked_until
                FROM api_request_rollup_state
                WHERE project_id = ${projectId}
                LIMIT 1
            `;
            const row = rows[0];
            return row
                ? {
                      cursorCreationTime: row.cursor_creation_time,
                      lockedUntil: row.locked_until,
                  }
                : null;
        },

        async tryAcquireRollupLock(projectId, now, lockMs) {
            const nextLockedUntil = now + lockMs;
            const rows = await sql<{ project_id: string }[]>`
                INSERT INTO api_request_rollup_state (project_id, cursor_creation_time, locked_until, updated_at)
                VALUES (${projectId}, 0, ${nextLockedUntil}, NOW())
                ON CONFLICT (project_id) DO UPDATE SET
                    locked_until = EXCLUDED.locked_until,
                    updated_at = NOW()
                WHERE api_request_rollup_state.locked_until <= ${now}
                RETURNING project_id
            `;
            return rows.length > 0;
        },

        async releaseRollupLock(projectId, nextCursor, now) {
            await sql`
                UPDATE api_request_rollup_state
                SET cursor_creation_time = ${nextCursor},
                    locked_until = 0,
                    updated_at = NOW()
                WHERE project_id = ${projectId}
                  AND (cursor_creation_time IS NULL OR cursor_creation_time <= ${nextCursor})
            `;
            void now;
        },

        async listProjectEventsForRollup(projectId, afterCreationTime, beforeCreationTime, limit) {
            const afterTs = new Date(afterCreationTime).toISOString();
            const beforeTs = new Date(beforeCreationTime).toISOString();
            const lim = Math.min(Math.max(limit, 1), 10_000);
            const rows = await sql<
                {
                    endpoint: string;
                    status: number;
                    latency_ms: number;
                    ts: number;
                    created_at_ms: number;
                }[]
            >`
                SELECT endpoint, status, latency_ms, ts,
                       (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_at_ms
                FROM api_request_events
                WHERE project_id = ${projectId}
                  AND created_at > ${afterTs}::timestamptz
                  AND created_at < ${beforeTs}::timestamptz
                ORDER BY created_at ASC
                LIMIT ${lim}
            `;
            const out: ApiRequestEvent[] = [];
            for (const row of rows) {
                out.push({
                    projectId,
                    endpoint: row.endpoint,
                    status: row.status,
                    latencyMs: row.latency_ms,
                    ts: row.ts,
                    creationTime: Number(row.created_at_ms),
                });
            }
            return out;
        },

        async applyDailyRollupDelta(delta, updatedAt) {
            await sql`
                INSERT INTO api_request_daily_rollups (
                    id, project_id, day, total_calls, asset_calls, success_calls, sum_latency_ms, updated_at
                )
                VALUES (
                    ${randomId('ard')}, ${delta.projectId}, ${delta.day}::date,
                    ${delta.totalCalls}, ${delta.assetCalls}, ${delta.successCalls}, ${delta.sumLatencyMs},
                    to_timestamp(${updatedAt} / 1000.0)
                )
                ON CONFLICT (project_id, day) DO UPDATE SET
                    total_calls = api_request_daily_rollups.total_calls + EXCLUDED.total_calls,
                    asset_calls = api_request_daily_rollups.asset_calls + EXCLUDED.asset_calls,
                    success_calls = api_request_daily_rollups.success_calls + EXCLUDED.success_calls,
                    sum_latency_ms = api_request_daily_rollups.sum_latency_ms + EXCLUDED.sum_latency_ms,
                    updated_at = EXCLUDED.updated_at
            `;
        },

        async applyEndpointDailyRollupDelta(delta, updatedAt) {
            await sql`
                INSERT INTO api_request_endpoint_daily_rollups (
                    id, project_id, day, endpoint, calls, success_calls, sum_latency_ms, latency_histogram, updated_at
                )
                VALUES (
                    ${randomId('are')}, ${delta.projectId}, ${delta.day}::date, ${delta.endpoint},
                    ${delta.calls}, ${delta.successCalls}, ${delta.sumLatencyMs},
                    ${sql.json(delta.latencyHistogram as never)},
                    to_timestamp(${updatedAt} / 1000.0)
                )
                ON CONFLICT (project_id, day, endpoint) DO UPDATE SET
                    calls = api_request_endpoint_daily_rollups.calls + EXCLUDED.calls,
                    success_calls = api_request_endpoint_daily_rollups.success_calls + EXCLUDED.success_calls,
                    sum_latency_ms = api_request_endpoint_daily_rollups.sum_latency_ms + EXCLUDED.sum_latency_ms,
                    latency_histogram = (
                        SELECT to_jsonb(
                            array(
                                SELECT COALESCE((api_request_endpoint_daily_rollups.latency_histogram->>i)::bigint, 0)
                                     + COALESCE((EXCLUDED.latency_histogram->>i)::bigint, 0)
                                FROM generate_series(
                                    0,
                                    GREATEST(
                                        jsonb_array_length(api_request_endpoint_daily_rollups.latency_histogram),
                                        jsonb_array_length(EXCLUDED.latency_histogram)
                                    ) - 1
                                ) AS i
                            )
                        )
                    ),
                    updated_at = EXCLUDED.updated_at
            `;
        },

        async applyRollupBatchAtomic({
            projectId,
            daily,
            endpointDaily,
            expectedCursor,
            nextCursor,
            nowMs,
            updatedAt,
        }) {
            let committed = false;
            await sql.begin(async tx => {
                const cursorRows = await tx<{ project_id: string }[]>`
                    UPDATE api_request_rollup_state
                    SET cursor_creation_time = ${nextCursor},
                        locked_until = 0,
                        updated_at = NOW()
                    WHERE project_id = ${projectId}
                      AND cursor_creation_time = ${expectedCursor}
                    RETURNING project_id
                `;
                if (cursorRows.length === 0) {
                    return;
                }
                for (const delta of daily) {
                    await tx`
                        INSERT INTO api_request_daily_rollups (
                            id, project_id, day, total_calls, asset_calls, success_calls, sum_latency_ms, updated_at
                        )
                        VALUES (
                            ${randomId('ard')}, ${delta.projectId}, ${delta.day}::date,
                            ${delta.totalCalls}, ${delta.assetCalls}, ${delta.successCalls}, ${delta.sumLatencyMs},
                            to_timestamp(${updatedAt} / 1000.0)
                        )
                        ON CONFLICT (project_id, day) DO UPDATE SET
                            total_calls = api_request_daily_rollups.total_calls + EXCLUDED.total_calls,
                            asset_calls = api_request_daily_rollups.asset_calls + EXCLUDED.asset_calls,
                            success_calls = api_request_daily_rollups.success_calls + EXCLUDED.success_calls,
                            sum_latency_ms = api_request_daily_rollups.sum_latency_ms + EXCLUDED.sum_latency_ms,
                            updated_at = EXCLUDED.updated_at
                    `;
                }
                for (const delta of endpointDaily) {
                    await tx`
                        INSERT INTO api_request_endpoint_daily_rollups (
                            id, project_id, day, endpoint, calls, success_calls, sum_latency_ms, latency_histogram, updated_at
                        )
                        VALUES (
                            ${randomId('are')}, ${delta.projectId}, ${delta.day}::date, ${delta.endpoint},
                            ${delta.calls}, ${delta.successCalls}, ${delta.sumLatencyMs},
                            ${tx.json(delta.latencyHistogram as never)},
                            to_timestamp(${updatedAt} / 1000.0)
                        )
                        ON CONFLICT (project_id, day, endpoint) DO UPDATE SET
                            calls = api_request_endpoint_daily_rollups.calls + EXCLUDED.calls,
                            success_calls = api_request_endpoint_daily_rollups.success_calls + EXCLUDED.success_calls,
                            sum_latency_ms = api_request_endpoint_daily_rollups.sum_latency_ms + EXCLUDED.sum_latency_ms,
                            latency_histogram = (
                                SELECT to_jsonb(
                                    array(
                                        SELECT COALESCE((api_request_endpoint_daily_rollups.latency_histogram->>i)::bigint, 0)
                                             + COALESCE((EXCLUDED.latency_histogram->>i)::bigint, 0)
                                        FROM generate_series(
                                            0,
                                            GREATEST(
                                                jsonb_array_length(api_request_endpoint_daily_rollups.latency_histogram),
                                                jsonb_array_length(EXCLUDED.latency_histogram)
                                            ) - 1
                                        ) AS i
                                    )
                                )
                            ),
                            updated_at = EXCLUDED.updated_at
                    `;
                }
                committed = true;
                void nowMs;
            });
            return committed;
        },

        async listAllProjectIds(maxProjects) {
            const lim = Math.min(Math.max(maxProjects, 1), 500);
            const rows = await sql<{ id: string }[]>`
                SELECT id
                FROM projects
                ORDER BY id DESC
                LIMIT ${lim}
            `;
            return rows.map(r => r.id);
        },

        async pruneApiRequestEventsForProject(projectId, cutoffTs, beforeCreationTime, batchSize) {
            const lim = Math.min(Math.max(batchSize, 1), 10_000);
            const beforeTs = new Date(beforeCreationTime).toISOString();
            const rows = await sql<{ count: number }[]>`
                WITH victims AS (
                    SELECT id, created_at
                    FROM api_request_events
                    WHERE project_id = ${projectId}
                      AND ts < ${cutoffTs}
                      AND created_at <= ${beforeTs}::timestamptz
                    ORDER BY created_at ASC
                    LIMIT ${lim}
                ),
                deleted AS (
                    DELETE FROM api_request_events e
                    USING victims v
                    WHERE e.id = v.id AND e.created_at = v.created_at
                    RETURNING 1
                )
                SELECT COUNT(*)::int AS count FROM deleted
            `;
            return rows[0]?.count ?? 0;
        },

        async getOhlcvBounds(address, interval) {
            const rows = await sql<{ min_time: number | null; max_time: number | null }[]>`
                SELECT MIN(time) AS min_time, MAX(time) AS max_time
                FROM ohlcv_candles
                WHERE address = ${address} AND interval = ${interval}
            `;
            const row = rows[0];
            return {
                minTime: row?.min_time ?? null,
                maxTime: row?.max_time ?? null,
            };
        },

        async upsertOhlcvCandles(address, interval, candles): Promise<OhlcvUpsertResult> {
            if (candles.length === 0) return { inserted: 0, updated: 0, skipped: 0 };
            const byTime = new Map<number, OhlcvCandle>();
            for (const candle of candles) byTime.set(candle.time, candle);
            const unique = Array.from(byTime.values());

            const times = unique.map(c => c.time);
            const existingRows = await sql<
                {
                    time: number;
                    open: number;
                    high: number;
                    low: number;
                    close: number;
                    volume: number;
                    source: string | null;
                }[]
            >`
                SELECT time, open, high, low, close, volume, source
                FROM ohlcv_candles
                WHERE address = ${address}
                  AND interval = ${interval}
                  AND time IN ${sql(times)}
            `;
            const existingByTime = new Map<number, (typeof existingRows)[number]>();
            for (const row of existingRows) existingByTime.set(row.time, row);

            let inserted = 0;
            let updated = 0;
            let skipped = 0;

            for (const candle of unique) {
                const current = existingByTime.get(candle.time);
                if (!current) {
                    await sql`
                        INSERT INTO ohlcv_candles (
                            id, address, interval, time, open, high, low, close, volume, source
                        )
                        VALUES (
                            ${randomId('ohlcv')}, ${address}, ${interval}, ${candle.time},
                            ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close}, ${candle.volume},
                            'birdeye'
                        )
                        ON CONFLICT (address, interval, time) DO NOTHING
                    `;
                    inserted += 1;
                    continue;
                }
                if (current.source === 'clickhouse_trades') {
                    skipped += 1;
                    continue;
                }
                if (
                    current.open === candle.open &&
                    current.high === candle.high &&
                    current.low === candle.low &&
                    current.close === candle.close &&
                    current.volume === candle.volume &&
                    current.source === 'birdeye'
                ) {
                    skipped += 1;
                    continue;
                }
                await sql`
                    UPDATE ohlcv_candles
                    SET open = ${candle.open},
                        high = ${candle.high},
                        low = ${candle.low},
                        close = ${candle.close},
                        volume = ${candle.volume},
                        source = 'birdeye'
                    WHERE address = ${address}
                      AND interval = ${interval}
                      AND time = ${candle.time}
                `;
                updated += 1;
            }

            return { inserted, updated, skipped };
        },
    };
}

export function makePostgresCoingeckoCuratedSource(sql: Sql): CoingeckoCuratedSource & { warmup(): Promise<void> } {
    let cachedIds: string[] | null = null;
    let loadedAtMs = 0;
    let inflight: Promise<void> | null = null;

    async function load(): Promise<void> {
        const rows = await sql<{ coingecko_id: string }[]>`
            SELECT DISTINCT a.coingecko_id AS coingecko_id, MIN(acm.rank) AS rank, MIN(
                array_position(
                    ${sql.unsafe(CURATED_COLLECTION_SLUGS_SQL_LITERAL)},
                    acm.collection_slug
                )
            ) AS slug_rank
            FROM asset_collection_members acm
            JOIN assets a
                ON a.asset_id = acm.asset_id
               AND a.is_active = true
            WHERE acm.collection_slug IN ${sql(CURATED_COLLECTION_SLUGS)}
              AND a.coingecko_id IS NOT NULL
              AND length(trim(a.coingecko_id)) > 0
            GROUP BY a.coingecko_id
            ORDER BY slug_rank ASC, rank ASC, a.coingecko_id ASC
        `;
        const seen = new Set<string>();
        const out: string[] = [];
        for (const row of rows) {
            const coinId = row.coingecko_id?.trim();
            if (!coinId || seen.has(coinId)) continue;
            seen.add(coinId);
            out.push(coinId);
        }
        cachedIds = out;
        loadedAtMs = Date.now();
    }

    function refreshIfStale(): void {
        if (inflight) return;
        if (cachedIds && Date.now() - loadedAtMs < CURATED_MINTS_TTL_MS) return;
        inflight = load()
            .catch(err => {
                console.error('[cloudrun-assets] curated coingecko ids refresh failed', err);
            })
            .finally(() => {
                inflight = null;
            });
    }

    return {
        async warmup() {
            if (!cachedIds) await load();
        },
        getCuratedCoinIdsInOrder(): string[] {
            refreshIfStale();
            return cachedIds ?? [];
        },
    };
}

export function makePostgresCoingeckoRepo(sql: Sql): CoingeckoRepo {
    return {
        async upsertCoinListBatch(coins) {
            if (coins.length === 0) return { inserted: 0, updated: 0, skipped: 0 };
            let inserted = 0;
            let updated = 0;
            let skipped = 0;
            for (const coin of coins) {
                const rows = await sql<{ action: 'inserted' | 'updated' | 'skipped' }[]>`
                    WITH upsert AS (
                        INSERT INTO coingecko_coins (id, coin_id, symbol, name, platforms, last_synced_at, last_metadata_fetched_at)
                        VALUES (
                            ${coin.id},
                            ${coin.id},
                            ${coin.symbol},
                            ${coin.name},
                            ${sql.json((coin.platforms ?? {}) as never)},
                            ${coin.syncedAt},
                            0
                        )
                        ON CONFLICT (coin_id) DO UPDATE
                        SET symbol         = EXCLUDED.symbol,
                            name           = EXCLUDED.name,
                            platforms      = EXCLUDED.platforms,
                            last_synced_at = EXCLUDED.last_synced_at
                        WHERE coingecko_coins.symbol IS DISTINCT FROM EXCLUDED.symbol
                           OR coingecko_coins.name IS DISTINCT FROM EXCLUDED.name
                           OR coingecko_coins.platforms IS DISTINCT FROM EXCLUDED.platforms
                           OR EXCLUDED.last_synced_at - coingecko_coins.last_synced_at >= 12 * 60 * 60 * 1000
                        RETURNING (xmax = 0) AS inserted
                    )
                    SELECT CASE WHEN inserted THEN 'inserted' ELSE 'updated' END AS action FROM upsert
                `;
                const action = rows[0]?.action;
                if (action === 'inserted') inserted += 1;
                else if (action === 'updated') updated += 1;
                else skipped += 1;
            }
            return { inserted, updated, skipped };
        },

        async getCoinMetadataLastFetchedAt(id) {
            const rows = await sql<{ last_metadata_fetched_at: number | null }[]>`
                SELECT last_metadata_fetched_at
                FROM coingecko_coins
                WHERE id = ${id}
                LIMIT 1
            `;
            const row = rows[0];
            if (!row) return null;
            const last = row.last_metadata_fetched_at;
            return last && last > 0 ? Number(last) : null;
        },

        async upsertCoinMetadata(args) {
            const symbol =
                typeof (args.coin as { symbol?: unknown }).symbol === 'string'
                    ? (args.coin as { symbol: string }).symbol
                    : '';
            const name =
                typeof (args.coin as { name?: unknown }).name === 'string' ? (args.coin as { name: string }).name : '';
            const platforms = (args.coin as { platforms?: Record<string, string> }).platforms ?? {};
            await sql`
                INSERT INTO coingecko_coins (
                    id, coin_id, symbol, name, platforms, last_synced_at, coin, last_metadata_fetched_at
                )
                VALUES (
                    ${args.id},
                    ${args.id},
                    ${symbol},
                    ${name},
                    ${sql.json(platforms as never)},
                    ${args.fetchedAt},
                    ${sql.json(args.coin as never)},
                    ${args.fetchedAt}
                )
                ON CONFLICT (id) DO UPDATE
                SET symbol                   = EXCLUDED.symbol,
                    name                     = EXCLUDED.name,
                    platforms                = EXCLUDED.platforms,
                    coin                     = EXCLUDED.coin,
                    last_metadata_fetched_at = EXCLUDED.last_metadata_fetched_at,
                    last_synced_at           = GREATEST(coingecko_coins.last_synced_at, EXCLUDED.last_synced_at)
            `;
        },

        async getTickersLastFetchedAt(coinId) {
            const rows = await sql<{ last_fetched_at: number | null }[]>`
                SELECT last_fetched_at
                FROM coingecko_coin_tickers_latest
                WHERE coin_id = ${coinId}
                LIMIT 1
            `;
            const row = rows[0];
            return row?.last_fetched_at ? Number(row.last_fetched_at) : null;
        },

        async upsertTickersLatest(args) {
            const tickers = args.tickers.slice(0, 250);
            const name = args.name ?? null;
            const total = typeof args.total === 'number' ? args.total : null;
            await sql`
                INSERT INTO coingecko_coin_tickers_latest (
                    id, coin_id, name, tickers, total, last_fetched_at
                )
                VALUES (
                    ${randomId('cgtick')},
                    ${args.coinId},
                    ${name},
                    ${sql.json(tickers as never)},
                    ${total},
                    ${args.lastFetchedAt}
                )
                ON CONFLICT (coin_id) DO UPDATE
                SET name            = EXCLUDED.name,
                    tickers         = EXCLUDED.tickers,
                    total           = EXCLUDED.total,
                    last_fetched_at = EXCLUDED.last_fetched_at
            `;
        },

        async touchTickersLatest(coinId, lastFetchedAt) {
            await sql`
                INSERT INTO coingecko_coin_tickers_latest (
                    id, coin_id, tickers, last_fetched_at
                )
                VALUES (
                    ${randomId('cgtick')},
                    ${coinId},
                    '[]'::jsonb,
                    ${lastFetchedAt}
                )
                ON CONFLICT (coin_id) DO UPDATE
                SET last_fetched_at = EXCLUDED.last_fetched_at
                WHERE coingecko_coin_tickers_latest.last_fetched_at IS DISTINCT FROM EXCLUDED.last_fetched_at
            `;
        },

        async upsertPriceLatest(args) {
            await sql`
                INSERT INTO coingecko_prices_latest (
                    id, coin_id, price_usd, market_cap_usd, volume_24h_usd,
                    price_change_24h_percent, provider_last_updated_at, last_fetched_at
                )
                VALUES (
                    ${randomId('cgprice')},
                    ${args.coinId},
                    ${args.priceUsd},
                    ${args.marketCapUsd},
                    ${args.volume24hUsd},
                    ${args.priceChange24hPercent},
                    ${args.providerLastUpdatedAt},
                    ${args.lastFetchedAt}
                )
                ON CONFLICT (coin_id) DO UPDATE
                SET price_usd                = EXCLUDED.price_usd,
                    market_cap_usd           = EXCLUDED.market_cap_usd,
                    volume_24h_usd           = EXCLUDED.volume_24h_usd,
                    price_change_24h_percent = EXCLUDED.price_change_24h_percent,
                    provider_last_updated_at = EXCLUDED.provider_last_updated_at,
                    last_fetched_at          = EXCLUDED.last_fetched_at
            `;
        },

        async listPriceLastFetchedAtByCoinIds(coinIds) {
            const out = new Map<string, number | null>();
            for (const id of coinIds) out.set(id, null);
            if (coinIds.length === 0) return out;
            const rows = await sql<{ coin_id: string; last_fetched_at: number | null }[]>`
                SELECT coin_id, last_fetched_at
                FROM coingecko_prices_latest
                WHERE coin_id IN ${sql(coinIds)}
            `;
            for (const row of rows) {
                out.set(row.coin_id, row.last_fetched_at ? Number(row.last_fetched_at) : null);
            }
            return out;
        },

        async filterKnownCoinIds(coinIds, syncedSinceMs) {
            if (coinIds.length === 0) return [];
            const rows = await sql<{ coin_id: string }[]>`
                SELECT coin_id FROM coingecko_coins
                WHERE coin_id IN ${sql(coinIds as string[])}
                  AND last_synced_at >= ${syncedSinceMs}
            `;
            const known = new Set(rows.map(r => r.coin_id));
            return coinIds.filter(id => known.has(id));
        },
        async hasFreshCoinListRows(syncedSinceMs) {
            const rows = await sql<{ one: number }[]>`
                SELECT 1 AS one FROM coingecko_coins
                WHERE last_synced_at >= ${syncedSinceMs}
                LIMIT 1
            `;
            return rows.length > 0;
        },
        async getOhlcvBounds(coinId, interval) {
            const rows = await sql<{ min_time: number | null; max_time: number | null }[]>`
                SELECT MIN(time) AS min_time, MAX(time) AS max_time
                FROM coingecko_ohlcv_candles
                WHERE coin_id = ${coinId} AND interval = ${interval}
            `;
            const row = rows[0];
            return {
                minTime: row?.min_time ?? null,
                maxTime: row?.max_time ?? null,
            };
        },

        async upsertOhlcvCandles(
            coinId: string,
            interval: CoingeckoOhlcvInterval,
            candles: readonly CoingeckoOhlcvCandle[],
        ): Promise<CoingeckoOhlcvUpsertResult> {
            if (candles.length === 0) return { inserted: 0, updated: 0, skipped: 0 };
            const byTime = new Map<number, CoingeckoOhlcvCandle>();
            for (const candle of candles) byTime.set(candle.time, candle);
            const unique = Array.from(byTime.values());

            const times = unique.map(c => c.time);
            const existingRows = await sql<
                {
                    time: number;
                    open: number;
                    high: number;
                    low: number;
                    close: number;
                    volume: number;
                }[]
            >`
                SELECT time, open, high, low, close, volume
                FROM coingecko_ohlcv_candles
                WHERE coin_id = ${coinId}
                  AND interval = ${interval}
                  AND time IN ${sql(times)}
            `;
            const existingByTime = new Map<number, (typeof existingRows)[number]>();
            for (const row of existingRows) existingByTime.set(row.time, row);

            let inserted = 0;
            let updated = 0;
            let skipped = 0;

            for (const candle of unique) {
                const current = existingByTime.get(candle.time);
                if (!current) {
                    await sql`
                        INSERT INTO coingecko_ohlcv_candles (
                            id, coin_id, interval, time, open, high, low, close, volume
                        )
                        VALUES (
                            ${randomId('cgohlcv')}, ${coinId}, ${interval}, ${candle.time},
                            ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close}, ${candle.volume}
                        )
                        ON CONFLICT (coin_id, interval, time) DO NOTHING
                    `;
                    inserted += 1;
                    continue;
                }
                if (
                    current.open === candle.open &&
                    current.high === candle.high &&
                    current.low === candle.low &&
                    current.close === candle.close &&
                    current.volume === candle.volume
                ) {
                    skipped += 1;
                    continue;
                }
                await sql`
                    UPDATE coingecko_ohlcv_candles
                    SET open = ${candle.open},
                        high = ${candle.high},
                        low = ${candle.low},
                        close = ${candle.close},
                        volume = ${candle.volume}
                    WHERE coin_id = ${coinId}
                      AND interval = ${interval}
                      AND time = ${candle.time}
                `;
                updated += 1;
            }

            return { inserted, updated, skipped };
        },
    };
}
export function makePostgresClickhouseRepo(sql: Sql): ClickhouseRepo {
    return {
        async listStockMappableAssets() {
            const rows = await sql<
                {
                    asset_id: string;
                    category: string;
                    name: string | null;
                    symbol: string | null;
                    aliases: string[] | null;
                }[]
            >`
                SELECT asset_id, category, name, symbol, aliases
                FROM assets
                WHERE category IN ('equity', 'commodity')
                  AND is_active = true
                ORDER BY asset_id ASC
                LIMIT 5000
            `;
            return rows.map(r => ({
                assetId: r.asset_id,
                category: r.category,
                ...(r.name ? { name: r.name } : {}),
                ...(r.symbol ? { symbol: r.symbol } : {}),
                ...(Array.isArray(r.aliases) ? { aliases: r.aliases } : {}),
            }));
        },

        async upsertStockInstruments(mappings) {
            let upserted = 0;
            let skipped = 0;
            for (const m of mappings) {
                const assetId = m.assetId.trim();
                const symbol = m.symbol.trim().toUpperCase();
                if (!assetId || !symbol) {
                    skipped += 1;
                    continue;
                }
                await sql`
                    INSERT INTO stock_instruments_latest (
                        id, asset_id, symbol, normalized_symbol, name, instrument_id, dataset,
                        is_active, source, last_synced_at
                    )
                    VALUES (
                        ${randomId('sil')}, ${assetId}, ${symbol}, ${symbol},
                        ${m.name ?? null}, ${m.instrumentId ?? null}, ${m.dataset ?? null},
                        ${m.isActive}, 'clickhouse', ${m.lastSyncedAt}
                    )
                    ON CONFLICT (asset_id) DO UPDATE SET
                        symbol = EXCLUDED.symbol,
                        normalized_symbol = EXCLUDED.normalized_symbol,
                        name = EXCLUDED.name,
                        instrument_id = EXCLUDED.instrument_id,
                        dataset = EXCLUDED.dataset,
                        is_active = EXCLUDED.is_active,
                        last_synced_at = EXCLUDED.last_synced_at
                `;
                upserted += 1;
            }
            return { upserted, skipped };
        },

        async listActiveStockMappings(limit) {
            const lim = Math.min(Math.max(limit, 1), 1000);
            const rows = await sql<
                {
                    asset_id: string;
                    symbol: string;
                    normalized_symbol: string;
                }[]
            >`
                SELECT asset_id, symbol, normalized_symbol
                FROM stock_instruments_latest
                WHERE is_active = true
                ORDER BY asset_id ASC
                LIMIT ${lim}
            `;
            const out: ActiveStockMapping[] = [];
            for (const r of rows) {
                out.push({
                    assetId: r.asset_id,
                    symbol: r.symbol,
                    normalizedSymbol: r.normalized_symbol,
                });
            }
            return out;
        },

        async upsertStockPriceLatest(args) {
            await sql`
                INSERT INTO stock_prices_latest (
                    id, asset_id, symbol, normalized_symbol,
                    price_usd, volume_24h_usd, price_change_24h_percent, as_of,
                    last_fetched_at, source
                )
                VALUES (
                    ${randomId('spl')}, ${args.assetId}, ${args.symbol}, ${args.normalizedSymbol},
                    ${args.priceUsd}, ${args.volume24hUsd}, ${args.priceChange24hPercent}, ${args.asOf},
                    ${args.lastFetchedAt}, 'clickhouse_stock'
                )
                ON CONFLICT (asset_id) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    normalized_symbol = EXCLUDED.normalized_symbol,
                    price_usd = EXCLUDED.price_usd,
                    volume_24h_usd = EXCLUDED.volume_24h_usd,
                    price_change_24h_percent = EXCLUDED.price_change_24h_percent,
                    as_of = EXCLUDED.as_of,
                    last_fetched_at = EXCLUDED.last_fetched_at
            `;
        },

        async updateStockSharesOutstanding(args) {
            const rows = await sql`
                UPDATE stock_prices_latest SET
                    shares_outstanding = ${args.sharesOutstanding},
                    shares_as_of = ${args.sharesAsOf},
                    shares_last_fetched_at = ${args.sharesLastFetchedAt}
                WHERE asset_id = ${args.assetId}
            `;
            return { updated: rows.count };
        },

        async upsertVariantMarketFromClickhouse(args) {
            const clickhouseJson = {
                source: 'clickhouse_trades',
                ...(args.symbol ? { symbol: args.symbol } : {}),
                ...(args.name ? { name: args.name } : {}),
                ...(args.price !== null ? { price: args.price } : {}),
                volume1hUSD: args.volume1hUSD,
                volume24hUSD: args.volume24hUSD,
                trade1h: args.trade1h,
                trade24h: args.trade24h,
                uniqueWallet1h: args.uniqueWallet1h,
                uniqueWallet24h: args.uniqueWallet24h,
                ...(args.asOf !== null ? { asOf: args.asOf } : {}),
                lastFetchedAt: args.lastFetchedAt,
            };
            await sql`
                INSERT INTO variant_markets_latest (
                    id, mint, source, metrics_source,
                    clickhouse_metrics,
                    symbol, name,
                    price, volume_1h_usd, volume_24h_usd,
                    trade_1h, trade_24h, unique_wallet_1h, unique_wallet_24h,
                    price_change_1h_percent, price_change_24h_percent,
                    last_trade_at, last_fetched_at
                )
                VALUES (
                    ${randomId('vml')}, ${args.mint}, 'clickhouse_trades', 'clickhouse_trades',
                    ${sql.json(clickhouseJson)},
                    ${args.symbol ?? null}, ${args.name ?? null},
                    ${args.price}, ${args.volume1hUSD}, ${args.volume24hUSD},
                    ${args.trade1h}, ${args.trade24h}, ${args.uniqueWallet1h}, ${args.uniqueWallet24h},
                    ${args.priceChange1hPercent}, ${args.priceChange24hPercent},
                    ${args.lastTradeAt}, ${args.lastFetchedAt}
                )
                ON CONFLICT (mint) DO UPDATE SET
                    source = EXCLUDED.source,
                    metrics_source = EXCLUDED.metrics_source,
                    clickhouse_metrics = EXCLUDED.clickhouse_metrics,
                    symbol = COALESCE(EXCLUDED.symbol, variant_markets_latest.symbol),
                    name = COALESCE(EXCLUDED.name, variant_markets_latest.name),
                    price = EXCLUDED.price,
                    volume_1h_usd = EXCLUDED.volume_1h_usd,
                    volume_24h_usd = EXCLUDED.volume_24h_usd,
                    trade_1h = EXCLUDED.trade_1h,
                    trade_24h = EXCLUDED.trade_24h,
                    unique_wallet_1h = EXCLUDED.unique_wallet_1h,
                    unique_wallet_24h = EXCLUDED.unique_wallet_24h,
                    price_change_1h_percent = EXCLUDED.price_change_1h_percent,
                    price_change_24h_percent = EXCLUDED.price_change_24h_percent,
                    last_trade_at = EXCLUDED.last_trade_at,
                    last_fetched_at = EXCLUDED.last_fetched_at
            `;
        },

        async getStableMints() {
            const rows = await sql<{ mint: string }[]>`
                SELECT av.mint
                FROM asset_variants av
                JOIN assets a ON a.asset_id = av.asset_id
                WHERE av.is_active = true
                  AND av.chain = 'solana'
                  AND av.kind = 'stablecoin'
            `;
            const out = new Set<string>();
            out.add('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
            out.add('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
            for (const r of rows) {
                const mint = r.mint.trim();
                if (mint) out.add(mint);
            }
            return Array.from(out);
        },

        async getRegistryIdentityByMint(mint) {
            const rows = await sql<{ symbol: string | null; name: string | null }[]>`
                SELECT a.symbol, a.name
                FROM asset_variants av
                JOIN assets a ON a.asset_id = av.asset_id
                WHERE av.mint = ${mint}
                  AND av.is_active = true
                LIMIT 1
            `;
            const r = rows[0];
            if (!r) return null;
            return {
                ...(r.symbol ? { symbol: r.symbol } : {}),
                ...(r.name ? { name: r.name } : {}),
            };
        },
    };
}

export function makePostgresMiscJobsRepo(sql: Sql): MiscJobsRepo {
    return {
        async listStaleTokenAddresses(beforeLastFetchedAt, limit) {
            const lim = Math.min(Math.max(limit, 1), 250);
            const rows = await sql<{ address: string }[]>`
                SELECT address
                FROM tokens
                WHERE last_fetched_at < ${beforeLastFetchedAt}
                ORDER BY last_fetched_at ASC, address ASC
                LIMIT ${lim}
            `;
            return rows.map(r => r.address);
        },

        async upsertTokenFromBirdeye(args) {
            await sql`
                INSERT INTO tokens (
                    id, address, symbol, name, decimals, logo_uri,
                    price, price_change_24h_percent, price_change_1h_percent,
                    volume_24h_usd, liquidity, market_cap,
                    last_fetched_at
                )
                VALUES (
                    ${randomId('tok')}, ${args.address}, ${args.symbol}, ${args.name}, ${args.decimals},
                    ${args.logoUri ?? null},
                    ${args.price ?? null}, ${args.priceChange24hPercent ?? null}, ${args.priceChange1hPercent ?? null},
                    ${args.volume24hUSD ?? null}, ${args.liquidity ?? null}, ${args.marketCap ?? null},
                    ${args.lastFetchedAt}
                )
                ON CONFLICT (address) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    decimals = EXCLUDED.decimals,
                    logo_uri = COALESCE(EXCLUDED.logo_uri, tokens.logo_uri),
                    price = COALESCE(EXCLUDED.price, tokens.price),
                    price_change_24h_percent = COALESCE(EXCLUDED.price_change_24h_percent, tokens.price_change_24h_percent),
                    price_change_1h_percent = COALESCE(EXCLUDED.price_change_1h_percent, tokens.price_change_1h_percent),
                    volume_24h_usd = COALESCE(EXCLUDED.volume_24h_usd, tokens.volume_24h_usd),
                    liquidity = COALESCE(EXCLUDED.liquidity, tokens.liquidity),
                    market_cap = COALESCE(EXCLUDED.market_cap, tokens.market_cap),
                    last_fetched_at = EXCLUDED.last_fetched_at
            `;
        },

        async getTokenMarketsLastFetchedAtByMint(mint) {
            const rows = await sql<{ last_fetched_at: number | null }[]>`
                SELECT last_fetched_at
                FROM token_markets_latest
                WHERE mint = ${mint}
                LIMIT 1
            `;
            return rows[0]?.last_fetched_at ?? null;
        },

        async upsertTokenMarketsLatest(args) {
            await sql`
                INSERT INTO token_markets_latest (
                    id, mint, source, markets, total, last_fetched_at
                )
                VALUES (
                    ${randomId('tml')}, ${args.mint}, 'birdeye',
                    ${sql.json(args.markets as never)}, ${args.markets.length}, ${args.lastFetchedAt}
                )
                ON CONFLICT (mint) DO UPDATE SET
                    source = EXCLUDED.source,
                    markets = EXCLUDED.markets,
                    total = EXCLUDED.total,
                    last_fetched_at = EXCLUDED.last_fetched_at
            `;
        },

        async touchTokenMarketsLatest(mint, lastFetchedAt) {
            await sql`
                INSERT INTO token_markets_latest (id, mint, source, markets, total, last_fetched_at)
                VALUES (${randomId('tml')}, ${mint}, 'touch', '[]'::jsonb, 0, ${lastFetchedAt})
                ON CONFLICT (mint) DO UPDATE SET
                    last_fetched_at = EXCLUDED.last_fetched_at
            `;
        },
    };
}

export function makePostgresAssetDeletionTombstonesRepo(sql: Sql): AssetDeletionTombstonesRepo {
    return {
        async findDeletedNormalizedRefs(normalizedRefs) {
            if (normalizedRefs.length === 0) return [];
            const rows = await sql<{ normalized_ref: string }[]>`
                SELECT DISTINCT normalized_ref
                FROM asset_deletion_tombstones
                WHERE normalized_ref IN ${sql(normalizedRefs)}
            `;
            const found = new Set(rows.map(r => r.normalized_ref));
            return normalizedRefs.filter(ref => found.has(ref));
        },
    };
}

export function makePostgresSanctumLstsRepo(sql: Sql): SanctumLstsRepo {
    return {
        async listActive(limit) {
            const rows = await sql<SanctumLstRow[]>`
                SELECT mint, symbol, symbol_lower, name, logo_uri, website_url,
                       tvl_usd, apy, source_rank, is_active,
                       last_seen_at, last_synced_at, created_at, updated_at
                FROM sanctum_lsts_latest
                WHERE is_active = true
                ORDER BY source_rank ASC
                LIMIT ${limit}
            `;
            return rows.map(r => ({
                ...r,
                created_at:
                    typeof r.created_at === 'number'
                        ? r.created_at
                        : new Date(r.created_at as unknown as string).getTime(),
                updated_at:
                    typeof r.updated_at === 'number'
                        ? r.updated_at
                        : new Date(r.updated_at as unknown as string).getTime(),
            }));
        },
        async findByMint(mint) {
            const rows = await sql<SanctumLstRow[]>`
                SELECT mint, symbol, symbol_lower, name, logo_uri, website_url,
                       tvl_usd, apy, source_rank, is_active,
                       last_seen_at, last_synced_at, created_at, updated_at
                FROM sanctum_lsts_latest
                WHERE mint = ${mint}
                LIMIT 1
            `;
            const row = rows[0];
            if (!row) return null;
            return {
                ...row,
                created_at:
                    typeof row.created_at === 'number'
                        ? row.created_at
                        : new Date(row.created_at as unknown as string).getTime(),
                updated_at:
                    typeof row.updated_at === 'number'
                        ? row.updated_at
                        : new Date(row.updated_at as unknown as string).getTime(),
            };
        },
        async findActiveBySymbolLower(symbolLower, limit) {
            const rows = await sql<SanctumLstRow[]>`
                SELECT mint, symbol, symbol_lower, name, logo_uri, website_url,
                       tvl_usd, apy, source_rank, is_active,
                       last_seen_at, last_synced_at, created_at, updated_at
                FROM sanctum_lsts_latest
                WHERE symbol_lower = ${symbolLower}
                  AND is_active = true
                LIMIT ${limit}
            `;
            return rows.map(r => ({
                ...r,
                created_at:
                    typeof r.created_at === 'number'
                        ? r.created_at
                        : new Date(r.created_at as unknown as string).getTime(),
                updated_at:
                    typeof r.updated_at === 'number'
                        ? r.updated_at
                        : new Date(r.updated_at as unknown as string).getTime(),
            }));
        },
    };
}

export function makePostgresAssetMarketsRepo(sql: Sql): AssetMarketsRepo {
    return {
        async findLatestByAssetId(assetId) {
            const rows = await sql<AssetMarketRow[]>`
                SELECT asset_id, liquidity, volume_24h_usd, volume_30d_usd,
                       primary_mint, last_computed_at,
                       min_variant_last_fetched_at, max_variant_last_fetched_at
                FROM asset_markets_latest
                WHERE asset_id = ${assetId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findLatestByAssetIds(assetIds) {
            if (assetIds.length === 0) return [];
            const rows = await sql<AssetMarketRow[]>`
                SELECT asset_id, liquidity, volume_24h_usd, volume_30d_usd,
                       primary_mint, last_computed_at,
                       min_variant_last_fetched_at, max_variant_last_fetched_at
                FROM asset_markets_latest
                WHERE asset_id IN ${sql(assetIds)}
            `;
            return rows;
        },
    };
}

export function makePostgresVariantMarketsRepo(sql: Sql): VariantMarketsRepo {
    return {
        async findLatestByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<VariantMarketRow[]>`
                SELECT ${sql.unsafe(VARIANT_MARKET_COLUMNS)}
                FROM variant_markets_latest
                WHERE mint IN ${sql(mints)}
            `;
            return rows;
        },
    };
}

export function makePostgresAssetVariantsRepo(sql: Sql): AssetVariantsRepo {
    return {
        async findVariantByMint(mint) {
            const rows = await sql<AssetVariantDocRow[]>`
                SELECT asset_id, chain, mint, variant_id, kind, trust_tier,
                       stock_variant_tier, tags, issuer, issuer_url, label,
                       is_active, created_at, updated_at
                FROM asset_variants
                WHERE mint = ${mint}
                LIMIT 1
            `;
            const row = rows[0];
            if (!row) return null;
            return normalizeAssetVariantRow(row);
        },
        async findVariantsByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<AssetVariantDocRow[]>`
                SELECT asset_id, chain, mint, variant_id, kind, trust_tier,
                       stock_variant_tier, tags, issuer, issuer_url, label,
                       is_active, created_at, updated_at
                FROM asset_variants
                WHERE mint IN ${sql(mints)}
            `;
            return rows.map(normalizeAssetVariantRow);
        },
        async findVariantsByAssetIds(assetIds, includeInactive) {
            if (assetIds.length === 0) return [];
            const rows = includeInactive
                ? await sql<AssetVariantDocRow[]>`
                    SELECT asset_id, chain, mint, variant_id, kind, trust_tier,
                           stock_variant_tier, tags, issuer, issuer_url, label,
                           is_active, created_at, updated_at
                    FROM asset_variants
                    WHERE asset_id IN ${sql(assetIds)}
                    ORDER BY asset_id ASC, mint ASC
                `
                : await sql<AssetVariantDocRow[]>`
                    SELECT asset_id, chain, mint, variant_id, kind, trust_tier,
                           stock_variant_tier, tags, issuer, issuer_url, label,
                           is_active, created_at, updated_at
                    FROM asset_variants
                    WHERE asset_id IN ${sql(assetIds)}
                      AND is_active = true
                    ORDER BY asset_id ASC, mint ASC
                `;
            return rows.map(normalizeAssetVariantRow);
        },
        async findActiveSolanaVariants() {
            const rows = await sql<AssetVariantDocRow[]>`
                SELECT asset_id, chain, mint, variant_id, kind, trust_tier,
                       stock_variant_tier, tags, issuer, issuer_url, label,
                       is_active, created_at, updated_at
                FROM asset_variants
                WHERE asset_id = 'solana' AND is_active = true
                ORDER BY mint ASC
            `;
            return rows.map(normalizeAssetVariantRow);
        },
        async findAssetIsActive(assetId) {
            const rows = await sql<{ is_active: boolean }[]>`
                SELECT is_active FROM assets WHERE asset_id = ${assetId} LIMIT 1
            `;
            if (rows.length === 0) return null;
            return rows[0]!.is_active;
        },
        async findSolanaDefaultVariantsView() {
            const rows = await sql<{ variants_json: string; updated_at: number }[]>`
                SELECT variants_json::text AS variants_json, updated_at
                FROM asset_variant_views
                WHERE key = 'solana:variants:default'
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async upsertSolanaDefaultVariantsView(args) {
            await sql`
                INSERT INTO asset_variant_views (id, key, asset_id, variants_json, updated_at)
                VALUES (
                    coalesce(
                        (SELECT id FROM asset_variant_views WHERE key = 'solana:variants:default'),
                        ${randomId('avv')}
                    ),
                    'solana:variants:default', 'solana', ${sql.json(JSON.parse(args.variantsJson) as never)}, ${args.updatedAt}
                )
                ON CONFLICT (key) DO UPDATE
                SET variants_json = EXCLUDED.variants_json,
                    asset_id = EXCLUDED.asset_id,
                    updated_at = EXCLUDED.updated_at
            `;
        },
        async findVariantMarketsByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<VariantMarketRow[]>`
                SELECT ${sql.unsafe(VARIANT_MARKET_COLUMNS)}
                FROM variant_markets_latest
                WHERE mint IN ${sql(mints)}
            `;
            return rows;
        },
        async findTokenMarketsByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<TokenMarketRow[]>`
                SELECT mint, source, markets, total, last_fetched_at
                FROM token_markets_latest
                WHERE mint IN ${sql(mints)}
            `;
            return rows;
        },
    };
}

export function makePostgresAssetsApiRepo(sql: Sql): AssetsApiRepo {
    return {
        async findAssetByAssetId(assetId) {
            const rows = await sql<AssetsApiAssetRow[]>`
                SELECT asset_id, category, name, symbol, aliases,
                       coingecko_id, description, image_url, is_active,
                       created_at, updated_at
                FROM assets
                WHERE asset_id = ${assetId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findActiveVariantsByAssetId(assetId) {
            const rows = await sql<AssetsApiVariantRow[]>`
                SELECT asset_id, chain, mint, variant_id, kind, trust_tier,
                       stock_variant_tier, tags, issuer, issuer_url, label,
                       is_active, created_at, updated_at
                FROM asset_variants
                WHERE asset_id = ${assetId}
                  AND is_active = true
                ORDER BY mint ASC
            `;
            return rows;
        },
        async findVariantMarketsLatestByMint(mint) {
            const rows = await sql<AssetsApiVariantMarketRow[]>`
                SELECT mint, source, metrics_source,
                       birdeye_metrics, rwa_metrics, clickhouse_metrics,
                       symbol, name, decimals, logo_uri,
                       price, liquidity,
                       volume_5m_usd, volume_15m_usd, volume_1h_usd,
                       volume_6h_usd, volume_24h_usd,
                       trade_5m, trade_15m, trade_1h, trade_6h, trade_24h,
                       unique_wallet_5m, unique_wallet_1h, unique_wallet_24h,
                       market_cap, fdv,
                       price_change_24h_percent, price_change_1h_percent,
                       holder, total_supply, circulating_supply,
                       last_trade_human_time, extensions,
                       as_of, last_trade_at, last_fetched_at, overview_last_fetched_at
                FROM variant_markets_latest
                WHERE mint = ${mint}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findVariantMarketsLatestByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<AssetsApiVariantMarketRow[]>`
                SELECT mint, source, metrics_source,
                       birdeye_metrics, rwa_metrics, clickhouse_metrics,
                       symbol, name, decimals, logo_uri,
                       price, liquidity,
                       volume_5m_usd, volume_15m_usd, volume_1h_usd,
                       volume_6h_usd, volume_24h_usd,
                       trade_5m, trade_15m, trade_1h, trade_6h, trade_24h,
                       unique_wallet_5m, unique_wallet_1h, unique_wallet_24h,
                       market_cap, fdv,
                       price_change_24h_percent, price_change_1h_percent,
                       holder, total_supply, circulating_supply,
                       last_trade_human_time, extensions,
                       as_of, last_trade_at, last_fetched_at, overview_last_fetched_at
                FROM variant_markets_latest
                WHERE mint IN ${sql(mints)}
            `;
            return rows;
        },
        async findVariantFillQualityLatestByMint(mint) {
            const rows = await sql<AssetsApiFillQualityRow[]>`
                SELECT mint, source, range_identifier, horizon, quote_mint,
                       volume_24h_usd, trade_24h,
                       bot_volume_24h_usd, bot_trade_24h, bot_volume_ratio,
                       fee_24h_usd, fee_bps, flow_source_count,
                       markout_pnl_24h_usd, markout_count, markout_bps,
                       execution_score, is_eligible_for_primary,
                       as_of, last_computed_at
                FROM variant_fill_quality_latest
                WHERE mint = ${mint}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findVariantFillQualityLatestByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<AssetsApiFillQualityRow[]>`
                SELECT DISTINCT ON (mint)
                       mint, source, range_identifier, horizon, quote_mint,
                       volume_24h_usd, trade_24h,
                       bot_volume_24h_usd, bot_trade_24h, bot_volume_ratio,
                       fee_24h_usd, fee_bps, flow_source_count,
                       markout_pnl_24h_usd, markout_count, markout_bps,
                       execution_score, is_eligible_for_primary,
                       as_of, last_computed_at
                FROM variant_fill_quality_latest
                WHERE mint IN ${sql(mints)}
                ORDER BY mint, last_computed_at DESC NULLS LAST, source ASC
            `;
            return rows;
        },
        async findAssetMarketsLatestByAssetId(assetId) {
            const rows = await sql<AssetsApiAssetMarketRow[]>`
                SELECT asset_id, liquidity, volume_24h_usd, volume_30d_usd,
                       primary_mint, last_computed_at,
                       min_variant_last_fetched_at, max_variant_last_fetched_at
                FROM asset_markets_latest
                WHERE asset_id = ${assetId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findCoingeckoCoinByCoinId(coinId) {
            const rows = await sql<AssetsApiCoingeckoCoinRow[]>`
                SELECT coin_id, symbol, name, platforms,
                       last_synced_at, coin, last_metadata_fetched_at
                FROM coingecko_coins
                WHERE coin_id = ${coinId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findStockInstrumentsLatestByAssetId(assetId) {
            const rows = await sql<AssetsApiStockInstrumentRow[]>`
                SELECT asset_id, symbol, normalized_symbol, name,
                       instrument_id, dataset, is_active, source, last_synced_at
                FROM stock_instruments_latest
                WHERE asset_id = ${assetId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findStockPricesLatestByAssetId(assetId) {
            const rows = await sql<AssetsApiStockPriceRow[]>`
                SELECT asset_id, symbol, normalized_symbol,
                       price_usd, volume_24h_usd, price_change_24h_percent,
                       as_of, last_fetched_at, source
                FROM stock_prices_latest
                WHERE asset_id = ${assetId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
    };
}
function normalizeAssetVariantRow(row: AssetVariantDocRow): AssetVariantDocRow {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    return {
        ...row,
        tags,
        created_at:
            typeof row.created_at === 'number'
                ? row.created_at
                : new Date(row.created_at as unknown as string).getTime(),
        updated_at:
            typeof row.updated_at === 'number'
                ? row.updated_at
                : new Date(row.updated_at as unknown as string).getTime(),
    };
}

function sqlFragmentColumns(cols: readonly string[]): string {
    return cols.join(', ');
}

export function makePostgresCoingeckoReadsRepo(sql: Sql): CoingeckoReadsRepo {
    return {
        async findCoinByCoinId(coinId) {
            const rows = await sql<CoingeckoCoinRow[]>`
                SELECT id, coin_id, symbol, name, platforms,
                       last_synced_at, coin, last_metadata_fetched_at, created_at
                FROM coingecko_coins
                WHERE coin_id = ${coinId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async searchCoinsById(query, limit) {
            const tsq = buildPrefixTsQuery(query) ?? 'noresultsentinel:*';
            const pattern = `%${query}%`;
            const prefix = `${query}%`;
            const rows = await sql<CoingeckoCoinSearchRow[]>`
                SELECT coin_id, symbol, name, platforms, coin
                FROM coingecko_coins
                WHERE to_tsvector('english', coin_id) @@ to_tsquery('english', ${tsq})
                   OR coin_id ILIKE ${pattern}
                ORDER BY
                    CASE
                        WHEN lower(coin_id) = lower(${query}) THEN 0
                        WHEN lower(coin_id) LIKE lower(${prefix}) THEN 1
                        ELSE 2
                    END,
                    ts_rank_cd(to_tsvector('english', coin_id), to_tsquery('english', ${tsq})) DESC,
                    length(coin_id) ASC,
                    coin_id ASC
                LIMIT ${limit}
            `;
            return rows;
        },
        async searchCoinsBySymbol(query, limit) {
            const tsq = buildPrefixTsQuery(query) ?? 'noresultsentinel:*';
            const pattern = `%${query}%`;
            const prefix = `${query}%`;
            const rows = await sql<CoingeckoCoinSearchRow[]>`
                SELECT coin_id, symbol, name, platforms, coin
                FROM coingecko_coins
                WHERE to_tsvector('english', symbol) @@ to_tsquery('english', ${tsq})
                   OR symbol ILIKE ${pattern}
                ORDER BY
                    CASE
                        WHEN lower(symbol) = lower(${query}) THEN 0
                        WHEN lower(symbol) LIKE lower(${prefix}) THEN 1
                        ELSE 2
                    END,
                    ts_rank_cd(to_tsvector('english', symbol), to_tsquery('english', ${tsq})) DESC,
                    length(symbol) ASC,
                    symbol ASC
                LIMIT ${limit}
            `;
            return rows;
        },
        async searchCoinsByName(query, limit) {
            const tsq = buildPrefixTsQuery(query) ?? 'noresultsentinel:*';
            const pattern = `%${query}%`;
            const prefix = `${query}%`;
            const rows = await sql<CoingeckoCoinSearchRow[]>`
                SELECT coin_id, symbol, name, platforms, coin
                FROM coingecko_coins
                WHERE to_tsvector('english', name) @@ to_tsquery('english', ${tsq})
                   OR name ILIKE ${pattern}
                ORDER BY
                    CASE
                        WHEN lower(name) = lower(${query}) THEN 0
                        WHEN lower(name) LIKE lower(${prefix}) THEN 1
                        ELSE 2
                    END,
                    ts_rank_cd(to_tsvector('english', name), to_tsquery('english', ${tsq})) DESC,
                    length(name) ASC,
                    name ASC
                LIMIT ${limit}
            `;
            return rows;
        },
        async listOhlcv(coinId, interval: CoingeckoOhlcvInterval, fromTime, toTime, limit) {
            const rows = await sql<CoingeckoOhlcvRow[]>`
                SELECT time, open, high, low, close, volume
                FROM coingecko_ohlcv_candles
                WHERE coin_id = ${coinId}
                  AND interval = ${interval}
                  AND time >= ${fromTime}
                  AND time <= ${toTime}
                ORDER BY time ASC
                LIMIT ${limit}
            `;
            return rows;
        },
        async findPriceLatestByCoinId(coinId) {
            const rows = await sql<CoingeckoPriceLatestRow[]>`
                SELECT coin_id, price_usd, market_cap_usd, volume_24h_usd,
                       price_change_24h_percent, provider_last_updated_at, last_fetched_at
                FROM coingecko_prices_latest
                WHERE coin_id = ${coinId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findPriceLatestByCoinIds(coinIds) {
            if (coinIds.length === 0) return [];
            const rows = await sql<CoingeckoPriceLatestRow[]>`
                SELECT coin_id, price_usd, market_cap_usd, volume_24h_usd,
                       price_change_24h_percent, provider_last_updated_at, last_fetched_at
                FROM coingecko_prices_latest
                WHERE coin_id IN ${sql(coinIds)}
            `;
            return rows;
        },
        async findTickersLatestByCoinId(coinId) {
            const rows = await sql<CoingeckoTickersLatestRow[]>`
                SELECT coin_id, name, tickers, total, last_fetched_at
                FROM coingecko_coin_tickers_latest
                WHERE coin_id = ${coinId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
    };
}

const VARIANT_MARKET_COLUMNS = sqlFragmentColumns([
    'mint',
    'source',
    'metrics_source',
    'birdeye_metrics',
    'rwa_metrics',
    'clickhouse_metrics',
    'symbol',
    'name',
    'decimals',
    'logo_uri',
    'price',
    'liquidity',
    'volume_1h_usd',
    'volume_24h_usd',
    'trade_1h',
    'trade_24h',
    'unique_wallet_1h',
    'unique_wallet_24h',
    'market_cap',
    'fdv',
    'price_change_24h_percent',
    'price_change_1h_percent',
    'holder',
    'total_supply',
    'circulating_supply',
    'last_trade_human_time',
    'extensions',
    'as_of',
    'last_trade_at',
    'last_fetched_at',
    'overview_last_fetched_at',
]);

export function makePostgresStockReadsRepo(sql: Sql): StockReadsRepo {
    return {
        async findInstrumentByAssetId(assetId) {
            const rows = await sql<StockInstrumentRow[]>`
                SELECT asset_id, symbol, normalized_symbol, name,
                       instrument_id, dataset, is_active, source, last_synced_at
                FROM stock_instruments_latest
                WHERE asset_id = ${assetId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findInstrumentsByAssetIds(assetIds) {
            if (assetIds.length === 0) return [];
            const rows = await sql<StockInstrumentRow[]>`
                SELECT asset_id, symbol, normalized_symbol, name,
                       instrument_id, dataset, is_active, source, last_synced_at
                FROM stock_instruments_latest
                WHERE asset_id IN ${sql(assetIds)}
            `;
            return rows;
        },
        async findPriceByAssetId(assetId) {
            const rows = await sql<StockPriceRow[]>`
                SELECT asset_id, symbol, normalized_symbol,
                       price_usd, volume_24h_usd, price_change_24h_percent,
                       shares_outstanding, shares_as_of, shares_last_fetched_at,
                       as_of, last_fetched_at, source
                FROM stock_prices_latest
                WHERE asset_id = ${assetId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findPricesByAssetIds(assetIds) {
            if (assetIds.length === 0) return [];
            const rows = await sql<StockPriceRow[]>`
                SELECT asset_id, symbol, normalized_symbol,
                       price_usd, volume_24h_usd, price_change_24h_percent,
                       shares_outstanding, shares_as_of, shares_last_fetched_at,
                       as_of, last_fetched_at, source
                FROM stock_prices_latest
                WHERE asset_id IN ${sql(assetIds)}
            `;
            return rows;
        },
    };
}

export function makePostgresPrestocksRepo(sql: Sql): PrestocksRepo {
    return {
        async upsertLatest(row) {
            await sql`
                INSERT INTO prestocks_prices_latest (
                    id, mint, symbol, name,
                    mark_price_usd, mark_valuation_usd, token_price_usd, implied_valuation_usd,
                    supply, image_url, external_url,
                    last_fetched_at, source
                )
                VALUES (
                    ${randomId('psl')}, ${row.mint}, ${row.symbol}, ${row.name},
                    ${row.markPriceUsd}, ${row.markValuationUsd}, ${row.tokenPriceUsd}, ${row.impliedValuationUsd},
                    ${row.supply}, ${row.imageUrl}, ${row.externalUrl},
                    ${row.lastFetchedAt}, 'prestocks'
                )
                ON CONFLICT (mint) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    mark_price_usd = EXCLUDED.mark_price_usd,
                    mark_valuation_usd = EXCLUDED.mark_valuation_usd,
                    token_price_usd = EXCLUDED.token_price_usd,
                    implied_valuation_usd = EXCLUDED.implied_valuation_usd,
                    supply = EXCLUDED.supply,
                    image_url = EXCLUDED.image_url,
                    external_url = EXCLUDED.external_url,
                    last_fetched_at = EXCLUDED.last_fetched_at,
                    updated_at = now()
            `;
        },
    };
}

export function makePostgresPrestocksReadsRepo(sql: Sql): PrestocksReadsRepo {
    return {
        async findLatestByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<PrestocksPriceRow[]>`
                SELECT mint, symbol, name,
                       mark_price_usd, mark_valuation_usd, token_price_usd, implied_valuation_usd,
                       supply, last_fetched_at, source
                FROM prestocks_prices_latest
                WHERE mint IN ${sql(mints)}
            `;
            return rows;
        },
    };
}

export function makePostgresOhlcvReadsRepo(sql: Sql): OhlcvReadsRepo {
    return {
        async listByAddressAndInterval(address, interval, from, to, limit) {
            const rows = await sql<OhlcvCandleRow[]>`
                SELECT time, open, high, low, close, volume
                FROM ohlcv_candles
                WHERE address = ${address}
                  AND interval = ${interval as TimeInterval}
                  AND time >= ${from}
                  AND time <= ${to}
                ORDER BY time ASC
                LIMIT ${limit}
            `;
            return rows;
        },
        async getBoundsByAddressAndInterval(address, interval) {
            const rows = await sql<{ min_time: number | null; max_time: number | null }[]>`
                SELECT MIN(time) AS min_time, MAX(time) AS max_time
                FROM ohlcv_candles
                WHERE address = ${address} AND interval = ${interval as TimeInterval}
            `;
            const row = rows[0];
            return {
                minTime: row?.min_time ?? null,
                maxTime: row?.max_time ?? null,
            };
        },
        async listByAssetIdAndInterval(assetId, interval, from, to, limit) {
            const rows = await sql<OhlcvCandleRow[]>`
                SELECT time, open, high, low, close, volume
                FROM stock_ohlcv_candles
                WHERE asset_id = ${assetId}
                  AND interval = ${interval as TimeInterval}
                  AND time >= ${from}
                  AND time <= ${to}
                ORDER BY time ASC
                LIMIT ${limit}
            `;
            return rows;
        },
    };
}

const TOKEN_COLUMNS = sqlFragmentColumns([
    'id',
    'address',
    'symbol',
    'name',
    'decimals',
    'logo_uri',
    'coingecko_id',
    'description',
    'website',
    'twitter',
    'discord',
    'telegram',
    'reddit',
    'github',
    'price',
    'price_change_24h_percent',
    'price_change_1h_percent',
    'volume_24h_usd',
    'liquidity',
    'market_cap',
    'last_fetched_at',
    'created_at',
]);

const TRENDING_MARKET_COLUMNS = sqlFragmentColumns([
    'mint',
    'asset_id',
    'variant_id',
    'category',
    'symbol',
    'name',
    'decimals',
    'logo_uri',
    'source',
    'scoring_version',
    'price',
    'volume_5m_usd',
    'volume_15m_usd',
    'volume_1h_usd',
    'volume_6h_usd',
    'volume_24h_usd',
    'trade_5m',
    'trade_15m',
    'trade_1h',
    'trade_6h',
    'trade_24h',
    'unique_wallet_5m',
    'unique_wallet_1h',
    'unique_wallet_24h',
    'price_change_1h_percent',
    'price_change_24h_percent',
    'trending_score',
    'rank',
    'category_rank',
    'last_trade_at',
    'as_of',
    'last_computed_at',
]);

const FRESH_TRENDING_MARKET_COLUMNS = sqlFragmentColumns([
    'mint',
    'asset_id',
    'variant_id',
    'category',
    'symbol',
    'name',
    'decimals',
    'logo_uri',
    'source',
    'metrics_source',
    'scoring_version',
    'price',
    'liquidity',
    'volume_5m_usd',
    'volume_15m_usd',
    'volume_1h_usd',
    'volume_6h_usd',
    'volume_24h_usd',
    'trade_5m',
    'trade_15m',
    'trade_1h',
    'trade_6h',
    'trade_24h',
    'unique_wallet_5m',
    'unique_wallet_1h',
    'unique_wallet_24h',
    'price_change_1h_percent',
    'price_change_24h_percent',
    'last_trade_at',
    'as_of',
    'last_fetched_at',
    'trending_score',
    'rank',
    'category_rank',
    'last_computed_at',
]);

const FILL_QUALITY_COLUMNS = sqlFragmentColumns([
    'mint',
    'source',
    'range_identifier',
    'horizon',
    'quote_mint',
    'volume_24h_usd',
    'trade_24h',
    'bot_volume_24h_usd',
    'bot_trade_24h',
    'bot_volume_ratio',
    'fee_24h_usd',
    'fee_bps',
    'flow_source_count',
    'markout_pnl_24h_usd',
    'markout_count',
    'markout_bps',
    'execution_score',
    'is_eligible_for_primary',
    'as_of',
    'last_computed_at',
]);

const TOKEN_DESCRIPTION_SUMMARY_COLUMNS = sqlFragmentColumns([
    'id',
    'address',
    'summary',
    'source_hash',
    'model',
    'prompt_version',
    'generated_at',
    'created_at',
]);

const TOKEN_MARKETS_LATEST_COLUMNS = sqlFragmentColumns(['mint', 'source', 'markets', 'total', 'last_fetched_at']);

export function makePostgresTokensReadsRepo(sql: Sql): TokensReadsRepo {
    return {
        async findTokenByAddress(address) {
            const rows = await sql<TokenRow[]>`
                SELECT ${sql.unsafe(TOKEN_COLUMNS)}
                FROM tokens
                WHERE address = ${address}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findTokensByAddresses(addresses) {
            if (addresses.length === 0) return [];
            const rows = await sql<TokenRow[]>`
                SELECT ${sql.unsafe(TOKEN_COLUMNS)}
                FROM tokens
                WHERE address IN ${sql(addresses)}
            `;
            return rows;
        },
        async searchTokensBySymbol(query, limit) {
            const tsq = buildPrefixTsQuery(query) ?? 'noresultsentinel:*';
            const pattern = `%${query}%`;
            const prefix = `${query}%`;
            const rows = await sql<TokenRow[]>`
                SELECT ${sql.unsafe(TOKEN_COLUMNS)}
                FROM tokens
                WHERE to_tsvector('english', coalesce(symbol, '')) @@ to_tsquery('english', ${tsq})
                   OR coalesce(symbol, '') ILIKE ${pattern}
                ORDER BY
                    CASE
                        WHEN lower(coalesce(symbol, '')) = lower(${query}) THEN 0
                        WHEN lower(coalesce(symbol, '')) LIKE lower(${prefix}) THEN 1
                        ELSE 2
                    END,
                    ts_rank_cd(to_tsvector('english', coalesce(symbol, '')), to_tsquery('english', ${tsq})) DESC,
                    length(coalesce(symbol, '')) ASC,
                    symbol ASC
                LIMIT ${limit}
            `;
            return rows;
        },
        async searchTokensByName(query, limit) {
            const tsq = buildPrefixTsQuery(query) ?? 'noresultsentinel:*';
            const pattern = `%${query}%`;
            const prefix = `${query}%`;
            const rows = await sql<TokenRow[]>`
                SELECT ${sql.unsafe(TOKEN_COLUMNS)}
                FROM tokens
                WHERE to_tsvector('english', coalesce(name, '')) @@ to_tsquery('english', ${tsq})
                   OR coalesce(name, '') ILIKE ${pattern}
                ORDER BY
                    CASE
                        WHEN lower(coalesce(name, '')) = lower(${query}) THEN 0
                        WHEN lower(coalesce(name, '')) LIKE lower(${prefix}) THEN 1
                        ELSE 2
                    END,
                    ts_rank_cd(to_tsvector('english', coalesce(name, '')), to_tsquery('english', ${tsq})) DESC,
                    length(coalesce(name, '')) ASC,
                    name ASC
                LIMIT ${limit}
            `;
            return rows;
        },
        async findTokenMarketsLatestByMint(mint) {
            const rows = await sql<TokenMarketsLatestRow[]>`
                SELECT ${sql.unsafe(TOKEN_MARKETS_LATEST_COLUMNS)}
                FROM token_markets_latest
                WHERE mint = ${mint}
                ORDER BY last_fetched_at DESC NULLS LAST, source ASC
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
        async findTokenMarketsLatestByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<TokenMarketsLatestRow[]>`
                SELECT DISTINCT ON (mint) ${sql.unsafe(TOKEN_MARKETS_LATEST_COLUMNS)}
                FROM token_markets_latest
                WHERE mint IN ${sql(mints)}
                ORDER BY mint, last_fetched_at DESC NULLS LAST, source ASC
            `;
            return rows;
        },
        async findTokenDescriptionSummaryByAddress(address) {
            const rows = await sql<TokenDescriptionSummaryRow[]>`
                SELECT ${sql.unsafe(TOKEN_DESCRIPTION_SUMMARY_COLUMNS)}
                FROM token_description_summaries
                WHERE address = ${address}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
    };
}

export function makePostgresTrendingReadsRepo(sql: Sql): TrendingReadsRepo {
    return {
        async listTrending(category) {
            const rows = category
                ? await sql<TrendingMarketRow[]>`
                    SELECT ${sql.unsafe(TRENDING_MARKET_COLUMNS)}
                    FROM trending_markets
                    WHERE category = ${category}
                `
                : await sql<TrendingMarketRow[]>`
                    SELECT ${sql.unsafe(TRENDING_MARKET_COLUMNS)}
                    FROM trending_markets
                `;
            return rows;
        },
        async listFreshTrending(category) {
            const rows = category
                ? await sql<FreshTrendingMarketRow[]>`
                    SELECT ${sql.unsafe(FRESH_TRENDING_MARKET_COLUMNS)}
                    FROM fresh_trending_markets
                    WHERE category = ${category}
                `
                : await sql<FreshTrendingMarketRow[]>`
                    SELECT ${sql.unsafe(FRESH_TRENDING_MARKET_COLUMNS)}
                    FROM fresh_trending_markets
                `;
            return rows;
        },
    };
}

export function makePostgresFillQualityReadsRepo(sql: Sql): FillQualityReadsRepo {
    return {
        async findLatestByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<FillQualityRow[]>`
                SELECT ${sql.unsafe(FILL_QUALITY_COLUMNS)}
                FROM variant_fill_quality_latest
                WHERE mint IN ${sql(mints)}
                  AND source = 'clickhouse_fill_quality'
                  AND range_identifier = '24h'
                  AND horizon = '5s'
            `;
            return rows;
        },
    };
}

export function makePostgresAssetCollectionsReadsRepo(sql: Sql): AssetCollectionsReadsRepo {
    return {
        async listMembersBySlug(slug, limit) {
            const rows = await sql<AssetCollectionMemberRow[]>`
                SELECT asset_id
                FROM asset_collection_members
                WHERE collection_slug = ${slug}
                ORDER BY rank ASC
                LIMIT ${limit}
            `;
            return rows;
        },
        async listMemberMintsBySlug(slug, limit) {
            const rows = await sql<{ mint: string }[]>`
                SELECT av.mint
                FROM asset_collection_members acm
                JOIN assets a ON a.asset_id = acm.asset_id AND a.is_active = true
                JOIN asset_variants av ON av.asset_id = acm.asset_id AND av.is_active = true
                WHERE acm.collection_slug = ${slug}
                ORDER BY acm.rank ASC, av.mint ASC
                LIMIT ${limit}
            `;
            return rows;
        },
        async getSummariesBySlugs(slugs) {
            if (slugs.length === 0) return [];
            // "Last added" counts a new variant on an existing member too: attaching
            // a mint to a canonical that is already in the list (the admin add-variant
            // flow) never writes asset_collection_members, so membership added_at
            // alone can never see it. Auto-synced yield/LST variants are excluded so
            // Sanctum churn cannot hold the highlight hostage.
            const rows = await sql<
                {
                    collection_slug: string;
                    member_count: number;
                    last_added_asset_id: string | null;
                    last_added_at: number | null;
                }[]
            >`
                WITH members AS (
                    SELECT acm.collection_slug,
                           acm.asset_id,
                           acm.rank,
                           GREATEST(
                               acm.added_at,
                               COALESCE((
                                   SELECT MAX((EXTRACT(EPOCH FROM av.created_at) * 1000)::bigint)
                                   FROM asset_variants av
                                   WHERE av.asset_id = acm.asset_id
                                     AND av.is_active = true
                                     AND av.kind NOT IN ('yield', 'lst')
                               ), acm.added_at)
                           ) AS added_at
                    FROM asset_collection_members acm
                    JOIN assets a ON a.asset_id = acm.asset_id AND a.is_active = true
                    WHERE acm.collection_slug IN ${sql([...slugs])}
                      AND NOT EXISTS (
                          SELECT 1 FROM asset_deletion_tombstones t WHERE t.asset_id = acm.asset_id
                      )
                )
                SELECT collection_slug,
                       COUNT(*)::int AS member_count,
                       (ARRAY_AGG(asset_id ORDER BY added_at DESC, rank ASC))[1] AS last_added_asset_id,
                       MAX(added_at) AS last_added_at
                FROM members
                GROUP BY collection_slug
            `;
            return rows.map(r => ({
                collection_slug: r.collection_slug,
                member_count: r.member_count,
                last_added_asset_id: r.last_added_asset_id,
                last_added_at: r.last_added_at === null ? null : Number(r.last_added_at),
            }));
        },
    };
}

/** Shared SELECT shape for token_lists rows with epoch-ms timestamps and member counts. */
const TOKEN_LIST_ROW_COLUMNS = `
    tl.id,
    tl.slug,
    tl.owner_project_id,
    tl.name,
    tl.status,
    (SELECT COUNT(*)::int FROM token_list_members m WHERE m.list_id = tl.id) AS member_count,
    (EXTRACT(EPOCH FROM tl.created_at) * 1000)::bigint AS created_at,
    (EXTRACT(EPOCH FROM tl.updated_at) * 1000)::bigint AS updated_at
`;

export function makePostgresTokenListsReadsRepo(sql: Sql): TokenListsReadsRepo {
    return {
        async listPublished(limit, offset) {
            const rows = await sql<TokenListSummaryRow[]>`
                SELECT tl.slug,
                       tl.name,
                       tl.owner_project_id,
                       (SELECT COUNT(*)::int FROM token_list_members m WHERE m.list_id = tl.id) AS member_count,
                       (EXTRACT(EPOCH FROM tl.updated_at) * 1000)::bigint AS updated_at
                FROM token_lists tl
                WHERE tl.status = 'published'
                ORDER BY tl.updated_at DESC, tl.slug ASC
                LIMIT ${limit} OFFSET ${offset}
            `;
            return rows;
        },
        async getBySlug(slug) {
            const rows = await sql<TokenListRow[]>`
                SELECT ${sql.unsafe(TOKEN_LIST_ROW_COLUMNS)} FROM token_lists tl WHERE tl.slug = ${slug}
            `;
            return rows[0] ?? null;
        },
        async listMembersBySlug(slug, limit, offset) {
            // `verified` = an active registry variant exists for the mint and its
            // asset was not hard-deleted (same tombstone rule as collections reads).
            const rows = await sql<TokenListMemberRow[]>`
                SELECT m.mint,
                       m.rank,
                       m.note,
                       m.added_at,
                       m.symbol,
                       m.name,
                       m.logo_uri,
                       m.decimals,
                       EXISTS (
                           SELECT 1
                           FROM asset_variants av
                           WHERE av.mint = m.mint
                             AND av.is_active = true
                             AND NOT EXISTS (
                                 SELECT 1 FROM asset_deletion_tombstones t WHERE t.asset_id = av.asset_id
                             )
                       ) AS verified
                FROM token_list_members m
                JOIN token_lists tl ON tl.id = m.list_id
                WHERE tl.slug = ${slug}
                ORDER BY m.rank ASC, m.mint ASC
                LIMIT ${limit} OFFSET ${offset}
            `;
            return rows;
        },
        async listSlugsByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<{ mint: string; slug: string }[]>`
                SELECT m.mint, tl.slug
                FROM token_list_members m
                JOIN token_lists tl ON tl.id = m.list_id AND tl.status = 'published'
                WHERE m.mint IN ${sql([...mints])}
                ORDER BY tl.slug ASC
            `;
            return rows;
        },
    };
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

export function makePostgresTokenListsMutationsRepo(sql: Sql): TokenListsMutationsRepo {
    async function getRowById(listId: string): Promise<TokenListMutationRow> {
        const rows = await sql<TokenListMutationRow[]>`
            SELECT ${sql.unsafe(TOKEN_LIST_ROW_COLUMNS)} FROM token_lists tl WHERE tl.id = ${listId}
        `;
        const row = rows[0];
        if (!row) throw new Error(`token list disappeared mid-mutation: ${listId}`);
        return row;
    }

    return {
        async getListBySlug(slug) {
            const rows = await sql<TokenListMutationRow[]>`
                SELECT ${sql.unsafe(TOKEN_LIST_ROW_COLUMNS)} FROM token_lists tl WHERE tl.slug = ${slug}
            `;
            return rows[0] ?? null;
        },
        async insertList(args) {
            const now = new Date(args.nowMs);
            const id = randomId('tl');
            try {
                await sql`
                    INSERT INTO token_lists (id, slug, owner_project_id, name, status, created_at, updated_at)
                    VALUES (${id}, ${args.slug}, ${args.ownerProjectId}, ${args.name}, ${args.status}, ${now}, ${now})
                `;
            } catch (err) {
                if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
                    throw new SlugConflictError(args.slug);
                }
                throw err;
            }
            return getRowById(id);
        },
        async updateList(listId, patch, nowMs) {
            // Merge in JS against the current row — the handler holds the only
            // write path and already verified ownership, so no lost-update risk
            // worth a FOR UPDATE here.
            const current = await getRowById(listId);
            try {
                await sql`
                    UPDATE token_lists SET
                        slug = ${patch.slug !== undefined ? patch.slug : current.slug},
                        name = ${patch.name !== undefined ? patch.name : current.name},
                        status = ${patch.status !== undefined ? patch.status : current.status},
                        updated_at = ${new Date(nowMs)}
                    WHERE id = ${listId}
                `;
            } catch (err) {
                if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
                    throw new SlugConflictError(patch.slug ?? current.slug);
                }
                throw err;
            }
            return getRowById(listId);
        },
        async deleteList(listId) {
            // token_list_members.list_id is ON DELETE CASCADE, so members go with it.
            await sql`DELETE FROM token_lists WHERE id = ${listId}`;
        },
        async upsertMember(args) {
            const rank = args.rank;
            await sql`
                INSERT INTO token_list_members (id, list_id, mint, rank, note, added_at, symbol, name, logo_uri, decimals)
                VALUES (
                    ${randomId('tlm')}, ${args.listId}, ${args.mint},
                    COALESCE(${rank}, (
                        SELECT COALESCE(MAX(rank), -1) + 1 FROM token_list_members WHERE list_id = ${args.listId}
                    )),
                    ${args.note}, ${args.addedAt},
                    ${args.snapshot?.symbol ?? null}, ${args.snapshot?.name ?? null},
                    ${args.snapshot?.logoUri ?? null}, ${args.snapshot?.decimals ?? null}
                )
                ON CONFLICT (list_id, mint) DO UPDATE SET
                    rank = COALESCE(${rank}, token_list_members.rank),
                    note = EXCLUDED.note,
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    logo_uri = EXCLUDED.logo_uri,
                    decimals = EXCLUDED.decimals
            `;
            // Discovery updatedAt must reflect member changes, not just metadata edits.
            await sql`UPDATE token_lists SET updated_at = ${new Date(args.addedAt)} WHERE id = ${args.listId}`;
        },
        async removeMember(listId, mint, nowMs) {
            const rows = await sql<{ id: string }[]>`
                DELETE FROM token_list_members WHERE list_id = ${listId} AND mint = ${mint} RETURNING id
            `;
            if (rows.length === 0) return false;
            await sql`UPDATE token_lists SET updated_at = ${new Date(nowMs)} WHERE id = ${listId}`;
            return true;
        },
        async hasActiveVariantForMint(mint) {
            const rows = await sql<{ exists: boolean }[]>`
                SELECT EXISTS (
                    SELECT 1
                    FROM asset_variants av
                    WHERE av.mint = ${mint}
                      AND av.is_active = true
                      AND NOT EXISTS (
                          SELECT 1 FROM asset_deletion_tombstones t WHERE t.asset_id = av.asset_id
                      )
                ) AS exists
            `;
            return rows[0]?.exists === true;
        },
        async hasTokenForAddress(mint) {
            const rows = await sql<{ exists: boolean }[]>`
                SELECT EXISTS (SELECT 1 FROM tokens WHERE address = ${mint}) AS exists
            `;
            return rows[0]?.exists === true;
        },
    };
}

export function makePostgresSeedRepo(sql: Sql): SeedRepo {
    return {
        async withTransaction(fn) {
            await sql.begin(async tx => {
                await fn(makePostgresSeedRepo(tx as unknown as Sql));
            });
        },
        async upsertCanonicalAsset(args) {
            const now = new Date();
            // Admin wins: once admin_edited_at is set, the registry seed stops
            // overwriting every field (including is_active — the seed passing
            // isActive=true must not undo an admin deactivation).
            await sql`
                INSERT INTO assets (
                    id, asset_id, category, name, symbol, aliases,
                    coingecko_id, image_url, is_active, created_at, updated_at
                )
                VALUES (
                    coalesce(
                        (SELECT id FROM assets WHERE asset_id = ${args.assetId}),
                        ${randomId('ast')}
                    ),
                    ${args.assetId}, ${args.category},
                    ${args.name ?? null}, ${args.symbol ?? null},
                    ${sql.json(args.aliases as never)},
                    ${args.coingeckoId ?? null}, ${args.imageUrl ?? null},
                    ${args.isActive}, ${now}, ${now}
                )
                ON CONFLICT (asset_id) DO UPDATE SET
                    category = CASE WHEN assets.admin_edited_at IS NULL THEN EXCLUDED.category ELSE assets.category END,
                    name = CASE WHEN assets.admin_edited_at IS NULL THEN coalesce(EXCLUDED.name, assets.name) ELSE assets.name END,
                    symbol = CASE WHEN assets.admin_edited_at IS NULL THEN coalesce(EXCLUDED.symbol, assets.symbol) ELSE assets.symbol END,
                    aliases = CASE WHEN assets.admin_edited_at IS NULL THEN EXCLUDED.aliases ELSE assets.aliases END,
                    coingecko_id = CASE WHEN assets.admin_edited_at IS NULL THEN coalesce(EXCLUDED.coingecko_id, assets.coingecko_id) ELSE assets.coingecko_id END,
                    image_url = CASE WHEN assets.admin_edited_at IS NULL THEN coalesce(EXCLUDED.image_url, assets.image_url) ELSE assets.image_url END,
                    is_active = CASE WHEN assets.admin_edited_at IS NULL THEN EXCLUDED.is_active ELSE assets.is_active END,
                    updated_at = CASE WHEN assets.admin_edited_at IS NULL THEN EXCLUDED.updated_at ELSE assets.updated_at END
            `;
        },
        async upsertCanonicalAssetVariant(args) {
            const now = new Date();
            await sql`
                INSERT INTO asset_variants (
                    id, asset_id, chain, mint, variant_id, kind, trust_tier,
                    stock_variant_tier, tags, issuer, issuer_url, label,
                    is_active, created_at, updated_at
                )
                VALUES (
                    coalesce(
                        (SELECT id FROM asset_variants WHERE asset_id = ${args.assetId} AND variant_id = ${args.variantId}),
                        ${randomId('avr')}
                    ),
                    ${args.assetId}, ${args.chain}, ${args.mint}, ${args.variantId},
                    ${args.kind}, ${args.trustTier},
                    ${args.stockVariantTier ?? null},
                    ${sql.json([...args.tags] as never)},
                    ${args.issuer ?? null}, ${args.issuerUrl ?? null}, ${args.label ?? null},
                    ${args.isActive}, ${now}, ${now}
                )
                ON CONFLICT (asset_id, variant_id) DO UPDATE SET
                    chain = EXCLUDED.chain,
                    mint = EXCLUDED.mint,
                    kind = EXCLUDED.kind,
                    trust_tier = EXCLUDED.trust_tier,
                    stock_variant_tier = EXCLUDED.stock_variant_tier,
                    tags = EXCLUDED.tags,
                    issuer = EXCLUDED.issuer,
                    issuer_url = EXCLUDED.issuer_url,
                    label = EXCLUDED.label,
                    is_active = EXCLUDED.is_active,
                    updated_at = EXCLUDED.updated_at
            `;
        },
        async upsertCanonicalAssetAlias(args) {
            const now = new Date();
            await sql`
                INSERT INTO asset_aliases (
                    id, normalized, alias, asset_id, kind, priority, created_at, updated_at
                )
                VALUES (
                    coalesce(
                        (SELECT id FROM asset_aliases
                         WHERE asset_id = ${args.assetId} AND normalized = ${args.normalized} AND kind = ${args.kind}),
                        ${randomId('aal')}
                    ),
                    ${args.normalized}, ${args.alias}, ${args.assetId},
                    ${args.kind}, ${args.priority}, ${now}, ${now}
                )
                ON CONFLICT (asset_id, normalized, kind) DO UPDATE SET
                    alias = EXCLUDED.alias,
                    priority = EXCLUDED.priority,
                    updated_at = EXCLUDED.updated_at
            `;
        },
        async ensureVariantMarketRow(mint) {
            await sql`
                INSERT INTO variant_markets_latest (id, mint, source, last_fetched_at, overview_last_fetched_at)
                VALUES (${randomId('vml')}, ${mint}, 'touch', 0, 0)
                ON CONFLICT (mint) DO NOTHING
            `;
        },
        async upsertAssetCollection(args) {
            const now = new Date();
            await sql`
                INSERT INTO asset_collections (id, slug, title, description, created_at, updated_at)
                VALUES (
                    coalesce(
                        (SELECT id FROM asset_collections WHERE slug = ${args.slug}),
                        ${randomId('acl')}
                    ),
                    ${args.slug}, ${args.title}, ${args.description}, ${now}, ${now}
                )
                ON CONFLICT (slug) DO UPDATE SET
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    updated_at = EXCLUDED.updated_at
            `;
        },
        async mergeAssetCollectionMembers(collectionSlug, members) {
            await sql.begin(async tx => {
                for (const m of members) {
                    // Existing rows keep their added_at and source (an asset
                    // the admin added that later lands in the registry stays
                    // source='admin'); only rank follows the registry.
                    await tx`
                        INSERT INTO asset_collection_members (id, collection_slug, asset_id, rank, added_at, source)
                        VALUES (${randomId('acm')}, ${m.collectionSlug}, ${m.assetId}, ${m.rank}, ${m.addedAt}, 'registry')
                        ON CONFLICT (collection_slug, asset_id) DO UPDATE SET rank = EXCLUDED.rank
                    `;
                }
                // Registry removals still propagate; admin rows are never pruned.
                const keepAssetIds = members.map(m => m.assetId);
                if (keepAssetIds.length === 0) {
                    await tx`
                        DELETE FROM asset_collection_members
                        WHERE collection_slug = ${collectionSlug} AND source = 'registry'
                    `;
                } else {
                    await tx`
                        DELETE FROM asset_collection_members
                        WHERE collection_slug = ${collectionSlug}
                          AND source = 'registry'
                          AND asset_id NOT IN ${tx(keepAssetIds)}
                    `;
                }
            });
        },
        async listTombstonedRefs(normalizedRefs) {
            if (normalizedRefs.length === 0) return [];
            const rows = await sql<{ normalized_ref: string }[]>`
                SELECT DISTINCT normalized_ref
                FROM asset_deletion_tombstones
                WHERE normalized_ref IN ${sql([...normalizedRefs])}
            `;
            return rows.map(r => r.normalized_ref);
        },
        async listCollectionMemberUnion(excludeSlug) {
            const rows = await sql<
                {
                    collection_slug: string;
                    asset_id: string;
                    rank: number;
                    added_at: number;
                }[]
            >`
                SELECT collection_slug, asset_id, rank, added_at
                FROM asset_collection_members
                WHERE collection_slug <> ${excludeSlug}
            `;
            return rows.map(r => ({
                collectionSlug: r.collection_slug,
                assetId: r.asset_id,
                rank: r.rank,
                addedAt: Number(r.added_at),
            }));
        },
        async lowerCollectionMemberAddedAtByMint(mint, addedAtMs) {
            const rows = await sql<{ id: string }[]>`
                UPDATE asset_collection_members AS acm
                SET added_at = ${addedAtMs}
                FROM asset_variants av
                WHERE av.mint = ${mint}
                  AND acm.asset_id = av.asset_id
                  AND acm.added_at > ${addedAtMs}
                RETURNING acm.id
            `;
            return rows.length;
        },
        async findIdentityAssetsByAssetIds(assetIds) {
            if (assetIds.length === 0) return [];
            const rows = await sql<
                {
                    asset_id: string;
                    category: string;
                    symbol: string | null;
                    name: string | null;
                }[]
            >`
                SELECT asset_id, category, symbol, name
                FROM assets
                WHERE asset_id IN ${sql(assetIds)}
            `;
            return rows.map(r => ({
                assetId: r.asset_id,
                category: r.category,
                symbol: r.symbol,
                name: r.name,
            }));
        },
        async findIdentityVariantsByAssetIds(assetIds) {
            if (assetIds.length === 0) return [];
            const rows = await sql<
                {
                    asset_id: string;
                    mint: string;
                    variant_id: string;
                    trust_tier: string;
                    label: string | null;
                    issuer: string | null;
                    tags: unknown;
                }[]
            >`
                SELECT asset_id, mint, variant_id, trust_tier, label, issuer, tags
                FROM asset_variants
                WHERE asset_id IN ${sql(assetIds)}
                  AND is_active = true
            `;
            return rows.map(r => {
                const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [];
                return {
                    assetId: r.asset_id,
                    mint: r.mint,
                    variantId: r.variant_id,
                    trustTier: r.trust_tier as 'tier1' | 'tier2' | 'tier3',
                    label: r.label,
                    issuer: r.issuer,
                    tags,
                };
            });
        },
        async findIdentityMarketsByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<{ mint: string; symbol: string | null; name: string | null }[]>`
                SELECT mint, symbol, name
                FROM variant_markets_latest
                WHERE mint IN ${sql(mints)}
            `;
            return rows.map(r => ({
                mint: r.mint,
                symbol: r.symbol && r.symbol.trim() ? r.symbol.trim() : null,
                name: r.name && r.name.trim() ? r.name.trim() : null,
            }));
        },
        async setAssetIdentityFromMintIfMissing(args) {
            const mint = args.mint.trim();
            if (!mint) return;
            const variantRows = await sql<{ asset_id: string }[]>`
                SELECT asset_id FROM asset_variants WHERE mint = ${mint} LIMIT 1
            `;
            const assetId = variantRows[0]?.asset_id;
            if (!assetId) return;
            const assetRows = await sql<
                {
                    symbol: string | null;
                    name: string | null;
                    category: string;
                }[]
            >`
                SELECT symbol, name, category FROM assets WHERE asset_id = ${assetId} LIMIT 1
            `;
            const asset = assetRows[0];
            if (!asset) return;
            const force = args.force ?? false;
            const rawSymbol = args.symbol && args.symbol.trim() ? args.symbol.trim() : null;
            const rawName = args.name && args.name.trim() ? args.name.trim() : null;
            if (!rawSymbol && !rawName) return;
            const existingSymbol = asset.symbol && asset.symbol.trim() ? asset.symbol.trim() : null;
            const existingName = asset.name && asset.name.trim() ? asset.name.trim() : null;
            const updates: { symbol?: string; name?: string } = {};
            if (rawSymbol && (force || !existingSymbol)) updates.symbol = rawSymbol;
            if (rawName && (force || !existingName)) updates.name = rawName;
            if (updates.symbol === undefined && updates.name === undefined) return;
            const now = new Date();
            if (updates.symbol !== undefined && updates.name !== undefined) {
                await sql`
                    UPDATE assets SET symbol = ${updates.symbol}, name = ${updates.name}, updated_at = ${now}
                    WHERE asset_id = ${assetId}
                `;
            } else if (updates.symbol !== undefined) {
                await sql`
                    UPDATE assets SET symbol = ${updates.symbol}, updated_at = ${now}
                    WHERE asset_id = ${assetId}
                `;
            } else if (updates.name !== undefined) {
                await sql`
                    UPDATE assets SET name = ${updates.name}, updated_at = ${now}
                    WHERE asset_id = ${assetId}
                `;
            }
            if (updates.symbol) {
                const normalized = updates.symbol.trim().toLowerCase();
                await sql`
                    INSERT INTO asset_aliases (id, normalized, alias, asset_id, kind, priority, created_at, updated_at)
                    VALUES (
                        coalesce(
                            (SELECT id FROM asset_aliases WHERE asset_id = ${assetId} AND normalized = ${normalized} AND kind = 'symbol'),
                            ${randomId('aal')}
                        ),
                        ${normalized}, ${updates.symbol}, ${assetId}, 'symbol', 800, ${now}, ${now}
                    )
                    ON CONFLICT (asset_id, normalized, kind) DO UPDATE SET
                        alias = EXCLUDED.alias,
                        priority = EXCLUDED.priority,
                        updated_at = EXCLUDED.updated_at
                `;
            }
            if (updates.name) {
                const normalized = updates.name.trim().toLowerCase();
                await sql`
                    INSERT INTO asset_aliases (id, normalized, alias, asset_id, kind, priority, created_at, updated_at)
                    VALUES (
                        coalesce(
                            (SELECT id FROM asset_aliases WHERE asset_id = ${assetId} AND normalized = ${normalized} AND kind = 'name'),
                            ${randomId('aal')}
                        ),
                        ${normalized}, ${updates.name}, ${assetId}, 'name', 900, ${now}, ${now}
                    )
                    ON CONFLICT (asset_id, normalized, kind) DO UPDATE SET
                        alias = EXCLUDED.alias,
                        priority = EXCLUDED.priority,
                        updated_at = EXCLUDED.updated_at
                `;
            }
        },
    };
}

function isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export function makePostgresAdminActionsRepo(sql: Sql): AdminActionsRepo {
    return {
        async findAssetByAssetId(assetId) {
            const rows = await sql<{ asset_id: string; category: string }[]>`
                SELECT asset_id, category
                FROM assets
                WHERE asset_id = ${assetId}
                LIMIT 1
            `;
            const row = rows[0];
            return row ? { assetId: row.asset_id, category: row.category } : null;
        },

        async listCollectionSlugsForAssetId(assetId) {
            const rows = await sql<{ collection_slug: string }[]>`
                SELECT DISTINCT collection_slug
                FROM asset_collection_members
                WHERE asset_id = ${assetId}
            `;
            return rows.map(r => r.collection_slug);
        },

        async findVariantByMint(mint) {
            const rows = await sql<{ asset_id: string; variant_id: string }[]>`
                SELECT asset_id, variant_id
                FROM asset_variants
                WHERE mint = ${mint}
                LIMIT 1
            `;
            const row = rows[0];
            return row ? { assetId: row.asset_id, variantId: row.variant_id } : null;
        },

        async listVariantIdsByAssetId(assetId) {
            const rows = await sql<{ variant_id: string }[]>`
                SELECT variant_id
                FROM asset_variants
                WHERE asset_id = ${assetId}
            `;
            return rows.map(r => r.variant_id);
        },

        async createVariantWithMarket(variant, market) {
            try {
                await sql.begin(async tx => {
                    // Serialize concurrent creates for the same mint: the re-check below only
                    // sees committed rows, so without this two transactions could both pass it
                    // and insert duplicate mint rows (mint has no unique constraint). The lock
                    // is released automatically at commit/rollback.
                    await tx`SELECT pg_advisory_xact_lock(hashtext(${variant.mint}))`;
                    // Re-check the mint inside the transaction (races the handler pre-check).
                    const existing = await tx<{ asset_id: string }[]>`
                        SELECT asset_id
                        FROM asset_variants
                        WHERE mint = ${variant.mint}
                        LIMIT 1
                    `;
                    if (existing.length > 0) throw new MintConflictError(existing[0]!.asset_id);
                    const now = new Date();
                    await tx`
                        INSERT INTO asset_variants (
                            id, asset_id, chain, mint, variant_id, kind, trust_tier,
                            stock_variant_tier, tags, label, is_active, created_at, updated_at
                        )
                        VALUES (
                            ${randomId('avr')}, ${variant.assetId}, ${variant.chain}, ${variant.mint},
                            ${variant.variantId}, ${variant.kind}, ${variant.trustTier},
                            ${variant.stockVariantTier ?? null},
                            ${sql.json(variant.tags as never)},
                            ${variant.label ?? null}, ${variant.isActive}, ${now}, ${now}
                        )
                    `;
                    await makePostgresJobsRepo(tx as unknown as Sql).upsertVariantMarketFromBirdeye(market);
                });
            } catch (err) {
                if (err instanceof MintConflictError) throw err;
                if (isUniqueViolation(err)) throw new VariantIdConflictError();
                throw err;
            }
        },

        async getNextCategoryRank(slug) {
            const rows = await sql<{ max_rank: number | null }[]>`
                SELECT MAX(rank)::int AS max_rank
                FROM asset_collection_members
                WHERE collection_slug = ${slug}
            `;
            return (rows[0]?.max_rank ?? -1) + 1;
        },

        async upsertAssetCollectionMember(args) {
            // Admin-added membership: the registry seed never removes or
            // restamps source='admin' rows. On update the original added_at
            // and source are preserved (only rank moves).
            await sql`
                INSERT INTO asset_collection_members (id, collection_slug, asset_id, rank, added_at, source)
                VALUES (${randomId('acm')}, ${args.collectionSlug}, ${args.assetId}, ${args.rank}, ${Date.now()}, 'admin')
                ON CONFLICT (collection_slug, asset_id) DO UPDATE SET rank = EXCLUDED.rank
            `;
        },

        async upsertAssetCollectionTitle(slug, title) {
            const now = new Date();
            await sql`
                INSERT INTO asset_collections (id, slug, title, created_at, updated_at)
                VALUES (${randomId('acl')}, ${slug}, ${title}, ${now}, ${now})
                ON CONFLICT (slug) DO UPDATE SET
                    title = EXCLUDED.title,
                    updated_at = EXCLUDED.updated_at
            `;
        },

        async clearDeletedRefs(normalizedRefs) {
            if (normalizedRefs.length === 0) return 0;
            const rows = await sql<{ id: string }[]>`
                DELETE FROM asset_deletion_tombstones
                WHERE normalized_ref IN ${sql([...normalizedRefs])}
                RETURNING id
            `;
            return rows.length;
        },
    };
}

export function makePostgresTrendingRepo(sql: Sql): TrendingRepo {
    return {
        async listFlowTrendingMints(limit) {
            const lim = Math.max(1, Math.min(limit, 5_000));
            const rows = await sql<{ mint: string }[]>`
                SELECT mint
                FROM trending_markets
                ORDER BY rank ASC, mint ASC
                LIMIT ${lim}
            `;
            return rows.map(r => r.mint);
        },
        async findVariantMarketSnapshotsByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<
                {
                    mint: string;
                    symbol: string | null;
                    name: string | null;
                    decimals: number | null;
                    logo_uri: string | null;
                    source: string;
                    metrics_source: string | null;
                    price: number | null;
                    liquidity: number | null;
                    volume_1h_usd: number | null;
                    volume_24h_usd: number | null;
                    trade_1h: number | null;
                    trade_24h: number | null;
                    unique_wallet_1h: number | null;
                    unique_wallet_24h: number | null;
                    price_change_1h_percent: number | null;
                    price_change_24h_percent: number | null;
                    last_trade_at: number | null;
                    as_of: number | null;
                    last_fetched_at: number;
                }[]
            >`
                SELECT mint, symbol, name, decimals, logo_uri,
                       source, metrics_source, price, liquidity,
                       volume_1h_usd, volume_24h_usd,
                       trade_1h, trade_24h,
                       unique_wallet_1h, unique_wallet_24h,
                       price_change_1h_percent, price_change_24h_percent,
                       last_trade_at, as_of, last_fetched_at
                FROM variant_markets_latest
                WHERE mint IN ${sql(mints)}
            `;
            const allowed = new Set(['birdeye', 'rwa_xyz', 'clickhouse_trades']);
            return rows.map(r => ({
                mint: r.mint,
                symbol: r.symbol,
                name: r.name,
                decimals: r.decimals,
                logoURI: r.logo_uri,
                source: allowed.has(r.source) ? (r.source as 'birdeye' | 'rwa_xyz' | 'clickhouse_trades') : null,
                metricsSource:
                    r.metrics_source && allowed.has(r.metrics_source)
                        ? (r.metrics_source as 'birdeye' | 'rwa_xyz' | 'clickhouse_trades')
                        : null,
                price: r.price,
                liquidity: r.liquidity,
                volume1hUSD: r.volume_1h_usd,
                volume24hUSD: r.volume_24h_usd,
                trade1h: r.trade_1h,
                trade24h: r.trade_24h,
                uniqueWallet1h: r.unique_wallet_1h,
                uniqueWallet24h: r.unique_wallet_24h,
                priceChange1hPercent: r.price_change_1h_percent,
                priceChange24hPercent: r.price_change_24h_percent,
                lastTradeAt: r.last_trade_at,
                asOf: r.as_of,
                lastFetchedAt: r.last_fetched_at,
            }));
        },
        async findFlowTrendingMarketsByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<
                {
                    mint: string;
                    volume_5m_usd: number;
                    volume_15m_usd: number;
                    volume_1h_usd: number;
                    volume_6h_usd: number;
                    volume_24h_usd: number;
                    trade_5m: number;
                    trade_15m: number;
                    trade_1h: number;
                    trade_6h: number;
                    trade_24h: number;
                    unique_wallet_5m: number;
                    unique_wallet_1h: number;
                    unique_wallet_24h: number;
                }[]
            >`
                SELECT mint,
                       volume_5m_usd, volume_15m_usd, volume_1h_usd, volume_6h_usd, volume_24h_usd,
                       trade_5m, trade_15m, trade_1h, trade_6h, trade_24h,
                       unique_wallet_5m, unique_wallet_1h, unique_wallet_24h
                FROM trending_markets
                WHERE mint IN ${sql(mints)}
            `;
            return rows.map(r => ({
                mint: r.mint,
                volume5mUSD: r.volume_5m_usd,
                volume15mUSD: r.volume_15m_usd,
                volume1hUSD: r.volume_1h_usd,
                volume6hUSD: r.volume_6h_usd,
                volume24hUSD: r.volume_24h_usd,
                trade5m: r.trade_5m,
                trade15m: r.trade_15m,
                trade1h: r.trade_1h,
                trade6h: r.trade_6h,
                trade24h: r.trade_24h,
                uniqueWallet5m: r.unique_wallet_5m,
                uniqueWallet1h: r.unique_wallet_1h,
                uniqueWallet24h: r.unique_wallet_24h,
            }));
        },
        async replaceFreshTrendingMarkets(rows) {
            const incomingMints = rows.map(r => r.mint);
            return sql.begin(async tx => {
                for (const row of rows) {
                    await tx`
                        INSERT INTO fresh_trending_markets (
                            id, mint, asset_id, variant_id, category, symbol, name,
                            decimals, logo_uri, source, metrics_source, scoring_version,
                            price, liquidity,
                            volume_5m_usd, volume_15m_usd, volume_1h_usd, volume_6h_usd, volume_24h_usd,
                            trade_5m, trade_15m, trade_1h, trade_6h, trade_24h,
                            unique_wallet_5m, unique_wallet_1h, unique_wallet_24h,
                            price_change_1h_percent, price_change_24h_percent,
                            last_trade_at, as_of, last_fetched_at,
                            trending_score, rank, category_rank, last_computed_at
                        )
                        VALUES (
                            coalesce((SELECT id FROM fresh_trending_markets WHERE mint = ${row.mint}), ${randomId('ftm')}),
                            ${row.mint}, ${row.assetId}, ${row.variantId}, ${row.category}, ${row.symbol}, ${row.name},
                            ${row.decimals ?? null}, ${row.logoURI ?? null},
                            ${row.source}, ${row.metricsSource ?? null}, ${row.scoringVersion},
                            ${row.price ?? null}, ${row.liquidity ?? null},
                            ${row.volume5mUSD ?? null}, ${row.volume15mUSD ?? null}, ${row.volume1hUSD ?? null},
                            ${row.volume6hUSD ?? null}, ${row.volume24hUSD ?? null},
                            ${row.trade5m ?? null}, ${row.trade15m ?? null}, ${row.trade1h ?? null},
                            ${row.trade6h ?? null}, ${row.trade24h ?? null},
                            ${row.uniqueWallet5m ?? null}, ${row.uniqueWallet1h ?? null}, ${row.uniqueWallet24h ?? null},
                            ${row.priceChange1hPercent ?? null}, ${row.priceChange24hPercent ?? null},
                            ${row.lastTradeAt ?? null}, ${row.asOf ?? null}, ${row.lastFetchedAt},
                            ${row.trendingScore}, ${row.rank}, ${row.categoryRank}, ${row.lastComputedAt}
                        )
                        ON CONFLICT (mint) DO UPDATE SET
                            asset_id = EXCLUDED.asset_id,
                            variant_id = EXCLUDED.variant_id,
                            category = EXCLUDED.category,
                            symbol = EXCLUDED.symbol,
                            name = EXCLUDED.name,
                            decimals = EXCLUDED.decimals,
                            logo_uri = EXCLUDED.logo_uri,
                            source = EXCLUDED.source,
                            metrics_source = EXCLUDED.metrics_source,
                            scoring_version = EXCLUDED.scoring_version,
                            price = EXCLUDED.price,
                            liquidity = EXCLUDED.liquidity,
                            volume_5m_usd = EXCLUDED.volume_5m_usd,
                            volume_15m_usd = EXCLUDED.volume_15m_usd,
                            volume_1h_usd = EXCLUDED.volume_1h_usd,
                            volume_6h_usd = EXCLUDED.volume_6h_usd,
                            volume_24h_usd = EXCLUDED.volume_24h_usd,
                            trade_5m = EXCLUDED.trade_5m,
                            trade_15m = EXCLUDED.trade_15m,
                            trade_1h = EXCLUDED.trade_1h,
                            trade_6h = EXCLUDED.trade_6h,
                            trade_24h = EXCLUDED.trade_24h,
                            unique_wallet_5m = EXCLUDED.unique_wallet_5m,
                            unique_wallet_1h = EXCLUDED.unique_wallet_1h,
                            unique_wallet_24h = EXCLUDED.unique_wallet_24h,
                            price_change_1h_percent = EXCLUDED.price_change_1h_percent,
                            price_change_24h_percent = EXCLUDED.price_change_24h_percent,
                            last_trade_at = EXCLUDED.last_trade_at,
                            as_of = EXCLUDED.as_of,
                            last_fetched_at = EXCLUDED.last_fetched_at,
                            trending_score = EXCLUDED.trending_score,
                            rank = EXCLUDED.rank,
                            category_rank = EXCLUDED.category_rank,
                            last_computed_at = EXCLUDED.last_computed_at
                    `;
                }
                const deleteResult: { count: number } =
                    incomingMints.length === 0
                        ? { count: 0 }
                        : await tx`DELETE FROM fresh_trending_markets WHERE mint NOT IN ${tx(incomingMints)}`.then(
                              r => ({
                                  count: (r as unknown as { count?: number }).count ?? 0,
                              }),
                          );
                return { upserted: rows.length, deleted: deleteResult.count };
            });
        },
    };
}

export function makePostgresClickhouseExtrasRepo(sql: Sql): ClickhouseExtrasRepo {
    return {
        async updateVariantMarketMetricsFromClickhouse(args) {
            if (args.rows.length === 0) return { updated: 0 };
            const result = await sql`
                UPDATE variant_markets_latest vml SET
                    price = COALESCE(u.price, vml.price),
                    volume_1h_usd = u.volume_1h_usd,
                    volume_24h_usd = u.volume_24h_usd,
                    trade_1h = u.trade_1h,
                    trade_24h = u.trade_24h,
                    unique_wallet_1h = u.unique_wallet_1h,
                    unique_wallet_24h = u.unique_wallet_24h,
                    price_change_1h_percent = COALESCE(u.price_change_1h_percent, vml.price_change_1h_percent),
                    price_change_24h_percent = COALESCE(u.price_change_24h_percent, vml.price_change_24h_percent),
                    last_trade_at = COALESCE(u.last_trade_at, vml.last_trade_at),
                    market_cap = CASE
                        WHEN u.price IS NOT NULL AND vml.circulating_supply IS NOT NULL
                        THEN vml.circulating_supply * u.price
                        ELSE vml.market_cap
                    END,
                    fdv = CASE
                        WHEN u.price IS NOT NULL AND vml.total_supply IS NOT NULL
                        THEN vml.total_supply * u.price
                        ELSE vml.fdv
                    END,
                    metrics_source = 'clickhouse_trades',
                    clickhouse_metrics = jsonb_strip_nulls(jsonb_build_object(
                        'source', 'clickhouse_trades',
                        'price', u.price,
                        'volume1hUSD', u.volume_1h_usd,
                        'volume24hUSD', u.volume_24h_usd,
                        'trade1h', u.trade_1h,
                        'trade24h', u.trade_24h,
                        'uniqueWallet1h', u.unique_wallet_1h,
                        'uniqueWallet24h', u.unique_wallet_24h,
                        'priceChange1hPercent', u.price_change_1h_percent,
                        'priceChange24hPercent', u.price_change_24h_percent,
                        'lastTradeAt', u.last_trade_at,
                        'lastFetchedAt', ${args.lastFetchedAt}::bigint
                    )),
                    last_fetched_at = ${args.lastFetchedAt}
                FROM unnest(
                    ${sql.array(args.rows.map(r => r.mint))}::text[],
                    ${sql.array(args.rows.map(r => r.priceUsd))}::double precision[],
                    ${sql.array(args.rows.map(r => r.volume1hUsd))}::double precision[],
                    ${sql.array(args.rows.map(r => r.volume24hUsd))}::double precision[],
                    ${sql.array(args.rows.map(r => r.trade1h))}::bigint[],
                    ${sql.array(args.rows.map(r => r.trade24h))}::bigint[],
                    ${sql.array(args.rows.map(r => r.uniqueTrader1h))}::bigint[],
                    ${sql.array(args.rows.map(r => r.uniqueTrader24h))}::bigint[],
                    ${sql.array(args.rows.map(r => r.priceChange1hPercent))}::double precision[],
                    ${sql.array(args.rows.map(r => r.priceChange24hPercent))}::double precision[],
                    ${sql.array(args.rows.map(r => r.lastTradeAt))}::bigint[]
                ) AS u(
                    mint, price, volume_1h_usd, volume_24h_usd,
                    trade_1h, trade_24h, unique_wallet_1h, unique_wallet_24h,
                    price_change_1h_percent, price_change_24h_percent, last_trade_at
                )
                WHERE vml.mint = u.mint AND vml.symbol IS NOT NULL
            `;
            return { updated: result.count };
        },

        async getStableMints() {
            const rows = await sql<{ mint: string }[]>`
                SELECT av.mint
                FROM asset_variants av
                WHERE av.is_active = true
                  AND av.chain = 'solana'
                  AND av.kind = 'stablecoin'
            `;
            const out = new Set<string>();
            out.add('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
            out.add('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
            for (const r of rows) {
                const mint = r.mint.trim();
                if (mint) out.add(mint);
            }
            return Array.from(out);
        },
        async findVariantMarketRegistryRowsByMints(mints) {
            if (mints.length === 0) return [];
            const rows = await sql<
                {
                    mint: string;
                    logo_uri: string | null;
                    name: string | null;
                    decimals: number | null;
                }[]
            >`
                SELECT mint, logo_uri, name, decimals
                FROM variant_markets_latest
                WHERE mint IN ${sql(mints)}
            `;
            return rows.map(r => ({
                mint: r.mint,
                logoURI: r.logo_uri,
                name: r.name,
                decimals: r.decimals,
            }));
        },
        async replaceTrendingFromClickHouse(args) {
            const incomingMints = args.rows.map(r => r.mint);
            for (const row of args.rows) {
                await sql`
                    INSERT INTO trending_markets (
                        id, mint, asset_id, variant_id, category, symbol, name,
                        decimals, logo_uri, source, scoring_version,
                        price, volume_5m_usd, volume_15m_usd, volume_1h_usd, volume_6h_usd, volume_24h_usd,
                        trade_5m, trade_15m, trade_1h, trade_6h, trade_24h,
                        unique_wallet_5m, unique_wallet_1h, unique_wallet_24h,
                        price_change_1h_percent, price_change_24h_percent,
                        trending_score, rank, category_rank,
                        last_trade_at, as_of, last_computed_at
                    )
                    VALUES (
                        coalesce((SELECT id FROM trending_markets WHERE mint = ${row.mint}), ${randomId('tm')}),
                        ${row.mint}, ${row.assetId}, ${row.variantId}, ${row.category}, ${row.symbol}, ${row.name},
                        ${row.decimals ?? null}, ${row.logoURI ?? null},
                        'clickhouse_trades', ${row.scoringVersion},
                        ${row.price ?? null},
                        ${row.volume5mUSD}, ${row.volume15mUSD}, ${row.volume1hUSD}, ${row.volume6hUSD}, ${row.volume24hUSD},
                        ${row.trade5m}, ${row.trade15m}, ${row.trade1h}, ${row.trade6h}, ${row.trade24h},
                        ${row.uniqueWallet5m}, ${row.uniqueWallet1h}, ${row.uniqueWallet24h},
                        ${row.priceChange1hPercent ?? null}, ${row.priceChange24hPercent ?? null},
                        ${row.trendingScore}, ${row.rank}, ${row.categoryRank},
                        ${row.lastTradeAt ?? null}, ${row.asOf}, ${row.lastComputedAt}
                    )
                    ON CONFLICT (mint) DO UPDATE SET
                        asset_id = EXCLUDED.asset_id,
                        variant_id = EXCLUDED.variant_id,
                        category = EXCLUDED.category,
                        symbol = EXCLUDED.symbol,
                        name = EXCLUDED.name,
                        decimals = EXCLUDED.decimals,
                        logo_uri = EXCLUDED.logo_uri,
                        source = EXCLUDED.source,
                        scoring_version = EXCLUDED.scoring_version,
                        price = EXCLUDED.price,
                        volume_5m_usd = EXCLUDED.volume_5m_usd,
                        volume_15m_usd = EXCLUDED.volume_15m_usd,
                        volume_1h_usd = EXCLUDED.volume_1h_usd,
                        volume_6h_usd = EXCLUDED.volume_6h_usd,
                        volume_24h_usd = EXCLUDED.volume_24h_usd,
                        trade_5m = EXCLUDED.trade_5m,
                        trade_15m = EXCLUDED.trade_15m,
                        trade_1h = EXCLUDED.trade_1h,
                        trade_6h = EXCLUDED.trade_6h,
                        trade_24h = EXCLUDED.trade_24h,
                        unique_wallet_5m = EXCLUDED.unique_wallet_5m,
                        unique_wallet_1h = EXCLUDED.unique_wallet_1h,
                        unique_wallet_24h = EXCLUDED.unique_wallet_24h,
                        price_change_1h_percent = EXCLUDED.price_change_1h_percent,
                        price_change_24h_percent = EXCLUDED.price_change_24h_percent,
                        trending_score = EXCLUDED.trending_score,
                        rank = EXCLUDED.rank,
                        category_rank = EXCLUDED.category_rank,
                        last_trade_at = EXCLUDED.last_trade_at,
                        as_of = EXCLUDED.as_of,
                        last_computed_at = EXCLUDED.last_computed_at
                `;
            }
            let deleted = 0;
            if (args.replaceMissing && incomingMints.length > 0) {
                const deleteResult = await sql`DELETE FROM trending_markets WHERE mint NOT IN ${sql(incomingMints)}`;
                deleted = (deleteResult as unknown as { count?: number }).count ?? 0;
            }
            return { upserted: args.rows.length, deleted };
        },
        async replaceVariantFillQualityFromClickHouse(args) {
            const FILL_QUALITY_SOURCE = 'clickhouse_fill_quality';
            const FILL_QUALITY_RANGE = '24h';
            const FILL_QUALITY_HORIZON = '5s';
            const incomingMints = new Set<string>();
            let upserted = 0;
            for (const row of args.rows) {
                const mint = row.mint.trim();
                if (!mint) continue;
                incomingMints.add(mint);
                const quoteMint = row.quoteMint.trim();
                const trade24h = Math.floor(Math.max(0, row.trade24h));
                const botTrade24h = Math.floor(Math.max(0, row.botTrade24h));
                const flowSourceCount = Math.floor(Math.max(0, row.flowSourceCount));
                const markoutPnl =
                    typeof row.markoutPnl24hUSD === 'number' && Number.isFinite(row.markoutPnl24hUSD)
                        ? row.markoutPnl24hUSD
                        : null;
                const markoutCount =
                    typeof row.markoutCount === 'number' && Number.isFinite(row.markoutCount)
                        ? Math.floor(row.markoutCount)
                        : null;
                const markoutBps =
                    typeof row.markoutBps === 'number' && Number.isFinite(row.markoutBps) ? row.markoutBps : null;
                await sql`
                    INSERT INTO variant_fill_quality_latest (
                        id, mint, source, range_identifier, horizon, quote_mint,
                        volume_24h_usd, trade_24h,
                        bot_volume_24h_usd, bot_trade_24h, bot_volume_ratio,
                        fee_24h_usd, fee_bps, flow_source_count,
                        markout_pnl_24h_usd, markout_count, markout_bps,
                        execution_score, is_eligible_for_primary,
                        as_of, last_computed_at
                    )
                    VALUES (
                        coalesce((SELECT id FROM variant_fill_quality_latest WHERE mint = ${mint}), ${randomId('vfq')}),
                        ${mint}, ${FILL_QUALITY_SOURCE}, ${FILL_QUALITY_RANGE}, ${FILL_QUALITY_HORIZON}, ${quoteMint},
                        ${Math.max(0, row.volume24hUSD)}, ${trade24h},
                        ${Math.max(0, row.botVolume24hUSD)}, ${botTrade24h}, ${Math.max(0, row.botVolumeRatio)},
                        ${Math.max(0, row.fee24hUSD)}, ${Math.max(0, row.feeBps)}, ${flowSourceCount},
                        ${markoutPnl}, ${markoutCount}, ${markoutBps},
                        ${Math.max(0, row.executionScore)}, ${row.isEligibleForPrimary},
                        ${row.asOf}, ${row.lastComputedAt}
                    )
                    ON CONFLICT (mint) DO UPDATE SET
                        source = EXCLUDED.source,
                        range_identifier = EXCLUDED.range_identifier,
                        horizon = EXCLUDED.horizon,
                        quote_mint = EXCLUDED.quote_mint,
                        volume_24h_usd = EXCLUDED.volume_24h_usd,
                        trade_24h = EXCLUDED.trade_24h,
                        bot_volume_24h_usd = EXCLUDED.bot_volume_24h_usd,
                        bot_trade_24h = EXCLUDED.bot_trade_24h,
                        bot_volume_ratio = EXCLUDED.bot_volume_ratio,
                        fee_24h_usd = EXCLUDED.fee_24h_usd,
                        fee_bps = EXCLUDED.fee_bps,
                        flow_source_count = EXCLUDED.flow_source_count,
                        markout_pnl_24h_usd = EXCLUDED.markout_pnl_24h_usd,
                        markout_count = EXCLUDED.markout_count,
                        markout_bps = EXCLUDED.markout_bps,
                        execution_score = EXCLUDED.execution_score,
                        is_eligible_for_primary = EXCLUDED.is_eligible_for_primary,
                        as_of = EXCLUDED.as_of,
                        last_computed_at = EXCLUDED.last_computed_at
                `;
                upserted += 1;
            }
            let deleted = 0;
            if (args.replaceMissing && incomingMints.size > 0) {
                const replacementMints = Array.from(
                    new Set(args.replacementMints.map(m => m.trim()).filter(Boolean)),
                ).filter(mint => !incomingMints.has(mint));
                if (replacementMints.length > 0) {
                    const result = await sql`
                        DELETE FROM variant_fill_quality_latest
                        WHERE mint IN ${sql(replacementMints)}
                    `;
                    deleted = (result as unknown as { count?: number }).count ?? 0;
                }
            }
            return { upserted, deleted };
        },
        async upsertSolanaOhlcv(args) {
            if (args.candles.length === 0) return { inserted: 0, updated: 0, skipped: 0 };
            const byTime = new Map<number, (typeof args.candles)[number]>();
            for (const candle of args.candles) byTime.set(candle.time, candle);
            let minTime = Infinity;
            let maxTime = -Infinity;
            for (const time of byTime.keys()) {
                if (time < minTime) minTime = time;
                if (time > maxTime) maxTime = time;
            }
            const existingRows = await sql<
                {
                    time: number;
                    open: number;
                    high: number;
                    low: number;
                    close: number;
                    volume: number;
                    trade_count: number | null;
                    source: string | null;
                }[]
            >`
                SELECT time, open, high, low, close, volume, trade_count, source
                FROM ohlcv_candles
                WHERE address = ${args.address}
                  AND interval = ${args.interval}
                  AND time >= ${minTime}
                  AND time <= ${maxTime}
            `;
            const existingByTime = new Map<number, (typeof existingRows)[number]>();
            for (const row of existingRows) existingByTime.set(row.time, row);
            let inserted = 0;
            let updated = 0;
            let skipped = 0;
            for (const [time, candle] of byTime) {
                const current = existingByTime.get(time);
                if (!current) {
                    await sql`
                        INSERT INTO ohlcv_candles (
                            id, address, interval, time, open, high, low, close, volume, source, trade_count
                        )
                        VALUES (
                            ${randomId('ohlcv')}, ${args.address}, ${args.interval}, ${candle.time},
                            ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close}, ${candle.volume},
                            ${args.source}, ${candle.tradeCount}
                        )
                        ON CONFLICT (address, interval, time) DO NOTHING
                    `;
                    inserted += 1;
                    continue;
                }
                if (
                    current.open === candle.open &&
                    current.high === candle.high &&
                    current.low === candle.low &&
                    current.close === candle.close &&
                    current.volume === candle.volume &&
                    current.source === args.source &&
                    (current.trade_count ?? null) === (candle.tradeCount ?? null)
                ) {
                    skipped += 1;
                    continue;
                }
                await sql`
                    UPDATE ohlcv_candles
                    SET open = ${candle.open},
                        high = ${candle.high},
                        low = ${candle.low},
                        close = ${candle.close},
                        volume = ${candle.volume},
                        source = ${args.source},
                        trade_count = ${candle.tradeCount}
                    WHERE address = ${args.address}
                      AND interval = ${args.interval}
                      AND time = ${candle.time}
                `;
                updated += 1;
            }
            return { inserted, updated, skipped };
        },
        async getSolanaOhlcvBounds(address, interval) {
            const rows = await sql<{ min_time: number | null; max_time: number | null }[]>`
                SELECT min(time) AS min_time, max(time) AS max_time
                FROM ohlcv_candles
                WHERE address = ${address}
                  AND interval = ${interval}
            `;
            const row = rows[0];
            return {
                minTime: row?.min_time ?? null,
                maxTime: row?.max_time ?? null,
            };
        },
        async upsertStockOhlcv(args) {
            if (args.candles.length === 0) return { inserted: 0, updated: 0, skipped: 0 };
            const assetId = args.assetId.trim();
            const symbol = args.symbol.trim().toUpperCase();
            if (!assetId || !symbol) return { inserted: 0, updated: 0, skipped: 0 };
            const byTime = new Map<number, (typeof args.candles)[number]>();
            for (const candle of args.candles) byTime.set(candle.time, candle);
            let minTime = Infinity;
            let maxTime = -Infinity;
            for (const time of byTime.keys()) {
                if (time < minTime) minTime = time;
                if (time > maxTime) maxTime = time;
            }
            const existingRows = await sql<
                {
                    time: number;
                    symbol: string;
                    normalized_symbol: string;
                    open: number;
                    high: number;
                    low: number;
                    close: number;
                    volume: number;
                }[]
            >`
                SELECT time, symbol, normalized_symbol, open, high, low, close, volume
                FROM stock_ohlcv_candles
                WHERE asset_id = ${assetId}
                  AND interval = ${args.interval}
                  AND time >= ${minTime}
                  AND time <= ${maxTime}
            `;
            const existingByTime = new Map<number, (typeof existingRows)[number]>();
            for (const row of existingRows) existingByTime.set(row.time, row);
            let inserted = 0;
            let updated = 0;
            let skipped = 0;
            for (const [time, candle] of byTime) {
                const current = existingByTime.get(time);
                if (!current) {
                    await sql`
                        INSERT INTO stock_ohlcv_candles (
                            id, asset_id, symbol, normalized_symbol, interval,
                            time, open, high, low, close, volume
                        )
                        VALUES (
                            ${randomId('sohlcv')}, ${assetId}, ${symbol}, ${symbol}, ${args.interval},
                            ${candle.time}, ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close}, ${candle.volume}
                        )
                        ON CONFLICT (asset_id, interval, time) DO NOTHING
                    `;
                    inserted += 1;
                    continue;
                }
                if (
                    current.symbol === symbol &&
                    current.normalized_symbol === symbol &&
                    current.open === candle.open &&
                    current.high === candle.high &&
                    current.low === candle.low &&
                    current.close === candle.close &&
                    current.volume === candle.volume
                ) {
                    skipped += 1;
                    continue;
                }
                await sql`
                    UPDATE stock_ohlcv_candles
                    SET symbol = ${symbol},
                        normalized_symbol = ${symbol},
                        open = ${candle.open},
                        high = ${candle.high},
                        low = ${candle.low},
                        close = ${candle.close},
                        volume = ${candle.volume}
                    WHERE asset_id = ${assetId}
                      AND interval = ${args.interval}
                      AND time = ${candle.time}
                `;
                updated += 1;
            }
            return { inserted, updated, skipped };
        },
        async getStockOhlcvBounds(assetId, interval) {
            const rows = await sql<{ min_time: number | null; max_time: number | null }[]>`
                SELECT min(time) AS min_time, max(time) AS max_time
                FROM stock_ohlcv_candles
                WHERE asset_id = ${assetId}
                  AND interval = ${interval}
            `;
            const row = rows[0];
            return {
                minTime: row?.min_time ?? null,
                maxTime: row?.max_time ?? null,
            };
        },
        async listActiveStockMappings(limit) {
            const cappedLimit = Math.min(Math.max(limit, 1), 5000);
            const rows = await sql<
                {
                    asset_id: string;
                    symbol: string;
                    normalized_symbol: string;
                }[]
            >`
                SELECT asset_id, symbol, normalized_symbol
                FROM stock_instruments_latest
                WHERE is_active = true
                ORDER BY asset_id ASC
                LIMIT ${cappedLimit}
            `;
            return rows.map(r => ({
                assetId: r.asset_id,
                symbol: r.symbol,
                normalizedSymbol: r.normalized_symbol,
            }));
        },
    };
}
