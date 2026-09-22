import { InvalidArgsError } from './assets';
import { resolveLogoUri } from './logoUrl';
import {
    selectMintMarketSnapshot,
    type MarketSource,
    type TokenExtensions,
    type VariantMarketDocLike,
} from './marketSourceSelection';

export interface VariantMarketRow {
    mint: string;
    source: string;
    metrics_source: string | null;
    birdeye_metrics: unknown;
    rwa_metrics: unknown;
    clickhouse_metrics: unknown;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    logo_uri: string | null;
    logo_cdn_url?: string | null;
    price: number | null;
    liquidity: number | null;
    volume_1h_usd: number | null;
    volume_24h_usd: number | null;
    trade_1h: number | null;
    trade_24h: number | null;
    unique_wallet_1h: number | null;
    unique_wallet_24h: number | null;
    market_cap: number | null;
    fdv: number | null;
    price_change_24h_percent: number | null;
    price_change_1h_percent: number | null;
    holder: number | null;
    total_supply: number | null;
    circulating_supply: number | null;
    last_trade_human_time: string | null;
    extensions: unknown;
    as_of: number | null;
    last_trade_at: number | null;
    last_fetched_at: number;
    overview_last_fetched_at: number | null;
}

export interface VariantMarketsRepo {
    findLatestByMints(mints: readonly string[]): Promise<VariantMarketRow[]>;
}

export interface VariantMarketSnapshotResult {
    mint: string;
    source: MarketSource;
    metricsSource?: MarketSource;
    symbol?: string;
    name?: string;
    decimals?: number;
    logoURI?: string;
    price?: number;
    liquidity?: number;
    volume1hUSD?: number;
    volume24hUSD?: number;
    trade1h?: number;
    trade24h?: number;
    uniqueWallet1h?: number;
    uniqueWallet24h?: number;
    marketCap?: number;
    fdv?: number;
    priceChange24hPercent?: number;
    priceChange1hPercent?: number;
    holder?: number;
    totalSupply?: number;
    circulatingSupply?: number;
    lastTradeHumanTime?: string;
    lastTradeAt?: number;
    extensions?: TokenExtensions;
    asOf?: number;
    lastFetchedAt: number;
}

export interface GetLatestByMintsEntry {
    mint: string;
    market: VariantMarketSnapshotResult | null;
}

const VARIANT_LOGO_FALLBACK_BY_MINT: Record<string, string> = {
    wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo: 'https://cdn.ondo.finance/tokens/logos/spcxon_160x160.png',
    '6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU': '/logos/popular/tbtc-logo.png',
};

function isMarketSource(value: unknown): value is MarketSource {
    return value === 'birdeye' || value === 'rwa_xyz' || value === 'clickhouse_trades';
}

function nullToUndef<T>(value: T | null): T | undefined {
    return value === null ? undefined : value;
}

function rowToDocLike(row: VariantMarketRow): VariantMarketDocLike {
    const doc: VariantMarketDocLike = {
        mint: row.mint,
        ...(isMarketSource(row.source) ? { source: row.source } : {}),
        ...(isMarketSource(row.metrics_source) ? { metricsSource: row.metrics_source } : {}),
        birdeyeMetrics: (row.birdeye_metrics ?? null) as VariantMarketDocLike['birdeyeMetrics'],
        rwaMetrics: (row.rwa_metrics ?? null) as VariantMarketDocLike['rwaMetrics'],
        clickhouseMetrics: (row.clickhouse_metrics ?? null) as VariantMarketDocLike['clickhouseMetrics'],
    };

    const symbol = nullToUndef(row.symbol);
    if (symbol !== undefined) doc.symbol = symbol;
    const name = nullToUndef(row.name);
    if (name !== undefined) doc.name = name;
    const decimals = nullToUndef(row.decimals);
    if (decimals !== undefined) doc.decimals = decimals;
    const logoURI = nullToUndef(resolveLogoUri(row));
    if (logoURI !== undefined) doc.logoURI = logoURI;
    const price = nullToUndef(row.price);
    if (price !== undefined) doc.price = price;
    const liquidity = nullToUndef(row.liquidity);
    if (liquidity !== undefined) doc.liquidity = liquidity;
    const volume1hUSD = nullToUndef(row.volume_1h_usd);
    if (volume1hUSD !== undefined) doc.volume1hUSD = volume1hUSD;
    const volume24hUSD = nullToUndef(row.volume_24h_usd);
    if (volume24hUSD !== undefined) doc.volume24hUSD = volume24hUSD;
    const trade1h = nullToUndef(row.trade_1h);
    if (trade1h !== undefined) doc.trade1h = trade1h;
    const trade24h = nullToUndef(row.trade_24h);
    if (trade24h !== undefined) doc.trade24h = trade24h;
    const uniqueWallet1h = nullToUndef(row.unique_wallet_1h);
    if (uniqueWallet1h !== undefined) doc.uniqueWallet1h = uniqueWallet1h;
    const uniqueWallet24h = nullToUndef(row.unique_wallet_24h);
    if (uniqueWallet24h !== undefined) doc.uniqueWallet24h = uniqueWallet24h;
    const marketCap = nullToUndef(row.market_cap);
    if (marketCap !== undefined) doc.marketCap = marketCap;
    const fdv = nullToUndef(row.fdv);
    if (fdv !== undefined) doc.fdv = fdv;
    const priceChange24hPercent = nullToUndef(row.price_change_24h_percent);
    if (priceChange24hPercent !== undefined) doc.priceChange24hPercent = priceChange24hPercent;
    const priceChange1hPercent = nullToUndef(row.price_change_1h_percent);
    if (priceChange1hPercent !== undefined) doc.priceChange1hPercent = priceChange1hPercent;
    const holder = nullToUndef(row.holder);
    if (holder !== undefined) doc.holder = holder;
    const totalSupply = nullToUndef(row.total_supply);
    if (totalSupply !== undefined) doc.totalSupply = totalSupply;
    const circulatingSupply = nullToUndef(row.circulating_supply);
    if (circulatingSupply !== undefined) doc.circulatingSupply = circulatingSupply;
    const lastTradeHumanTime = nullToUndef(row.last_trade_human_time);
    if (lastTradeHumanTime !== undefined) doc.lastTradeHumanTime = lastTradeHumanTime;
    const lastTradeAt = nullToUndef(row.last_trade_at);
    if (lastTradeAt !== undefined) doc.lastTradeAt = lastTradeAt;
    const asOf = nullToUndef(row.as_of);
    if (asOf !== undefined) doc.asOf = asOf;
    doc.lastFetchedAt = row.last_fetched_at;
    const overviewLastFetchedAt = nullToUndef(row.overview_last_fetched_at);
    if (overviewLastFetchedAt !== undefined) doc.overviewLastFetchedAt = overviewLastFetchedAt;

    if (row.extensions && typeof row.extensions === 'object') {
        doc.extensions = row.extensions as TokenExtensions;
    }

    return doc;
}

function optionalMarketSource(value: unknown): MarketSource | undefined {
    return value === 'birdeye' || value === 'rwa_xyz' || value === 'clickhouse_trades' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalTokenExtensions(value: unknown): TokenExtensions | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const fields = value as Record<string, unknown>;
    const out: TokenExtensions = {};
    for (const key of ['coingeckoId', 'website', 'twitter', 'discord', 'telegram', 'description', 'github'] as const) {
        const text = optionalString(fields[key]);
        if (text !== undefined) out[key] = text;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

export async function getLatestByMints(
    repo: VariantMarketsRepo,
    args: unknown,
): Promise<GetLatestByMintsEntry[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { mints?: unknown };
    if (!Array.isArray(a.mints)) {
        throw new InvalidArgsError('mints must be an array of strings');
    }
    for (const item of a.mints) {
        if (typeof item !== 'string') {
            throw new InvalidArgsError('mints must be an array of strings');
        }
    }

    const mints = (a.mints as string[])
        .slice(0, 250)
        .map(m => m.trim())
        .filter(Boolean);

    if (mints.length === 0) return [];

    const rows = await repo.findLatestByMints(mints);
    const byMint = new Map(rows.map(r => [r.mint, r] as const));

    return mints.map(mint => {
        const row = byMint.get(mint);
        if (!row) return { mint, market: null };

        const selected = selectMintMarketSnapshot(rowToDocLike(row));
        const source = optionalMarketSource(selected.source);
        const lastFetchedAt = optionalFiniteNumber(selected.lastFetchedAt);
        if (!source || lastFetchedAt === undefined) return { mint, market: null };

        const metricsSource = optionalMarketSource(selected.metricsSource);
        const symbol = optionalString(selected.symbol);
        const name = optionalString(selected.name);
        const logoURI = optionalString(selected.logoURI) ?? VARIANT_LOGO_FALLBACK_BY_MINT[mint];
        const decimals = optionalFiniteNumber(selected.decimals);
        const price = optionalFiniteNumber(selected.price);
        const liquidity = optionalFiniteNumber(selected.liquidity);
        const volume1hUSD = optionalFiniteNumber(selected.volume1hUSD);
        const volume24hUSD = optionalFiniteNumber(selected.volume24hUSD);
        const trade1h = optionalFiniteNumber(selected.trade1h);
        const trade24h = optionalFiniteNumber(selected.trade24h);
        const uniqueWallet1h = optionalFiniteNumber(selected.uniqueWallet1h);
        const uniqueWallet24h = optionalFiniteNumber(selected.uniqueWallet24h);
        const marketCap = optionalFiniteNumber(selected.marketCap);
        const fdv = optionalFiniteNumber(selected.fdv);
        const priceChange24hPercent = optionalFiniteNumber(selected.priceChange24hPercent);
        const priceChange1hPercent = optionalFiniteNumber(selected.priceChange1hPercent);
        const holder = optionalFiniteNumber(selected.holder);
        const totalSupply = optionalFiniteNumber(selected.totalSupply);
        const circulatingSupply = optionalFiniteNumber(selected.circulatingSupply);
        const lastTradeHumanTime = optionalString(selected.lastTradeHumanTime);
        const lastTradeAt = optionalFiniteNumber(selected.lastTradeAt);
        const asOf = optionalFiniteNumber(selected.asOf);
        const extensions = optionalTokenExtensions(selected.extensions);

        const market: VariantMarketSnapshotResult = {
            mint,
            source,
            lastFetchedAt,
            ...(metricsSource !== undefined ? { metricsSource } : {}),
            ...(symbol !== undefined ? { symbol } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(decimals !== undefined ? { decimals } : {}),
            ...(logoURI !== undefined ? { logoURI } : {}),
            ...(price !== undefined ? { price } : {}),
            ...(liquidity !== undefined ? { liquidity } : {}),
            ...(volume1hUSD !== undefined ? { volume1hUSD } : {}),
            ...(volume24hUSD !== undefined ? { volume24hUSD } : {}),
            ...(trade1h !== undefined ? { trade1h } : {}),
            ...(trade24h !== undefined ? { trade24h } : {}),
            ...(uniqueWallet1h !== undefined ? { uniqueWallet1h } : {}),
            ...(uniqueWallet24h !== undefined ? { uniqueWallet24h } : {}),
            ...(marketCap !== undefined ? { marketCap } : {}),
            ...(fdv !== undefined ? { fdv } : {}),
            ...(priceChange24hPercent !== undefined ? { priceChange24hPercent } : {}),
            ...(priceChange1hPercent !== undefined ? { priceChange1hPercent } : {}),
            ...(holder !== undefined ? { holder } : {}),
            ...(totalSupply !== undefined ? { totalSupply } : {}),
            ...(circulatingSupply !== undefined ? { circulatingSupply } : {}),
            ...(lastTradeHumanTime !== undefined ? { lastTradeHumanTime } : {}),
            ...(lastTradeAt !== undefined ? { lastTradeAt } : {}),
            ...(extensions !== undefined ? { extensions } : {}),
            ...(asOf !== undefined ? { asOf } : {}),
        };

        return { mint, market };
    });
}
