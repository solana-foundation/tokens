import 'server-only';

import { withTtl } from './cache';
import { runScannerQuery } from './tradingview';
import type { Token } from '@/lib/types';

/**
 * Assets the platform registry does not carry but the site still lists.
 *
 * The registry is Solana-first: an asset only exists there once it has a mint.
 * Chains the site covers without a Solana representation (Stellar today) have
 * no entry at all, so their rows are assembled here from a public quote feed
 * and appended to the curated list they belong to. Everything downstream —
 * table, sorting, formatting — treats them as ordinary `Token`s.
 *
 * Prices come from the TradingView scanner rather than an exchange API on
 * purpose: this network resets the TLS handshake to Binance and Coinbase, so a
 * direct exchange call fails here even though the same data is one scanner
 * query away.
 */
export interface ManualAsset {
    /** Route segment and dedupe key. Never collides with a registry assetId. */
    assetId: string;
    symbol: string;
    name: string;
    /** Base currency as the scanner spells it, e.g. `XLM`. */
    scannerBaseCurrency: string;
    logoURI: string;
    /** Chain the asset is native to, for the detail page header. */
    chainLabel: string;
}

export const MANUAL_ASSETS: readonly ManualAsset[] = [
    {
        assetId: 'stellar',
        symbol: 'XLM',
        name: 'Stellar',
        scannerBaseCurrency: 'XLM',
        logoURI: 'https://assets.coingecko.com/coins/images/100/large/fmpFRHHQ_400x400.jpg',
        chainLabel: 'Stellar',
    },
];

/** Which curated tab each manual asset is appended to. */
export const MANUAL_ASSETS_BY_LIST: Record<string, readonly ManualAsset[]> = {
    majors: MANUAL_ASSETS,
};

const SCANNER_COLUMNS = [
    'base_currency',
    'base_currency_desc',
    'close',
    'change',
    'market_cap_calc',
    '24h_vol_cmc',
] as const;

/** Matches the curated lists' own revalidate window so tabs age together. */
const QUOTES_TTL_MS = 30_000;

function numberOrNull(value: unknown): number | null {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

export interface ManualAssetQuote {
    price: number | null;
    priceChange24hPercent: number | null;
    marketCap: number | null;
    volume24hUSD: number | null;
}

/**
 * One scanner call covers every manual asset — the filter takes a list, so the
 * cost does not grow with the number of assets added above.
 */
const loadQuotes = withTtl(QUOTES_TTL_MS, async (): Promise<Map<string, ManualAssetQuote>> => {
    const quotes = new Map<string, ManualAssetQuote>();
    if (MANUAL_ASSETS.length === 0) return quotes;

    const result = await runScannerQuery({
        market: 'coin',
        columns: SCANNER_COLUMNS,
        filter: [
            {
                left: 'base_currency',
                operation: 'in_range',
                right: MANUAL_ASSETS.map(asset => asset.scannerBaseCurrency),
            },
        ],
        range: [0, MANUAL_ASSETS.length * 4],
    });

    for (const row of result.rows) {
        const base = typeof row.values.base_currency === 'string' ? row.values.base_currency : null;
        if (!base || quotes.has(base)) continue;

        quotes.set(base, {
            price: numberOrNull(row.values.close),
            priceChange24hPercent: numberOrNull(row.values.change),
            marketCap: numberOrNull(row.values.market_cap_calc),
            volume24hUSD: numberOrNull(row.values['24h_vol_cmc']),
        });
    }

    return quotes;
});

function toToken(asset: ManualAsset, quote: ManualAssetQuote | undefined): Token {
    return {
        assetId: asset.assetId,
        category: 'crypto',
        // No mint exists off Solana; the asset id doubles as the row key and the
        // link target, and `buildCoinHref` prefers it over the address anyway.
        address: asset.assetId,
        symbol: asset.symbol,
        name: asset.name,
        decimals: 7,
        logoURI: asset.logoURI,
        // The scanner reports traded value, not pool depth — leaving this null
        // renders `—` instead of claiming zero liquidity.
        liquidity: null,
        volume24hUSD: quote?.volume24hUSD ?? 0,
        volume24hSource: 'canonical',
        price: quote?.price ?? 0,
        priceChange24hPercent: quote?.priceChange24hPercent ?? 0,
        marketCap: quote?.marketCap ?? 0,
    } satisfies Token;
}

/**
 * Manual rows for one curated list, or an empty array when the list has none or
 * the quote feed is unreachable. Never throws: a missing quote must not take
 * the whole tab down.
 */
export async function fetchManualAssetsForList(listId: string): Promise<Token[]> {
    const assets = MANUAL_ASSETS_BY_LIST[listId];
    if (!assets || assets.length === 0) return [];

    try {
        const quotes = await loadQuotes();
        return assets.map(asset => toToken(asset, quotes.get(asset.scannerBaseCurrency)));
    } catch (error) {
        console.warn(
            '[manual-assets] quotes unavailable:',
            error instanceof Error ? error.message : String(error),
        );
        return [];
    }
}

/**
 * The same rows in the platform API's own asset shape, for the curated proxy
 * route: tab switches after first paint fetch through it, so a manual row that
 * only existed in the server render would vanish on the second click.
 */
export async function fetchManualCuratedEntriesForList(listId: string): Promise<unknown[]> {
    const assets = MANUAL_ASSETS_BY_LIST[listId];
    if (!assets || assets.length === 0) return [];

    let quotes: Map<string, ManualAssetQuote>;
    try {
        quotes = await loadQuotes();
    } catch {
        return [];
    }

    return assets.map(asset => {
        const quote = quotes.get(asset.scannerBaseCurrency);
        const stats = {
            price: quote?.price ?? null,
            liquidity: null,
            volume24hUSD: quote?.volume24hUSD ?? null,
            marketCap: quote?.marketCap ?? null,
            priceChange24hPercent: quote?.priceChange24hPercent ?? null,
            priceChange1hPercent: null,
        };

        return {
            assetId: asset.assetId,
            name: asset.name,
            symbol: asset.symbol,
            category: 'crypto',
            imageUrl: asset.logoURI,
            stats,
            primaryVariant: {
                mint: asset.assetId,
                symbol: asset.symbol,
                name: asset.name,
                market: {
                    price: stats.price,
                    liquidity: null,
                    volume24hUSD: stats.volume24hUSD,
                    marketCap: stats.marketCap,
                    priceChange24hPercent: stats.priceChange24hPercent,
                    priceChange1hPercent: null,
                    decimals: 7,
                    logoURI: asset.logoURI,
                    symbol: asset.symbol,
                    name: asset.name,
                },
            },
        };
    });
}

export function findManualAsset(assetIdOrSymbol: string): ManualAsset | null {
    const needle = assetIdOrSymbol.trim().toLowerCase();
    if (!needle) return null;

    return (
        MANUAL_ASSETS.find(
            asset => asset.assetId.toLowerCase() === needle || asset.symbol.toLowerCase() === needle,
        ) ?? null
    );
}

export async function fetchManualAssetQuote(asset: ManualAsset): Promise<ManualAssetQuote | null> {
    try {
        const quotes = await loadQuotes();
        return quotes.get(asset.scannerBaseCurrency) ?? null;
    } catch {
        return null;
    }
}
