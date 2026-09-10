'use client';

import { useMutation } from '@tanstack/react-query';
import { Effect } from 'effect';

import { apiJson } from '@/effect/api-client';

/**
 * The response shape is imported from the endpoint's own contract module rather
 * than transcribed here. The route annotates its return value with the same
 * types, so this app cannot drift from the API it dogfoods. The module is
 * import-free by design, so nothing server-only follows it into the bundle
 * (and these are type-only imports, erased at compile time regardless).
 */
export type {
    ExecutionEvaluationMeta,
    ExecutionEvaluationResponse,
    ExecutionProviderQuote,
    ExecutionQuoteFees,
    ExecutionQuoteAmount,
    ExecutionQuoteRequest,
    ExecutionQuoteRow,
    ExecutionQuoteSide,
    ExecutionRouteStep as ExecutionQuoteRouteStep,
    PriceImpactSource,
    QuoteUnavailableReason,
    ComparisonSummary as ExecutionComparisonSummary,
    ProviderStat as ExecutionProviderStat,
    QuoteEdge as ExecutionQuoteEdge,
    QuoteProvider as ExecutionQuoteProvider,
} from '../../../../api/src/app/api/v2/execution/evaluate/contract';

import type {
    ExecutionEvaluationResponse,
    ExecutionQuoteSide,
} from '../../../../api/src/app/api/v2/execution/evaluate/contract';

export interface ExecutionQuoteRequestArgs {
    mint: string;
    side: ExecutionQuoteSide;
    amounts: string[];
}

export const EVALUATE_ENDPOINT_PATH = '/api/v2/execution/evaluate';

/**
 * The request path for one evaluation.
 *
 * Exported because the page shows callers the exact request it is making: a
 * snippet built by separate string-assembly would drift from the real call the
 * first time a param changed, which is worse than showing no snippet at all.
 * Both the fetch below and the displayed code come from here.
 */
export function buildEvaluateRequestPath(args: ExecutionQuoteRequestArgs): string {
    const params = new URLSearchParams({ mint: args.mint, side: args.side });
    const key = args.side === 'buy' ? 'amountUsd' : 'tokenAmount';
    for (const amount of args.amounts) params.append(key, amount);
    return `${EVALUATE_ENDPOINT_PATH}?${params.toString()}`;
}

export function useExecutionEvaluation() {
    const mutation = useMutation<ExecutionEvaluationResponse, unknown, ExecutionQuoteRequestArgs>({
        mutationKey: ['execution', 'evaluate'],
        retry: false,
        mutationFn: async args =>
            Effect.runPromise(
                apiJson<ExecutionEvaluationResponse>({
                    url: buildEvaluateRequestPath(args),
                    init: { cache: 'no-store' },
                }),
            ),
    });

    return {
        data: mutation.data ?? null,
        error: mutation.error ?? null,
        isError: mutation.isError,
        isPending: mutation.isPending,
        // Swallow the rejection: callers read `error`, and an unhandled promise
        // from a fire-and-forget click handler would surface as a console error.
        execute: (args: ExecutionQuoteRequestArgs) => mutation.mutateAsync(args).catch(() => null),
        reset: mutation.reset,
    };
}
