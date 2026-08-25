import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import {
    COMPARISON_VERSION,
    formatRawAmount,
    QUOTE_PROVIDERS,
    summarizeComparison,
    type QuoteProvider,
} from '../evaluate/comparison';
import { serializeQuoteRows } from '../evaluate/serialize';
import {
    ALLOCATION_VERSION,
    ROUTING_VERSION,
    type AllocationLeg,
    type AllocationPlan,
    type AllocationStatus,
    type ExecutionRouteResponse,
    type RoutedVariant,
} from './contract';
import {
    computeAllocation,
    computeAllocationEdge,
    type AllocatableVariant,
    type AllocationBaseline,
    type AllocationEngineResult,
} from './allocation';
import { buildVariantCurve, type VariantCurve } from './curve';
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
            const allocateRaw = (params.get('allocate') ?? 'true').trim().toLowerCase();
            if (allocateRaw !== 'true' && allocateRaw !== 'false') {
                return yield* Effect.fail(new BadRequestError({ message: 'allocate must be true or false' }));
            }
            const allocate = allocateRaw === 'true';

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
            const curveByMint = new Map<string, VariantCurve>();
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
                curveByMint.set(selected.variant.mint, curve);
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

            // --- Allocation over the parity pool ---
            const pool: AllocatableVariant[] = variants
                .filter(variant => variant.allocationEligible)
                .map(variant => ({
                    variantId: variant.variantId,
                    mint: variant.mint,
                    symbol: variant.symbol,
                    decimals: variant.decimals,
                    rank: variant.rank,
                    points: curveByMint.get(variant.mint)?.points ?? [],
                }));

            let allocationStatus: AllocationStatus;
            let engine: AllocationEngineResult | null = null;
            if (!allocate) {
                allocationStatus = 'not_requested';
            } else if (pool.length === 0) {
                allocationStatus = 'no_eligible_variants';
            } else {
                engine = computeAllocation({ targetUsd, variants: pool });
                allocationStatus = engine && engine.legs.length > 0 ? 'ok' : 'insufficient_quotes';
                if (allocationStatus !== 'ok') engine = null;
            }

            let allocation: AllocationPlan | null = null;
            let verificationQuotes = 0;
            if (engine) {
                if (engine.unallocatedUsd > 0) warnings.push('target_exceeds_probed_depth');
                for (const mint of engine.clampedMints) warnings.push(`curve_not_concave:${mint}`);
                if (engine.pegSpreadBps !== null && engine.pegSpreadBps > 50) warnings.push('peg_divergence');

                // Verification wave: one exact quote per leg, in parallel. The
                // verified quote becomes the leg's reported numbers; a failed
                // verification keeps the interpolation and says so.
                const verifications = yield* Effect.all(
                    engine.legs.map(leg =>
                        executionQuotesLive({
                            mint: leg.mint,
                            side: 'buy',
                            amounts: [String(leg.amountUsd)],
                            tokenDecimals: leg.decimals,
                            providers,
                        }).pipe(Effect.catch(() => Effect.succeed(null))),
                    ),
                    { concurrency: engine.legs.length || 1 },
                );
                verificationQuotes = engine.legs.length * providers.length;

                const unitDecimals = engine.outputUnitDecimals;
                let totalOutUnitsRaw = 0n;
                const legs: AllocationLeg[] = engine.legs.map((leg, index) => {
                    const scale = 10n ** BigInt(unitDecimals - leg.decimals);
                    const verification = verifications[index] ?? null;
                    const verified = verification
                        ? serializeQuoteRows({
                              entries: verification.entries,
                              side: 'buy',
                              inputToken: { mint: verification.quoteMint, symbol: 'USDC', decimals: 6 },
                              outputToken: { mint: leg.mint, symbol: leg.symbol, decimals: leg.decimals },
                          }).quotes[0]
                        : null;
                    if (verified && verified.status === 'available') {
                        const verifiedOutRaw = BigInt(verified.best.output.rawAmount);
                        totalOutUnitsRaw += verifiedOutRaw * scale;
                        const deltaRatio =
                            leg.expectedOutRaw > 0n
                                ? Number((verifiedOutRaw * 1_000_000n) / leg.expectedOutRaw - 1_000_000n) / 100
                                : null;
                        return {
                            variantId: leg.variantId,
                            mint: leg.mint,
                            symbol: leg.symbol,
                            amountUsd: String(leg.amountUsd),
                            amountUsdRaw: (BigInt(leg.amountUsd) * 1_000_000n).toString(),
                            shareOfTarget: Math.round((leg.amountUsd / targetUsd) * 10_000) / 10_000,
                            provider: verified.best.provider,
                            expectedOut: verified.best.output,
                            effectivePrice: verified.best.effectivePrice,
                            impactBps: leg.impactBps,
                            router: verified.best.router,
                            verification: {
                                status: 'verified' as const,
                                deltaBps: deltaRatio === null ? null : Math.round(deltaRatio * 100) / 100,
                                quotedAt: verified.best.quotedAt,
                            },
                        };
                    }
                    warnings.push(`verification_unavailable:${leg.mint}`);
                    totalOutUnitsRaw += leg.expectedOutUnitsRaw;
                    return {
                        variantId: leg.variantId,
                        mint: leg.mint,
                        symbol: leg.symbol,
                        amountUsd: String(leg.amountUsd),
                        amountUsdRaw: (BigInt(leg.amountUsd) * 1_000_000n).toString(),
                        shareOfTarget: Math.round((leg.amountUsd / targetUsd) * 10_000) / 10_000,
                        provider: leg.provider,
                        expectedOut: {
                            mint: leg.mint,
                            symbol: leg.symbol,
                            decimals: leg.decimals,
                            amount: formatRawAmount(leg.expectedOutRaw.toString(), leg.decimals),
                            rawAmount: leg.expectedOutRaw.toString(),
                        },
                        effectivePrice: null,
                        impactBps: leg.impactBps,
                        router: null,
                        verification: {
                            status: 'interpolated' as const,
                            deltaBps: null,
                            quotedAt: new Date().toISOString(),
                        },
                    };
                });

                const edgeFrom = (baseline: AllocationBaseline | null) => {
                    if (!baseline) return null;
                    const edge = computeAllocationEdge({
                        planOutUnitsRaw: totalOutUnitsRaw,
                        baselineOutUnitsRaw: baseline.outUnitsRaw,
                        targetUsd,
                    });
                    if (!edge) return null;
                    return {
                        baselineVariantId: baseline.variantId,
                        baselineMint: baseline.mint,
                        baselineSymbol: baseline.symbol,
                        outAmountDiffRaw: edge.outAmountDiffRaw.toString(),
                        outAmountDiff: formatRawAmount(edge.outAmountDiffRaw.toString(), unitDecimals),
                        bps: edge.bps,
                        usd: edge.usd,
                    };
                };

                allocation = {
                    version: ALLOCATION_VERSION,
                    targetUsd: String(targetUsd),
                    allocatedUsd: String(engine.allocatedUsd),
                    unallocatedUsd: String(engine.unallocatedUsd),
                    chunkUsd: engine.chunkUsd,
                    legs,
                    outputUnit: { symbol: asset.symbol ?? asset.assetId, decimals: unitDecimals },
                    totalExpectedOut:
                        totalOutUnitsRaw > 0n
                            ? {
                                  amount: formatRawAmount(totalOutUnitsRaw.toString(), unitDecimals),
                                  rawAmount: totalOutUnitsRaw.toString(),
                              }
                            : null,
                    edge: {
                        vsBestSingleVariant: edgeFrom(engine.bestSingleAtTarget),
                        vsPrimaryVariant: edgeFrom(engine.primaryAtTarget),
                    },
                    pegSpreadBps: engine.pegSpreadBps,
                };
            }

            const response: ExecutionRouteResponse = {
                assetId: asset.assetId,
                providers,
                variants,
                allocationStatus,
                allocation,
                meta: {
                    assetId: asset.assetId,
                    category: asset.category,
                    side: 'buy',
                    targetUsd: String(targetUsd),
                    probeLadderUsd,
                    maxVariants,
                    selectedVariants: variants.length,
                    excludedVariants: selection.excluded,
                    upstreamQuotes: variants.length * probeLadderUsd.length * providers.length + verificationQuotes,
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
