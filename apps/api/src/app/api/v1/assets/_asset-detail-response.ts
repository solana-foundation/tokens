import type { CanonicalAsset, PrimaryVariantStrategy, StablecoinHealth, VariantKind } from '@tokens/asset-registry';
import { liquidityTierPriority } from '@tokens/asset-registry';

import type { AssetAdvisorySummaryEntry } from '@/lib/advisories';
import { toCompactPegHealth } from '@/lib/stablecoin-health';
import {
    computePreStocksDerived,
    optionalText,
    resolveVariantSymbol,
    withDerivedVariantTier,
    type TokenMarketSnapshot,
    type VariantExecutionQualitySnapshot,
} from './_asset-helpers';

export function isSpotKind(kind: VariantKind): boolean {
    return kind === 'native' || kind === 'wrapped' || kind === 'bridged' || kind === 'spot' || kind === 'stablecoin';
}

type CanonicalMarket =
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
          /** Underlying-company market cap (price × shares outstanding); equities only. */
          marketCap: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          lastFetchedAt: number | null;
          providerLastUpdatedAt: number | null;
          asOf: number | null;
      }
    | {
          source: 'prestocks';
          symbol: string;
          mint: string;
          /** Basis price the derived fields use: on-chain token price, falling back to the PreStocks token price. */
          price: number | null;
          /** Implied company valuation (markValuation × price ÷ markPrice) — NOT the tokenized float value. */
          marketCap: number | null;
          markPriceUsd: number | null;
          markValuationUsd: number | null;
          impliedValuationUsd: number | null;
          premiumToMarkPercent: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          lastFetchedAt: number | null;
          /** PreStocks provides no timestamp; mirrors our fetch time. */
          providerLastUpdatedAt: number | null;
          asOf: number | null;
      };

/** Raw PreStocks reference snapshot for one mint, as stored by the cron. */
export interface PreStocksMintSnapshot {
    symbol: string;
    markPriceUsd: number | null;
    markValuationUsd: number | null;
    tokenPriceUsd: number | null;
    lastFetchedAt: number;
}

export interface BuildAssetDetailResponseParams {
    /** Variants should already carry `advisory` (see `annotateAssetAdvisories`). */
    asset: CanonicalAsset;
    /**
     * `asset.advisories[]` — every flagged variant of the asset, including
     * ones a caller hid. Defaults to `[]`; the key is always emitted.
     */
    advisories?: AssetAdvisorySummaryEntry[];
    /**
     * Mint -> Webacy stablecoin health. Only read when `asset.category ===
     * 'stablecoin'`; those assets always emit `pegHealth` (compact, `null` when
     * the mint has no entry) on every variant row and on `primaryVariant`.
     * Non-stablecoin assets never carry the key.
     */
    stablecoinHealthByMint?: ReadonlyMap<string, StablecoinHealth>;
    assetDescription?: string | null;
    primaryVariant: CanonicalAsset['variants'][number] | null;
    token: TokenMarketSnapshot | undefined;
    tokenByMint: Map<string, TokenMarketSnapshot>;
    fillQualityByMint: Map<string, VariantExecutionQualitySnapshot>;
    marketMeta: { lastFetchedAt: number } | undefined;
    marketMetaByMint: Map<string, { lastFetchedAt: number }>;
    effectiveStats: unknown;
    imageUrl: string | null;
    symbols: string[];
    stockSymbol: string | null;
    canonicalMarket: CanonicalMarket | undefined;
    preStocksByMint?: Map<string, PreStocksMintSnapshot>;
    mintRank: Map<string, number>;
    sanctumActiveMints: Set<string> | null;
    includeMint: string | null;
    variantsMode: string;
    includesOut: Record<string, unknown>;
    hasIncludes: boolean;
    resolution?: {
        assetId: string;
        ref: string;
        resolvedBy: string;
        mint: string | null;
    };
    primaryVariantStrategy?: PrimaryVariantStrategy;
}

function buildVariantPreStocksBlock(
    snapshot: PreStocksMintSnapshot | undefined,
    onChainPriceUsd: number | null | undefined,
) {
    if (!snapshot) return null;
    const derived = computePreStocksDerived(snapshot, onChainPriceUsd);
    return {
        symbol: snapshot.symbol,
        markPriceUsd: snapshot.markPriceUsd,
        markValuationUsd: snapshot.markValuationUsd,
        impliedValuationUsd: derived.impliedValuationUsd,
        premiumToMarkPercent: derived.premiumToMarkPercent,
        lastFetchedAt: snapshot.lastFetchedAt,
    };
}

export function buildAssetDetailResponse(params: BuildAssetDetailResponseParams) {
    const responseAssetSymbol = params.stockSymbol ?? params.asset.symbol;
    const responseSymbols = params.stockSymbol
        ? Array.from(new Set([params.stockSymbol, ...params.symbols].map(symbol => symbol.trim()).filter(Boolean)))
        : params.symbols;

    // Stablecoin identity is the canonical category (never `variant.kind`: the
    // `usd` group's variants are `native` / `yield`).
    const isStablecoinAsset = params.asset.category === 'stablecoin';
    const pegHealthBlock = (mint: string) =>
        isStablecoinAsset
            ? { pegHealth: toCompactPegHealth(params.stablecoinHealthByMint?.get(mint)?.pegHealth ?? null) }
            : {};

    const variantsWithMarket = params.asset.variants.map(variant => {
        const token = params.tokenByMint.get(variant.mint);
        const executionQuality = params.fillQualityByMint.get(variant.mint) ?? null;
        const marketMeta = params.marketMetaByMint.get(variant.mint);

        const variantSymbol = resolveVariantSymbol({
            variantSymbol: variant.symbol,
            marketSymbol: token?.symbol,
            label: variant.label,
            canonicalSymbol: responseAssetSymbol,
        });
        const variantName =
            optionalText(variant.name) ?? optionalText(token?.name) ?? optionalText(variant.label) ?? variantSymbol;

        const market = token
            ? {
                  ...(token.source ? { source: token.source } : {}),
                  ...(token.metricsSource ? { metricsSource: token.metricsSource } : {}),
                  price: token.price,
                  liquidity: token.liquidity,
                  volume1hUSD: token.volume1hUSD ?? null,
                  volume24hUSD: token.volume24hUSD,
                  trade1h: token.trade1h ?? null,
                  trade24h: token.trade24h ?? null,
                  uniqueWallet1h: token.uniqueWallet1h ?? null,
                  uniqueWallet24h: token.uniqueWallet24h ?? null,
                  marketCap: token.marketCap,
                  fdv: token.fdv,
                  holder: token.holder,
                  totalSupply: token.totalSupply,
                  circulatingSupply: token.circulatingSupply,
                  priceChange24hPercent: token.priceChange24hPercent,
                  priceChange1hPercent: token.priceChange1hPercent,
                  decimals: token.decimals,
                  logoURI: token.logoURI ?? null,
                  lastTradeAt: token.lastTradeAt ?? null,
                  asOf: token.asOf ?? null,
                  lastFetchedAt: marketMeta ? marketMeta.lastFetchedAt : null,
              }
            : null;

        const preStocks = buildVariantPreStocksBlock(params.preStocksByMint?.get(variant.mint), token?.price);

        return withDerivedVariantTier(
            {
                ...variant,
                ...(variantSymbol ? { symbol: variantSymbol } : {}),
                ...(variantName ? { name: variantName } : {}),
                market,
                executionQuality,
                ...pegHealthBlock(variant.mint),
                ...(preStocks ? { preStocks } : {}),
            },
            market?.liquidity,
        );
    });

    type VariantWithMaybeMarket = (typeof variantsWithMarket)[number];

    const getLiquidity = (variant: VariantWithMaybeMarket): number => {
        const value = variant.market?.liquidity;
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };
    const getVolume = (variant: VariantWithMaybeMarket): number => {
        const value = variant.market?.volume24hUSD;
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };
    const getRank = (mint: string): number => params.mintRank.get(mint) ?? Number.POSITIVE_INFINITY;
    const compareVariants = (a: VariantWithMaybeMarket, b: VariantWithMaybeMarket): number => {
        const liquidityDelta = getLiquidity(b) - getLiquidity(a);
        if (liquidityDelta !== 0) return liquidityDelta;

        const trustDelta = liquidityTierPriority(b.liquidityTier) - liquidityTierPriority(a.liquidityTier);
        if (trustDelta !== 0) return trustDelta;

        const volumeDelta = getVolume(b) - getVolume(a);
        if (volumeDelta !== 0) return volumeDelta;

        const rankDelta = getRank(a.mint) - getRank(b.mint);
        if (rankDelta !== 0) return rankDelta;

        return a.mint.localeCompare(b.mint);
    };

    const rankedVariants = variantsWithMarket.slice().sort(compareVariants);
    const rankByMint = new Map(rankedVariants.map((v, idx) => [v.mint, idx] as const));

    let variantGroups = {
        spot: rankedVariants.filter(v => isSpotKind(v.kind)).map(v => ({ ...v, rank: rankByMint.get(v.mint) ?? 0 })),
        etf: rankedVariants.filter(v => v.kind === 'etf').map(v => ({ ...v, rank: rankByMint.get(v.mint) ?? 0 })),
        yield: rankedVariants
            .filter(v => v.kind === 'yield' && (!params.sanctumActiveMints || params.sanctumActiveMints.has(v.mint)))
            .map(v => ({ ...v, rank: rankByMint.get(v.mint) ?? 0 })),
        leveraged: rankedVariants
            .filter(v => v.kind === 'leveraged')
            .map(v => ({ ...v, rank: rankByMint.get(v.mint) ?? 0 })),
        basket: rankedVariants.filter(v => v.kind === 'basket').map(v => ({ ...v, rank: rankByMint.get(v.mint) ?? 0 })),
        lst: rankedVariants.filter(v => v.kind === 'lst').map(v => ({ ...v, rank: rankByMint.get(v.mint) ?? 0 })),
        tokenizedEquity: rankedVariants
            .filter(v => v.kind === 'tokenized_equity')
            .map(v => ({ ...v, rank: rankByMint.get(v.mint) ?? 0 })),
    };

    if (params.asset.assetId === 'solana' && params.variantsMode !== 'all') {
        const SOLANA_YIELD_MIN_LIQUIDITY_USD = 250_000;
        const SOLANA_YIELD_MAX = 500;
        const yieldRows = variantGroups.yield;
        const getYieldLiquidity = (row: (typeof yieldRows)[number]): number => {
            const liq = row.market?.liquidity ?? 0;
            return typeof liq === 'number' && Number.isFinite(liq) ? liq : 0;
        };

        const pinnedMint = params.includeMint;
        const pinnedRow =
            pinnedMint && yieldRows.some(r => r.mint === pinnedMint)
                ? (yieldRows.find(r => r.mint === pinnedMint) ?? null)
                : null;

        const eligible = yieldRows.filter(
            r => r.mint === pinnedMint || getYieldLiquidity(r) >= SOLANA_YIELD_MIN_LIQUIDITY_USD,
        );
        let capped = eligible;
        if (capped.length > SOLANA_YIELD_MAX) capped = capped.slice(0, SOLANA_YIELD_MAX);

        if (pinnedRow && !capped.some(r => r.mint === pinnedRow.mint)) {
            capped = [...capped.slice(0, Math.max(0, SOLANA_YIELD_MAX - 1)), pinnedRow];
        }

        variantGroups = { ...variantGroups, yield: capped };
    }

    const primaryVariantSymbol = resolveVariantSymbol({
        variantSymbol: params.primaryVariant?.symbol,
        marketSymbol: params.token?.symbol,
        label: params.primaryVariant?.label,
        canonicalSymbol: responseAssetSymbol,
    });
    const primaryVariantName =
        optionalText(params.primaryVariant?.name) ??
        optionalText(params.token?.name) ??
        optionalText(params.primaryVariant?.label) ??
        primaryVariantSymbol;
    const primaryMarket = params.token
        ? {
              ...(params.token.source ? { source: params.token.source } : {}),
              ...(params.token.metricsSource ? { metricsSource: params.token.metricsSource } : {}),
              price: params.token.price,
              liquidity: params.token.liquidity,
              volume1hUSD: params.token.volume1hUSD ?? null,
              volume24hUSD: params.token.volume24hUSD,
              trade1h: params.token.trade1h ?? null,
              trade24h: params.token.trade24h ?? null,
              uniqueWallet1h: params.token.uniqueWallet1h ?? null,
              uniqueWallet24h: params.token.uniqueWallet24h ?? null,
              marketCap: params.token.marketCap,
              fdv: params.token.fdv,
              holder: params.token.holder,
              totalSupply: params.token.totalSupply,
              circulatingSupply: params.token.circulatingSupply,
              priceChange24hPercent: params.token.priceChange24hPercent,
              priceChange1hPercent: params.token.priceChange1hPercent,
              decimals: params.token.decimals,
              logoURI: params.token.logoURI ?? null,
              lastTradeAt: params.token.lastTradeAt ?? null,
              asOf: params.token.asOf ?? null,
              lastFetchedAt: params.marketMeta ? params.marketMeta.lastFetchedAt : null,
          }
        : null;
    const primaryPreStocks = params.primaryVariant
        ? buildVariantPreStocksBlock(params.preStocksByMint?.get(params.primaryVariant.mint), params.token?.price)
        : null;

    return {
        asset: {
            assetId: params.asset.assetId,
            name: params.asset.name,
            symbol: responseAssetSymbol,
            ...(params.assetDescription ? { description: params.assetDescription } : {}),
            category: params.asset.category,
            aliases: params.asset.aliases,
            symbols: responseSymbols,
            imageUrl: params.imageUrl,
            stats: params.effectiveStats,
            primaryVariantStrategy: params.primaryVariantStrategy ?? 'liquidity',
            ...(params.canonicalMarket ? { canonicalMarket: params.canonicalMarket } : {}),
            advisories: params.advisories ?? [],
            variantGroups,
            primaryVariant: params.primaryVariant
                ? withDerivedVariantTier(
                      {
                          ...params.primaryVariant,
                          ...(rankByMint.has(params.primaryVariant.mint)
                              ? { rank: rankByMint.get(params.primaryVariant.mint) }
                              : {}),
                          ...(primaryVariantSymbol ? { symbol: primaryVariantSymbol } : {}),
                          ...(primaryVariantName ? { name: primaryVariantName } : {}),
                          market: primaryMarket,
                          executionQuality: params.fillQualityByMint.get(params.primaryVariant.mint) ?? null,
                          ...pegHealthBlock(params.primaryVariant.mint),
                          ...(primaryPreStocks ? { preStocks: primaryPreStocks } : {}),
                      },
                      primaryMarket?.liquidity,
                  )
                : null,
        },
        ...(params.hasIncludes ? { includes: params.includesOut } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
    };
}
