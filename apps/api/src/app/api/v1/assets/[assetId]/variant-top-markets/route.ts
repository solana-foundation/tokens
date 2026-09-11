import { Array as Arr, Effect } from 'effect';

import { route } from '@/effect/next-route';
import { decodeLimit, decodeOffset } from '@tokens/effect';
import { BadRequestError, NotFoundError } from '@tokens/effect';
import { scheduleCacheWarm } from '@/lib/cloudrun/cacheWarm';
import { getByAssetId as cloudRunGetByAssetId } from '@/lib/cloudrun/assets';
import {
    assetVariantsListByAssetIds,
    sanctumListActive,
    tokenMarketsGetLatestByMints,
    variantMarketsGetLatestByMints,
} from '@/lib/cloudrun';
import { tapErrorAndDefault } from '@tokens/effect';
import { loadAdvisoriesOrEmpty } from '@/lib/advisories';
import type { TokenMarket, TokenMarketToken } from '@/lib/birdeye';
import { cleanTokenName, getTokenLogoURL } from '@/lib/logo-overrides';

import type { AssetVariant, CanonicalAsset, LiquidityTier } from '@tokens/asset-registry';
import { resolveAlias as resolveRegistryAlias } from '@tokens/asset-registry';

import { resolveAssetIdFromRef } from '../../_resolve-asset-ref';
import { singletonAssetIdToMint } from '../../_singleton-asset-id';
import { canonicalizeAssetVariants } from '../../_canonical-overrides';
import { optionalText, resolveVariantSymbol, withDerivedVariantTier } from '../../_asset-helpers';
import { POOL_PROTOCOL_TOKENS, getProtocolTokenFallback } from '../../_protocol-tokens';
import { DEFAULT_MARKETS_STALE_MS, EQUITY_MARKETS_STALE_MS } from '../../_market-cache';

function scheduleMarketsWarm(mint: string): Effect.Effect<void, never> {
    return scheduleCacheWarm(null, {
        mint,
        markets: true,
        variantMarket: false,
        ohlcv: false,
        minAgeMs: 0,
        label: 'assets.variantTopMarkets.scheduleWarm',
    });
}

export interface VariantTopMarketsResponse {
    assetId: string;
    total: number;
    offset: number;
    limit: number;
    variants: Array<{
        mint: string;
        kind: AssetVariant['kind'];
        liquidityTier: LiquidityTier;
        trustTier: AssetVariant['trustTier'];
        label?: string;
        stockVariantTier?: AssetVariant['stockVariantTier'];
        symbol?: string;
        name?: string;
        logoURI?: string;
        topMarket: TokenMarket | null;
        protocolToken?: TokenMarketToken;
        topMarkets?: Array<{
            market: TokenMarket;
            protocolToken?: TokenMarketToken;
        }>;
        marketsTotal: number | null;
        totalLiquidity: number | null;
        lastFetchedAt: number | null;
    }>;
    lastUpdatedAt: number | null;
}

function toFiniteOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isInactiveMarket(market: TokenMarket): boolean {
    return toFiniteOrZero(market.liquidity) <= 0 && toFiniteOrZero(market.volume24h) <= 0;
}

function sortMarketsByVolume(
    markets: readonly TokenMarket[],
    options: { includeInactive: boolean },
): TokenMarket[] {
    const rows = options.includeInactive ? markets : markets.filter(market => !isInactiveMarket(market));

    return rows
        .slice()
        .sort(
            (a, b) =>
                toFiniteOrZero(b.volume24h) - toFiniteOrZero(a.volume24h) ||
                toFiniteOrZero(b.liquidity) - toFiniteOrZero(a.liquidity) ||
                a.address.localeCompare(b.address),
        );
}

function sumMarketsLiquidity(markets: readonly TokenMarket[], options: { includeInactive: boolean }): number {
    const rows = options.includeInactive ? markets : markets.filter(market => !isInactiveMarket(market));

    return rows.reduce((sum, market) => sum + toFiniteOrZero(market.liquidity), 0);
}

export const GET = route(
    (request: Request, ctx: { params: Promise<{ assetId: string }> }) =>
        Effect.gen(function* () {
            const { assetId: rawAssetId } = yield* Effect.tryPromise(() => ctx.params);
            const assetRef = (rawAssetId ?? '').trim();
            if (!assetRef) return yield* Effect.fail(new BadRequestError({ message: 'assetId is required' }));

            const url = new URL(request.url);
            const offset = yield* decodeOffset(url.searchParams.get('offset'));
            const limit = yield* decodeLimit(url.searchParams.get('limit'), { defaultValue: '50', max: 100 });
            const variantsMode = (url.searchParams.get('variantsMode') ?? '').trim();

            const assetId = yield* resolveAssetIdFromRef(assetRef);
            const singletonMint = singletonAssetIdToMint(assetId);

            let outAssetId = assetId;
            let assetCategory: CanonicalAsset['category'] = 'crypto';
            let canonicalSymbol: string | null = null;
            let variants: CanonicalAsset['variants'] = [];

            if (singletonMint) {
                assetCategory = 'crypto';
                variants = [
                    {
                        variantId: `${assetId}:${singletonMint.slice(0, 8)}`,
                        mint: singletonMint,
                        kind: 'native',
                        trustTier: 'tier3',
                        tags: [],
                    },
                ];
            } else {
                const assetDoc = yield* cloudRunGetByAssetId({ assetId });
                if (!assetDoc) {
                    const registry = resolveRegistryAlias(assetId);
                    if (!registry) {
                        return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));
                    }

                    outAssetId = registry.assetId;
                    assetCategory = registry.category;
                    canonicalSymbol = optionalText(registry.symbol);
                    variants = registry.variants;
                } else {
                    outAssetId = assetDoc.assetId;
                    assetCategory = assetDoc.category;
                    canonicalSymbol = optionalText(assetDoc.symbol);
                    const variantsRows = yield* assetVariantsListByAssetIds({ assetIds: [assetDoc.assetId] });
                    const dbVariants = (variantsRows[0]?.variants ?? []) as unknown as AssetVariant[];
                    variants = canonicalizeAssetVariants(outAssetId, dbVariants);
                }
            }

            if (variants.length === 0) {
                const empty: VariantTopMarketsResponse = {
                    assetId: outAssetId,
                    total: 0,
                    offset,
                    limit,
                    variants: [],
                    lastUpdatedAt: null,
                };
                return empty;
            }

            const sanctumActiveMints =
                outAssetId === 'solana'
                    ? yield* sanctumListActive({ limit: 5000 })
                          .pipe(tapErrorAndDefault('assets.variantTopMarkets.sanctumLsts', [], { assetId: outAssetId }))
                          .pipe(
                              Effect.map((rows: Array<{ mint: string }>) =>
                                  rows.length > 0 ? new Set(rows.map(r => r.mint)) : null,
                              ),
                          )
                    : null;

            if (sanctumActiveMints) {
                variants = variants.filter(v => v.kind !== 'yield' || sanctumActiveMints.has(v.mint));
            }

            const allMints = variants.map(v => v.mint);
            const variantMarketRows = yield* variantMarketsGetLatestByMints({ mints: allMints });
            const variantMarketByMint = new Map<string, (typeof variantMarketRows)[number]['market']>();
            for (const row of variantMarketRows) variantMarketByMint.set(row.mint, row.market);

            // Solana can have a very large number of yield variants (LSTs). Cap the set by default.
            if (outAssetId === 'solana' && variantsMode !== 'all') {
                const SOLANA_YIELD_MIN_LIQUIDITY_USD = 250_000;
                const SOLANA_YIELD_MAX = 500;

                const yieldVariants = variants.filter(v => v.kind === 'yield');
                const nonYieldVariants = variants.filter(v => v.kind !== 'yield');

                const eligibleYield = yieldVariants
                    .map(v => {
                        const liq = variantMarketByMint.get(v.mint)?.liquidity ?? 0;
                        const liquidity = typeof liq === 'number' && Number.isFinite(liq) ? liq : 0;
                        return { v, liquidity };
                    })
                    .filter(row => row.liquidity >= SOLANA_YIELD_MIN_LIQUIDITY_USD)
                    .sort((a, b) => b.liquidity - a.liquidity)
                    .slice(0, SOLANA_YIELD_MAX)
                    .map(row => row.v);

                variants = [...nonYieldVariants, ...eligibleYield];
            }

            const mints = variants.map(v => v.mint);
            const mintChunks = Arr.chunksOf(mints, 50);
            const chunkRows = yield* Effect.all(
                mintChunks.map(chunk =>
                    tokenMarketsGetLatestByMints({ mints: chunk }),
                ),
                { concurrency: 2 },
            );
            const rows = chunkRows.flat();
            const byMint = new Map<string, (typeof rows)[number]>();
            for (const row of rows) byMint.set(row.mint, row);

            const now = Date.now();
            const marketStaleMs = assetCategory === 'equity' ? EQUITY_MARKETS_STALE_MS : DEFAULT_MARKETS_STALE_MS;
            const missingOrStale: string[] = [];

            for (const mint of mints) {
                const row = byMint.get(mint);
                const doc = row?.doc ?? null;
                const lastFetchedAt = doc?.lastFetchedAt ?? null;
                const isStale = lastFetchedAt === null || now - lastFetchedAt > marketStaleMs;
                const isMissing = !doc || doc.markets.length === 0;
                if (isMissing || isStale) missingOrStale.push(mint);
            }

            if (missingOrStale.length > 0) {
                yield* Effect.all(
                    missingOrStale.slice(0, 5).map(mint => scheduleMarketsWarm(mint)),
                    { concurrency: 2 },
                );
            }

            const protocolMints: string[] = [];
            const protocolConfigByMint = new Map<string, (typeof POOL_PROTOCOL_TOKENS)[number]>();
            const protocolMintByMarketAddress = new Map<string, string>();

            const topMarketsByMint = new Map<string, TokenMarket[]>();
            const MARKETS_PER_VARIANT = 5;
            const includeInactiveMarkets = assetCategory === 'equity';

            for (const row of rows) {
                const topMarkets = sortMarketsByVolume((row.doc?.markets ?? []) as TokenMarket[], {
                    includeInactive: includeInactiveMarkets,
                }).slice(0, MARKETS_PER_VARIANT);
                topMarketsByMint.set(row.mint, topMarkets);

                for (const market of topMarkets) {
                    if (!market.address) continue;

                    const config = market.source ? getProtocolTokenFallback(market.source) : null;
                    if (!config) continue;

                    protocolConfigByMint.set(config.address, config);
                    protocolMintByMarketAddress.set(market.address, config.address);
                    protocolMints.push(config.address);
                }
            }

            const uniqueProtocolMints = Array.from(new Set(protocolMints.map(m => m.trim()).filter(Boolean)));
            const protocolRows =
                uniqueProtocolMints.length > 0
                    ? yield* variantMarketsGetLatestByMints({ mints: uniqueProtocolMints })
                    : [];

            const protocolMarketByMint = new Map<string, (typeof protocolRows)[number]['market']>();
            for (const row of protocolRows) protocolMarketByMint.set(row.mint, row.market);

            const protocolTokenByMarketAddress = new Map<string, TokenMarketToken | undefined>();
            for (const [marketAddress, mint] of protocolMintByMarketAddress) {
                const fallback = protocolConfigByMint.get(mint);
                const market = protocolMarketByMint.get(mint) ?? null;

                const symbol = (market?.symbol ?? fallback?.symbol ?? '???').trim() || '???';
                const cleanedName = cleanTokenName(market?.name ?? fallback?.name ?? symbol);

                protocolTokenByMarketAddress.set(marketAddress, {
                    address: mint,
                    symbol,
                    name: cleanedName,
                    icon: getTokenLogoURL(symbol, market?.logoURI),
                });
            }

            let lastUpdatedAt: number | null = null;
            for (const row of rows) {
                const lastFetchedAt = row.doc?.lastFetchedAt ?? null;
                if (lastFetchedAt === null) continue;
                lastUpdatedAt = lastUpdatedAt === null ? lastFetchedAt : Math.max(lastUpdatedAt, lastFetchedAt);
            }

            const response: VariantTopMarketsResponse = {
                assetId: outAssetId,
                total: 0,
                offset,
                limit,
                variants: [],
                lastUpdatedAt,
            };

            const advisoriesByMint = yield* loadAdvisoriesOrEmpty();
            const enriched = variants.map(variant => {
                const row = byMint.get(variant.mint);
                const doc = row?.doc ?? null;
                const variantMarket = variantMarketByMint.get(variant.mint) ?? null;
                const variantSymbol =
                    resolveVariantSymbol({
                        variantSymbol: variant.symbol,
                        marketSymbol: variantMarket?.symbol,
                        label: variant.label,
                        canonicalSymbol,
                    }) ?? undefined;
                const variantName =
                    (variant.name ?? '').trim() ||
                    (variantMarket?.name ?? '').trim() ||
                    (variant.label ?? '').trim() ||
                    undefined;
                const variantLogoURI = (variantMarket?.logoURI ?? '').trim() || undefined;

                const topMarkets = topMarketsByMint.get(variant.mint) ?? [];
                const topMarket = topMarkets[0] ?? null;
                const variantLiquidity = toFiniteOrZero(variantMarket?.liquidity);
                const totalLiquidity = sumMarketsLiquidity((doc?.markets ?? []) as TokenMarket[], {
                    includeInactive: includeInactiveMarkets,
                });
                const protocolToken = topMarket
                    ? (protocolTokenByMarketAddress.get(topMarket.address) ?? undefined)
                    : undefined;
                const topMarketsWithProtocol = topMarkets.map(market => {
                    const marketProtocolToken = protocolTokenByMarketAddress.get(market.address) ?? undefined;
                    return {
                        market,
                        ...(marketProtocolToken ? { protocolToken: marketProtocolToken } : {}),
                    };
                });

                return withDerivedVariantTier(
                    {
                        mint: variant.mint,
                        kind: variant.kind,
                        advisory: advisoriesByMint.get(variant.mint) ?? null,
                        ...(variant.label ? { label: variant.label } : {}),
                        ...(variant.stockVariantTier ? { stockVariantTier: variant.stockVariantTier } : {}),
                        ...(variantSymbol ? { symbol: variantSymbol } : {}),
                        ...(variantName ? { name: variantName } : {}),
                        ...(variantLogoURI ? { logoURI: variantLogoURI } : {}),
                        topMarket,
                        ...(protocolToken ? { protocolToken } : {}),
                        ...(topMarketsWithProtocol.length > 0 ? { topMarkets: topMarketsWithProtocol } : {}),
                        marketsTotal: doc?.total ?? null,
                        totalLiquidity: variantLiquidity > 0 ? variantLiquidity : totalLiquidity > 0 ? totalLiquidity : null,
                        lastFetchedAt: doc?.lastFetchedAt ?? null,
                    },
                    variantMarket?.liquidity ?? null,
                );
            });

            const rowsWithMarket = enriched
                .filter(v => Boolean(v.topMarket))
                .sort((a, b) => {
                    const volumeDelta = (b.topMarket?.volume24h ?? 0) - (a.topMarket?.volume24h ?? 0);
                    if (volumeDelta !== 0) return volumeDelta;
                    const liquidityDelta = (b.topMarket?.liquidity ?? 0) - (a.topMarket?.liquidity ?? 0);
                    if (liquidityDelta !== 0) return liquidityDelta;
                    return a.mint.localeCompare(b.mint);
                });

            const total = rowsWithMarket.length;
            const page = rowsWithMarket.slice(offset, offset + limit);

            response.total = total;
            response.variants = page;

            return response;
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60 } },
);
