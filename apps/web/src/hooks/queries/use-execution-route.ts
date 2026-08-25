'use client';

import { useMutation } from '@tanstack/react-query';
import { Effect } from 'effect';

import { apiJson } from '@/effect/api-client';

/**
 * Types come from the endpoint's own contract module (import-free by design),
 * exactly like the evaluate hook — the dogfood app cannot drift from the API.
 */
export type {
    AllocationLeg,
    AllocationPlan,
    AllocationStatus,
    ExecutionRouteMeta,
    ExecutionRouteResponse,
    ExcludedVariant,
    ParityBasis,
    RoutedVariant,
    VariantCurveRung,
} from '../../../../api/src/app/api/v2/execution/route/contract';

import type { ExecutionRouteResponse } from '../../../../api/src/app/api/v2/execution/route/contract';

export const ROUTE_ENDPOINT_PATH = '/api/v2/execution/route';

export interface ExecutionRouteRequestArgs {
    assetId: string;
    amountUsd: string;
}

/**
 * The request path for one routing call. Exported because the page shows the
 * exact request it makes — the same builder feeds the fetch and the snippet,
 * so the code on screen can never drift from the call.
 */
export function buildRouteRequestPath(args: ExecutionRouteRequestArgs): string {
    const params = new URLSearchParams({ assetId: args.assetId, amountUsd: args.amountUsd });
    return `${ROUTE_ENDPOINT_PATH}?${params.toString()}`;
}

/**
 * One deliberate routing call per click — a mutation, not a query: each call
 * spends ~40 real upstream quotes, so it must never refetch on focus, retry,
 * or serve from cache.
 */
export function useExecutionRoute() {
    const mutation = useMutation<ExecutionRouteResponse, unknown, ExecutionRouteRequestArgs>({
        mutationKey: ['execution', 'route'],
        retry: false,
        mutationFn: async args =>
            Effect.runPromise(
                apiJson<ExecutionRouteResponse>({
                    url: buildRouteRequestPath(args),
                    init: { cache: 'no-store' },
                }),
            ),
    });

    return {
        data: mutation.data ?? null,
        error: mutation.error ?? null,
        isError: mutation.isError,
        isPending: mutation.isPending,
        execute: (args: ExecutionRouteRequestArgs) => mutation.mutateAsync(args).catch(() => null),
        reset: mutation.reset,
    };
}
