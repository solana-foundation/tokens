import { InvalidArgsError } from './assets';
import { resolveLogoUri } from './logoUrl';
import {
    getLatestByMints as variantMarketsGetLatestByMints,
    type VariantMarketSnapshotResult,
    type VariantMarketsRepo,
} from './variantMarkets';

export interface TokenRow {
    id: string;
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logo_uri: string | null;
    logo_cdn_url?: string | null;
    coingecko_id: string | null;
    description: string | null;
    website: string | null;
    twitter: string | null;
    discord: string | null;
    telegram: string | null;
    reddit: string | null;
    github: string | null;
    price: number | null;
    price_change_24h_percent: number | null;
    price_change_1h_percent: number | null;
    volume_24h_usd: number | null;
    liquidity: number | null;
    market_cap: number | null;
    last_fetched_at: number;
    created_at: Date;
}

export interface TokenMarketsLatestRow {
    mint: string;
    source: string;
    markets: unknown;
    total: number;
    last_fetched_at: number;
}

export interface TokenDescriptionSummaryRow {
    id: string;
    address: string;
    summary: string;
    source_hash: string | null;
    model: string | null;
    prompt_version: number | null;
    generated_at: number;
    created_at: Date;
}

export interface TokensReadsRepo {
    findTokenByAddress(address: string): Promise<TokenRow | null>;
    findTokensByAddresses(addresses: readonly string[]): Promise<TokenRow[]>;
    searchTokensBySymbol(query: string, limit: number): Promise<TokenRow[]>;
    searchTokensByName(query: string, limit: number): Promise<TokenRow[]>;
    findTokenMarketsLatestByMint(mint: string): Promise<TokenMarketsLatestRow | null>;
    findTokenMarketsLatestByMints(mints: readonly string[]): Promise<TokenMarketsLatestRow[]>;
    findTokenDescriptionSummaryByAddress(address: string): Promise<TokenDescriptionSummaryRow | null>;
}

export interface TokenDoc {
    _id: string;
    _creationTime: number;
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logoUri?: string;
    coingeckoId?: string;
    description?: string;
    website?: string;
    twitter?: string;
    discord?: string;
    telegram?: string;
    reddit?: string;
    github?: string;
    price?: number;
    priceChange24hPercent?: number;
    priceChange1hPercent?: number;
    volume24hUSD?: number;
    liquidity?: number;
    marketCap?: number;
    lastFetchedAt: number;
}

export interface TokenSearchToken {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
    liquidity: number;
    volume24hUSD: number;
    price: number;
    priceChange24hPercent: number;
    priceChange1hPercent?: number;
    marketCap: number;
    /**
     * Present when the row was built from the variant-market snapshot (the
     * table every curated mint is refreshed into) rather than the legacy
     * `tokens` table. Same shape the `variant-markets` batch route exposes.
     */
    source?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    metricsSource?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    fdv?: number;
    holder?: number;
    totalSupply?: number;
    circulatingSupply?: number;
    volume1hUSD?: number;
    trade1h?: number;
    trade24h?: number;
    uniqueWallet1h?: number;
    uniqueWallet24h?: number;
    lastTradeAt?: number;
    asOf?: number;
    lastFetchedAt?: number;
}

export interface GetSearchTokensByAddressesEntry {
    address: string;
    token: TokenSearchToken | null;
    hasMarket: boolean;
}

function rowToTokenDoc(row: TokenRow): TokenDoc {
    const doc: TokenDoc = {
        _id: row.id,
        _creationTime: row.created_at.getTime(),
        address: row.address,
        symbol: row.symbol,
        name: row.name,
        decimals: row.decimals,
        lastFetchedAt: row.last_fetched_at,
    };
    const docLogo = resolveLogoUri(row);
    if (docLogo !== null) doc.logoUri = docLogo;
    if (row.coingecko_id !== null) doc.coingeckoId = row.coingecko_id;
    if (row.description !== null) doc.description = row.description;
    if (row.website !== null) doc.website = row.website;
    if (row.twitter !== null) doc.twitter = row.twitter;
    if (row.discord !== null) doc.discord = row.discord;
    if (row.telegram !== null) doc.telegram = row.telegram;
    if (row.reddit !== null) doc.reddit = row.reddit;
    if (row.github !== null) doc.github = row.github;
    if (row.price !== null) doc.price = row.price;
    if (row.price_change_24h_percent !== null) doc.priceChange24hPercent = row.price_change_24h_percent;
    if (row.price_change_1h_percent !== null) doc.priceChange1hPercent = row.price_change_1h_percent;
    if (row.volume_24h_usd !== null) doc.volume24hUSD = row.volume_24h_usd;
    if (row.liquidity !== null) doc.liquidity = row.liquidity;
    if (row.market_cap !== null) doc.marketCap = row.market_cap;
    return doc;
}

function rowToSearchToken(row: TokenRow): TokenSearchToken {
    const out: TokenSearchToken = {
        address: row.address,
        symbol: row.symbol,
        name: row.name,
        decimals: row.decimals,
        liquidity: row.liquidity ?? 0,
        volume24hUSD: row.volume_24h_usd ?? 0,
        price: row.price ?? 0,
        priceChange24hPercent: row.price_change_24h_percent ?? 0,
        marketCap: row.market_cap ?? 0,
    };
    const logoURI = resolveLogoUri(row);
    if (logoURI !== null) out.logoURI = logoURI;
    if (row.price_change_1h_percent !== null) out.priceChange1hPercent = row.price_change_1h_percent;
    return out;
}

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export async function getTokenByAddress(repo: TokensReadsRepo, args: unknown): Promise<TokenDoc | null> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { address?: unknown };
    if (typeof a.address !== 'string') {
        throw new InvalidArgsError('address must be a string');
    }
    const address = a.address;
    if (!address) return null;
    const row = await repo.findTokenByAddress(address);
    if (!row) return null;
    return rowToTokenDoc(row);
}

export async function searchTokens(repo: TokensReadsRepo, args: unknown): Promise<TokenSearchToken[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { query?: unknown; limit?: unknown };
    if (typeof a.query !== 'string') {
        throw new InvalidArgsError('query must be a string');
    }
    if (a.limit !== undefined && typeof a.limit !== 'number') {
        throw new InvalidArgsError('limit must be a number when present');
    }
    const q = a.query.trim();
    if (!q) return [];

    const limit = Math.min(Math.max(typeof a.limit === 'number' ? a.limit : 20, 1), 50);

    if (looksLikeSolanaMintAddress(q)) {
        const row = await repo.findTokenByAddress(q);
        return row ? [rowToSearchToken(row)] : [];
    }

    const seen = new Set<string>();
    const results: TokenSearchToken[] = [];

    const symbolMatches = await repo.searchTokensBySymbol(q, limit);
    for (const row of symbolMatches) {
        if (results.length >= limit) break;
        if (seen.has(row.address)) continue;
        seen.add(row.address);
        results.push(rowToSearchToken(row));
    }

    if (results.length < limit) {
        const nameMatches = await repo.searchTokensByName(q, limit);
        for (const row of nameMatches) {
            if (results.length >= limit) break;
            if (seen.has(row.address)) continue;
            seen.add(row.address);
            results.push(rowToSearchToken(row));
        }
    }

    return results;
}

/**
 * A variant-market snapshot carries identity when the provider overview
 * succeeded; a `touch`-only row (overview failed or lacked symbol/name) has
 * none and must not shadow a legacy row that does. Mirrors the API's
 * `_load-variant-markets` rule.
 */
function variantSnapshotHasIdentity(
    market: VariantMarketSnapshotResult | null | undefined,
): market is VariantMarketSnapshotResult & { symbol: string; name: string; decimals: number } {
    return (
        !!market &&
        typeof market.symbol === 'string' &&
        market.symbol.trim().length > 0 &&
        typeof market.name === 'string' &&
        market.name.trim().length > 0 &&
        typeof market.decimals === 'number' &&
        Number.isFinite(market.decimals)
    );
}

function finiteOrUndefined(value: number | null | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Shared `hasMarket` rule for both sources: a real price plus 24h volume and change. */
function computeHasMarket(args: {
    price: number | undefined;
    volume24hUSD: number | undefined;
    priceChange24hPercent: number | undefined;
}): boolean {
    return (
        args.price !== undefined &&
        args.price > 0 &&
        args.volume24hUSD !== undefined &&
        args.priceChange24hPercent !== undefined
    );
}

function variantSnapshotMetricFields(market: VariantMarketSnapshotResult): Partial<TokenSearchToken> {
    const out: Partial<TokenSearchToken> = { source: market.source, lastFetchedAt: market.lastFetchedAt };
    if (market.metricsSource !== undefined) out.metricsSource = market.metricsSource;
    const fdv = finiteOrUndefined(market.fdv);
    if (fdv !== undefined) out.fdv = fdv;
    const holder = finiteOrUndefined(market.holder);
    if (holder !== undefined) out.holder = holder;
    const totalSupply = finiteOrUndefined(market.totalSupply);
    if (totalSupply !== undefined) out.totalSupply = totalSupply;
    const circulatingSupply = finiteOrUndefined(market.circulatingSupply);
    if (circulatingSupply !== undefined) out.circulatingSupply = circulatingSupply;
    const volume1hUSD = finiteOrUndefined(market.volume1hUSD);
    if (volume1hUSD !== undefined) out.volume1hUSD = volume1hUSD;
    const trade1h = finiteOrUndefined(market.trade1h);
    if (trade1h !== undefined) out.trade1h = trade1h;
    const trade24h = finiteOrUndefined(market.trade24h);
    if (trade24h !== undefined) out.trade24h = trade24h;
    const uniqueWallet1h = finiteOrUndefined(market.uniqueWallet1h);
    if (uniqueWallet1h !== undefined) out.uniqueWallet1h = uniqueWallet1h;
    const uniqueWallet24h = finiteOrUndefined(market.uniqueWallet24h);
    if (uniqueWallet24h !== undefined) out.uniqueWallet24h = uniqueWallet24h;
    const lastTradeAt = finiteOrUndefined(market.lastTradeAt);
    if (lastTradeAt !== undefined) out.lastTradeAt = lastTradeAt;
    const asOf = finiteOrUndefined(market.asOf);
    if (asOf !== undefined) out.asOf = asOf;
    return out;
}

/**
 * Build a search row from a variant-market snapshot, filling any metric the
 * snapshot lacks from the legacy `tokens` row when one exists.
 */
function variantSnapshotToSearchToken(
    address: string,
    market: VariantMarketSnapshotResult & { symbol: string; name: string; decimals: number },
    row: TokenRow | undefined,
): { token: TokenSearchToken; hasMarket: boolean } {
    const price = finiteOrUndefined(market.price) ?? finiteOrUndefined(row?.price);
    const volume24hUSD = finiteOrUndefined(market.volume24hUSD) ?? finiteOrUndefined(row?.volume_24h_usd);
    const priceChange24hPercent =
        finiteOrUndefined(market.priceChange24hPercent) ?? finiteOrUndefined(row?.price_change_24h_percent);
    const priceChange1hPercent =
        finiteOrUndefined(market.priceChange1hPercent) ?? finiteOrUndefined(row?.price_change_1h_percent);
    const liquidity = finiteOrUndefined(market.liquidity) ?? finiteOrUndefined(row?.liquidity);
    const marketCap = finiteOrUndefined(market.marketCap) ?? finiteOrUndefined(row?.market_cap);
    const logoURI = market.logoURI ?? (row ? resolveLogoUri(row) : null);

    const out: TokenSearchToken = {
        address,
        symbol: market.symbol,
        name: market.name,
        decimals: market.decimals,
        liquidity: liquidity ?? 0,
        volume24hUSD: volume24hUSD ?? 0,
        price: price ?? 0,
        priceChange24hPercent: priceChange24hPercent ?? 0,
        marketCap: marketCap ?? 0,
        ...variantSnapshotMetricFields(market),
    };
    if (logoURI) out.logoURI = logoURI;
    if (priceChange1hPercent !== undefined) out.priceChange1hPercent = priceChange1hPercent;

    return { token: out, hasMarket: computeHasMarket({ price, volume24hUSD, priceChange24hPercent }) };
}

/**
 * Legacy-row search token, with finite metrics from a touch-only or
 * identity-less variant snapshot layered on top when present.
 */
function legacyRowToSearchToken(
    row: TokenRow,
    market: VariantMarketSnapshotResult | null | undefined,
): { token: TokenSearchToken; hasMarket: boolean } {
    const out = rowToSearchToken(row);
    const price = finiteOrUndefined(market?.price) ?? finiteOrUndefined(row.price);
    const volume24hUSD = finiteOrUndefined(market?.volume24hUSD) ?? finiteOrUndefined(row.volume_24h_usd);
    const priceChange24hPercent =
        finiteOrUndefined(market?.priceChange24hPercent) ?? finiteOrUndefined(row.price_change_24h_percent);
    const priceChange1hPercent =
        finiteOrUndefined(market?.priceChange1hPercent) ?? finiteOrUndefined(row.price_change_1h_percent);
    const liquidity = finiteOrUndefined(market?.liquidity) ?? finiteOrUndefined(row.liquidity);
    const marketCap = finiteOrUndefined(market?.marketCap) ?? finiteOrUndefined(row.market_cap);

    if (price !== undefined) out.price = price;
    if (volume24hUSD !== undefined) out.volume24hUSD = volume24hUSD;
    if (priceChange24hPercent !== undefined) out.priceChange24hPercent = priceChange24hPercent;
    if (priceChange1hPercent !== undefined) out.priceChange1hPercent = priceChange1hPercent;
    if (liquidity !== undefined) out.liquidity = liquidity;
    if (marketCap !== undefined) out.marketCap = marketCap;
    if (market) Object.assign(out, variantSnapshotMetricFields(market));

    return { token: out, hasMarket: computeHasMarket({ price, volume24hUSD, priceChange24hPercent }) };
}

/**
 * Batch token metadata + market snapshot by mint.
 *
 * Reads the variant-market snapshot first (`variant_markets_latest`, refreshed
 * for every curated mint) and falls back to the legacy `tokens` table, which
 * only ever refreshes rows that already exist — mints curated after that
 * table's write path was retired have no row there at all.
 */
export async function getSearchTokensByAddresses(
    repo: TokensReadsRepo,
    variantMarketsRepo: VariantMarketsRepo | null,
    args: unknown,
): Promise<GetSearchTokensByAddressesEntry[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { addresses?: unknown };
    if (!Array.isArray(a.addresses)) {
        throw new InvalidArgsError('addresses must be an array of strings');
    }
    for (const item of a.addresses) {
        if (typeof item !== 'string') {
            throw new InvalidArgsError('addresses must be an array of strings');
        }
    }
    const addresses = (a.addresses as string[]).slice(0, 250);
    if (addresses.length === 0) return [];

    const [rows, marketEntries] = await Promise.all([
        repo.findTokensByAddresses(addresses),
        variantMarketsRepo ? variantMarketsGetLatestByMints(variantMarketsRepo, { mints: addresses }) : [],
    ]);
    const byAddress = new Map(rows.map(r => [r.address, r] as const));
    const marketByMint = new Map(marketEntries.map(entry => [entry.mint, entry.market] as const));

    return addresses.map(address => {
        const row = byAddress.get(address);
        const market = marketByMint.get(address) ?? null;

        if (variantSnapshotHasIdentity(market)) {
            const built = variantSnapshotToSearchToken(address, market, row);
            return { address, token: built.token, hasMarket: built.hasMarket };
        }
        if (row) {
            const built = legacyRowToSearchToken(row, market);
            return { address, token: built.token, hasMarket: built.hasMarket };
        }
        return { address, token: null, hasMarket: false };
    });
}

export type MarketSourceKind = 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';

export interface TokenMarketTokenLike {
    address: string;
    decimals?: number;
    symbol?: string;
    icon?: string;
    name?: string;
}

export interface TokenMarketLike {
    address: string;
    name?: string;
    base?: TokenMarketTokenLike;
    quote?: TokenMarketTokenLike;
    source?: string;
    createdAt?: string;
    liquidity?: number;
    volume24h?: number;
    trade24h?: number;
    trade24hChangePercent?: number;
    uniqueWallet24h?: number;
    uniqueWallet24hChangePercent?: number;
    price?: number;
}

export interface TokenMarketsDoc {
    mint: string;
    source: MarketSourceKind;
    markets: TokenMarketLike[];
    total: number;
    lastFetchedAt: number;
}

export interface GetTokenMarketsLatestByMintsEntry {
    mint: string;
    doc: TokenMarketsDoc | null;
}

export interface GetTopMarketsByMintsEntry {
    mint: string;
    topMarket: TokenMarketLike | null;
    total: number | null;
    lastFetchedAt: number | null;
}

function isMarketSourceKind(value: unknown): value is MarketSourceKind {
    return value === 'birdeye' || value === 'rwa_xyz' || value === 'clickhouse_trades';
}

function isTokenMarketToken(value: unknown): value is TokenMarketTokenLike {
    if (!value || typeof value !== 'object') return false;
    const token = value as { address?: unknown };
    return typeof token.address === 'string' && token.address.length > 0;
}

function isTokenMarket(value: unknown): value is TokenMarketLike {
    if (!value || typeof value !== 'object') return false;
    const market = value as { address?: unknown; base?: unknown; quote?: unknown };
    if (typeof market.address !== 'string' || market.address.length === 0) return false;
    if (market.base !== undefined && !isTokenMarketToken(market.base)) return false;
    if (market.quote !== undefined && !isTokenMarketToken(market.quote)) return false;
    return true;
}

function toFiniteOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function pickTopMarket(markets: readonly unknown[]): TokenMarketLike | null {
    const valid = markets.filter(isTokenMarket);
    if (valid.length === 0) return null;
    const sorted = valid.slice().sort(
        (a, b) =>
            toFiniteOrZero(b.liquidity) - toFiniteOrZero(a.liquidity) ||
            toFiniteOrZero(b.volume24h) - toFiniteOrZero(a.volume24h),
    );
    const priced = sorted.find(m => toFiniteOrZero(m.price) > 0) ?? null;
    return priced ?? sorted[0] ?? null;
}

function rowToTokenMarketsDoc(row: TokenMarketsLatestRow): TokenMarketsDoc | null {
    if (!isMarketSourceKind(row.source)) return null;
    const rawMarkets = Array.isArray(row.markets) ? row.markets : [];
    return {
        mint: row.mint,
        source: row.source,
        markets: rawMarkets.filter(isTokenMarket),
        total: row.total,
        lastFetchedAt: row.last_fetched_at,
    };
}

export async function getTokenMarketsLatestByMint(
    repo: TokensReadsRepo,
    args: unknown,
): Promise<TokenMarketsDoc | null> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { mint?: unknown };
    if (typeof a.mint !== 'string') {
        throw new InvalidArgsError('mint must be a string');
    }
    const mint = a.mint.trim();
    if (!mint) return null;
    const row = await repo.findTokenMarketsLatestByMint(mint);
    if (!row) return null;
    return rowToTokenMarketsDoc(row);
}

export async function getTokenMarketsLatestByMints(
    repo: TokensReadsRepo,
    args: unknown,
): Promise<GetTokenMarketsLatestByMintsEntry[]> {
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
    const mints = (a.mints as string[]).map(m => m.trim()).filter(Boolean);
    const MAX_MINTS_PER_CALL = 50;
    if (mints.length > MAX_MINTS_PER_CALL) {
        throw new InvalidArgsError(`Too many mints: max ${MAX_MINTS_PER_CALL} per call`);
    }
    if (mints.length === 0) return [];
    const rows = await repo.findTokenMarketsLatestByMints(mints);
    const byMint = new Map(rows.map(r => [r.mint, r] as const));
    return mints.map(mint => {
        const row = byMint.get(mint);
        if (!row) return { mint, doc: null };
        return { mint, doc: rowToTokenMarketsDoc(row) };
    });
}

export async function getTopMarketsByMints(
    repo: TokensReadsRepo,
    args: unknown,
): Promise<GetTopMarketsByMintsEntry[]> {
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
    const mints = (a.mints as string[]).map(m => m.trim()).filter(Boolean);
    const MAX_MINTS_PER_CALL = 50;
    if (mints.length > MAX_MINTS_PER_CALL) {
        throw new InvalidArgsError(`Too many mints: max ${MAX_MINTS_PER_CALL} per call`);
    }
    if (mints.length === 0) return [];
    const rows = await repo.findTokenMarketsLatestByMints(mints);
    const byMint = new Map(rows.map(r => [r.mint, r] as const));
    return mints.map(mint => {
        const row = byMint.get(mint);
        if (!row) return { mint, topMarket: null, total: null, lastFetchedAt: null };
        const rawMarkets = Array.isArray(row.markets) ? row.markets : [];
        const top = pickTopMarket(rawMarkets);
        return {
            mint: row.mint,
            topMarket: top,
            total: row.total,
            lastFetchedAt: row.last_fetched_at,
        };
    });
}

export interface TokenDescriptionSummaryDoc {
    _id: string;
    _creationTime: number;
    address: string;
    summary: string;
    sourceHash?: string;
    model?: string;
    promptVersion?: number;
    generatedAt: number;
}

function rowToSummaryDoc(row: TokenDescriptionSummaryRow): TokenDescriptionSummaryDoc {
    const out: TokenDescriptionSummaryDoc = {
        _id: row.id,
        _creationTime: row.created_at.getTime(),
        address: row.address,
        summary: row.summary,
        generatedAt: row.generated_at,
    };
    if (row.source_hash !== null) out.sourceHash = row.source_hash;
    if (row.model !== null) out.model = row.model;
    if (row.prompt_version !== null) out.promptVersion = row.prompt_version;
    return out;
}

export async function getTokenDescriptionSummaryByAddress(
    repo: TokensReadsRepo,
    args: unknown,
): Promise<TokenDescriptionSummaryDoc | null> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { address?: unknown };
    if (typeof a.address !== 'string') {
        throw new InvalidArgsError('address must be a string');
    }
    const row = await repo.findTokenDescriptionSummaryByAddress(a.address);
    if (!row) return null;
    return rowToSummaryDoc(row);
}
