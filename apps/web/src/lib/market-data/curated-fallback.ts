import 'server-only';

import { getVariantByMint } from '@tokens/asset-registry';
import { CURATED_LIST_ORDER, getCuratedTokenList, type CuratedTokenListId } from '@tokens/asset-registry/compat';
import type { Token } from '@/lib/types';
import { withTtl } from './cache';
import { COINGECKO_BASE_URL, loadCoinGeckoIndex, resolveCoinGeckoId, slugify } from './coingecko-index';
import { fetchTokenLiquidity } from './token-liquidity';
import { runScannerQuery } from './tradingview';
import { numberOrNull, stringOrNull } from './types';

/**
 * Fills the homepage curated tabs when the Tokens platform API is unavailable
 * (no `TOKENS_PLATFORM_API_KEY`, or `apps/api` and its Cloud Run backends are
 * not running locally).
 *
 * Assets are matched by symbol/name rather than by mint so the mapping keeps
 * working once the registry carries non-Solana chains. Coverage is partial by
 * nature — measured against the current registry it lands around 90% for
 * majors/currencies/metals/etfs and ~70% for stocks; unmatched rows are
 * returned without market numbers rather than being hidden.
 */

interface Quote {
    price: number | null;
    changePercent: number | null;
    volume24h: number | null;
    marketCap: number | null;
}

interface CuratedAsset {
    mint: string;
    assetId: string;
    symbol: string;
    name: string;
    aliases: string[];
    coingeckoId: string | null;
    category: string | null;
    /**
     * Registry entry carries neither a name nor a symbol (auto-generated ids
     * like `stock-yqznqh2y`). Nothing can be matched against it, and it has
     * nothing to display either.
     */
    unnamed: boolean;
}

/**
 * Registry entries whose symbol/name cannot be matched automatically, mapped to
 * their bare exchange symbol. The exchange prefix is intentionally omitted —
 * it is resolved from the live screener index, because prefixes vary per
 * listing (AMEX vs NASDAQ vs CBOE) and hardcoding them silently breaks rows.
 */
const SYMBOL_OVERRIDES: Record<string, string> = {
    // ETFs — the registry stores display names only.
    nasdaq: 'QQQ',
    sp500: 'SPY',
    tqqq: 'TQQQ',
    'russell-2000': 'IWM',
    'core-msci-em': 'IEMG',
    'schwab-intl': 'SCHF',
    vanguard: 'VOO',
    'vanguard-total-world': 'VT',
    'ishares-msci-emerging-markets-etf': 'EEM',
    'ishares-msci-eafe-etf': 'EFA',
    'ishares-core-msci-eafe-etf': 'IEFA',
    'ishares-core-sandp-midcap-etf': 'IJH',
    'ishares-core-sandp-total-us-stock-market-etf': 'ITOT',
    'ishares-core-sandp-500-etf': 'IVV',
    'ishares-russell-1000-growth-etf': 'IWF',
    'ishares-russell-2000-etf': 'IWM',
    'ishares-russell-2000-value-etf': 'IWN',
    'invesco-qqq': 'QQQ',
    'spdr-sandp-500-etf': 'SPY',
    'vanguard-total-stock-market-etf': 'VTI',
    'proshares-ultrapro-short-qqq': 'SQQQ',
    'proshares-ultrapro-qqq': 'TQQQ',

    // Bond/credit ETFs that sit in the RWA list.
    'ishares-core-us-aggregate-bond-etf': 'AGG',
    'ishares-20-year-treasury-bond-etf': 'TLT',
    'wisdomtree-floating-rate-treasury-fund': 'USFR',
    'ishares-aaa-clo-active-etf': 'CLOA',
    'vaneck-clo-etf': 'CLOI',
};

/**
 * How many rows per list get an on-chain liquidity lookup. One batch of 30,
 * because the homepage renders six lists at once and GeckoTerminal serializes
 * every caller: at two batches per list a cold render measured 14-26s per list.
 */
const LIQUIDITY_LOOKUP_LIMIT = 30;

/**
 * Liquidity is secondary to price, so it never blocks a render for long. Past
 * this deadline the rows are returned without it; the underlying batches keep
 * resolving into their 5-minute cache and populate the next render.
 */
const LIQUIDITY_DEADLINE_MS = 5_000;

/** Spot metal benchmarks, which live outside the equity screener. */
const METAL_TICKERS: Record<string, string> = {
    gold: 'TVC:GOLD',
    silver: 'TVC:SILVER',
    copper: 'COMEX:HG1!',
};


// ---------------------------------------------------------------- TradingView

interface ScreenerIndex {
    /** Bare symbol (`SPY`) -> quote. */
    bySymbol: Map<string, Quote>;
    /** Slugified description (`apple-inc`) -> quote. */
    byName: Map<string, Quote>;
}

const EQUITY_COLUMNS = [
    'name',
    'description',
    'close',
    'change',
    'volume',
    'market_cap_basic',
    'aum',
] as const;

/**
 * Stocks and funds are scanned separately because they rank on different
 * columns: funds leave `market_cap_basic` null, so a single market-cap sort
 * pushes every ETF past the row limit and silently loses them.
 */
const loadEquityIndex = withTtl(60_000, async (): Promise<ScreenerIndex> => {
    const [stocks, funds] = await Promise.all([
        runScannerQuery({
            market: 'america',
            columns: EQUITY_COLUMNS,
            filter: [{ left: 'type', operation: 'equal', right: 'stock' }],
            sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
            // Ranges cover the full US listing count (~11.8k stocks, ~6.5k
            // funds); truncating here drops small caps the registry tracks.
            range: [0, 12_000],
        }),
        runScannerQuery({
            market: 'america',
            columns: EQUITY_COLUMNS,
            filter: [{ left: 'type', operation: 'equal', right: 'fund' }],
            sort: { sortBy: 'aum', sortOrder: 'desc' },
            range: [0, 8_000],
        }),
    ]);

    const bySymbol = new Map<string, Quote>();
    const byName = new Map<string, Quote>();
    for (const row of [...stocks.rows, ...funds.rows]) {
        const quote: Quote = {
            price: numberOrNull(row.values.close),
            changePercent: numberOrNull(row.values.change),
            volume24h: numberOrNull(row.values.volume),
            marketCap: numberOrNull(row.values.market_cap_basic) ?? numberOrNull(row.values.aum),
        };
        const symbol = stringOrNull(row.values.name)?.toUpperCase();
        if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, quote);
        const name = stringOrNull(row.values.description);
        if (name) {
            const key = slugify(name);
            if (key && !byName.has(key)) byName.set(key, quote);
        }
    }
    return { bySymbol, byName };
});

const loadCoinIndex = withTtl(60_000, async (): Promise<ScreenerIndex> => {
    const result = await runScannerQuery({
        market: 'coin',
        columns: ['base_currency', 'base_currency_desc', 'close', 'change', 'market_cap_calc', '24h_vol_cmc'],
        sort: { sortBy: 'market_cap_calc', sortOrder: 'desc' },
        range: [0, 3000],
    });

    const bySymbol = new Map<string, Quote>();
    const byName = new Map<string, Quote>();
    for (const row of result.rows) {
        const quote: Quote = {
            price: numberOrNull(row.values.close),
            changePercent: numberOrNull(row.values.change),
            volume24h: numberOrNull(row.values['24h_vol_cmc']),
            marketCap: numberOrNull(row.values.market_cap_calc),
        };
        const symbol = stringOrNull(row.values.base_currency)?.toUpperCase();
        if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, quote);
        const name = stringOrNull(row.values.base_currency_desc);
        if (name) {
            const key = slugify(name);
            if (key && !byName.has(key)) byName.set(key, quote);
        }
    }
    return { bySymbol, byName };
});

async function loadMetalQuotes(): Promise<Map<string, Quote>> {
    const tickers = [...new Set(Object.values(METAL_TICKERS))];
    const result = await runScannerQuery({
        market: 'global',
        columns: ['close', 'change'],
        tickers,
    });

    const byTicker = new Map<string, Quote>();
    for (const row of result.rows) {
        byTicker.set(row.ticker, {
            price: numberOrNull(row.values.close),
            changePercent: numberOrNull(row.values.change),
            volume24h: null,
            marketCap: null,
        });
    }
    return byTicker;
}

// ------------------------------------------------------------------ CoinGecko

async function fetchCoinGeckoQuotes(ids: readonly string[]): Promise<Map<string, Quote>> {
    const quotes = new Map<string, Quote>();
    if (ids.length === 0) return quotes;

    // `/coins/markets` returns price, cap, volume and 24h change in one call.
    for (let offset = 0; offset < ids.length; offset += 250) {
        if (offset > 0) await new Promise(resolve => setTimeout(resolve, 1_500));
        const batch = ids.slice(offset, offset + 250);
        const url =
            `${COINGECKO_BASE_URL}/coins/markets?vs_currency=usd&per_page=250&page=1` +
            `&ids=${encodeURIComponent(batch.join(','))}`;

        const res = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(30_000),
            cache: 'no-store',
        });
        if (!res.ok) {
            console.warn(`[curated-fallback] CoinGecko markets HTTP ${res.status}`);
            continue;
        }

        const rows = (await res.json()) as Record<string, unknown>[];
        for (const row of rows) {
            const id = stringOrNull(row.id);
            if (!id) continue;
            quotes.set(id, {
                price: numberOrNull(row.current_price),
                changePercent: numberOrNull(row.price_change_percentage_24h),
                volume24h: numberOrNull(row.total_volume),
                marketCap: numberOrNull(row.market_cap),
            });
        }
    }
    return quotes;
}

/**
 * CoinGecko's keyless tier rate-limits aggressively, and the homepage renders
 * every curated tab at once. Resolving and fetching all lists together — behind
 * one cache entry that also collapses concurrent callers — keeps a full page
 * render at a couple of upstream calls instead of one burst per tab.
 */
const loadCoinGeckoQuotes = withTtl(
    60_000,
    async (): Promise<{ quotes: Map<string, Quote>; idsByAsset: Map<string, string> }> => {
        const index = await loadCoinGeckoIndex();

        const idsByAsset = new Map<string, string>();
        for (const listId of CURATED_LIST_ORDER) {
            for (const asset of resolveCuratedAssets(listId)) {
                if (idsByAsset.has(asset.assetId)) continue;
                const id = resolveCoinGeckoId(asset, index);
                if (id) idsByAsset.set(asset.assetId, id);
            }
        }

        const quotes = await fetchCoinGeckoQuotes([...new Set(idsByAsset.values())]);
        return { quotes, idsByAsset };
    },
);

// ------------------------------------------------------------------ Resolution

function resolveCuratedAssets(listId: CuratedTokenListId): CuratedAsset[] {
    const list = getCuratedTokenList(listId) as { addresses?: string[] } | undefined;
    const mints = list?.addresses ?? [];

    const seen = new Set<string>();
    const assets: CuratedAsset[] = [];

    for (const mint of mints) {
        const match = getVariantByMint(mint) as
            | {
                  asset?: {
                      assetId?: string;
                      symbol?: string;
                      name?: string;
                      aliases?: string[];
                      coingeckoId?: string;
                      category?: string;
                  };
                  variant?: { symbol?: string; name?: string };
              }
            | undefined;

        const asset = match?.asset;
        const assetId = stringOrNull(asset?.assetId);
        if (!assetId || seen.has(assetId)) continue;
        seen.add(assetId);

        const symbol = stringOrNull(asset?.symbol) ?? stringOrNull(match?.variant?.symbol) ?? '';
        const name = stringOrNull(asset?.name) ?? stringOrNull(match?.variant?.name);
        assets.push({
            mint,
            assetId,
            symbol,
            name: name ?? (symbol || assetId),
            aliases: asset?.aliases ?? [],
            coingeckoId: stringOrNull(asset?.coingeckoId),
            category: stringOrNull(asset?.category),
            unnamed: !name && !symbol,
        });
    }

    return assets;
}

function resolveScreenerQuote(asset: CuratedAsset, index: ScreenerIndex): Quote | null {
    const override = SYMBOL_OVERRIDES[asset.assetId];
    if (override) {
        const hit = index.bySymbol.get(override);
        if (hit) return hit;
    }

    const symbol = asset.symbol.toUpperCase();
    if (symbol) {
        const hit = index.bySymbol.get(symbol);
        if (hit) return hit;
    }

    for (const alias of asset.aliases) {
        const upper = alias.toUpperCase();
        if (upper.length <= 6) {
            const hit = index.bySymbol.get(upper);
            if (hit) return hit;
        }
    }

    const byName = index.byName.get(asset.assetId);
    if (byName) return byName;

    // Registry names are shorter or longer than the exchange's legal name in
    // both directions: `abbott` -> "Abbott Laboratories", but also
    // `arm-holdings-plc` -> "Arm Holdings". Accept either as a prefix.
    for (const [name, quote] of index.byName) {
        if (name.startsWith(`${asset.assetId}-`) || asset.assetId.startsWith(`${name}-`)) {
            return quote;
        }
    }

    return null;
}

/**
 * Screener-first for listed instruments, CoinGecko-first for on-chain assets.
 *
 * Metals belong to the screener side: their registry symbols (`COPPER`,
 * `METALS`) collide with unrelated meme tokens on CoinGecko, which quoted
 * copper at $7.08e-6. Spot benchmarks are authoritative and collision-free.
 */
function prefersScreener(listId: CuratedTokenListId): boolean {
    return listId === 'etfs' || listId === 'stocks' || listId === 'metals';
}

function toToken(asset: CuratedAsset, quote: Quote | null): Token {
    return {
        assetId: asset.assetId,
        ...(asset.category ? { category: asset.category } : {}),
        address: asset.mint,
        name: asset.name,
        // Upper-casing the slug would render `ISHARES-CORE-SANDP-500-ETF`; the
        // mapped exchange ticker is both correct and what a table can show.
        symbol: asset.symbol || SYMBOL_OVERRIDES[asset.assetId] || asset.assetId.toUpperCase(),
        decimals: 0,
        liquidity: 0,
        volume24hUSD: quote?.volume24h ?? 0,
        price: quote?.price ?? 0,
        priceChange24hPercent: quote?.changePercent ?? 0,
        marketCap: quote?.marketCap ?? 0,
    } satisfies Token;
}

export async function fetchCuratedTokensFallback(listId: CuratedTokenListId): Promise<Token[]> {
    const assets = resolveCuratedAssets(listId);
    if (assets.length === 0) return [];

    const screenerFirst = prefersScreener(listId);

    const [screenerIndex, coinIndex, coingecko, metalQuotes] = await Promise.all([
        loadEquityIndex().catch(error => {
            console.warn('[curated-fallback] equity screener unavailable:', error);
            return null;
        }),
        loadCoinIndex().catch(error => {
            console.warn('[curated-fallback] coin screener unavailable:', error);
            return null;
        }),
        loadCoinGeckoQuotes().catch(error => {
            console.warn('[curated-fallback] CoinGecko unavailable:', error);
            return null;
        }),
        listId === 'metals'
            ? loadMetalQuotes().catch(() => new Map<string, Quote>())
            : Promise.resolve(new Map<string, Quote>()),
    ]);

    const coingeckoIds = coingecko?.idsByAsset ?? new Map<string, string>();
    const coingeckoQuotes = coingecko?.quotes ?? new Map<string, Quote>();

    function screenerQuote(asset: CuratedAsset): Quote | null {
        const metal = METAL_TICKERS[asset.assetId];
        if (metal) return metalQuotes.get(metal) ?? null;
        if (listId === 'metals') return null;

        for (const index of [screenerIndex, coinIndex]) {
            if (!index) continue;
            const hit = resolveScreenerQuote(asset, index);
            if (hit) return hit;
        }
        return null;
    }

    function coingeckoQuote(asset: CuratedAsset): Quote | null {
        const id = coingeckoIds.get(asset.assetId);
        return id ? (coingeckoQuotes.get(id) ?? null) : null;
    }

    let matched = 0;
    let dropped = 0;
    const tokens: Token[] = [];
    for (const asset of assets) {
        let quote: Quote | null;
        if (listId === 'metals') {
            // Spot benchmarks only. Every other route into this list resolves
            // by generic symbol, which is exactly what produced bogus quotes.
            quote = screenerQuote(asset);
        } else if (SYMBOL_OVERRIDES[asset.assetId]) {
            // A hand-mapped exchange ticker is authoritative. Letting CoinGecko
            // answer first here priced USFR and CLOI (both ~$50 bond ETFs) at
            // $0.337 off an unrelated coin that matched by name.
            quote = screenerQuote(asset) ?? coingeckoQuote(asset);
        } else if (screenerFirst) {
            quote = screenerQuote(asset) ?? coingeckoQuote(asset);
        } else {
            quote = coingeckoQuote(asset) ?? screenerQuote(asset);
        }
        if (quote) matched += 1;

        // A row with no name, no symbol and no price would render as a blank
        // placeholder. Named assets are kept even unpriced — they are real
        // holdings whose quote is merely missing.
        if (!quote && asset.unnamed) {
            dropped += 1;
            continue;
        }
        tokens.push(toToken(asset, quote));
    }

    const matchable = assets.length - assets.filter(a => a.unnamed).length;
    console.info(
        `[curated-fallback] ${listId}: ${matched}/${assets.length} priced ` +
            `(${matched}/${matchable} of named assets; ${dropped} unnamed rows dropped) ` +
            `via ${screenerFirst ? 'screener-first' : 'coingecko-first'}`,
    );

    // Rows without a price would otherwise sort above real data in the table.
    tokens.sort((a, b) => b.marketCap - a.marketCap || b.volume24hUSD - a.volume24hUSD);

    await attachLiquidity(listId, tokens);
    return tokens;
}

/**
 * Fills the liquidity column from on-chain DEX reserves.
 *
 * Only the top rows are looked up. GeckoTerminal takes 30 addresses per call
 * and its keyless tier is paced, so covering all ~600 curated mints would add
 * roughly half a minute to a cold homepage render. Sorting by market cap first
 * means the budget is spent on the rows actually visible; the remainder keeps
 * a null liquidity and the count is logged rather than passed off as zero.
 */
async function attachLiquidity(listId: CuratedTokenListId, tokens: Token[]): Promise<void> {
    const covered = tokens.slice(0, LIQUIDITY_LOOKUP_LIMIT);
    if (covered.length === 0) return;

    // Curated variants are Solana mints today; the lookup is chain-parameterised
    // so other networks drop in once the registry carries their addresses.
    const lookup = fetchTokenLiquidity('solana', covered.map(token => token.address));
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), LIQUIDITY_DEADLINE_MS));

    const result = await Promise.race([lookup, timeout]);
    if (!result) {
        console.info(`[curated-fallback] ${listId}: liquidity lookup exceeded its deadline, skipped`);
        return;
    }
    const { byAddress, missing } = result;

    let filled = 0;
    for (const token of covered) {
        const hit = byAddress.get(token.address.toLowerCase());
        if (hit?.liquidityUsd == null) continue;
        token.liquidity = hit.liquidityUsd;
        filled += 1;
    }

    const skipped = tokens.length - covered.length;
    console.info(
        `[curated-fallback] ${listId}: liquidity for ${filled}/${covered.length} looked-up rows` +
            (missing.length > 0 ? `, ${missing.length} unknown to the DEX indexer` : '') +
            (skipped > 0 ? `, ${skipped} rows below the lookup limit left unpriced` : ''),
    );
}
