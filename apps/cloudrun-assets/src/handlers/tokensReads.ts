import { InvalidArgsError } from './assets';
import { resolveLogoUri } from './logoUrl';

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

export async function getSearchTokensByAddresses(
    repo: TokensReadsRepo,
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

    const rows = await repo.findTokensByAddresses(addresses);
    const byAddress = new Map(rows.map(r => [r.address, r] as const));

    return addresses.map(address => {
        const row = byAddress.get(address);
        if (!row) return { address, token: null, hasMarket: false };
        const hasMarket =
            row.price !== null &&
            Number.isFinite(row.price) &&
            row.price > 0 &&
            row.volume_24h_usd !== null &&
            row.price_change_24h_percent !== null;
        return { address, token: rowToSearchToken(row), hasMarket };
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
