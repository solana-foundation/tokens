/**
 * The public response contract for GET /v2/execution/evaluate.
 *
 * Deliberately import-free apart from `./comparison` (itself dependency-free)
 * so consumers outside this app can `import type` it by path without dragging
 * in `server-only`, the `@/` aliases, or anything else that only resolves
 * inside apps/api.
 */

import type { ComparisonSummary, PriceImpactSource, ProviderStat, QuoteEdge, QuoteProvider } from './comparison';

export type { ComparisonSummary, PriceImpactSource, ProviderStat, QuoteEdge, QuoteProvider };

export type ExecutionQuoteSide = 'buy' | 'sell';

/** Kept in sync with the handler's QUOTE_UNAVAILABLE_REASONS. */
export type QuoteUnavailableReason = 'no_route' | 'timeout' | 'auth' | 'malformed' | 'error';

export interface ExecutionRouteStep {
    ammKey: string | null;
    label: string | null;
    percent: number | null;
    inputMint: string | null;
    outputMint: string | null;
    inAmountRaw: string | null;
    outAmountRaw: string | null;
    feeAmountRaw: string | null;
    feeMint: string | null;
}

export interface ExecutionQuoteAmount {
    mint: string;
    symbol: string;
    decimals: number;
    amount: string;
    rawAmount: string;
}

export interface ExecutionQuoteRequest {
    unit: 'usd' | 'token';
    amount: string;
    rawAmount: string;
}

export interface ExecutionQuoteFees {
    feeBps: number | null;
    feeMint: string | null;
    platformFee: {
        amountRaw: string | null;
        feeBps: number | null;
        feeMint: string | null;
    } | null;
}

/** One provider's answer at one size. `rank` is 1-based among available. */
export type ExecutionProviderQuote =
    | {
          provider: QuoteProvider;
          status: 'available';
          rank: number | null;
          isBest: boolean;
          input: ExecutionQuoteAmount;
          output: ExecutionQuoteAmount;
          effectivePrice: string | null;
          priceImpactPct: number | null;
          priceImpactSource: PriceImpactSource;
          route: readonly ExecutionRouteStep[];
          contextSlot: number | null;
          router: string | null;
          mode: string | null;
          fees: ExecutionQuoteFees | null;
          quotedAt: string;
      }
    | {
          provider: QuoteProvider;
          status: 'unavailable';
          reason: QuoteUnavailableReason;
          rank: null;
          isBest: false;
          input: null;
          output: null;
          effectivePrice: null;
          priceImpactPct: null;
          priceImpactSource: PriceImpactSource;
          route: readonly ExecutionRouteStep[];
          contextSlot: null;
          router: null;
          mode: null;
          fees: null;
          quotedAt: string;
      };

/** A winning quote is by construction an available one. */
export type ExecutionBestQuote = Extract<ExecutionProviderQuote, { status: 'available' }>;

/**
 * One requested size: who won, by how much, and everyone's answer. An
 * `available` row always names a winner.
 */
export type ExecutionQuoteRow =
    | {
          request: ExecutionQuoteRequest;
          status: 'available';
          best: ExecutionBestQuote;
          edge: QuoteEdge | null;
          providerQuotes: ExecutionProviderQuote[];
      }
    | {
          request: ExecutionQuoteRequest;
          status: 'unavailable';
          reason: QuoteUnavailableReason;
          best: null;
          edge: null;
          providerQuotes: ExecutionProviderQuote[];
      };

export interface ExecutionEvaluationMeta {
    requested: number;
    available: number;
    unavailable: number;
    deduped: number;
    upstreamQuotes: number;
    limits: { maxAmounts: number; maxProviders: number };
    tieBreak: QuoteProvider;
    comparisonVersion: string;
    amountSource: 'request' | 'default';
    defaultLadderUsd: number[] | null;
    tokenSource: 'registry' | 'upstream';
    providerStats: Record<QuoteProvider, ProviderStat>;
    summary: ComparisonSummary;
    warnings: string[];
}

export interface ExecutionEvaluationResponse {
    mint: string;
    side: ExecutionQuoteSide;
    providers: readonly QuoteProvider[];
    token: { mint: string; symbol: string; name: string; decimals: number; verified: boolean };
    quotes: ExecutionQuoteRow[];
    meta: ExecutionEvaluationMeta;
}
