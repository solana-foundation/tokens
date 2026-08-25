import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { COMPARISON_VERSION, QUOTE_PROVIDERS, summarizeComparison, type QuoteProvider } from '../evaluate/comparison';
import { serializeQuoteRows } from '../evaluate/serialize';
import {
    ROUTING_VERSION,
    type AllocationStatus,
    type ExecutionRouteResponse,
    type RoutedVariant,
} from './contract';
import { buildVariantCurve } from './curve';
import { buildProbeLadderUsd, selectVariants } from './variant-selection';
import {
    executionQuotesLive,
    variantFillQualityGetLatestByMints,
    variantMarketsGetLatestByMints,
} from '@/lib/cloudrun';
import { buildCuratedMintRank } from '@/app/api/v1/assets/_asset-helpers';
import { BadRequestError, NotFoundError } from '@tokens/effect';
import { getAsset, resolveAlias } from '@tokens/asset-registry';

const DEFAULT_TARGET_USD = 1_000_000;
const MIN_TARGET_USD = 1;
const MAX_TARGET_USD = 50_000_000;
const DEFAULT_MAX_VARIANTS = 4;
const MAX_MAX_VARIANTS = 6;

/** Editorial tiebreak for the registry ranking; computed once per deploy. */
const CURATED_MINT_RANK = buildCuratedMintRank();

function decodeTargetUsd(raw: string | null): Effect.Effect<number, BadRequestError> {
    if (raw === null || raw.trim() === '') return Effect.succeed(DEFAULT_TARGET_USD);
    const value = Number(raw.trim());
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
        return Effect.fail(new BadRequestError({ message: 'amountUsd must be a whole number of dollars' }));
    }
    if (value < MIN_TARGET_USD || value > MAX_TARGET_USD) {
        return Effect.fail(
            new BadRequestError({ message: `amountUsd must be between ${MIN_TARGET_USD} and ${MAX_TARGET_USD}` }),
        );
    }
    return Effect.succeed(value);
}

function decodeMaxVariants(raw: string | null): Effect.Effect<number, BadRequestError> {
    if (raw === null || raw.trim() === '') return Effect.succeed(DEFAULT_MAX_VARIANTS);
    const value = Number(raw.trim());
    if (!Number.isInteger(value) || value < 1 || value > MAX_MAX_VARIANTS) {
        return Effect.fail(
            new BadRequestError({ message: `maxVariants must be an integer between 1 and ${MAX_MAX_VARIANTS}` }),
        );
    }
    return Effect.succeed(value);
}

function decodeProviders(raw: string | null): Effect.Effect<QuoteProvider[], BadRequestError> {
    if (raw === null) return Effect.succeed([...QUOTE_PROVIDERS]);
    const requested = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))];
    if (requested.length === 0) {
        return Effect.fail(new BadRequestError({ message: 'providers must name at least one provider' }));
    }
    const unknown = requested.filter(value => !QUOTE_PROVIDERS.includes(value as QuoteProvider));
    if (unknown.length > 0) {
        return Effect.fail(
            new BadRequestError({
                message: `Unknown providers value(s): ${unknown.join(', ')}. Valid: ${QUOTE_PROVIDERS.join(', ')}`,
            }),
        );
    }
    return Effect.succeed(QUOTE_PROVIDERS.filter(provider => requested.includes(provider)));
}

/**
 * Above evaluate's 30s: this route runs two quote waves (probe fanout, then
 * allocation verification), each bounded by the same 12s/14s ladder, in
 * parallel across variants.
 */
export const maxDuration = 60;

/**
 * GET /api/v2/execution/route — the asset-level execution product. Quotes a
 * canonical asset's variants across a target-scaled ladder and (where unit
 * parity holds) computes how to split the order for the best total fill.
 */
export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const params = new URL(request.url).searchParams;
            const rawAssetId = params.get('assetId');
            if (!rawAssetId || !rawAssetId.trim()) {
                return yield* Effect.fail(new BadRequestError({ message: 'Missing required query param: assetId' }));
            }
            const side = (params.get('side') ?? 'buy').trim().toLowerCase();
            if (side === 'sell') {
                return yield* Effect.fail(
                    new BadRequestError({
                        message:
                            'side=sell is not supported yet: selling needs per-variant token amounts and a unit-parity conversion. Quote each variant with /v2/execution/evaluate instead.',
                    }),
                );
            }
            if (side !== 'buy') {
                return yield* Effect.fail(new BadRequestError({ message: 'Invalid side: expected buy' }));
            }
            const assetId = rawAssetId.trim();
            const asset = getAsset(assetId) ?? resolveAlias(assetId);
            if (!asset) {
                return yield* Effect.fail(
                    new NotFoundError({ message: `Unknown assetId: ${assetId}`, resource: 'asset' }),
                );
            }
            const targetUsd = yield* decodeTargetUsd(params.get('amountUsd'));
            const providers = yield* decodeProviders(params.get('providers'));
            const maxVariants = yield* decodeMaxVariants(params.get('maxVariants'));

            // One batched market + fill-quality read over every variant mint;
            // this is where decimals, symbols, and the liquidity floor come from.
            const mints = asset.variants.map(variant => variant.mint);
            const [marketEntries, fillQualityEntries] = yield* Effect.all(
                [
                    variantMarketsGetLatestByMints({ mints }),
                    variantFillQualityGetLatestByMints({ mints }).pipe(
                        // Fill quality is a ranking refinement, not a requirement.
                        Effect.catch(() => Effect.succeed([])),
                    ),
                ],
                { concurrency: 2 },
            );
            const marketByMint = new Map(
                marketEntries.map(entry => [
                    entry.mint,
                    entry.market
                        ? {
                              liquidity: entry.market.liquidity ?? null,
                              volume24hUSD: entry.market.volume24hUSD ?? null,
                              trade24h: entry.market.trade24h ?? null,
                          }
                        : null,
                ]),
            );
            const fillQualityByMint = new Map(
                fillQualityEntries.map(entry => [
                    entry.mint,
                    entry.fillQuality
                        ? {
                              volume24hUSD: entry.fillQuality.volume24hUSD,
                              trade24h: entry.fillQuality.trade24h,
                              flowSourceCount: entry.fillQuality.flowSourceCount,
                              botVolumeRatio: entry.fillQuality.botVolumeRatio,
                              feeBps: entry.fillQuality.feeBps,
                              executionScore: entry.fillQuality.executionScore,
                              isEligibleForPrimary: entry.fillQuality.isEligibleForPrimary,
                              asOf: entry.fillQuality.asOf,
                          }
                        : null,
                ]),
            );
            const displayByMint = new Map(
                marketEntries.map(entry => [
                    entry.mint,
                    entry.market
                        ? {
                              symbol: entry.market.symbol ?? null,
                              name: entry.market.name ?? null,
                              decimals: entry.market.decimals ?? null,
                              price: entry.market.price ?? null,
                              liquidity: entry.market.liquidity ?? null,
                              volume24hUSD: entry.market.volume24hUSD ?? null,
                          }
                        : null,
                ]),
            );

            const selection = selectVariants({
                asset,
                mintRank: CURATED_MINT_RANK,
                marketByMint,
                fillQualityByMint,
                displayByMint,
                targetUsd,
                maxVariants,
            });

            const probeLadderUsd = buildProbeLadderUsd(targetUsd);
            const amounts = probeLadderUsd.map(String);

            // Probe fanout: one call per variant, in parallel. A variant whose
            // fanout fails entirely (transport error, not market weather)
            // degrades to a variant with no successful rungs rather than
            // failing the request.
            const fanoutResults = yield* Effect.all(
                selection.selected.map(selected =>
                    executionQuotesLive({
                        mint: selected.variant.mint,
                        side: 'buy',
                        amounts,
                        tokenDecimals: selected.decimals,
                        providers,
                    }).pipe(Effect.catch(() => Effect.succeed(null))),
                ),
                { concurrency: selection.selected.length || 1 },
            );

            const warnings: string[] = [];
            const summarizable = [];
            const variants: RoutedVariant[] = [];
            for (const [index, selected] of selection.selected.entries()) {
                const result = fanoutResults[index] ?? null;
                const serialized = result
                    ? serializeQuoteRows({
                          entries: result.entries,
                          side: 'buy',
                          inputToken: { mint: result.quoteMint, symbol: 'USDC', decimals: 6 },
                          outputToken: { mint: selected.variant.mint, symbol: selected.symbol, decimals: selected.decimals },
                      })
                    : { quotes: [], summarizable: [] };
                summarizable.push(...serialized.summarizable);
                if (!result) warnings.push(`variant_fanout_failed:${selected.variant.mint}`);

                const curve = buildVariantCurve(serialized.quotes);
                variants.push({
                    variantId: selected.variant.variantId,
                    mint: selected.variant.mint,
                    symbol: selected.symbol,
                    name: selected.name,
                    decimals: selected.decimals,
                    kind: selected.variant.kind,
                    issuer: selected.variant.issuer ?? null,
                    stockVariantTier: selected.variant.stockVariantTier ?? null,
                    rank: selected.rank,
                    parityBasis: selected.parityBasis,
                    allocationEligible: selected.parityBasis !== 'none' && curve.points.length > 0,
                    market: selected.market,
                    quotes: serialized.quotes,
                    curve: {
                        baseEffectivePrice: curve.baseEffectivePrice,
                        rungs: curve.rungs,
                        maxProvenSizeUsd: curve.maxProvenSizeUsd,
                    },
                });
            }

            if (variants.some(variant => variant.parityBasis === 'issuer_assertion')) {
                // Both fixed disclosures for tokenized equity: unit parity is
                // the issuer's claim, and issuer mint/redeem primary markets
                // are invisible to every aggregator we quote.
                warnings.push('equity_unit_parity_assumed', 'issuer_primary_market_not_quoted');
            }

            const { providerStats } = summarizeComparison({ providers, entries: summarizable });
            const allocationStatus: AllocationStatus = 'not_requested';

            const response: ExecutionRouteResponse = {
                assetId: asset.assetId,
                providers,
                variants,
                allocationStatus,
                allocation: null,
                meta: {
                    assetId: asset.assetId,
                    category: asset.category,
                    side: 'buy',
                    targetUsd: String(targetUsd),
                    probeLadderUsd,
                    maxVariants,
                    selectedVariants: variants.length,
                    excludedVariants: selection.excluded,
                    upstreamQuotes: variants.length * probeLadderUsd.length * providers.length,
                    providerStats,
                    tieBreak: QUOTE_PROVIDERS[0],
                    routingVersion: ROUTING_VERSION,
                    comparisonVersion: COMPARISON_VERSION,
                    warnings,
                },
            };
            return response;
        }),
    { platform: { requiredScopes: ['execution:read'] } },
);
