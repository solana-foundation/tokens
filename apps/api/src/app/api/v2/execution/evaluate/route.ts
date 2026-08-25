import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import {
    COMPARISON_VERSION,
    computeEdge,
    formatRawAmount,
    QUOTE_PROVIDERS,
    rankQuotes,
    summarizeComparison,
    type PriceImpactSource,
    type QuoteProvider,
    type SummarizableEntry,
} from './comparison';
import type {
    ExecutionBestQuote,
    ExecutionEvaluationResponse,
    ExecutionProviderQuote,
    ExecutionQuoteRow,
} from './contract';
import {
    executionQuoteTokenMetadata,
    executionQuotesLive,
    tokensGetByAddress,
    variantMarketsGetLatestByMints,
} from '@/lib/cloudrun';
import { BadRequestError, NotFoundError, SolanaAddress, decodeUnknownOrBadRequest } from '@tokens/effect';
import { getVariantByMint } from '@tokens/asset-registry';

type Side = 'buy' | 'sell';
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_AMOUNTS = 9;
/**
 * Ladder used when the caller names no amounts: three rungs is 6 upstream
 * quotes, cheap enough to be a safe default. The $5M rung is deliberately
 * omitted — it no-routes on most tokens and would make the default look broken.
 */
const DEFAULT_LADDER_USD = [10_000, 100_000, 1_000_000] as const;

function decodeSide(raw: string | null): Effect.Effect<Side, BadRequestError> {
    if (raw === null || raw.trim() === '') return Effect.succeed('buy');
    const value = raw.trim().toLowerCase();
    return value === 'buy' || value === 'sell'
        ? Effect.succeed(value)
        : Effect.fail(new BadRequestError({ message: 'Invalid side: expected buy or sell' }));
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
    // Keep canonical order so the tie-break rule stays deterministic.
    return Effect.succeed(QUOTE_PROVIDERS.filter(provider => requested.includes(provider)));
}

function decodeAmounts(args: {
    side: Side;
    amountUsd: string[];
    tokenAmount: string[];
}): Effect.Effect<string[], BadRequestError> {
    if (args.side === 'buy') {
        if (args.tokenAmount.length > 0) {
            return Effect.fail(new BadRequestError({ message: 'tokenAmount is only valid when side=sell' }));
        }
        // No amounts named: quote the default ladder rather than erroring, so
        // the simplest possible call still returns a useful comparison.
        if (args.amountUsd.length === 0) {
            return Effect.succeed(DEFAULT_LADDER_USD.map(String));
        }
        return Effect.succeed(args.amountUsd);
    }
    if (args.amountUsd.length > 0) {
        return Effect.fail(new BadRequestError({ message: 'amountUsd is only valid when side=buy' }));
    }
    if (args.tokenAmount.length === 0) {
        return Effect.fail(new BadRequestError({ message: 'At least one tokenAmount is required when side=sell' }));
    }
    return Effect.succeed(args.tokenAmount);
}

function validateAmounts(args: {
    amounts: string[];
    decimals: number;
    side: Side;
}): Effect.Effect<string[], BadRequestError> {
    return Effect.try({
        try: () => {
            const normalized: string[] = [];
            const seen = new Set<string>();
            for (const raw of args.amounts) {
                const value = raw.trim();
                const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
                if (!match) throw new Error('Amounts must be positive decimal strings');
                const fraction = match[2] ?? '';
                if (fraction.length > args.decimals) {
                    throw new Error(`Amount has more than ${args.decimals} decimal places`);
                }
                const amountRaw = BigInt(`${match[1]}${fraction.padEnd(args.decimals, '0')}`);
                if (amountRaw <= 0n || amountRaw > MAX_U64) throw new Error('Amount is outside the supported range');
                if (args.side === 'buy' && (amountRaw < 1_000_000n || amountRaw > 50_000_000_000_000n)) {
                    throw new Error('amountUsd must be between 1 and 50000000');
                }
                const key = amountRaw.toString();
                if (seen.has(key)) continue;
                seen.add(key);
                normalized.push(formatRawAmount(key, args.decimals));
            }
            if (normalized.length > MAX_AMOUNTS) {
                throw new Error(`At most ${MAX_AMOUNTS} unique amounts are allowed`);
            }
            return normalized;
        },
        catch: error =>
            new BadRequestError({ message: error instanceof Error ? error.message : 'Invalid quote amount' }),
    });
}

/**
 * Serverless ceiling for this route. Sits above the transport timeout (14s),
 * which sits above the fan-out budget (12s), so the innermost layer is the one
 * that gives up and can still answer with partial results.
 */
export const maxDuration = 30;

/** GET /api/v2/execution/evaluate — uncached, exact-mint Titan and Jupiter quotes. */
export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const params = new URL(request.url).searchParams;
            const rawMint = params.get('mint');
            if (!rawMint) {
                return yield* Effect.fail(new BadRequestError({ message: 'Missing required query param: mint' }));
            }
            const mint = yield* decodeUnknownOrBadRequest(SolanaAddress, rawMint, 'Invalid mint');
            const registryMatch = getVariantByMint(mint);
            if (!registryMatch) {
                return yield* Effect.fail(
                    new NotFoundError({ message: `Unsupported token mint: ${mint}`, resource: 'token' }),
                );
            }
            const side = yield* decodeSide(params.get('side'));
            const providers = yield* decodeProviders(params.get('providers'));
            const amountSource: 'request' | 'default' =
                side === 'buy' && params.getAll('amountUsd').length === 0 ? 'default' : 'request';
            const rawAmounts = yield* decodeAmounts({
                side,
                amountUsd: params.getAll('amountUsd'),
                tokenAmount: params.getAll('tokenAmount'),
            });

            const token = yield* tokensGetByAddress({ address: mint });
            const needsMarket =
                !token || !Number.isInteger(token.decimals) || !token.symbol?.trim() || !token.name?.trim();
            const market = needsMarket
                ? ((yield* variantMarketsGetLatestByMints({ mints: [mint] }))[0]?.market ?? null)
                : null;
            const localDecimals = token?.decimals ?? market?.decimals ?? null;
            const jupiterMetadata = Number.isInteger(localDecimals)
                ? null
                : yield* executionQuoteTokenMetadata({ mint });
            const decimals = localDecimals ?? jupiterMetadata?.decimals ?? null;
            if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 18) {
                return yield* Effect.fail(
                    new NotFoundError({ message: `Unsupported token mint: ${mint}`, resource: 'token' }),
                );
            }
            const tokenDecimals = decimals as number;
            const symbol =
                token?.symbol ??
                market?.symbol ??
                jupiterMetadata?.symbol ??
                registryMatch.variant.symbol ??
                registryMatch.variant.label ??
                registryMatch.asset.symbol ??
                mint.slice(0, 4);
            const name =
                token?.name ??
                market?.name ??
                jupiterMetadata?.name ??
                registryMatch.variant.name ??
                registryMatch.asset.name ??
                symbol;
            const amounts = yield* validateAmounts({
                amounts: rawAmounts,
                decimals: side === 'buy' ? 6 : tokenDecimals,
                side,
            });

            const result = yield* executionQuotesLive({
                mint,
                side,
                amounts,
                tokenDecimals,
                providers,
            });

            const inputToken =
                side === 'buy'
                    ? { mint: result.quoteMint, symbol: 'USDC', decimals: 6 }
                    : { mint, symbol, decimals: tokenDecimals };
            const outputToken =
                side === 'buy'
                    ? { mint, symbol, decimals: tokenDecimals }
                    : { mint: result.quoteMint, symbol: 'USDC', decimals: 6 };

            /**
             * One provider's answer. `rank` and `isBest` make the relationship
             * to the hoisted `best` explicit, so callers (and the contract test)
             * never have to infer it from array position.
             */
            const serializeQuote = (
                candidate: (typeof result.entries)[number]['candidates'][number],
                rank: number | null,
                isBest: boolean,
            ): ExecutionProviderQuote => {
                if (candidate.status === 'unavailable') {
                    return {
                        provider: candidate.provider,
                        status: candidate.status,
                        reason: candidate.reason,
                        rank: null,
                        isBest: false,
                        input: null,
                        output: null,
                        effectivePrice: null,
                        priceImpactPct: null,
                        priceImpactSource: 'unavailable' as PriceImpactSource,
                        route: candidate.route,
                        contextSlot: null,
                        router: null,
                        mode: null,
                        fees: null,
                        quotedAt: candidate.quotedAt,
                    };
                }
                const inAmount = formatRawAmount(candidate.inAmountRaw, inputToken.decimals);
                const outAmount = formatRawAmount(candidate.outAmountRaw, outputToken.decimals);
                const inNumeric = Number(inAmount);
                return {
                    provider: candidate.provider,
                    status: candidate.status,
                    rank,
                    isBest,
                    input: { ...inputToken, amount: inAmount, rawAmount: candidate.inAmountRaw },
                    output: { ...outputToken, amount: outAmount, rawAmount: candidate.outAmountRaw },
                    // Output per unit of input: the comparable unit price.
                    effectivePrice:
                        Number.isFinite(inNumeric) && inNumeric > 0
                            ? String(Number(outAmount) / inNumeric)
                            : null,
                    priceImpactPct: candidate.priceImpactPct,
                    // Distinguishes "provider reported zero" from "provider
                    // reports nothing" — Titan has no impact field at all.
                    priceImpactSource: (candidate.priceImpactPct === null
                        ? 'unavailable'
                        : 'provider') as PriceImpactSource,
                    route: candidate.route,
                    contextSlot: candidate.contextSlot,
                    router: candidate.router,
                    mode: candidate.mode,
                    fees: candidate.fees,
                    quotedAt: candidate.quotedAt,
                };
            };

            const summarizable: SummarizableEntry[] = [];
            const quotes: ExecutionQuoteRow[] = result.entries.map((entry): ExecutionQuoteRow => {
                const availableCandidates = entry.candidates.filter(
                    (candidate): candidate is Extract<typeof candidate, { status: 'available' }> =>
                        candidate.status === 'available',
                );
                const ranked = rankQuotes(
                    availableCandidates.map(candidate => ({
                        provider: candidate.provider as QuoteProvider,
                        outAmountRaw: candidate.outAmountRaw,
                    })),
                );
                const rankByProvider = new Map(ranked.map((quote, index) => [quote.provider, index + 1]));
                const winner = ranked[0]?.provider ?? null;

                const edge = computeEdge({
                    ranked,
                    outputDecimals: outputToken.decimals,
                    side,
                    requestRawAmount: entry.request.rawAmount,
                });

                // Ranked best-first, so providerQuotes[1] is the runner-up;
                // unavailable providers trail with rank null.
                const providerQuotes = [...entry.candidates]
                    .sort((a, b) => {
                        const left = rankByProvider.get(a.provider as QuoteProvider) ?? Number.MAX_SAFE_INTEGER;
                        const right = rankByProvider.get(b.provider as QuoteProvider) ?? Number.MAX_SAFE_INTEGER;
                        return left - right;
                    })
                    .map(candidate =>
                        serializeQuote(
                            candidate,
                            rankByProvider.get(candidate.provider as QuoteProvider) ?? null,
                            candidate.status === 'available' && candidate.provider === winner,
                        ),
                    );

                summarizable.push({
                    request: { unit: entry.request.unit, amount: entry.request.amount },
                    availableProviders: availableCandidates.map(candidate => candidate.provider as QuoteProvider),
                    unavailableProviders: entry.candidates
                        .filter(candidate => candidate.status === 'unavailable')
                        .map(candidate => candidate.provider as QuoteProvider),
                    winner,
                    edgeBps: edge?.bps ?? null,
                });

                const best = providerQuotes.find((quote): quote is ExecutionBestQuote => quote.isBest) ?? null;
                // No winner means nothing quoted, whatever the upstream entry
                // claimed — report it as unavailable rather than emitting an
                // "available" row with a null best that callers must guard.
                if (entry.status === 'unavailable' || best === null) {
                    return {
                        request: entry.request,
                        status: 'unavailable',
                        reason: entry.status === 'unavailable' ? entry.reason : 'error',
                        best: null,
                        edge: null,
                        providerQuotes,
                    };
                }
                return {
                    request: entry.request,
                    status: entry.status,
                    best,
                    edge,
                    providerQuotes,
                };
            });

            const available = quotes.filter(quote => quote.status === 'available').length;
            const { providerStats, summary } = summarizeComparison({ providers, entries: summarizable });

            const response: ExecutionEvaluationResponse = {
                mint,
                side,
                providers: result.providers,
                token: {
                    mint,
                    symbol,
                    name,
                    decimals: tokenDecimals,
                    // Registry-listed today; the field exists so an unlisted-mint
                    // tier can flip it without a contract change.
                    verified: true,
                },
                quotes,
                meta: {
                    requested: quotes.length,
                    available,
                    unavailable: quotes.length - available,
                    // Duplicate amounts collapse silently; report how many.
                    deduped: rawAmounts.length - amounts.length,
                    // Honest cost echo: what this call spent upstream.
                    upstreamQuotes: quotes.length * providers.length,
                    limits: { maxAmounts: MAX_AMOUNTS, maxProviders: QUOTE_PROVIDERS.length },
                    tieBreak: QUOTE_PROVIDERS[0],
                    comparisonVersion: COMPARISON_VERSION,
                    amountSource,
                    defaultLadderUsd: amountSource === 'default' ? [...DEFAULT_LADDER_USD] : null,
                    tokenSource: token ? ('registry' as const) : ('upstream' as const),
                    providerStats,
                    summary,
                    warnings: [] as string[],
                },
            };
            return response;
        }),
    { platform: { requiredScopes: ['execution:read'] } },
);
