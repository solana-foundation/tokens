'use client';

import * as React from 'react';
import { Info } from 'lucide-react';

import { Tooltip } from '@solana/design-system/tooltip';
import { Alert, AlertDescription, AlertTitle } from '@tokens/ui/alert';

import type { ExecutionRouteResponse, RoutedVariant } from '@/hooks/queries/use-execution-route';

/** Mirrors the API's impact grading thresholds for at-a-glance reading. */
function impactTone(impactBps: number | null): string {
    if (impactBps === null) return 'text-text-extra-low';
    if (impactBps <= 10) return 'text-green-700';
    if (impactBps <= 50) return 'text-green-600';
    if (impactBps <= 150) return 'text-amber-600';
    if (impactBps <= 500) return 'text-orange-600';
    return 'text-red-700';
}

function formatUsd(value: number | string): string {
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(numeric)) return String(value);
    if (numeric >= 1_000_000) return `$${(numeric / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`;
    if (numeric >= 1_000) return `$${(numeric / 1_000).toLocaleString('en-US', { maximumFractionDigits: 0 })}K`;
    return `$${numeric.toLocaleString('en-US')}`;
}

function formatBps(bps: number): string {
    return `${bps >= 0 ? '+' : ''}${bps.toLocaleString('en-US', { maximumFractionDigits: 2 })} bps`;
}

function AllocationHeadline({ data }: { data: ExecutionRouteResponse }) {
    const { allocation } = data;
    if (!allocation) return null;
    const edge = allocation.edge.vsBestSingleVariant;
    return (
        <div className="border-b border-border-extra-light bg-gray-50/40 px-4 py-3">
            <p className="text-[13px] text-text-high">
                {allocation.fellBackToSingleVariant ? (
                    <>
                        Re-quoting turned the split into a loss — recommending all-in{' '}
                        <span className="font-medium text-text-extra-high">{allocation.legs[0]?.symbol}</span> instead
                    </>
                ) : edge && edge.bps > 0.5 ? (
                    <>
                        Splitting beats all-in{' '}
                        <span className="font-medium text-text-extra-high">{edge.baselineSymbol}</span> by{' '}
                        <span className="font-medium text-green-700">{formatBps(edge.bps)}</span>
                        {' · '}
                        <span className="font-medium text-green-700">
                            +${edge.usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </span>{' '}
                        on {formatUsd(allocation.targetUsd)}
                    </>
                ) : (
                    <>
                        One variant is best here — no split needed at {formatUsd(allocation.targetUsd)}
                        {edge ? ` (edge ${formatBps(edge.bps)})` : ''}
                    </>
                )}
                {allocation.totalExpectedOut ? (
                    <span className="text-text-medium">
                        {' '}
                        · expected {allocation.totalExpectedOut.amount} {allocation.outputUnit.symbol}
                    </span>
                ) : null}
                {allocation.repaired ? (
                    <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                        repaired: a collapsed re-quote was distrusted
                    </span>
                ) : null}
            </p>
        </div>
    );
}

function AllocationLegsTable({ data }: { data: ExecutionRouteResponse }) {
    const { allocation } = data;
    if (!allocation) return null;
    return (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
                <thead>
                    <tr className="border-b border-border-light bg-gray-50/80">
                        <th className="py-2.5 pl-4 pr-3 text-[11px] font-medium text-text-extra-low">Leg</th>
                        <th className="px-3 py-2.5 text-right text-[11px] font-medium text-text-extra-low">Amount</th>
                        <th className="px-3 py-2.5 text-right text-[11px] font-medium text-text-extra-low">Share</th>
                        <th className="px-3 py-2.5 text-right text-[11px] font-medium text-text-extra-low">Router</th>
                        <th className="px-3 py-2.5 text-right text-[11px] font-medium text-text-extra-low">
                            Expected out
                        </th>
                        <th className="px-3 py-2.5 text-right text-[11px] font-medium text-text-extra-low">Impact</th>
                        <th className="px-3 py-2.5 pr-4 text-right text-[11px] font-medium text-text-extra-low">
                            Verified
                        </th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border-extra-light">
                    {allocation.legs.map(leg => (
                        <tr key={leg.mint}>
                            <td className="py-2.5 pl-4 pr-3 text-[13px] font-medium text-text-extra-high">
                                {leg.symbol}
                            </td>
                            <td className="px-3 py-2.5 text-right text-[13px] text-text-high tabular-nums">
                                ${Number(leg.amountUsd).toLocaleString('en-US')}
                            </td>
                            <td className="px-3 py-2.5 text-right text-[12px] text-text-medium tabular-nums">
                                {(leg.shareOfTarget * 100).toFixed(1)}%
                            </td>
                            <td className="px-3 py-2.5 text-right text-[12px] text-text-medium">
                                {leg.provider ?? '—'}
                                {leg.router ? <span className="text-text-extra-low"> · {leg.router}</span> : null}
                            </td>
                            <td className="px-3 py-2.5 text-right text-[12px] text-text-high tabular-nums">
                                {leg.expectedOut ? `${leg.expectedOut.amount} ${leg.symbol}` : '—'}
                            </td>
                            <td
                                className={`px-3 py-2.5 text-right text-[12px] tabular-nums ${impactTone(leg.impactBps)}`}
                            >
                                {leg.impactBps === null ? '—' : `${leg.impactBps.toFixed(2)} bps`}
                            </td>
                            <td className="px-3 py-2.5 pr-4 text-right text-[12px] tabular-nums">
                                {leg.verification.status === 'verified' ? (
                                    <Tooltip
                                        content="Re-quoted at exactly this size after allocation. The delta is how far the curve's interpolation was off."
                                        side="top"
                                        align="end"
                                    >
                                        <span className="cursor-help text-green-700">
                                            ✓
                                            {leg.verification.deltaBps !== null
                                                ? ` ${formatBps(leg.verification.deltaBps)}`
                                                : ''}
                                        </span>
                                    </Tooltip>
                                ) : (
                                    <Tooltip
                                        content="The verification quote failed; these numbers are interpolated from the probe curve."
                                        side="top"
                                        align="end"
                                    >
                                        <span className="cursor-help text-amber-600">interpolated</span>
                                    </Tooltip>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function VariantMatrix({ data }: { data: ExecutionRouteResponse }) {
    const sizes = data.meta.probeLadderUsd;
    return (
        <div className="overflow-x-auto border-t border-border-extra-light">
            <table className="w-full min-w-[720px] border-collapse text-left">
                <thead>
                    <tr className="border-b border-border-light bg-gray-50/80">
                        <th className="py-2.5 pl-4 pr-3 text-[11px] font-medium text-text-extra-low">
                            Variant · impact by size
                        </th>
                        {sizes.map(sizeUsd => (
                            <th
                                key={sizeUsd}
                                className="px-3 py-2.5 text-right text-[11px] font-medium text-text-extra-low"
                            >
                                {formatUsd(sizeUsd)}
                            </th>
                        ))}
                        <th className="px-3 py-2.5 pr-4 text-right text-[11px] font-medium text-text-extra-low">
                            Liquidity
                        </th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border-extra-light">
                    {data.variants.map((variant: RoutedVariant) => (
                        <tr key={variant.mint}>
                            <td className="py-2.5 pl-4 pr-3">
                                <span className="text-[13px] font-medium text-text-extra-high">{variant.symbol}</span>
                                <span className="ml-2 text-[10px] text-text-extra-low">
                                    #{variant.rank}
                                    {variant.issuer ? ` · ${variant.issuer}` : ''}
                                    {!variant.allocationEligible ? ' · not allocatable' : ''}
                                </span>
                            </td>
                            {sizes.map(sizeUsd => {
                                const rung = variant.curve.rungs.find(r => r.sizeUsd === sizeUsd);
                                const impact = rung?.impactBps ?? null;
                                return (
                                    <td
                                        key={sizeUsd}
                                        className={`px-3 py-2.5 text-right text-[12px] tabular-nums ${impactTone(impact)}`}
                                    >
                                        {impact === null ? (
                                            <Tooltip content="No route found at this size" side="top">
                                                <span className="cursor-help">—</span>
                                            </Tooltip>
                                        ) : (
                                            `${impact.toFixed(impact >= 100 ? 0 : 1)} bps`
                                        )}
                                    </td>
                                );
                            })}
                            <td className="px-3 py-2.5 pr-4 text-right text-[12px] text-text-medium tabular-nums">
                                {variant.market?.liquidity ? formatUsd(variant.market.liquidity) : '—'}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** The asset-mode result card: allocation plan on top, per-variant evidence below. */
export function RouteResults({
    data,
    isPending,
    isError,
}: {
    data: ExecutionRouteResponse | null;
    isPending: boolean;
    isError: boolean;
}) {
    return (
        <section className="overflow-hidden rounded-[24px] border border-border-medium bg-white shadow-[0_8px_40px_rgba(0,0,0,0.03)]">
            {data && !isPending ? (
                <>
                    <AllocationHeadline data={data} />
                    {data.allocation ? <AllocationLegsTable data={data} /> : null}
                    <VariantMatrix data={data} />
                </>
            ) : (
                <div className="px-4 py-10 text-center text-[12px] text-text-low">
                    {isPending
                        ? 'Probing every variant across the size ladder…'
                        : 'Pick an asset and a size, then get the route.'}
                </div>
            )}

            <div className="border-t border-border-extra-light p-4">
                <Alert className="rounded-xl border-border-light bg-gray-50/80 px-4 py-3 text-text-medium">
                    <Info className="size-4 text-text-low" aria-hidden />
                    <AlertTitle className="text-[12px] font-medium text-text-high">
                        {isError ? 'Routing unavailable' : 'How to read this'}
                    </AlertTitle>
                    <AlertDescription className="space-y-1 text-[11px] text-text-low">
                        {isError ? <p>The routing call failed; no previous result was substituted.</p> : null}
                        {data && data.allocation && Number(data.allocation.unallocatedUsd) > 0 ? (
                            <p className="text-amber-700">
                                ${Number(data.allocation.unallocatedUsd).toLocaleString('en-US')} could not be placed —
                                the target exceeds the depth these variants proved in this probe.
                            </p>
                        ) : null}
                        {data && data.allocation?.pegSpreadBps && data.allocation.pegSpreadBps > 50 ? (
                            <p className="text-amber-700">
                                Variant base prices diverge by {data.allocation.pegSpreadBps.toFixed(0)} bps — a cheap
                                variant is cheap for a reason, and the buyer inherits that peg risk.
                            </p>
                        ) : null}
                        {data?.meta.warnings.includes('legs_share_liquidity') ? (
                            <p className="text-amber-700">
                                Some legs share liquidity (one leg&apos;s route passes through another leg&apos;s
                                token or pools) — the edge is an upper bound. Execute the largest leg first.
                            </p>
                        ) : null}
                        {data?.meta.warnings.some(warning => warning.startsWith('price_divergence_excluded:')) ? (
                            <p className="text-amber-700">
                                Some variants were excluded from the split because their unit price diverges too far
                                from the pool — a different unit or a broken book, either way not summable.
                            </p>
                        ) : null}
                        {data?.meta.warnings.includes('equity_unit_parity_assumed') ? (
                            <p>
                                Equity variants assume 1 token = 1 share per the issuer&apos;s claim; issuer mint/redeem
                                primary markets are not visible to any quoted router.
                            </p>
                        ) : null}
                        {data && data.meta.excludedVariants.length > 0 ? (
                            <p>
                                Not quoted:{' '}
                                {data.meta.excludedVariants
                                    .map(
                                        entry =>
                                            `${entry.symbol ?? entry.mint.slice(0, 4)} (${entry.reason.replaceAll('_', ' ')})`,
                                    )
                                    .join(', ')}
                                .
                            </p>
                        ) : null}
                        <p>
                            Impact is measured against each variant&apos;s own smallest-size price. Allocation never
                            exceeds a variant&apos;s largest successfully quoted size. These are quotes, not an
                            execution guarantee, and the split is not an atomic transaction.
                        </p>
                    </AlertDescription>
                </Alert>
            </div>
        </section>
    );
}
