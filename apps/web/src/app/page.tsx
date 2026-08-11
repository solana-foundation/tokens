import type { Metadata } from 'next';
import { Suspense } from 'react';

import { HeroSearch } from '@/components/hero-search';
import { CategoryTabs, HighlightsSection, HomeTokensProvider } from '@/components/home';
import { SiteFooter } from '@/components/site-footer';
import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import { CURATED_LIST_ORDER_WITHOUT_LSTS, type CuratedTokenListIdWithoutLsts } from '@/lib/curated-token-lists';
import { createHomeHighlights, type HomeTabId } from '@/lib/home-highlights';
import { fetchCuratedTokensFallback } from '@/lib/market-data/curated-fallback';
import { getTokenLogoURLWithSecondarySymbol } from '@/lib/logo-overrides';
import type { Token } from '@/lib/types';
import { type CuratedTokenListId } from '@tokens/asset-registry/compat';
import { Skeleton } from '@tokens/ui/skeleton';

export const metadata: Metadata = {
    title: 'Tokens | Solana Liquidity & Token Aggregator',
    description:
        'Aggregate liquidity and token data across Solana DEXs. Find the best prices, analyze token metrics, and discover new opportunities.',
};

interface AssetMarketSnapshot {
    source?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    metricsSource?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    price: number | null;
    liquidity: number | null;
    volume5mUSD?: number | null;
    volume15mUSD?: number | null;
    volume1hUSD?: number | null;
    volume6hUSD?: number | null;
    volume24hUSD: number | null;
    trade5m?: number | null;
    trade15m?: number | null;
    trade1h?: number | null;
    trade6h?: number | null;
    trade24h?: number | null;
    uniqueWallet5m?: number | null;
    uniqueWallet1h?: number | null;
    uniqueWallet24h?: number | null;
    marketCap: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
    decimals: number | null;
    logoURI: string | null;
    // These may or may not be present depending on the endpoint/version.
    symbol?: string;
    name?: string;
    lastTradeAt?: number | null;
    asOf?: number | null;
    lastFetchedAt?: number | null;
}

interface AssetPrimaryVariant {
    mint: string;
    symbol?: string;
    name?: string;
    market?: AssetMarketSnapshot | null;
}

interface AssetStats {
    price: number | null;
    liquidity: number | null;
    volume24hUSD: number | null;
    marketCap: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
}

type CanonicalMarketSnapshot =
    | {
          source: 'coingecko';
          coinId: string;
          price: number | null;
          marketCap: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          lastFetchedAt: number | null;
          providerLastUpdatedAt: number | null;
      }
    | {
          source: 'clickhouse_stock';
          symbol: string;
          price: number | null;
          marketCap?: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          lastFetchedAt: number | null;
          providerLastUpdatedAt: number | null;
          asOf: number | null;
      };

interface AssetSearchResult {
    assetId: string;
    name?: string;
    symbol?: string;
    category?: string;
    imageUrl?: string | null;
    canonicalMarket?: CanonicalMarketSnapshot;
    stats?: AssetStats | null;
    primaryVariant: AssetPrimaryVariant | null;
}

interface AssetsCuratedResponse {
    listId: string;
    assets: AssetSearchResult[];
}

interface TrendingAssetResult {
    rank: number;
    assetId: string;
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    imageUrl: string | null;
    market: {
        source: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
        metricsSource: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
        price: number | null;
        liquidity?: number | null;
        volume5mUSD?: number | null;
        volume15mUSD?: number | null;
        volume1hUSD?: number | null;
        volume6hUSD?: number | null;
        volume24hUSD?: number | null;
        trade5m?: number | null;
        trade15m?: number | null;
        trade1h?: number | null;
        trade6h?: number | null;
        trade24h?: number | null;
        uniqueWallet5m?: number | null;
        uniqueWallet1h?: number | null;
        uniqueWallet24h?: number | null;
        priceChange1hPercent: number | null;
        priceChange24hPercent: number | null;
        lastTradeAt: number | null;
        asOf: number | null;
        lastFetchedAt?: number | null;
    };
    trending: {
        score: number;
        scoringVersion: string;
    };
}

interface AssetsTrendingResponse {
    trending: TrendingAssetResult[];
}

interface CuratedListMeta {
    id: CuratedTokenListIdWithoutLsts;
    name: string;
    count: number;
    lastAddedAssetId: string | null;
    lastAddedAt?: number | null;
}

function canonicalVolumeLabel(source: CanonicalMarketSnapshot['source'] | undefined): string | null {
    if (source === 'clickhouse_stock') return 'Stock';
    if (source === 'coingecko') return 'Canonical';
    return null;
}

function shouldShowCanonicalVolumePill(result: AssetSearchResult, canonicalMarket: CanonicalMarketSnapshot | null) {
    return canonicalMarket?.source === 'clickhouse_stock' || result.category === 'crypto';
}

function assetResultToToken(result: AssetSearchResult): Token | null {
    const primary = result.primaryVariant;
    const market = primary?.market;
    const stats = result.stats ?? null;
    const canonicalMarket = result.canonicalMarket ?? null;
    if (!primary) return null;

    function pickFinite(primary: number | null | undefined, fallback: number | null | undefined): number | null {
        const a = typeof primary === 'number' && Number.isFinite(primary) ? primary : null;
        if (a !== null) return a;
        const b = typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : null;
        return b;
    }

    function pickPositive(primary: number | null | undefined, fallback: number | null | undefined): number | null {
        const a = typeof primary === 'number' && Number.isFinite(primary) && primary > 0 ? primary : null;
        if (a !== null) return a;
        const b = typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0 ? fallback : null;
        return b;
    }

    // Prefer canonical identity (asset-level), then fall back to the primary mint.
    const symbol = (result.symbol ?? primary.symbol ?? market?.symbol ?? '').trim() || '—';
    const name = (result.name ?? primary.name ?? market?.name ?? symbol).trim() || symbol;
    const fallbackLogoURI = result.imageUrl ?? market?.logoURI ?? undefined;
    const marketSymbol = (market?.symbol ?? primary.symbol ?? '').trim() || undefined;
    const logoURI = getTokenLogoURLWithSecondarySymbol(symbol, marketSymbol, fallbackLogoURI);
    const priceChange1hPercent = pickFinite(market?.priceChange1hPercent, stats?.priceChange1hPercent);

    const canonicalPrice = pickPositive(canonicalMarket?.price, null);
    const canonicalPriceChange24h = pickFinite(canonicalMarket?.priceChange24hPercent, null);
    const isStockCanonical = canonicalMarket?.source === 'clickhouse_stock';
    const showCanonicalVolumePill = shouldShowCanonicalVolumePill(result, canonicalMarket);
    const underlyingVolume24hUSD =
        showCanonicalVolumePill && canonicalMarket ? pickPositive(canonicalMarket.volume24hUSD, null) : null;
    const underlyingVolume24hLabel =
        underlyingVolume24hUSD !== null ? canonicalVolumeLabel(canonicalMarket?.source) : null;
    const coingeckoId = canonicalMarket?.source === 'coingecko' ? canonicalMarket.coinId : null;

    return {
        assetId: result.assetId,
        ...(coingeckoId ? { coingeckoId } : {}),
        ...(result.category ? { category: result.category } : {}),
        ...(canonicalMarket?.source ? { canonicalMarketSource: canonicalMarket.source } : {}),
        address: primary.mint,
        ...(market?.source ? { source: market.source } : {}),
        ...(market?.metricsSource ? { metricsSource: market.metricsSource } : {}),
        symbol,
        name,
        decimals: market?.decimals ?? 9,
        ...(logoURI ? { logoURI } : {}),
        liquidity: pickPositive(stats?.liquidity, market?.liquidity) ?? 0,
        ...(market?.volume1hUSD != null ? { volume1hUSD: market.volume1hUSD } : {}),
        volume24hUSD: pickPositive(stats?.volume24hUSD, market?.volume24hUSD) ?? 0,
        ...(underlyingVolume24hUSD !== null ? { underlyingVolume24hUSD } : {}),
        ...(underlyingVolume24hLabel ? { underlyingVolume24hLabel } : {}),
        ...(market?.trade1h != null ? { trade1h: market.trade1h } : {}),
        ...(market?.trade24h != null ? { trade24h: market.trade24h } : {}),
        ...(market?.uniqueWallet1h != null ? { uniqueWallet1h: market.uniqueWallet1h } : {}),
        ...(market?.uniqueWallet24h != null ? { uniqueWallet24h: market.uniqueWallet24h } : {}),
        price: isStockCanonical
            ? (pickPositive(stats?.price, market?.price) ?? canonicalPrice ?? 0)
            : (canonicalPrice ?? pickPositive(market?.price, stats?.price) ?? 0),
        priceChange24hPercent: isStockCanonical
            ? (pickFinite(stats?.priceChange24hPercent, market?.priceChange24hPercent) ?? canonicalPriceChange24h ?? 0)
            : (canonicalPriceChange24h ?? pickFinite(market?.priceChange24hPercent, stats?.priceChange24hPercent) ?? 0),
        ...(priceChange1hPercent !== null ? { priceChange1hPercent } : {}),
        marketCap: isStockCanonical
            ? 0
            : (pickPositive(canonicalMarket?.marketCap, pickPositive(market?.marketCap, stats?.marketCap)) ?? 0),
        ...(market?.lastTradeAt != null ? { lastTradeAt: market.lastTradeAt } : {}),
        ...(market?.asOf != null ? { asOf: market.asOf } : {}),
    } satisfies Token;
}

function trendingResultToToken(result: TrendingAssetResult): Token {
    const market = result.market;
    const logoURI = (result.imageUrl ?? '').trim() || undefined;

    return {
        assetId: result.assetId,
        address: result.mint,
        source: market.source,
        metricsSource: market.metricsSource,
        symbol: result.symbol,
        name: result.name,
        decimals: result.decimals,
        ...(logoURI ? { logoURI } : {}),
        liquidity: market.liquidity ?? 0,
        ...(market.volume5mUSD != null ? { volume5mUSD: market.volume5mUSD } : {}),
        ...(market.volume15mUSD != null ? { volume15mUSD: market.volume15mUSD } : {}),
        ...(market.volume1hUSD != null ? { volume1hUSD: market.volume1hUSD } : {}),
        ...(market.volume6hUSD != null ? { volume6hUSD: market.volume6hUSD } : {}),
        volume24hUSD: market.volume24hUSD ?? 0,
        ...(market.trade5m != null ? { trade5m: market.trade5m } : {}),
        ...(market.trade15m != null ? { trade15m: market.trade15m } : {}),
        ...(market.trade1h != null ? { trade1h: market.trade1h } : {}),
        ...(market.trade6h != null ? { trade6h: market.trade6h } : {}),
        ...(market.trade24h != null ? { trade24h: market.trade24h } : {}),
        ...(market.uniqueWallet5m != null ? { uniqueWallet5m: market.uniqueWallet5m } : {}),
        ...(market.uniqueWallet1h != null ? { uniqueWallet1h: market.uniqueWallet1h } : {}),
        ...(market.uniqueWallet24h != null ? { uniqueWallet24h: market.uniqueWallet24h } : {}),
        price: market.price ?? 0,
        priceChange24hPercent: market.priceChange24hPercent ?? 0,
        ...(market.priceChange1hPercent != null ? { priceChange1hPercent: market.priceChange1hPercent } : {}),
        marketCap: 0,
        ...(market.lastTradeAt != null ? { lastTradeAt: market.lastTradeAt } : {}),
        ...(market.asOf != null ? { asOf: market.asOf } : {}),
        trendingRank: result.rank,
        trendingScore: result.trending.score,
    } satisfies Token;
}

async function fetchCuratedTokens(listId: CuratedTokenListId): Promise<Token[]> {
    const data = await fetchApiAppJsonOrNull<AssetsCuratedResponse>(
        `/api/v1/assets/curated?list=${encodeURIComponent(listId)}&groupBy=asset`,
        { next: { revalidate: 30 } },
    );

    // The platform API needs TOKENS_PLATFORM_API_KEY plus the Cloud Run/Postgres
    // stack behind it. Without them every tab renders empty, so fall back to
    // public market data keyed by symbol. Once the API answers, this is skipped.
    if (!data?.assets?.length) {
        return await fetchCuratedTokensFallback(listId);
    }

    const tokens = (data?.assets ?? []).map(assetResultToToken).filter((t): t is NonNullable<typeof t> => t !== null);
    const seen = new Set<string>();
    const unique: Token[] = [];
    for (const token of tokens) {
        const key = (token.assetId ?? '').trim() || token.address;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(token);
    }
    return unique;
}

async function fetchTrendingTokens(): Promise<Token[]> {
    const data = await fetchApiAppJsonOrNull<AssetsTrendingResponse>('/api/v1/assets/trending?limit=50&mode=fresh', {
        next: { revalidate: 15 },
    });

    return (data?.trending ?? []).map(trendingResultToToken);
}

interface HomePageProps {
    searchParams?: Promise<{
        category?: string | string[] | undefined;
    }>;
}

export default function Home({ searchParams }: HomePageProps) {
    return (
        <main className="min-h-dvh space-y-12 bg-white relative overflow-x-hidden">
            <div className="absolute inset-x-0 top-0 h-[600px] bg-gradient-to-b from-gray-1400/5 to-transparent pointer-events-none" />
            <section className="mx-auto max-w-7xl px-6 pt-28 mt-12 pb-12">
                <div className="mx-auto max-w-4xl text-center text-pretty">
                    <h1 className="text-balance text-[44px] leading-[1.02] md:text-[54px] font-medium text-text-extra-high">
                        Tokens on Solana
                    </h1>
                </div>

                <div className="mt-10">
                    <HeroSearch />
                </div>
            </section>

            <Suspense fallback={<HomeTokensFallback />}>
                <HomeTokensSection searchParams={searchParams} />
            </Suspense>

            <section className="border-t border-gray-1400/10">
                <div className="mx-auto max-w-[1120px] px-6 pb-10">
                    <SiteFooter tone="light" />
                </div>
            </section>
        </main>
    );
}

/**
 * Streams in behind the static shell: the searchParams read and all upstream fetches
 * (list meta, every curated list, and trending when it is the initial tab) happen here
 * so the hero/search chrome can prerender and flush immediately while this suspends.
 */
async function HomeTokensSection({ searchParams }: { searchParams: HomePageProps['searchParams'] }) {
    const resolvedSearchParams = (await searchParams) ?? {};
    const rawCategoryParam = resolvedSearchParams.category;
    const categoryParam = Array.isArray(rawCategoryParam) ? rawCategoryParam[0] : rawCategoryParam;
    const normalizedCategoryParam = categoryParam === 'stables' ? 'currencies' : categoryParam;
    const requestedCategoryId: HomeTabId | null =
        normalizedCategoryParam === 'trending'
            ? 'trending'
            : normalizedCategoryParam &&
                CURATED_LIST_ORDER_WITHOUT_LSTS.includes(normalizedCategoryParam as CuratedTokenListIdWithoutLsts)
              ? (normalizedCategoryParam as CuratedTokenListIdWithoutLsts)
              : null;

    // The rendered category ids always come from CURATED_LIST_ORDER_WITHOUT_LSTS (the
    // upstream list meta only customizes display names), so the default is synchronous.
    const defaultCategoryId: CuratedTokenListIdWithoutLsts = CURATED_LIST_ORDER_WITHOUT_LSTS.includes('majors')
        ? 'majors'
        : (CURATED_LIST_ORDER_WITHOUT_LSTS[0] ?? 'majors');
    const initialCategoryId: HomeTabId = requestedCategoryId ?? defaultCategoryId;

    const meta = await fetchApiAppJsonOrNull<CuratedListMeta[]>(`/api/v1/assets/curated/lists`, {
        next: { revalidate: 60 },
    });

    const categories: Array<{ id: CuratedTokenListIdWithoutLsts; name: string }> =
        meta && Array.isArray(meta) && meta.length > 0
            ? CURATED_LIST_ORDER_WITHOUT_LSTS.map(id => {
                  const row = meta.find(r => r.id === id);
                  return {
                      id,
                      name: row?.name ?? id,
                  };
              })
            : CURATED_LIST_ORDER_WITHOUT_LSTS.map(id => ({ id, name: id }));

    // Global highlight pool: every curated asset across all home lists, deduped.
    // Highlights are intentionally independent of the selected tab.
    const allListTokens = await Promise.all(CURATED_LIST_ORDER_WITHOUT_LSTS.map(listId => fetchCuratedTokens(listId)));
    const globalTokens: Token[] = [];
    const seenGlobalKeys = new Set<string>();
    for (const listTokens of allListTokens) {
        for (const token of listTokens) {
            const key = (token.assetId ?? '').trim() || token.address;
            if (seenGlobalKeys.has(key)) continue;
            seenGlobalKeys.add(key);
            globalTokens.push(token);
        }
    }

    // Latest added across ALL lists: the list meta row with the newest lastAddedAt wins.
    const metaRows = meta && Array.isArray(meta) ? meta : [];
    const latestAddedRow = metaRows.reduce<CuratedListMeta | null>((best, row) => {
        if (!row.lastAddedAssetId) return best;
        if (!best) return row;
        return (row.lastAddedAt ?? 0) > (best.lastAddedAt ?? 0) ? row : best;
    }, null);
    const highlights = createHomeHighlights(globalTokens, latestAddedRow?.lastAddedAssetId ?? null);

    const initialTokens =
        initialCategoryId === 'trending'
            ? await fetchTrendingTokens()
            : (allListTokens[CURATED_LIST_ORDER_WITHOUT_LSTS.indexOf(initialCategoryId)] ?? []);

    return (
        <>
            <HighlightsSection cards={highlights} />

            <HomeTokensProvider
                categories={[...categories, { id: 'trending', name: 'Trending' }]}
                initialCategoryId={initialCategoryId}
                initialTokens={initialTokens}
            >
                <CategoryTabs />
            </HomeTokensProvider>
        </>
    );
}

/**
 * Suspense fallback matching the streamed region's footprint (highlight cards, the
 * category-tab pill row, and the token table with its 64px rows) so the swap to real
 * content does not shift layout.
 */
function HomeTokensFallback() {
    return (
        <>
            {/* Highlights: three stat cards (chart + token row). */}
            <section className="mx-auto max-w-7xl px-6 pb-10 md:pb-12">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {Array.from({ length: 3 }, (_, index) => (
                        <div key={index} className="rounded-[22px] bg-border-light/30">
                            <div className="p-3 pl-[24px] py-[10px] pb-0">
                                <Skeleton className="h-[15px] w-36 bg-gray-100" />
                            </div>
                            <div className="mt-3 rounded-[22px] border border-border-medium bg-white p-[24px]">
                                <Skeleton className="h-32 w-full rounded-sm bg-gray-100" />
                                <div className="mt-1 flex items-center justify-between gap-3">
                                    <div className="flex min-w-0 items-center gap-2.5">
                                        <Skeleton className="size-6.5 shrink-0 rounded-full bg-gray-100" />
                                        <Skeleton className="h-[22px] w-28 bg-gray-100" />
                                    </div>
                                    <Skeleton className="h-[18px] w-16 shrink-0 bg-gray-100" />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* Category tabs + token table. */}
            <div>
                <div className="mx-auto max-w-7xl px-4 md:px-6">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-hidden pb-2 -mb-2">
                            {Array.from({ length: CURATED_LIST_ORDER_WITHOUT_LSTS.length + 1 }, (_, index) => (
                                <Skeleton key={index} className="h-10 w-24 shrink-0 rounded-full bg-gray-100" />
                            ))}
                        </div>
                    </div>
                </div>

                <section className="mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24">
                    <div className="bg-white rounded-[24px] md:rounded-[32px] border border-border-medium shadow-[0_8px_40px_rgba(0,0,0,0.03)] overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="border-b border-border-extra-light bg-gray-50/80">
                                        {Array.from({ length: 6 }, (_, index) => (
                                            <th
                                                key={index}
                                                className={`py-3 bg-gray-50/80 border-b border-border-light ${
                                                    index === 0
                                                        ? 'pl-4 md:pl-8 pr-4'
                                                        : index === 5
                                                          ? 'pl-6 pr-4 md:pr-8 text-right'
                                                          : 'px-3 md:px-6'
                                                }`}
                                            >
                                                <Skeleton className="h-4 w-16 md:w-20 bg-gray-100 rounded" />
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border-extra-light">
                                    {Array.from({ length: 8 }, (_, rowIndex) => (
                                        // py-4 + the 32px logo makes each row 64px tall,
                                        // matching TOKEN_TABLE_ROW_HEIGHT in token-table.tsx.
                                        <tr key={rowIndex}>
                                            <td className="py-4 pl-4 md:pl-8 pr-4">
                                                <div className="flex items-center gap-3 md:gap-4">
                                                    <Skeleton className="h-8 w-8 rounded-full bg-gray-100" />
                                                    <div className="space-y-2">
                                                        <Skeleton className="h-4 w-24 md:w-40 bg-gray-100" />
                                                        <Skeleton className="h-3 w-16 md:w-20 bg-gray-100" />
                                                    </div>
                                                </div>
                                            </td>
                                            {Array.from({ length: 5 }, (_, colIndex) => (
                                                <td
                                                    key={colIndex}
                                                    className={
                                                        colIndex === 4 ? 'py-4 pl-6 pr-4 md:pr-8' : 'py-4 px-3 md:px-6'
                                                    }
                                                >
                                                    <Skeleton className="h-4 w-16 md:w-24 bg-gray-100 ml-auto" />
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>
            </div>
        </>
    );
}

