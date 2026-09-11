import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { decodeLimit, decodeOffset } from '@tokens/effect';
import {
    freshTrendingMarketsList,
    trendingMarketsList,
    type FreshTrendingMarketsListResult,
    type TrendingMarketsListResult,
} from '@/lib/cloudrun';
import { loadAdvisoriesOrEmpty } from '@/lib/advisories';
import { getTokenLogoURLForMint } from '@/lib/logo-overrides';
import { getVariantByMint, type VariantAdvisory } from '@tokens/asset-registry';
import { resolveVariantSymbol } from '../_asset-helpers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ASSET_CATEGORIES = new Set(['crypto', 'stablecoin', 'lst', 'rwa', 'commodity', 'equity', 'etf', 'index']);

type AssetCategory = 'crypto' | 'stablecoin' | 'lst' | 'rwa' | 'commodity' | 'equity' | 'etf' | 'index';
type TrendingMode = 'fresh' | 'flow';
type MarketSource = 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
type FlowTrendingListResult = TrendingMarketsListResult;
type FreshTrendingListResult = FreshTrendingMarketsListResult;
type FlowTrendingRow = FlowTrendingListResult['rows'][number];
type FreshTrendingRow = FreshTrendingListResult['rows'][number];

interface SharedTrendingRow {
    rank: number;
    assetId: string;
    mint: string;
    symbol: string;
    name: string;
    decimals?: number;
    category: AssetCategory;
    logoURI?: string;
}

function parseCategory(value: string | null): AssetCategory | undefined {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return undefined;
    return ASSET_CATEGORIES.has(trimmed) ? (trimmed as AssetCategory) : undefined;
}

function parseMode(value: string | null): TrendingMode {
    return value === 'flow' ? 'flow' : 'fresh';
}

function absolutizeLogoUrl(request: Request, value: string | null | undefined): string | null {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('/logos/')) return new URL(trimmed.replace(/\.svg$/i, '.png'), request.url).toString();

    try {
        const parsed = new URL(trimmed);
        if (parsed.origin === new URL(request.url).origin && parsed.pathname.startsWith('/logos/')) {
            return new URL(parsed.pathname.replace(/\.svg$/i, '.png'), request.url).toString();
        }
    } catch {
        // Keep non-URL values as-is.
    }

    return trimmed;
}

function getXstockSymbolFromLogoUrl(value: string | null | undefined): string | null {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;

    const match = trimmed.match(/\/logos\/xstocks\/([^/?#]+)\.png(?:[?#].*)?$/i);
    if (!match?.[1]) return null;

    const symbol = match[1].replace(/-\d+$/i, '');
    return symbol.endsWith('x') ? symbol : null;
}

function getCanonicalSymbolFromXstockSymbol(value: string | null | undefined): string | null {
    const trimmed = (value ?? '').trim();
    if (!trimmed.toLowerCase().endsWith('x')) return null;
    return trimmed.slice(0, -1) || null;
}

function pickFullerText(primary: string | null | undefined, fallback: string | null | undefined): string {
    const primaryText = (primary ?? '').trim();
    const fallbackText = (fallback ?? '').trim();
    if (!primaryText) return fallbackText;
    if (!fallbackText) return primaryText;
    return primaryText.length >= fallbackText.length ? primaryText : fallbackText;
}

function includesText(haystack: string, needle: string): boolean {
    return haystack.toLowerCase().includes(needle.toLowerCase());
}

function displayVariantLabel(label: string): string {
    return label.replace(/\bBackpack Securities\b/gi, 'BP Securities');
}

function displayTrendingName(name: string): string {
    return name.replace(/\bBackpack Securities\b/gi, 'BP Securities');
}

function getRegistryDisplayName(registryMatch: ReturnType<typeof getVariantByMint>): string | undefined {
    if (!registryMatch) return undefined;

    const baseName = (registryMatch.variant.name ?? registryMatch.asset.name ?? '').trim();
    const variantLabel = displayVariantLabel((registryMatch.variant.label ?? '').trim());
    if (baseName && variantLabel && !includesText(baseName, variantLabel)) return `${baseName} - ${variantLabel}`;
    return baseName || variantLabel || undefined;
}

function buildBaseTrendingAsset(
    request: Request,
    row: SharedTrendingRow,
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>,
) {
    const registryMatch = getVariantByMint(row.mint);
    const logoSymbol = getXstockSymbolFromLogoUrl(row.logoURI);
    const canonicalSymbol = registryMatch?.asset.symbol ?? getCanonicalSymbolFromXstockSymbol(logoSymbol);
    const symbol =
        resolveVariantSymbol({
            variantSymbol: registryMatch?.variant.symbol,
            marketSymbol: row.symbol,
            label: registryMatch?.variant.label ?? row.symbol,
            canonicalSymbol,
        }) ??
        logoSymbol ??
        row.symbol;
    const registryName = getRegistryDisplayName(registryMatch);
    const name = displayTrendingName(pickFullerText(row.name, registryName));

    return {
        rank: row.rank,
        assetId: row.assetId,
        mint: row.mint,
        symbol,
        name,
        decimals: row.decimals ?? 9,
        category: row.category,
        imageUrl: absolutizeLogoUrl(
            request,
            row.logoURI ?? getTokenLogoURLForMint(row.mint, symbol, row.symbol) ?? null,
        ),
        // cloudrun-assets excludes compromised/blocked mints in SQL, so only a
        // `caution` advisory can appear here; the key is always present.
        advisory: advisoriesByMint.get(row.mint) ?? null,
    };
}

export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const category = parseCategory(url.searchParams.get('category'));
            const mode = parseMode(url.searchParams.get('mode'));
            const limit = yield* decodeLimit(url.searchParams.get('limit'), {
                defaultValue: '50',
                max: 50,
            });
            const offset = yield* decodeOffset(url.searchParams.get('offset'));

            const queryArgs = {
                ...(category ? { category } : {}),
                limit,
                offset,
            };

            const advisoriesByMint = yield* loadAdvisoriesOrEmpty();

            if (mode === 'flow') {
                const result = (yield* trendingMarketsList(queryArgs)) as FlowTrendingListResult;

                return {
                    trending: result.rows.map((row: FlowTrendingRow) => ({
                        ...buildBaseTrendingAsset(request, row, advisoriesByMint),
                        market: {
                            source: 'clickhouse_trades' as const,
                            metricsSource: 'clickhouse_trades' as const,
                            price: row.price ?? null,
                            volume5mUSD: row.volume5mUSD,
                            volume15mUSD: row.volume15mUSD,
                            volume1hUSD: row.volume1hUSD,
                            volume6hUSD: row.volume6hUSD,
                            volume24hUSD: row.volume24hUSD,
                            trade5m: row.trade5m,
                            trade15m: row.trade15m,
                            trade1h: row.trade1h,
                            trade6h: row.trade6h,
                            trade24h: row.trade24h,
                            uniqueWallet5m: row.uniqueWallet5m,
                            uniqueWallet1h: row.uniqueWallet1h,
                            uniqueWallet24h: row.uniqueWallet24h,
                            priceChange1hPercent: row.priceChange1hPercent ?? null,
                            priceChange24hPercent: row.priceChange24hPercent ?? null,
                            lastTradeAt: row.lastTradeAt ?? null,
                            asOf: row.asOf ?? null,
                        },
                        trending: {
                            score: row.trendingScore,
                            scoringVersion: row.scoringVersion,
                        },
                    })),
                    meta: {
                        limit,
                        offset,
                        total: result.total,
                        asOf: result.asOf,
                        scoringVersion: result.scoringVersion,
                        mode,
                    },
                };
            }

            const result = (yield* freshTrendingMarketsList(queryArgs)) as FreshTrendingListResult;

            return {
                trending: result.rows.map((row: FreshTrendingRow) => ({
                    ...buildBaseTrendingAsset(request, row, advisoriesByMint),
                    market: {
                        source: row.source as MarketSource,
                        metricsSource: (row.metricsSource ?? row.source) as MarketSource,
                        price: row.price ?? null,
                        liquidity: row.liquidity ?? null,
                        volume5mUSD: row.volume5mUSD ?? null,
                        volume15mUSD: row.volume15mUSD ?? null,
                        volume1hUSD: row.volume1hUSD ?? null,
                        volume6hUSD: row.volume6hUSD ?? null,
                        volume24hUSD: row.volume24hUSD ?? null,
                        trade5m: row.trade5m ?? null,
                        trade15m: row.trade15m ?? null,
                        trade1h: row.trade1h ?? null,
                        trade6h: row.trade6h ?? null,
                        trade24h: row.trade24h ?? null,
                        uniqueWallet5m: row.uniqueWallet5m ?? null,
                        uniqueWallet1h: row.uniqueWallet1h ?? null,
                        uniqueWallet24h: row.uniqueWallet24h ?? null,
                        priceChange1hPercent: row.priceChange1hPercent ?? null,
                        priceChange24hPercent: row.priceChange24hPercent ?? null,
                        lastTradeAt: row.lastTradeAt ?? null,
                        asOf: row.asOf ?? null,
                        lastFetchedAt: row.lastFetchedAt,
                    },
                    trending: {
                        score: row.trendingScore,
                        scoringVersion: row.scoringVersion,
                    },
                })),
                meta: {
                    limit,
                    offset,
                    total: result.total,
                    asOf: result.asOf,
                    scoringVersion: result.scoringVersion,
                    mode,
                },
            };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 30 } },
);
