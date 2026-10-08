/**
 * Legacy `tokens` table write shape + the Birdeye overview → row mapping.
 *
 * Lives in its own module so both the misc token-price cron and the curated
 * variant-market refresh can write through to `tokens` without a circular
 * import between `crons.ts` and `crons.misc.ts`.
 */
export interface TokenUpsertFromBirdeye {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logoUri?: string;
    price?: number;
    priceChange24hPercent?: number;
    priceChange1hPercent?: number;
    volume24hUSD?: number;
    liquidity?: number;
    marketCap?: number;
    lastFetchedAt: number;
}

/** The overview fields the mapping reads; satisfied by `BirdeyeOverview` and raw JSON alike. */
export interface TokenOverviewLike {
    symbol?: unknown;
    name?: unknown;
    decimals?: unknown;
    logoURI?: unknown;
    price?: unknown;
    priceChange24hPercent?: unknown;
    priceChange1hPercent?: unknown;
    v24hUSD?: unknown;
    liquidity?: unknown;
    marketCap?: unknown;
}

export function cleanTokenName(name: string | undefined): string {
    if (!name) return 'Unknown';
    return (
        name
            .replace(/\s*xStock\s*$/i, '')
            .replace(/\s*\(\s*(wormhole|bridged|wrapped|omnibridge|coinbase|ondo\s+tokenized)\s*\)\s*/gi, ' ')
            .replace(/\s*\(\s*mSOL\s*\)\s*/gi, ' ')
            .replace(/^\s*coinbase\s+wrapped\s+/i, '')
            .replace(/^\s*wrapped\s+/i, '')
            .replace(/\s+wrapped\s+/gi, ' ')
            .replace(/\s+wrapped\s*$/i, '')
            .replace(/\s+staked\s+sol(?=\s*(\(|$))/i, '')
            .replace(/\s{2,}/g, ' ')
            .trim() || 'Unknown'
    );
}

export function birdeyeOverviewToTokenUpsert(
    address: string,
    overview: TokenOverviewLike,
    lastFetchedAt: number,
): TokenUpsertFromBirdeye | null {
    const symbol = typeof overview.symbol === 'string' ? overview.symbol.trim() : '';
    const rawName = typeof overview.name === 'string' ? overview.name.trim() : '';
    const name = cleanTokenName(rawName);
    if (!symbol) return null;
    if (!name || name === 'Unknown') return null;
    const decimals =
        typeof overview.decimals === 'number' && Number.isFinite(overview.decimals) ? overview.decimals : 9;
    const out: TokenUpsertFromBirdeye = { address, symbol, name, decimals, lastFetchedAt };
    const logo = typeof overview.logoURI === 'string' ? overview.logoURI.trim() : '';
    if (logo) out.logoUri = logo;
    if (typeof overview.price === 'number' && Number.isFinite(overview.price)) out.price = overview.price;
    if (typeof overview.priceChange24hPercent === 'number' && Number.isFinite(overview.priceChange24hPercent))
        out.priceChange24hPercent = overview.priceChange24hPercent;
    if (typeof overview.priceChange1hPercent === 'number' && Number.isFinite(overview.priceChange1hPercent))
        out.priceChange1hPercent = overview.priceChange1hPercent;
    if (typeof overview.v24hUSD === 'number' && Number.isFinite(overview.v24hUSD))
        out.volume24hUSD = overview.v24hUSD;
    if (typeof overview.liquidity === 'number' && Number.isFinite(overview.liquidity))
        out.liquidity = overview.liquidity;
    if (typeof overview.marketCap === 'number' && Number.isFinite(overview.marketCap))
        out.marketCap = overview.marketCap;
    return out;
}
