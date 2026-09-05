'use client';

import * as React from 'react';
import { ChevronDown, Info } from 'lucide-react';

import { Tooltip } from '@solana/design-system/tooltip';
import { Alert, AlertDescription, AlertTitle } from '@tokens/ui/alert';

import type {
    ExecutionEvaluationResponse,
    ExecutionQuoteEdge,
    ExecutionQuoteSide,
} from '@/hooks/queries/use-execution-evaluation';
import { CandidateComparison, ImpactValue, ProviderBadge } from './candidate-comparison';
import {
    formatExecutionRouterLabel,
    formatQuoteTime,
    formatTokenAmount,
    providerLabel,
    routeDetails,
    routeLabel,
} from '@/lib/execution-quote-format';

function formatRequestedAmount(amount: string, side: ExecutionQuoteSide): string {
    const numeric = Number(amount);
    if (side === 'sell') return amount;
    if (!Number.isFinite(numeric)) return `$${amount}`;
    if (numeric >= 1_000_000) {
        const millions = numeric / 1_000_000;
        return `$${Number.isInteger(millions) ? millions : millions.toFixed(2)}M`;
    }
    if (numeric >= 1_000) return `$${numeric / 1_000}K`;
    return `$${numeric.toLocaleString('en-US')}`;
}

function EdgeValue({ edge }: { edge: ExecutionQuoteEdge | null }) {
    if (!edge) {
        return (
            <Tooltip content="Only one router quoted this size, so there is nothing to compare." side="top" align="end">
                <span className="cursor-help text-text-extra-low">—</span>
            </Tooltip>
        );
    }
    const usd =
        Math.abs(edge.usd) >= 0.01 ? ` · +$${edge.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '';
    return (
        <Tooltip
            content={`Best output is ${edge.bps} bps above ${providerLabel(edge.runnerUp)} (+${edge.outAmountDiff}).`}
            side="top"
            align="end"
        >
            <span className={`cursor-help tabular-nums ${edge.bps > 0 ? 'text-green-800' : 'text-text-medium'}`}>
                +{edge.bps} bps{usd}
            </span>
        </Tooltip>
    );
}

/**
 * One-line verdict for the whole ladder. Only meaningful over contested sizes,
 * so it says so rather than implying a comparison that did not happen.
 */
function ComparisonSummary({ meta }: { meta: ExecutionEvaluationResponse['meta'] }) {
    const { summary } = meta;
    if (summary.comparableEntries === 0) {
        return (
            <p className="text-[11px] text-text-medium">
                {summary.bestProvider
                    ? `Only ${providerLabel(summary.bestProvider)} quoted, so there is nothing to compare.`
                    : 'No size had two routers quote, so there is nothing to compare.'}
            </p>
        );
    }

    const winner = summary.bestProvider;
    const wins = winner ? meta.providerStats[winner].wins : 0;
    return (
        <p className="text-[11px] text-text-medium">
            {winner ? (
                <>
                    <span className="font-medium text-text-extra-high">{providerLabel(winner)}</span> best on {wins} of{' '}
                    {summary.comparableEntries} compared {summary.comparableEntries === 1 ? 'size' : 'sizes'}
                </>
            ) : (
                <span className="font-medium text-text-extra-high">Evenly matched</span>
            )}
            {summary.medianEdgeBps !== null ? <> · median edge +{summary.medianEdgeBps} bps</> : null}
            {summary.maxEdgeBps !== null && summary.maxEdgeAt ? (
                <>
                    {' '}
                    · biggest +{summary.maxEdgeBps} bps at{' '}
                    {formatRequestedAmount(summary.maxEdgeAt.amount, summary.maxEdgeAt.unit === 'usd' ? 'buy' : 'sell')}
                </>
            ) : null}
        </p>
    );
}

function LoadingRow({ amount, side }: { amount: string; side: ExecutionQuoteSide }) {
    return (
        <tr>
            <td className="py-3 pl-4 pr-3 text-[14px] font-medium text-text-high tabular-nums">
                {formatRequestedAmount(amount, side)}
            </td>
            {Array.from({ length: 6 }, (_, index) => (
                <td key={index} className="px-3 py-3 last:pr-4">
                    <span className="ml-auto block h-3 w-20 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
                </td>
            ))}
        </tr>
    );
}

export function QuoteComparisonTable({
    data,
    isPending,
    isError,
    requestedAmounts,
    customAmount,
    side,
}: {
    data: ExecutionEvaluationResponse | null;
    isPending: boolean;
    isError: boolean;
    requestedAmounts: string[];
    customAmount: string | null;
    side: ExecutionQuoteSide;
}) {
    // The open row belongs to the response that produced it, so the expansion
    // is stored with that response and validated during render. Clearing it
    // from an effect instead would show the previous row's comparison against
    // fresh quotes for one paint.
    const [expanded, setExpanded] = React.useState<{
        source: ExecutionEvaluationResponse;
        rawAmount: string;
    } | null>(null);
    const expandedRawAmount = expanded?.source === data ? (expanded?.rawAmount ?? null) : null;

    const unavailable = data?.quotes.filter(quote => quote.status === 'unavailable') ?? [];
    const titanUnavailable =
        data?.quotes.filter(
            quote =>
                quote.status === 'available' &&
                quote.providerQuotes.some(
                    providerQuote => providerQuote.provider === 'titan' && providerQuote.status === 'unavailable',
                ),
        ) ?? [];
    const allUnavailable = Boolean(data && data.meta.available === 0);

    return (
        <section className="overflow-hidden rounded-[24px] border border-border-medium bg-white shadow-[0_8px_40px_rgba(0,0,0,0.03)]">
            <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse text-left">
                    <thead>
                        <tr className="border-b border-border-light bg-gray-50/80">
                            <th className="py-3 pl-4 pr-3 text-[11px] font-medium text-text-extra-low">Requested</th>
                            <th className="px-3 py-3 text-right text-[11px] font-medium text-text-extra-low">
                                You pay
                            </th>
                            <th className="px-3 py-3 text-right text-[11px] font-medium text-text-extra-low">
                                Best quoted output
                            </th>
                            <th className="px-3 py-3 text-right text-[11px] font-medium text-text-extra-low">Edge</th>
                            <th className="px-3 py-3 text-right text-[11px] font-medium text-text-extra-low">Impact</th>
                            <th className="px-3 py-3 text-right text-[11px] font-medium text-text-extra-low">
                                Winning route
                            </th>
                            <th className="px-3 py-3 pr-4 text-right text-[11px] font-medium text-text-extra-low">
                                Quoted
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border-extra-light">
                        {isPending
                            ? requestedAmounts.map(amount => <LoadingRow key={amount} amount={amount} side={side} />)
                            : data?.quotes.map(row => {
                                  const isCustom = customAmount !== null && row.request.amount === customAmount;
                                  const isExpanded = expandedRawAmount === row.request.rawAmount;
                                  const detailsId = `quote-comparison-${row.request.rawAmount}`;
                                  return (
                                      <React.Fragment key={row.request.rawAmount}>
                                          <tr>
                                              <td className="py-3 pl-4 pr-3 align-middle">
                                                  <span className="text-[14px] font-medium text-text-high tabular-nums">
                                                      {formatRequestedAmount(row.request.amount, side)}
                                                  </span>
                                                  {isCustom ? (
                                                      <span className="ml-2 rounded-full bg-[#F2F3F5] px-1.5 py-0.5 text-[10px] font-medium text-text-medium">
                                                          Your amount
                                                      </span>
                                                  ) : null}
                                              </td>
                                              {row.status === 'available' ? (
                                                  <>
                                                      <td
                                                          className="px-3 py-3 text-right text-[13px] text-text-high tabular-nums"
                                                          title={`${row.best.input.amount} ${row.best.input.symbol}`}
                                                      >
                                                          {formatTokenAmount(row.best.input.amount)}{' '}
                                                          {row.best.input.symbol}
                                                      </td>
                                                      <td
                                                          className="px-3 py-3 text-right text-[13px] font-medium text-text-extra-high tabular-nums"
                                                          title={`${row.best.output.amount} ${row.best.output.symbol}`}
                                                      >
                                                          {formatTokenAmount(row.best.output.amount)}{' '}
                                                          {row.best.output.symbol}
                                                      </td>
                                                      <td className="px-3 py-3 text-right text-[13px] tabular-nums">
                                                          <EdgeValue edge={row.edge} />
                                                      </td>
                                                      <td className="px-3 py-3 text-right text-[13px] text-text-high tabular-nums">
                                                          <ImpactValue
                                                              value={row.best.priceImpactPct}
                                                              source={row.best.priceImpactSource}
                                                          />
                                                      </td>
                                                      <td className="max-w-[250px] px-3 py-3 text-right text-[12px] text-text-medium">
                                                          <div className="flex items-center justify-end gap-2">
                                                              <ProviderBadge provider={row.best.provider} />
                                                              <Tooltip
                                                                  content={routeDetails(
                                                                      row.best.route,
                                                                      row.best.contextSlot,
                                                                  )}
                                                                  side="top"
                                                                  align="end"
                                                              >
                                                                  <span className="inline-block max-w-[180px] cursor-help truncate align-bottom">
                                                                      {row.best.router
                                                                          ? `${formatExecutionRouterLabel(row.best.router)} · `
                                                                          : ''}
                                                                      {routeLabel(row.best.route, row.best.provider)}
                                                                  </span>
                                                              </Tooltip>
                                                          </div>
                                                          <button
                                                              type="button"
                                                              className="mt-1 inline-flex items-center gap-1 rounded text-[10px] font-medium text-text-low outline-none transition-colors hover:text-text-high focus-visible:ring-2 focus-visible:ring-blue-500 active:scale-[0.98]"
                                                              aria-expanded={isExpanded}
                                                              aria-controls={detailsId}
                                                              onClick={() =>
                                                                  setExpanded(
                                                                      isExpanded || !data
                                                                          ? null
                                                                          : {
                                                                                source: data,
                                                                                rawAmount: row.request.rawAmount,
                                                                            },
                                                                  )
                                                              }
                                                          >
                                                              {isExpanded ? 'Hide comparison' : 'View comparison'}
                                                              <ChevronDown
                                                                  className={`size-3 ${isExpanded ? 'rotate-180' : ''}`}
                                                                  aria-hidden
                                                              />
                                                          </button>
                                                      </td>
                                                      <td
                                                          className="px-3 py-3 pr-4 text-right text-[11px] text-text-extra-low tabular-nums"
                                                          title={row.best.quotedAt}
                                                      >
                                                          {formatQuoteTime(row.best.quotedAt)}
                                                      </td>
                                                  </>
                                              ) : (
                                                  <td colSpan={6} className="px-3 py-3 pr-4 text-right">
                                                      <span className="block text-[12px] font-medium text-text-high">
                                                          Quote unavailable
                                                      </span>
                                                      <span className="block text-[10px] text-text-extra-low">
                                                          Neither Titan nor Jupiter could provide this route right now.
                                                      </span>
                                                  </td>
                                              )}
                                          </tr>
                                          {row.status === 'available' && isExpanded ? (
                                              <tr id={detailsId}>
                                                  <td colSpan={7}>
                                                      <CandidateComparison candidates={row.providerQuotes} />
                                                  </td>
                                              </tr>
                                          ) : null}
                                      </React.Fragment>
                                  );
                              })}
                    </tbody>
                </table>
            </div>

            <div className="border-t border-border-extra-light p-4">
                <Alert className="rounded-xl border-border-light bg-gray-50/80 px-4 py-3 text-text-medium">
                    <Info className="size-4 text-text-low" aria-hidden />
                    <AlertTitle className="text-[12px] font-medium text-text-high">
                        {isError || allUnavailable ? 'Quotes unavailable' : 'Titan + Jupiter Swap V2 · Live comparison'}
                    </AlertTitle>
                    <AlertDescription className="space-y-1 text-[11px] text-text-low">
                        {data && !isPending ? <ComparisonSummary meta={data.meta} /> : null}
                        {isError ? (
                            <p>Titan and Jupiter could not provide fresh quotes. No previous quote was substituted.</p>
                        ) : null}
                        {unavailable.length > 0 ? (
                            <p>
                                No quote found right now for:{' '}
                                <span className="font-medium text-text-high">
                                    {unavailable.map(row => formatRequestedAmount(row.request.amount, side)).join(', ')}
                                </span>
                                .
                            </p>
                        ) : null}
                        {titanUnavailable.length > 0 ? (
                            <p>
                                Titan could not provide quotes for:{' '}
                                <span className="font-medium text-text-high">
                                    {titanUnavailable
                                        .map(row => formatRequestedAmount(row.request.amount, side))
                                        .join(', ')}
                                </span>
                                . Jupiter results are shown without substitution.
                            </p>
                        ) : null}
                        <p>
                            Jupiter quotes use Swap V2’s fee-inclusive best result across its available routing engines.
                            The highest quoted output between Titan and Jupiter is shown for each amount. Outputs and
                            routes can change before execution. These are quotes, not an execution guarantee.
                        </p>
                    </AlertDescription>
                </Alert>
            </div>
        </section>
    );
}
