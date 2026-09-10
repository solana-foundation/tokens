'use client';

/**
 * The per-provider quote breakdown, shared by the single-mint comparison table
 * and the routing page's variant drill-down: who quoted, on which router, and
 * what they returned at one size.
 */

import * as React from 'react';

import { Tooltip } from '@solana/design-system/tooltip';

import type {
    ExecutionProviderQuote,
    ExecutionQuoteProvider,
    PriceImpactSource,
} from '@/hooks/queries/use-execution-evaluation';
import {
    feeMintLabel,
    formatExecutionRouterLabel,
    formatPriceImpactRatio,
    formatQuoteTime,
    formatTokenAmount,
    fullPriceImpactRatio,
    providerLabel,
    routeDetails,
    routeLabel,
} from '@/lib/execution-quote-format';

export function FeeValue({ candidate }: { candidate: Extract<ExecutionProviderQuote, { status: 'available' }> }) {
    const fees = candidate.fees;
    if (!fees) {
        return (
            <Tooltip content="This provider did not report fee details for the quote." side="top" align="end">
                <span className="cursor-help">—</span>
            </Tooltip>
        );
    }
    const feeMint = feeMintLabel(candidate, fees.feeMint);
    const summary = `${fees.feeBps === null ? 'Fee reported' : `${fees.feeBps} bps`} · ${feeMint}`;
    const details = [
        `Total fee: ${fees.feeBps === null ? 'Not provided' : `${fees.feeBps} bps`}`,
        `Fee mint: ${fees.feeMint ?? 'Not provided'}${fees.feeMint ? ` (${feeMint})` : ''}`,
        `Platform fee: ${fees.platformFee?.feeBps === null || fees.platformFee?.feeBps === undefined ? 'Not provided' : `${fees.platformFee.feeBps} bps`}`,
        `Platform fee mint: ${fees.platformFee?.feeMint ?? 'Not provided'}`,
        `Platform fee amount: ${fees.platformFee?.amountRaw === null || fees.platformFee?.amountRaw === undefined ? 'Not provided' : `${fees.platformFee.amountRaw} raw units`}`,
        'Jupiter’s quoted output already reflects its quoted fee treatment.',
    ].join('\n');
    return (
        <Tooltip content={details} side="top" align="end">
            <span className="cursor-help whitespace-nowrap tabular-nums">{summary}</span>
        </Tooltip>
    );
}

export function ProviderBadge({ provider }: { provider: ExecutionQuoteProvider }) {
    const color =
        provider === 'titan'
            ? 'border-violet-200 bg-violet-50 text-violet-800'
            : 'border-emerald-200 bg-emerald-50 text-emerald-800';
    return (
        <span className={`inline-flex shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
            {providerLabel(provider)}
        </span>
    );
}

export function ImpactValue({ value, source }: { value: number | null; source: PriceImpactSource }) {
    if (value === null) {
        return (
            <Tooltip
                content={
                    source === 'unavailable'
                        ? 'This router does not report price impact for the quote.'
                        : 'No price impact reported for this quote.'
                }
                side="top"
                align="end"
            >
                <span className="cursor-help">—</span>
            </Tooltip>
        );
    }
    return <span title={fullPriceImpactRatio(value)}>{formatPriceImpactRatio(value)}</span>;
}

/** How much the winner beat the runner-up by, in bps and dollars. */

export function CandidateComparison({ candidates }: { candidates: ExecutionProviderQuote[] }) {
    return (
        <div
            className="px-4 py-4"
            style={{
                backgroundImage: `repeating-linear-gradient(
                    45deg,
                    transparent,
                    transparent 10px,
                    rgba(233, 231, 222, 0.5) 10px,
                    rgba(233, 231, 222, 0.5) 11px
                )`,
            }}
        >
            <div className="overflow-x-auto rounded-xl border border-border-medium bg-white">
                <table className="w-full min-w-[1040px] border-collapse text-left">
                    <thead>
                        <tr className="border-b border-border-extra-light bg-gray-50/70">
                            {[
                                ['Provider', false],
                                ['Router', false],
                                ['Status', false],
                                ['Quoted output', true],
                                ['Impact', true],
                                ['Fees', true],
                                ['Route', true],
                                ['Context slot', true],
                                ['Time', true],
                            ].map(([label, right]) => (
                                <th
                                    key={String(label)}
                                    className={`px-3 py-2 text-[10px] font-medium text-text-extra-low ${right ? 'text-right' : ''}`}
                                >
                                    {label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border-light">
                        {candidates.map(candidate => {
                            const isWinner = candidate.isBest;
                            return (
                                <tr key={candidate.provider}>
                                    <td className="px-3 py-3">
                                        <ProviderBadge provider={candidate.provider} />
                                    </td>
                                    <td className="px-3 py-3 text-[11px] font-medium text-text-high">
                                        {candidate.status === 'available' ? (
                                            <Tooltip
                                                content={
                                                    candidate.mode
                                                        ? `Jupiter quote mode: ${candidate.mode}`
                                                        : 'No internal router reported.'
                                                }
                                                side="top"
                                                align="start"
                                            >
                                                <span className={candidate.router ? 'cursor-help' : ''}>
                                                    {formatExecutionRouterLabel(candidate.router)}
                                                </span>
                                            </Tooltip>
                                        ) : (
                                            '—'
                                        )}
                                    </td>
                                    <td className="px-3 py-3 text-[11px] text-text-medium">
                                        {candidate.status === 'available' ? (
                                            isWinner ? (
                                                <span className="rounded-full bg-gray-900 px-1.5 py-0.5 text-[9px] font-medium text-white">
                                                    Best quote
                                                </span>
                                            ) : (
                                                'Available'
                                            )
                                        ) : (
                                            <span className="font-medium text-text-high">Quote unavailable</span>
                                        )}
                                    </td>
                                    {candidate.status === 'available' ? (
                                        <>
                                            <td
                                                className="px-3 py-3 text-right text-[11px] font-medium text-text-high tabular-nums"
                                                title={`${candidate.output.amount} ${candidate.output.symbol}`}
                                            >
                                                {formatTokenAmount(candidate.output.amount)} {candidate.output.symbol}
                                            </td>
                                            <td className="px-3 py-3 text-right text-[11px] text-text-medium tabular-nums">
                                                <ImpactValue
                                                    value={candidate.priceImpactPct}
                                                    source={candidate.priceImpactSource}
                                                />
                                            </td>
                                            <td className="px-3 py-3 text-right text-[11px] text-text-medium">
                                                <FeeValue candidate={candidate} />
                                            </td>
                                            <td className="max-w-[190px] px-3 py-3 text-right text-[11px] text-text-medium">
                                                <Tooltip
                                                    content={routeDetails(candidate.route, candidate.contextSlot)}
                                                    side="top"
                                                    align="end"
                                                >
                                                    <span className="inline-block max-w-[180px] cursor-help truncate align-bottom">
                                                        {routeLabel(candidate.route, candidate.provider)}
                                                    </span>
                                                </Tooltip>
                                            </td>
                                            <td className="px-3 py-3 text-right text-[11px] text-text-medium tabular-nums">
                                                {candidate.contextSlot ?? '—'}
                                            </td>
                                            <td
                                                className="px-3 py-3 text-right text-[11px] text-text-extra-low tabular-nums"
                                                title={candidate.quotedAt}
                                            >
                                                {formatQuoteTime(candidate.quotedAt)}
                                            </td>
                                        </>
                                    ) : (
                                        <td
                                            colSpan={6}
                                            className="px-3 py-3 text-right text-[11px] text-text-extra-low"
                                        >
                                            This provider could not return a fresh quote.
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
