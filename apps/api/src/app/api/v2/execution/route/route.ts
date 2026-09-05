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
    type AllocationEngineLeg,
    type AllocationEngineResult,
    gradeBlendedImpact,
    resolveTuningProfile,
} from './allocation';
import { buildVariantCurve, type VariantCurve } from './curve';
import { analyzeLegIndependence } from './leg-independence';
import { buildProbeLadderUsd, selectVariants } from './variant-selection';
import {
    executionQuoteTokenMetadata,
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
    const requested = [
        ...new Set(
            raw
                .split(',')
                .map(value => value.trim())
                .filter(Boolean),
        ),
    ];
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

/** Above evaluate's 30s: this route runs two quote waves. */
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
            const { tuning, marketClosedMultiplierApplied } = resolveTuningProfile({
                category: asset.category,
                now: new Date(),
            });

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
                              priceAsOf: Number.isFinite(entry.market.lastFetchedAt)
                                  ? new Date(entry.market.lastFetchedAt).toISOString()
                                  : null,
                              liquidity: entry.market.liquidity ?? null,
                              volume24hUSD: entry.market.volume24hUSD ?? null,
                          }
                        : null,
                ]),
            );

            // Decimals fall back to Jupiter token metadata for mints without
            // market rows (common for tokenized equities), bounded to 8.
            const missingDecimalMints = asset.variants
                .map(variant => variant.mint)
                .filter(mint => !Number.isInteger(displayByMint.get(mint)?.decimals ?? null));
            if (missingDecimalMints.length > 0) {
                const fallbacks = yield* Effect.all(
                    missingDecimalMints
                        .slice(0, 8)
                        .map(mint =>
                            executionQuoteTokenMetadata({ mint }).pipe(Effect.catch(() => Effect.succeed(null))),
                        ),
                    { concurrency: 4 },
                );
                for (const [index, metadata] of fallbacks.entries()) {
                    if (!metadata || !Number.isInteger(metadata.decimals)) continue;
                    const mint = missingDecimalMints[index]!;
                    const existing = displayByMint.get(mint) ?? null;
                    displayByMint.set(mint, {
                        symbol: existing?.symbol ?? metadata.symbol ?? null,
                        name: existing?.name ?? metadata.name ?? null,
                        decimals: metadata.decimals,
                        price: existing?.price ?? null,
                        priceAsOf: existing?.priceAsOf ?? null,
                        liquidity: existing?.liquidity ?? null,
                        volume24hUSD: existing?.volume24hUSD ?? null,
                    });
                }
            }

            const selection = selectVariants({
                asset,
                // Editorial tiebreak, read per request: it is backed by the
                // curated-membership snapshot, which is empty at module load
                // and fills in asynchronously. Hoisting it to a module
                // constant pins it empty for the life of the process.
                mintRank: buildCuratedMintRank(),
                marketByMint,
                fillQualityByMint,
                displayByMint,
                targetUsd,
                maxVariants,
            });

            const probeLadderUsd = buildProbeLadderUsd(targetUsd);
            const amounts = probeLadderUsd.map(String);

            // Probe fanout: a variant whose fanout fails degrades to one with
            // no successful rungs rather than failing the request.
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
                          outputToken: {
                              mint: selected.variant.mint,
                              symbol: selected.symbol,
                              decimals: selected.decimals,
                          },
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
                        parityDivergenceBps: null,
                    },
                });
            }

            if (variants.some(variant => variant.parityBasis === 'issuer_assertion')) {
                warnings.push('equity_unit_parity_assumed', 'issuer_primary_market_not_quoted');
            }

            const { providerStats } = summarizeComparison({ providers, entries: summarizable });

            const pool: AllocatableVariant[] = variants
                .filter(variant => variant.allocationEligible)
                .map(variant => ({
                    variantId: variant.variantId,
                    mint: variant.mint,
                    symbol: variant.symbol,
                    decimals: variant.decimals,
                    rank: variant.rank,
                    points: curveByMint.get(variant.mint)?.points ?? [],
                    depthUncertain: variant.curve.rungs.some(
                        rung => rung.impactBps === null && rung.reason !== null && rung.reason !== 'no_route',
                    ),
                }));

            // 'no_eligible_variants' means the asset cannot be routed;
            // 'insufficient_quotes' means parity existed but nothing quoted a
            // usable curve — retryable, and the two must not be conflated.
            const parityCandidates = variants.filter(variant => variant.parityBasis !== 'none');
            let allocationStatus: AllocationStatus;
            let engine: AllocationEngineResult | null = null;
            if (!allocate) {
                allocationStatus = 'not_requested';
            } else if (parityCandidates.length === 0) {
                // missing_decimals exclusions are coverage failures on variants
                // that passed every structural filter — retryable, not "cannot
                // be routed".
                allocationStatus = selection.excluded.some(entry => entry.reason === 'missing_decimals')
                    ? 'insufficient_quotes'
                    : 'no_eligible_variants';
            } else if (pool.length === 0) {
                allocationStatus = 'insufficient_quotes';
            } else {
                engine = computeAllocation({ targetUsd, variants: pool, tuning });
                allocationStatus = engine && engine.legs.length > 0 ? 'ok' : 'insufficient_quotes';
                if (allocationStatus !== 'ok') engine = null;
            }

            let allocation: AllocationPlan | null = null;
            let verificationQuotes = 0;
            if (engine) {
                // One exact re-quote per leg, keyed by (mint, size) so repair
                // waves reuse unchanged results.
                const verifiedRowByKey = new Map<
                    string,
                    ReturnType<typeof serializeQuoteRows>['quotes'][number] | null
                >();
                const legKey = (leg: AllocationEngineLeg) => `${leg.mint}:${leg.amountUsd}`;
                const verifyWave = (waveLegs: AllocationEngineLeg[]) =>
                    Effect.gen(function* () {
                        const missing = waveLegs.filter(leg => !verifiedRowByKey.has(legKey(leg)));
                        if (missing.length === 0) return;
                        const results = yield* Effect.all(
                            missing.map(leg =>
                                executionQuotesLive({
                                    mint: leg.mint,
                                    side: 'buy',
                                    amounts: [String(leg.amountUsd)],
                                    tokenDecimals: leg.decimals,
                                    providers,
                                }).pipe(Effect.catch(() => Effect.succeed(null))),
                            ),
                            { concurrency: missing.length },
                        );
                        verificationQuotes += missing.length * providers.length;
                        for (const [index, result] of results.entries()) {
                            const leg = missing[index]!;
                            const row = result
                                ? (serializeQuoteRows({
                                      entries: result.entries,
                                      side: 'buy',
                                      inputToken: { mint: result.quoteMint, symbol: 'USDC', decimals: 6 },
                                      outputToken: { mint: leg.mint, symbol: leg.symbol, decimals: leg.decimals },
                                  }).quotes[0] ?? null)
                                : null;
                            verifiedRowByKey.set(legKey(leg), row);
                        }
                    });
                const verifiedDeltaBps = (leg: AllocationEngineLeg): number | null => {
                    const row = verifiedRowByKey.get(legKey(leg));
                    if (!row || row.status !== 'available' || leg.expectedOutRaw <= 0n) return null;
                    const verifiedOutRaw = BigInt(row.best.output.rawAmount);
                    return Number((verifiedOutRaw * 1_000_000n) / leg.expectedOutRaw - 1_000_000n) / 100;
                };

                yield* verifyWave(engine.legs);

                // One-shot repair: a collapsed variant is distrusted entirely
                // and the allocation re-derived without it. Exactly one repair;
                // a second collapse ships with its honest delta.
                let activeEngine: AllocationEngineResult = engine;
                let repaired = false;
                const collapsedLegs = engine.legs.filter(leg => {
                    const delta = verifiedDeltaBps(leg);
                    return delta !== null && delta < tuning.collapseThresholdBps;
                });
                if (collapsedLegs.length > 0) {
                    const collapsedMints = new Set(collapsedLegs.map(leg => leg.mint));
                    // A variant the parity gate ejected is just as distrusted as
                    // the collapsed one — repair must never re-admit it.
                    const ejectedMints = new Set(engine.ejected.map(entry => entry.mint));
                    const repairedPool = pool.filter(
                        poolVariant => !collapsedMints.has(poolVariant.mint) && !ejectedMints.has(poolVariant.mint),
                    );
                    const repairedEngine =
                        repairedPool.length > 0
                            ? computeAllocation({ targetUsd, variants: repairedPool, tuning })
                            : null;
                    if (repairedEngine && repairedEngine.legs.length > 0) {
                        activeEngine = repairedEngine;
                        repaired = true;
                        for (const leg of collapsedLegs) {
                            warnings.push(`plan_repaired:${leg.mint}`);
                            const routed = variants.find(variant => variant.mint === leg.mint);
                            if (routed) routed.allocationEligible = false;
                        }
                        yield* verifyWave(repairedEngine.legs);
                    } else {
                        for (const leg of collapsedLegs) {
                            warnings.push(`collapse_unrepairable:${leg.mint}`);
                        }
                    }
                }

                // Surface the parity gate's verdicts on the variants themselves,
                // from both engines: a repair must not erase the original ejections.
                const ejectedByMint = new Map(
                    [...engine.ejected, ...activeEngine.ejected].map(entry => [entry.mint, entry]),
                );
                for (const ejectedVariant of ejectedByMint.values()) {
                    warnings.push(`price_divergence_excluded:${ejectedVariant.mint}`);
                    const routed = variants.find(variant => variant.mint === ejectedVariant.mint);
                    if (routed) {
                        routed.allocationEligible = false;
                        routed.curve.parityDivergenceBps = ejectedVariant.divergenceBps;
                    }
                }
                for (const [mint, divergence] of Object.entries({
                    ...engine.divergenceBpsByMint,
                    ...activeEngine.divergenceBpsByMint,
                })) {
                    const routed = variants.find(variant => variant.mint === mint);
                    if (routed) routed.curve.parityDivergenceBps = divergence;
                }
                if (activeEngine.unallocatedUsd > 0) warnings.push('target_exceeds_probed_depth');
                for (const mint of activeEngine.clampedMints) warnings.push(`curve_not_concave:${mint}`);
                if (activeEngine.pegSpreadBps !== null && activeEngine.pegSpreadBps > tuning.pegWarnBps) {
                    warnings.push('peg_divergence');
                }
                if (marketClosedMultiplierApplied) warnings.push('market_closed_spread_tolerance');

                const unitDecimals = activeEngine.outputUnitDecimals;
                const legs: AllocationLeg[] = activeEngine.legs.map(leg => {
                    const verified = verifiedRowByKey.get(legKey(leg)) ?? null;
                    if (verified && verified.status === 'available') {
                        const delta = verifiedDeltaBps(leg);
                        // A verified output far ABOVE the curve's expectation
                        // means the probe curve was wrong (a fill appeared that
                        // the probes missed) — the sizes were derived from bad
                        // data even though the totals err in the caller's favor.
                        const upsideAnomaly = delta !== null && delta > Math.abs(tuning.collapseThresholdBps);
                        if (upsideAnomaly) warnings.push(`verification_upside_anomaly:${leg.mint}`);
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
                            route: verified.best.route,
                            shareConfidence: upsideAnomaly ? ('soft' as const) : leg.shareConfidence,
                            verification: {
                                status: 'verified' as const,
                                deltaBps: delta === null ? null : Math.round(delta * 100) / 100,
                                quotedAt: verified.best.quotedAt,
                            },
                        };
                    }
                    warnings.push(`verification_unavailable:${leg.mint}`);
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
                        route: [],
                        shareConfidence: leg.shareConfidence,
                        verification: {
                            status: 'interpolated' as const,
                            deltaBps: null,
                            quotedAt: new Date().toISOString(),
                        },
                    };
                });

                const decimalsByMint = new Map(variants.map(variant => [variant.mint, variant.decimals]));
                const legStepsOf = (leg: AllocationLeg) => {
                    const verified = verifiedRowByKey.get(`${leg.mint}:${Number(leg.amountUsd)}`);
                    if (verified && verified.status === 'available') return verified.best.route;
                    const probeRow = variants
                        .find(variant => variant.mint === leg.mint)
                        ?.quotes.find(row => row.status === 'available' && row.request.amount === leg.amountUsd);
                    return probeRow && probeRow.status === 'available' ? probeRow.best.route : [];
                };
                const totalOf = (planLegs: AllocationLeg[]) =>
                    planLegs.reduce((sum, leg) => {
                        if (!leg.expectedOut) return sum;
                        const scale = 10n ** BigInt(unitDecimals - (decimalsByMint.get(leg.mint) ?? unitDecimals));
                        return sum + BigInt(leg.expectedOut.rawAmount) * scale;
                    }, 0n);

                // Interpolated legs have no verification route; use their probe rung's.
                for (const leg of legs) {
                    if (leg.route.length === 0) leg.route = legStepsOf(leg);
                }

                // Overlap detection uses routes already in hand — costs nothing.
                let legIndependence = analyzeLegIndependence({
                    legs: legs.map(leg => ({ mint: leg.mint, steps: legStepsOf(leg) })),
                });

                // Overlapping legs get ONE restricted re-quote each; the result
                // is only trusted after effect-verification below.
                let workingLegs = legs;
                let edgeBasis: 'independent_quotes' | 'restricted_requotes' = 'independent_quotes';
                if (!legIndependence.independent && legs.length > 1) {
                    const legMints = new Set(legs.map(leg => leg.mint));
                    const implicatedMints = new Set([
                        ...legIndependence.passThrough.map(entry => entry.legMint),
                        ...legIndependence.sharedPools.flatMap(pool => pool.legMints),
                    ]);
                    const implicated = legs.filter(leg => implicatedMints.has(leg.mint));
                    const offendingLabels = (leg: AllocationLeg): string[] => [
                        ...new Set(
                            legStepsOf(leg)
                                .filter(step =>
                                    [step.inputMint, step.outputMint].some(
                                        mint => mint !== null && mint !== leg.mint && legMints.has(mint),
                                    ),
                                )
                                .map(step => step.label)
                                .filter((label): label is string => label !== null && label.length > 0),
                        ),
                    ];
                    // Breathing room after the verification burst on the same
                    // per-key upstream rate limits.
                    yield* Effect.sleep('1 second');
                    const restrictedResults = yield* Effect.all(
                        implicated.map(leg =>
                            executionQuotesLive({
                                mint: leg.mint,
                                side: 'buy',
                                amounts: [String(Number(leg.amountUsd))],
                                tokenDecimals: decimalsByMint.get(leg.mint) ?? 9,
                                providers,
                                restrictions: {
                                    jupiter: { onlyDirectRoutes: true },
                                    titan: { excludeDexes: offendingLabels(leg) },
                                },
                            }).pipe(Effect.catch(() => Effect.succeed(null))),
                        ),
                        { concurrency: implicated.length || 1 },
                    );
                    verificationQuotes += implicated.length * providers.length;

                    const restrictedByMint = new Map<string, (typeof legs)[number]>();
                    let allClean = true;
                    for (const [index, result] of restrictedResults.entries()) {
                        const leg = implicated[index]!;
                        const decimals = decimalsByMint.get(leg.mint) ?? 9;
                        const row = result
                            ? (serializeQuoteRows({
                                  entries: result.entries,
                                  side: 'buy',
                                  inputToken: { mint: result.quoteMint, symbol: 'USDC', decimals: 6 },
                                  outputToken: { mint: leg.mint, symbol: leg.symbol, decimals },
                              }).quotes[0] ?? null)
                            : null;
                        if (!row || row.status !== 'available') {
                            allClean = false;
                            break;
                        }
                        // Effect-verification: a restriction the server ignored
                        // must never be treated as applied — take the best
                        // CLEAN candidate rather than the overall winner.
                        const isClean = (route: readonly (typeof row.best.route)[number][]) =>
                            !route.some(step =>
                                [step.inputMint, step.outputMint].some(
                                    mint => mint !== null && mint !== leg.mint && legMints.has(mint),
                                ),
                            );
                        const cleanQuote = row.providerQuotes.find(
                            (quote): quote is Extract<typeof quote, { status: 'available' }> =>
                                quote.status === 'available' && isClean(quote.route),
                        );
                        if (!cleanQuote) {
                            allClean = false;
                            break;
                        }
                        const engineLeg = activeEngine.legs.find(
                            candidate => candidate.mint === leg.mint && String(candidate.amountUsd) === leg.amountUsd,
                        );
                        const deltaVsCurve =
                            engineLeg && engineLeg.expectedOutRaw > 0n
                                ? Number(
                                      (BigInt(cleanQuote.output.rawAmount) * 1_000_000n) / engineLeg.expectedOutRaw -
                                          1_000_000n,
                                  ) / 100
                                : null;
                        restrictedByMint.set(leg.mint, {
                            ...leg,
                            provider: cleanQuote.provider,
                            expectedOut: cleanQuote.output,
                            effectivePrice: cleanQuote.effectivePrice,
                            router: cleanQuote.router,
                            route: cleanQuote.route,
                            verification: {
                                status: 'verified' as const,
                                deltaBps: deltaVsCurve === null ? null : Math.round(deltaVsCurve * 100) / 100,
                                quotedAt: cleanQuote.quotedAt,
                            },
                        });
                    }
                    if (allClean && restrictedByMint.size === implicated.length) {
                        workingLegs = legs.map(leg => restrictedByMint.get(leg.mint) ?? leg);
                        edgeBasis = 'restricted_requotes';
                        legIndependence = { independent: true, passThrough: [], sharedPools: [] };
                        warnings.push('legs_restricted_requoted');
                    }
                }
                if (!legIndependence.independent) warnings.push('legs_share_liquidity');

                // A split that loses to the best single variant on the FINAL
                // totals is replaced with one leg on that variant.
                let fellBackToSingleVariant = false;
                let finalLegs = workingLegs;
                let finalTotalOutUnitsRaw = totalOf(workingLegs);
                let allocatedUsd = activeEngine.allocatedUsd;
                let unallocatedUsd = activeEngine.unallocatedUsd;
                const bestSingle = activeEngine.bestSingleAtTarget;
                if (bestSingle && workingLegs.length > 1) {
                    const verifiedEdge = computeAllocationEdge({
                        planOutUnitsRaw: finalTotalOutUnitsRaw,
                        baselineOutUnitsRaw: bestSingle.outUnitsRaw,
                        targetUsd,
                    });
                    if (verifiedEdge && verifiedEdge.bps < 0) {
                        const baselineVariant = variants.find(variant => variant.mint === bestSingle.mint);
                        const baselineRow = baselineVariant?.quotes.find(
                            row => row.status === 'available' && Number(row.request.amount) === targetUsd,
                        );
                        if (baselineVariant && baselineRow && baselineRow.status === 'available') {
                            fellBackToSingleVariant = true;
                            warnings.push('plan_fell_back_to_single_variant');
                            const targetRung = baselineVariant.curve.rungs.find(rung => rung.sizeUsd === targetUsd);
                            finalLegs = [
                                {
                                    variantId: baselineVariant.variantId,
                                    mint: baselineVariant.mint,
                                    symbol: baselineVariant.symbol,
                                    amountUsd: String(targetUsd),
                                    amountUsdRaw: (BigInt(targetUsd) * 1_000_000n).toString(),
                                    shareOfTarget: 1,
                                    provider: baselineRow.best.provider,
                                    expectedOut: baselineRow.best.output,
                                    effectivePrice: baselineRow.best.effectivePrice,
                                    impactBps: targetRung?.impactBps ?? null,
                                    router: baselineRow.best.router,
                                    route: baselineRow.best.route,
                                    // Exact full-target quote: no marginal sizing.
                                    shareConfidence: 'firm' as const,
                                    verification: {
                                        status: 'verified' as const,
                                        deltaBps: null,
                                        quotedAt: baselineRow.best.quotedAt,
                                    },
                                },
                            ];
                            finalTotalOutUnitsRaw = bestSingle.outUnitsRaw;
                            allocatedUsd = targetUsd;
                            unallocatedUsd = 0;
                            legIndependence = { independent: true, passThrough: [], sharedPools: [] };
                        }
                    }
                }

                // Whole-plan impact vs each leg variant's own baseline price.
                let blendedImpactBps: number | null = null;
                {
                    let baselineUnitsRaw = 0n;
                    let baselineComplete = finalLegs.length > 0;
                    for (const leg of finalLegs) {
                        const base = curveByMint.get(leg.mint)?.points[0];
                        const legDecimals = decimalsByMint.get(leg.mint);
                        if (!base || legDecimals === undefined) {
                            baselineComplete = false;
                            break;
                        }
                        const scale = 10n ** BigInt(unitDecimals - legDecimals);
                        baselineUnitsRaw += (BigInt(leg.amountUsdRaw) * base.outRaw * scale) / base.inRaw;
                    }
                    if (baselineComplete && baselineUnitsRaw > 0n && finalTotalOutUnitsRaw > 0n) {
                        const ratio = (finalTotalOutUnitsRaw * 1_000_000n) / baselineUnitsRaw;
                        const impact = Number(1_000_000n - ratio) / 100;
                        blendedImpactBps = impact > 0 ? Math.round(impact * 100) / 100 : 0;
                    }
                }
                const blendedImpactGrade = blendedImpactBps === null ? null : gradeBlendedImpact(blendedImpactBps);
                if (blendedImpactGrade === 'poor' || blendedImpactGrade === 'avoid') {
                    warnings.push('extreme_impact');
                }

                // An RFQ fill is a firm offer with no persistence guarantee —
                // the fill itself can be absent on a re-ask, so the leg's size
                // is never firm.
                finalLegs = finalLegs.map(leg =>
                    leg.router === 'jupiterz' && leg.shareConfidence === 'firm'
                        ? { ...leg, shareConfidence: 'soft' as const }
                        : leg,
                );

                // Share stability: worst-of the legs.
                const softLegs = finalLegs.filter(leg => leg.shareConfidence === 'soft').length;
                const shareStability: 'firm' | 'mixed' | 'soft' =
                    softLegs === 0 ? 'firm' : softLegs === finalLegs.length ? 'soft' : 'mixed';
                if (shareStability !== 'firm') warnings.push('shares_may_move');

                const edgeFrom = (baseline: AllocationBaseline | null) => {
                    if (!baseline) return null;
                    // Same-variant single-leg comparison is quote noise, not edge.
                    if (finalLegs.length === 1 && finalLegs[0]!.mint === baseline.mint) return null;
                    const edge = computeAllocationEdge({
                        planOutUnitsRaw: finalTotalOutUnitsRaw,
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
                    allocatedUsd: String(allocatedUsd),
                    unallocatedUsd: String(unallocatedUsd),
                    chunkUsd: activeEngine.chunkUsd,
                    minLegUsd: activeEngine.minLegUsd,
                    repaired,
                    fellBackToSingleVariant,
                    legs: finalLegs,
                    outputUnit: { symbol: asset.symbol ?? asset.assetId, decimals: unitDecimals },
                    totalExpectedOut:
                        finalTotalOutUnitsRaw > 0n
                            ? {
                                  amount: formatRawAmount(finalTotalOutUnitsRaw.toString(), unitDecimals),
                                  rawAmount: finalTotalOutUnitsRaw.toString(),
                              }
                            : null,
                    edge: {
                        basis: edgeBasis,
                        vsBestSingleVariant: edgeFrom(activeEngine.bestSingleAtTarget),
                        vsPrimaryVariant: edgeFrom(activeEngine.primaryAtTarget),
                    },
                    pegSpreadBps: activeEngine.pegSpreadBps,
                    blendedImpactBps,
                    blendedImpactGrade,
                    shareStability,
                    legIndependence,
                };
            }

            const response: ExecutionRouteResponse = {
                assetId: asset.assetId,
                providers,
                variants,
                allocationStatus,
                allocation,
                meta: {
                    generatedAt: new Date().toISOString(),
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
                    tuning: { ...tuning, marketClosedMultiplierApplied },
                    warnings,
                },
            };
            return response;
        }),
    { platform: { requiredScopes: ['execution:read'] } },
);
