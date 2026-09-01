import type {
    DepthSampleResult,
    ExecutionQuotesLiveResult,
    JupiterTokenMetadata,
} from '../../../../cloudrun-assets/src/handlers/liveQuotes';

import { Schema, type Effect } from 'effect';

import { cloudRunMutation, cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

/**
 * Raw amounts cross the wire as decimal strings and the route feeds them
 * straight to BigInt(). Validating the digits here turns malformed upstream
 * data into a tagged UpstreamDataError at the boundary instead of a BigInt
 * SyntaxError thrown mid-serialization.
 */
const RawAmount = Schema.String.check(Schema.isPattern(/^\d+$/));

const RouteStepSchema = Schema.Struct({
    ammKey: Schema.NullOr(Schema.String),
    label: Schema.NullOr(Schema.String),
    percent: Schema.NullOr(Schema.Number),
    inputMint: Schema.NullOr(Schema.String),
    outputMint: Schema.NullOr(Schema.String),
    inAmountRaw: Schema.NullOr(RawAmount),
    outAmountRaw: Schema.NullOr(RawAmount),
    feeAmountRaw: Schema.NullOr(RawAmount),
    feeMint: Schema.NullOr(Schema.String),
});

const ProviderSchema = Schema.Literals(['jupiter', 'titan']);
const ReasonSchema = Schema.Literals(['no_route', 'timeout', 'auth', 'malformed', 'error']);
const FeesSchema = Schema.NullOr(
    Schema.Struct({
        feeBps: Schema.NullOr(Schema.Number),
        feeMint: Schema.NullOr(Schema.String),
        platformFee: Schema.NullOr(
            Schema.Struct({
                amountRaw: Schema.NullOr(RawAmount),
                feeBps: Schema.NullOr(Schema.Number),
                feeMint: Schema.NullOr(Schema.String),
            }),
        ),
    }),
);

/**
 * Available and unavailable candidates are separate members rather than one
 * struct of nullables: it is exactly the "available implies a usable
 * outAmountRaw" guarantee the comparison math depends on.
 */
const CandidateSchema = Schema.Union([
    Schema.Struct({
        provider: ProviderSchema,
        status: Schema.Literal('available'),
        inAmountRaw: RawAmount,
        outAmountRaw: RawAmount,
        priceImpactPct: Schema.NullOr(Schema.Number),
        route: Schema.Array(RouteStepSchema),
        contextSlot: Schema.NullOr(Schema.Number),
        router: Schema.NullOr(Schema.String),
        mode: Schema.NullOr(Schema.String),
        fees: FeesSchema,
        quotedAt: Schema.String,
    }),
    Schema.Struct({
        provider: ProviderSchema,
        status: Schema.Literal('unavailable'),
        reason: ReasonSchema,
        inAmountRaw: Schema.Null,
        outAmountRaw: Schema.Null,
        priceImpactPct: Schema.Null,
        route: Schema.Array(RouteStepSchema),
        contextSlot: Schema.Null,
        router: Schema.Null,
        mode: Schema.Null,
        fees: Schema.Null,
        quotedAt: Schema.String,
    }),
]);

const RequestSchema = Schema.Struct({
    unit: Schema.Literals(['usd', 'token']),
    amount: Schema.String,
    rawAmount: RawAmount,
});

/**
 * The entry's hoisted winner fields are the handler's own legacy shape; the
 * route reads `candidates`. They stay in the schema because strict decoding
 * would otherwise drop them, and a future reader may still want them.
 */
const EntrySchema = Schema.Union([
    Schema.Struct({
        request: RequestSchema,
        status: Schema.Literal('available'),
        provider: ProviderSchema,
        inAmountRaw: RawAmount,
        outAmountRaw: RawAmount,
        priceImpactPct: Schema.NullOr(Schema.Number),
        route: Schema.Array(RouteStepSchema),
        contextSlot: Schema.NullOr(Schema.Number),
        router: Schema.NullOr(Schema.String),
        mode: Schema.NullOr(Schema.String),
        fees: FeesSchema,
        quotedAt: Schema.String,
        candidates: Schema.Array(CandidateSchema),
    }),
    Schema.Struct({
        request: RequestSchema,
        status: Schema.Literal('unavailable'),
        reason: ReasonSchema,
        provider: Schema.Null,
        inAmountRaw: Schema.Null,
        outAmountRaw: Schema.Null,
        priceImpactPct: Schema.Null,
        route: Schema.Array(RouteStepSchema),
        contextSlot: Schema.Null,
        router: Schema.Null,
        mode: Schema.Null,
        fees: Schema.Null,
        quotedAt: Schema.String,
        candidates: Schema.Array(CandidateSchema),
    }),
]);

const ExecutionQuotesLiveResultSchema = Schema.Struct({
    providers: Schema.Array(ProviderSchema),
    mint: Schema.String,
    side: Schema.Literals(['buy', 'sell']),
    quoteMint: Schema.String,
    entries: Schema.Array(EntrySchema),
});

/**
 * Compile-time guard that the schema still describes the handler's type. The
 * array-valued fields are excluded: Schema.Array decodes to readonly arrays,
 * which are not assignable to the handler's mutable ones even though the wire
 * payload is identical. Every discriminant and raw-amount field is covered.
 */
type AssertAssignable<_A extends B, B> = never;
type SchemaEntry = Schema.Schema.Type<typeof ExecutionQuotesLiveResultSchema>['entries'][number];
type HandlerEntry = ExecutionQuotesLiveResult['entries'][number];
type _EntryDrift = AssertAssignable<
    Omit<SchemaEntry, 'route' | 'candidates' | 'request'>,
    Omit<HandlerEntry, 'route' | 'candidates' | 'request'>
>;
type _RequestDrift = AssertAssignable<SchemaEntry['request'], HandlerEntry['request']>;
type _CandidateDrift = AssertAssignable<
    Omit<SchemaEntry['candidates'][number], 'route'>,
    Omit<HandlerEntry['candidates'][number], 'route'>
>;
type _RouteStepDrift = AssertAssignable<Schema.Schema.Type<typeof RouteStepSchema>, HandlerEntry['route'][number]>;

export type ExecutionQuotesLiveArgs = {
    mint: string;
    side: 'buy' | 'sell';
    amounts: string[];
    tokenDecimals: number;
    /** Fan-out wall-clock budget; the handler returns partial results past it. */
    timeoutMs?: number;
    /** Narrow the provider set to trade comparison breadth for cost. */
    providers?: ('jupiter' | 'titan')[];
    /**
     * Per-provider routing restrictions for restricted re-quotes (the
     * leg-overlap fix). Callers must effect-verify the returned routes.
     */
    restrictions?: Partial<
        Record<'jupiter' | 'titan', { onlyDirectRoutes?: boolean; excludeDexes?: string[] }>
    >;
};

/**
 * The transport timeout sits above the handler's own budget so the handler is
 * the layer that gives up first and can answer with partial results.
 */
const QUOTE_FANOUT_BUDGET_MS = 12_000;
const QUOTE_TRANSPORT_TIMEOUT_MS = 14_000;

export function executionQuotesLive(
    args: ExecutionQuotesLiveArgs,
): Effect.Effect<ExecutionQuotesLiveResult, CloudRunError> {
    return cloudRunQuery<ExecutionQuotesLiveResult>(
        'assets',
        'executionQuotesLive',
        { timeoutMs: QUOTE_FANOUT_BUDGET_MS, ...args },
        { timeoutMs: QUOTE_TRANSPORT_TIMEOUT_MS, schema: ExecutionQuotesLiveResultSchema },
    );
}

export type ExecutionQuoteTokenMetadataArgs = { mint: string };

export function executionQuoteTokenMetadata(
    args: ExecutionQuoteTokenMetadataArgs,
): Effect.Effect<JupiterTokenMetadata | null, CloudRunError> {
    return cloudRunQuery<JupiterTokenMetadata | null>('assets', 'executionQuoteTokenMetadata', { ...args });
}

export type DepthSampleMintsArgs = { mints: string[] };

export function depthSampleMints(args: DepthSampleMintsArgs): Effect.Effect<DepthSampleResult, CloudRunError> {
    return cloudRunMutation<DepthSampleResult>('assets', 'depthSampleMints', { ...args });
}
