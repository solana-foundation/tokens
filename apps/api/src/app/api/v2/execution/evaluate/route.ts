import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import {
    COMPARISON_VERSION,
    formatRawAmount,
    QUOTE_PROVIDERS,
    summarizeComparison,
    type QuoteProvider,
} from './comparison';
import type { ExecutionEvaluationResponse } from './contract';
import { serializeQuoteRows } from './serialize';
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

            const { quotes, summarizable } = serializeQuoteRows({
                entries: result.entries,
                side,
                inputToken,
                outputToken,
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
