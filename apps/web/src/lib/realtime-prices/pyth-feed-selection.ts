/**
 * Pure feed selection for Pyth Pro symbols.
 *
 * Pyth names feeds `<Namespace>.<BASE>/<QUOTE>` (e.g. `Crypto.SOL/USD`,
 * `Equity.US.TSLA/USD`, `Metal.XAU/USD`). Our assets carry a category and a
 * ticker; this module decides which Pyth namespaces to try for a given
 * (category, mode) pair and picks the best live entry out of a symbol search.
 */

export type PythFeedMode = 'canonical' | 'variant';

export interface PythSymbolEntry {
    pyth_lazer_id: number;
    symbol: string;
    asset_type?: string | null;
    state?: string | null;
    min_channel?: string | null;
    hermes_id?: string | null;
    exponent?: number | null;
    schedule?: string | null;
    description?: string | null;
}

export interface PythFeedSelection {
    feedId: number;
    symbol: string;
    assetType: string | null;
    minChannel: string | null;
    hermesId: string | null;
    schedule: string | null;
}

/** Namespaces to try, in priority order, when resolving a canonical asset by category. */
const CANONICAL_NAMESPACES_BY_CATEGORY: Record<string, readonly string[]> = {
    crypto: ['Crypto'],
    lst: ['Crypto'],
    stablecoin: ['Crypto', 'FX'],
    equity: ['Equity.US', 'Equity.Index'],
    etf: ['Equity.US'],
    index: ['Equity.Index', 'Crypto.Index'],
    rwa: ['Equity.US', 'Crypto'],
    commodity: ['Metal', 'Commodities', 'Equity.US', 'Crypto'],
};

const DEFAULT_NAMESPACES: readonly string[] = ['Crypto'];

/** Variants are the tokens themselves (xStocks, Ondo, wrapped assets): always a crypto feed. */
const VARIANT_NAMESPACES: readonly string[] = ['Crypto'];

/**
 * Categories whose variants are tokenized securities. Their token symbols are
 * short enough to collide with unrelated crypto feeds (AT&T's Ondo token is
 * `TON`, Li Auto's is `LION`), so a crypto feed only qualifies when Pyth
 * describes it as a tokenized stock.
 */
const TOKENIZED_SECURITY_CATEGORIES: ReadonlySet<string> = new Set(['equity', 'etf', 'index', 'rwa']);
const TOKENIZED_STOCK_DESCRIPTION = /XSTOCK|ONDO|TOKENI[SZ]ED|PRESTOCK|DINARI|BACKED/i;

export function isTokenizedStockFeed(entry: Pick<PythSymbolEntry, 'description'>): boolean {
    return TOKENIZED_STOCK_DESCRIPTION.test(entry.description ?? '');
}

function requiresTokenizedStockFeed(category: string | null | undefined, mode: PythFeedMode): boolean {
    return mode === 'variant' && TOKENIZED_SECURITY_CATEGORIES.has((category ?? '').trim().toLowerCase());
}

export function normalizePythTicker(value: string | null | undefined): string {
    return (value ?? '').trim().toUpperCase();
}

export function isSupportedPythTicker(tickerUpper: string): boolean {
    return /^[A-Z0-9.-]{1,20}$/.test(tickerUpper);
}

export function pythNamespacesFor(category: string | null | undefined, mode: PythFeedMode): readonly string[] {
    if (mode === 'variant') return VARIANT_NAMESPACES;
    const key = (category ?? '').trim().toLowerCase();
    return CANONICAL_NAMESPACES_BY_CATEGORY[key] ?? DEFAULT_NAMESPACES;
}

/** Exact Pyth symbols to look for, best first. */
export function buildPythSymbolCandidates(
    ticker: string,
    category: string | null | undefined,
    mode: PythFeedMode,
): string[] {
    const tickerUpper = normalizePythTicker(ticker);
    if (!tickerUpper || !isSupportedPythTicker(tickerUpper)) return [];
    return pythNamespacesFor(category, mode).map(ns => `${ns}.${tickerUpper}/USD`);
}

function toSelection(entry: PythSymbolEntry): PythFeedSelection {
    return {
        feedId: entry.pyth_lazer_id,
        symbol: entry.symbol,
        assetType: entry.asset_type ?? null,
        minChannel: entry.min_channel ?? null,
        hermesId: entry.hermes_id ?? null,
        schedule: entry.schedule ?? null,
    };
}

/**
 * Pick the best live feed for a ticker out of a Pyth symbol search result.
 * Only `stable` feeds qualify; candidates are matched by exact symbol in
 * namespace priority order.
 */
export function selectPythFeed(
    args: { ticker: string; category?: string | null; mode: PythFeedMode },
    entries: readonly PythSymbolEntry[],
): PythFeedSelection | null {
    const candidates = buildPythSymbolCandidates(args.ticker, args.category, args.mode);
    if (candidates.length === 0) return null;

    const bySymbol = new Map<string, PythSymbolEntry>();
    for (const entry of entries) {
        if (!entry || typeof entry.pyth_lazer_id !== 'number' || !Number.isInteger(entry.pyth_lazer_id)) continue;
        if ((entry.state ?? '').toLowerCase() !== 'stable') continue;
        const symbol = (entry.symbol ?? '').trim();
        if (!symbol || bySymbol.has(symbol)) continue;
        bySymbol.set(symbol, entry);
    }

    const mustBeTokenizedStock = requiresTokenizedStockFeed(args.category, args.mode);
    for (const candidate of candidates) {
        const hit = bySymbol.get(candidate);
        if (!hit) continue;
        if (mustBeTokenizedStock && !isTokenizedStockFeed(hit)) continue;
        return toSelection(hit);
    }
    return null;
}
