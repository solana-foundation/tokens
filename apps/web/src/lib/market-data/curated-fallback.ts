import 'server-only';

import { getVariantByMint } from '@tokens/asset-registry';
import { CURATED_LIST_ORDER, getCuratedTokenList, type CuratedTokenListId } from '@tokens/asset-registry/compat';
import type { Token } from '@/lib/types';
import { withTtl } from './cache';
import { loadCoinGeckoIndex, resolveCoinGeckoId, slugify } from './coingecko-index';
import { fetchCoinGeckoMarkets, type Quote } from './coingecko-markets';
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

/** GeckoTerminal's cap on addresses per multi-token call. */
const ONCHAIN_BATCH_SIZE = 30;

/**
 * How long a warmed on-chain sweep is trusted before another one starts. Kept
 * under GeckoTerminal's own 5-minute batch cache so a refresh finds fresh
 * upstream data rather than replaying the cached batches.
 */
const ONCHAIN_REFRESH_MS = 4 * 60_000;

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
        // The screener's `volume` is a share count, not a dollar amount. Passing
        // it straight through rendered NVDA's 180M traded shares as "$180.00M".
        // Multiplying by the last close is what turns it into traded value.
        const price = numberOrNull(row.values.close);
        const shares = numberOrNull(row.values.volume);
        const quote: Quote = {
            price,
            changePercent: numberOrNull(row.values.change),
            volume24h: price !== null && shares !== null ? price * shares : null,
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

/**
 * CoinGecko's keyless tier rate-limits aggressively, and the homepage renders
 * every curated tab at once. Resolving and fetching all lists together — behind
 * one cache entry that also collapses concurrent callers — keeps a full page
 * render at a couple of upstream calls instead of one burst per tab.
 *
 * Exported because the inline sparklines ride on the same batch: the OHLCV
 * route awaits this to make sure a series has been fetched before it looks one
 * up. See `coingecko-markets.ts`.
 */
export const loadCoinGeckoQuotes = withTtl(
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

        const quotes = await fetchCoinGeckoMarkets([...new Set(idsByAsset.values())]);
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
        liquidity: null,
        volume24hUSD: quote?.volume24h ?? 0,
        volume24hSource: 'canonical',
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

    attachOnChainMarket(listId, tokens);
    return tokens;
}

// ------------------------------------------------------------ On-chain market

interface OnChainMarket {
    liquidityUsd: number | null;
    volume24hUsd: number | null;
}

/** Lower-cased mint -> what the DEX indexer knows, filled by the sweep below. */
const onChainByAddress = new Map<string, OnChainMarket>();

/**
 * Reads every curated mint's DEX depth and traded volume into
 * `onChainByAddress`.
 *
 * This deliberately does not run on the render path. GeckoTerminal's keyless
 * tier serializes callers and paces them ~1.5s apart, so the six curated lists
 * used to queue behind each other and four of them routinely blew past their
 * five-second budget — which is why the column read $0.00 on a cold homepage.
 * One shared sweep, refreshed on a timer, keeps renders instant and converges
 * on full coverage instead of only the top rows of each list.
 *
 * `withTtl` both collapses concurrent callers onto one sweep and re-arms it
 * once the result ages out. It returns a count rather than nothing because an
 * `undefined` result would never satisfy its cache check.
 */
const warmOnChainMarkets = withTtl(ONCHAIN_REFRESH_MS, async (): Promise<number> => {
    // Curated variants are Solana mints today; the lookup is chain-parameterised
    // so other networks drop in once the registry carries their addresses.
    const addresses = [
        ...new Set(CURATED_LIST_ORDER.flatMap(listId => resolveCuratedAssets(listId).map(asset => asset.mint))),
    ];

    let filled = 0;
    for (let offset = 0; offset < addresses.length; offset += ONCHAIN_BATCH_SIZE) {
        const batch = addresses.slice(offset, offset + ONCHAIN_BATCH_SIZE);
        const { byAddress } = await fetchTokenLiquidity('solana', batch);
        // Written per batch rather than at the end: a sweep over ~600 mints
        // takes tens of seconds, and renders in between should see the part
        // that has already landed.
        for (const [address, market] of byAddress) {
            if (market.liquidityUsd == null && market.volume24hUsd == null) continue;
            onChainByAddress.set(address, {
                liquidityUsd: market.liquidityUsd,
                volume24hUsd: market.volume24hUsd,
            });
            filled += 1;
        }
    }

    console.info(`[curated-fallback] on-chain sweep: ${filled}/${addresses.length} mints known to the DEX indexer`);
    return filled;
});

/**
 * Overlays whatever the sweep has resolved so far, and makes sure a sweep is
 * running.
 *
 * The 24h volume column leads with the on-chain figure and keeps the wider
 * market's number as the secondary pill, matching how the platform API feeds
 * the same column: for a wrapped asset those are genuinely different facts —
 * cbBTC trades tens of millions on Solana while bitcoin itself trades tens of
 * billions, and collapsing them into one number hides the one the reader came
 * for. Rows the indexer does not know keep the canonical figure alone.
 */
function attachOnChainMarket(listId: CuratedTokenListId, tokens: Token[]): void {
    void warmOnChainMarkets().catch(error => {
        console.warn('[curated-fallback] on-chain sweep failed:', error);
    });

    let withLiquidity = 0;
    let withVolume = 0;
    for (const token of tokens) {
        const market = onChainByAddress.get(token.address.toLowerCase());
        if (!market) continue;

        if (market.liquidityUsd !== null) {
            token.liquidity = market.liquidityUsd;
            withLiquidity += 1;
        }
        if (market.volume24hUsd !== null) {
            if (token.volume24hUSD > 0) {
                token.underlyingVolume24hUSD = token.volume24hUSD;
                token.underlyingVolume24hLabel = 'Canonical';
            }
            token.volume24hUSD = market.volume24hUsd;
            token.volume24hSource = 'onchain';
            withVolume += 1;
        }
    }

    console.info(
        `[curated-fallback] ${listId}: on-chain liquidity for ${withLiquidity}/${tokens.length} rows, ` +
            `volume for ${withVolume}/${tokens.length}`,
    );
}
