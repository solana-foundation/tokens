import { InvalidArgsError } from './assets';

export type CoingeckoOhlcvInterval = '1m' | '5m' | '15m' | '1H' | '4H' | '1D' | '1W';

const VALID_OHLCV_INTERVALS: ReadonlySet<string> = new Set([
    '1m',
    '5m',
    '15m',
    '1H',
    '4H',
    '1D',
    '1W',
]);

const MAX_OHLCV_CANDLES = 12_000;
const MAX_PRICE_COIN_IDS_PER_CALL = 50;

export interface CoingeckoCoinRow {
    id: string;
    coin_id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string> | null;
    last_synced_at: number;
    coin: Record<string, unknown> | null;
    last_metadata_fetched_at: number | null;
    created_at: Date | string;
}

export interface CoingeckoCoinSearchRow {
    coin_id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string> | null;
    coin: Record<string, unknown> | null;
}

export interface CoingeckoOhlcvRow {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface CoingeckoPriceLatestRow {
    coin_id: string;
    price_usd: number | null;
    market_cap_usd: number | null;
    volume_24h_usd: number | null;
    price_change_24h_percent: number | null;
    provider_last_updated_at: number | null;
    last_fetched_at: number;
    circulating_supply?: number | null;
    total_supply?: number | null;
    max_supply?: number | null;
    fdv_usd?: number | null;
}

export interface CoingeckoTickersLatestRow {
    coin_id: string;
    name: string | null;
    tickers: unknown;
    total: number | null;
    last_fetched_at: number;
}

export interface CoingeckoReadsRepo {
    findCoinByCoinId(coinId: string): Promise<CoingeckoCoinRow | null>;
    searchCoinsById(query: string, limit: number): Promise<CoingeckoCoinSearchRow[]>;
    searchCoinsBySymbol(query: string, limit: number): Promise<CoingeckoCoinSearchRow[]>;
    searchCoinsByName(query: string, limit: number): Promise<CoingeckoCoinSearchRow[]>;
    listOhlcv(
        coinId: string,
        interval: CoingeckoOhlcvInterval,
        fromTime: number,
        toTime: number,
        limit: number,
    ): Promise<CoingeckoOhlcvRow[]>;
    findPriceLatestByCoinId(coinId: string): Promise<CoingeckoPriceLatestRow | null>;
    findPriceLatestByCoinIds(coinIds: readonly string[]): Promise<CoingeckoPriceLatestRow[]>;
    findTickersLatestByCoinId(coinId: string): Promise<CoingeckoTickersLatestRow | null>;
}

export interface CoingeckoCoinImage {
    thumb?: string;
    small?: string;
    large?: string;
}

/**
 * Shape of the cached CoinGecko `/coins/{id}` snapshot we persist in postgres.
 * Optional fields reflect CoinGecko's own contract — every leaf can be absent
 * when the upstream API omits it.
 */
export interface CoingeckoCoinDoc {
    id?: string;
    symbol?: string;
    name?: string;
    description?: Record<string, string>;
    links?: {
        homepage?: string[];
        twitter_screen_name?: string;
        telegram_channel_identifier?: string;
        subreddit_url?: string;
        chat_url?: string[];
        official_forum_url?: string[];
        [k: string]: unknown;
    };
    market_data?: {
        current_price?: Record<string, number | undefined>;
        market_cap?: Record<string, number | undefined>;
        fully_diluted_valuation?: Record<string, number | undefined>;
        total_volume?: Record<string, number | undefined>;
        circulating_supply?: number;
        total_supply?: number;
        max_supply?: number | null;
        price_change_percentage_24h?: number;
        ath?: Record<string, number | undefined>;
        ath_date?: Record<string, string | undefined>;
        [k: string]: unknown;
    };
    image?: CoingeckoCoinImage;
    [k: string]: unknown;
}

export interface CoingeckoCoinResult {
    _id: string;
    _creationTime: number;
    id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string>;
    lastSyncedAt: number;
    coin?: CoingeckoCoinDoc;
    lastMetadataFetchedAt?: number;
}

export interface CoingeckoCoinSearchResult {
    id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string>;
    image?: CoingeckoCoinImage;
}

export interface CoingeckoPriceSnapshot {
    coinId: string;
    priceUsd: number | null;
    marketCapUsd: number | null;
    volume24hUsd: number | null;
    priceChange24hPercent: number | null;
    providerLastUpdatedAt: number | null;
    lastFetchedAt: number;
    /** Canonical (cross-chain) supply from CoinGecko; `null` when unknown or, for `maxSupply`, uncapped. */
    circulatingSupply: number | null;
    totalSupply: number | null;
    maxSupply: number | null;
    fdvUsd: number | null;
}

export interface CoingeckoPriceBatchEntry {
    coinId: string;
    snapshot: CoingeckoPriceSnapshot | null;
}

export interface CoingeckoTickersResult {
    coinId: string;
    name?: string;
    tickers: unknown[];
    total?: number;
    lastFetchedAt: number;
}

function asObject(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    return args as Record<string, unknown>;
}

function readString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') {
        throw new InvalidArgsError(`${key} must be a string`);
    }
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

function readStringArray(args: Record<string, unknown>, key: string): string[] {
    const value = args[key];
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

function toMs(value: Date | string): number {
    if (value instanceof Date) return value.getTime();
    return new Date(value).getTime();
}

function coinRowToResult(row: CoingeckoCoinRow): CoingeckoCoinResult {
    const platforms = row.platforms ?? {};
    const out: CoingeckoCoinResult = {
        _id: row.id,
        _creationTime: toMs(row.created_at),
        id: row.coin_id,
        symbol: row.symbol,
        name: row.name,
        platforms,
        lastSyncedAt: row.last_synced_at,
    };
    if (row.coin) out.coin = row.coin;
    if (row.last_metadata_fetched_at !== null && row.last_metadata_fetched_at !== undefined) {
        out.lastMetadataFetchedAt = row.last_metadata_fetched_at;
    }
    return out;
}

function coinRowToSearchResult(row: CoingeckoCoinSearchRow): CoingeckoCoinSearchResult {
    const platforms = row.platforms ?? {};
    const out: CoingeckoCoinSearchResult = {
        id: row.coin_id,
        symbol: row.symbol,
        name: row.name,
        platforms,
    };
    const image =
        row.coin && typeof row.coin === 'object'
            ? (row.coin as { image?: CoingeckoCoinImage }).image
            : undefined;
    if (image && typeof image === 'object') out.image = image;
    return out;
}

function priceRowToSnapshot(row: CoingeckoPriceLatestRow): CoingeckoPriceSnapshot {
    return {
        coinId: row.coin_id,
        priceUsd: row.price_usd,
        marketCapUsd: row.market_cap_usd,
        volume24hUsd: row.volume_24h_usd,
        priceChange24hPercent: row.price_change_24h_percent,
        providerLastUpdatedAt: row.provider_last_updated_at,
        lastFetchedAt: row.last_fetched_at,
        circulatingSupply: row.circulating_supply ?? null,
        totalSupply: row.total_supply ?? null,
        maxSupply: row.max_supply ?? null,
        fdvUsd: row.fdv_usd ?? null,
    };
}

function uniqueNonEmpty(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of values) {
        const value = raw.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

export async function getCoinById(
    repo: CoingeckoReadsRepo,
    args: unknown,
): Promise<CoingeckoCoinResult | null> {
    const a = asObject(args);
    const id = readString(a, 'id').trim();
    if (!id) return null;
    const row = await repo.findCoinByCoinId(id);
    if (!row) return null;
    return coinRowToResult(row);
}

export async function searchCoins(
    repo: CoingeckoReadsRepo,
    args: unknown,
): Promise<CoingeckoCoinSearchResult[]> {
    const a = asObject(args);
    const queryRaw = readString(a, 'query').trim();
    if (!queryRaw) return [];
    const limitArg = readOptionalNumber(a, 'limit');
    const limit = Math.min(Math.max(limitArg ?? 20, 1), 50);

    const out: CoingeckoCoinSearchResult[] = [];
    const seen = new Set<string>();

    const idMatches = await repo.searchCoinsById(queryRaw, limit);
    for (const row of idMatches) {
        if (out.length >= limit) break;
        if (seen.has(row.coin_id)) continue;
        seen.add(row.coin_id);
        out.push(coinRowToSearchResult(row));
    }

    if (out.length < limit) {
        const symbolMatches = await repo.searchCoinsBySymbol(queryRaw, limit);
        for (const row of symbolMatches) {
            if (out.length >= limit) break;
            if (seen.has(row.coin_id)) continue;
            seen.add(row.coin_id);
            out.push(coinRowToSearchResult(row));
        }
    }

    if (out.length < limit) {
        const nameMatches = await repo.searchCoinsByName(queryRaw, limit);
        for (const row of nameMatches) {
            if (out.length >= limit) break;
            if (seen.has(row.coin_id)) continue;
            seen.add(row.coin_id);
            out.push(coinRowToSearchResult(row));
        }
    }

    return out;
}

export async function listOhlcv(
    repo: CoingeckoReadsRepo,
    args: unknown,
): Promise<CoingeckoOhlcvRow[]> {
    const a = asObject(args);
    const coinIdRaw = readString(a, 'coinId').trim();
    if (!coinIdRaw) return [];
    const intervalValue = a.interval;
    if (typeof intervalValue !== 'string' || !VALID_OHLCV_INTERVALS.has(intervalValue)) {
        throw new InvalidArgsError('interval must be one of: 1m, 5m, 15m, 1H, 4H, 1D, 1W');
    }
    const interval = intervalValue as CoingeckoOhlcvInterval;
    const fromArg = readOptionalNumber(a, 'from');
    const toArg = readOptionalNumber(a, 'to');
    const limitArg = readOptionalNumber(a, 'limit');
    const fromTime = fromArg ?? 0;
    const toTime = toArg ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.min(MAX_OHLCV_CANDLES, Math.max(1, limitArg ?? MAX_OHLCV_CANDLES));
    return await repo.listOhlcv(coinIdRaw, interval, fromTime, toTime, limit);
}

export async function getPriceLatestByCoinId(
    repo: CoingeckoReadsRepo,
    args: unknown,
): Promise<CoingeckoPriceSnapshot | null> {
    const a = asObject(args);
    const coinId = readString(a, 'coinId').trim();
    if (!coinId) return null;
    const row = await repo.findPriceLatestByCoinId(coinId);
    if (!row) return null;
    return priceRowToSnapshot(row);
}

export async function getPriceLatestByCoinIds(
    repo: CoingeckoReadsRepo,
    args: unknown,
): Promise<CoingeckoPriceBatchEntry[]> {
    const a = asObject(args);
    const coinIds = uniqueNonEmpty(readStringArray(a, 'coinIds'));
    if (coinIds.length === 0) return [];
    if (coinIds.length > MAX_PRICE_COIN_IDS_PER_CALL) {
        throw new InvalidArgsError(`Too many coinIds: max ${MAX_PRICE_COIN_IDS_PER_CALL} per call`);
    }
    const rows = await repo.findPriceLatestByCoinIds(coinIds);
    const byId = new Map(rows.map(r => [r.coin_id, r] as const));
    return coinIds.map(coinId => {
        const row = byId.get(coinId);
        return { coinId, snapshot: row ? priceRowToSnapshot(row) : null };
    });
}

export async function getTickersLatestByCoinId(
    repo: CoingeckoReadsRepo,
    args: unknown,
): Promise<CoingeckoTickersResult | null> {
    const a = asObject(args);
    const coinId = readString(a, 'coinId').trim();
    if (!coinId) return null;
    const row = await repo.findTickersLatestByCoinId(coinId);
    if (!row) return null;
    const tickers = Array.isArray(row.tickers) ? row.tickers : [];
    const out: CoingeckoTickersResult = {
        coinId: row.coin_id,
        tickers,
        lastFetchedAt: row.last_fetched_at,
    };
    if (row.name) out.name = row.name;
    if (typeof row.total === 'number') out.total = row.total;
    return out;
}
