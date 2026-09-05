'use client';

import * as React from 'react';
import { ChevronDown, Info } from 'lucide-react';

import { Tooltip } from '@solana/design-system/tooltip';
import { Alert, AlertDescription, AlertTitle } from '@tokens/ui/alert';

import type { ExecutionQuoteRow } from '@/hooks/queries/use-execution-evaluation';
import type { ExecutionRouteResponse, RoutedVariant } from '@/hooks/queries/use-execution-route';
import { formatExecutionRouterLabel, providerLabel } from '@/lib/execution-quote-format';
import { CandidateComparison } from './candidate-comparison';

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
            {allocation.blendedImpactBps !== null && allocation.blendedImpactBps > 500 ? (
                <p className="mt-1 text-[12px] font-medium text-red-700">
                    Even this best-available plan absorbs ~
                    {allocation.blendedImpactBps.toLocaleString('en-US', { maximumFractionDigits: 0 })} bps of impact —
                    this size may not fit this asset yet. Consider a smaller order.
                </p>
            ) : null}
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
                                {leg.shareConfidence === 'soft' ? (
                                    <Tooltip
                                        content="This size was decided in a steep part of the curve — it may move on a re-ask. The leg's expected output is still a verified quote."
                                        side="top"
                                        align="end"
                                    >
                                        <span className="ml-1 cursor-help text-[10px] text-amber-700">~</span>
                                    </Tooltip>
                                ) : null}
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

function Chip({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn'; children: React.ReactNode }) {
    const palette = {
        neutral: 'bg-gray-100 text-text-high',
        good: 'bg-green-50 text-green-800',
        warn: 'bg-amber-50 text-amber-800',
    }[tone];
    return (
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums ${palette}`}>{children}</span>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <dt className="text-[10px] text-text-extra-low">{label}</dt>
            <dd className="text-[11px] text-text-high tabular-nums">{children}</dd>
        </div>
    );
}

/**
 * Every router that answered for this variant, counted across the whole size
 * ladder. The headline row only shows each rung's winner, so an RFQ that quoted
 * but lost is invisible without this.
 */
function routerTally(rows: ExecutionQuoteRow[]): {
    quoted: Array<{ key: string; count: number; wins: number }>;
    failed: Array<{ key: string; count: number }>;
} {
    const quoted = new Map<string, { count: number; wins: number }>();
    const failed = new Map<string, number>();
    for (const row of rows) {
        for (const quote of row.providerQuotes) {
            if (quote.status === 'available') {
                const key = `${providerLabel(quote.provider)} · ${formatExecutionRouterLabel(quote.router)}`;
                const entry = quoted.get(key) ?? { count: 0, wins: 0 };
                entry.count += 1;
                if (quote.isBest) entry.wins += 1;
                quoted.set(key, entry);
            } else {
                const key = `${providerLabel(quote.provider)}: ${quote.reason}`;
                failed.set(key, (failed.get(key) ?? 0) + 1);
            }
        }
    }
    return {
        quoted: [...quoted.entries()]
            .map(([key, value]) => ({ key, ...value }))
            .sort((a, b) => b.wins - a.wins || b.count - a.count),
        failed: [...failed.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    };
}

/** Everything the API knew about one variant: parity facts, routers, per-rung quotes. */
function VariantDetail({ variant, colSpan }: { variant: RoutedVariant; colSpan: number }) {
    const tally = routerTally(variant.quotes);
    return (
        <tr className="bg-gray-50/40">
            <td colSpan={colSpan} className="px-4 py-4">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 lg:grid-cols-7">
                    <Field label="Kind">{variant.kind}</Field>
                    <Field label="Parity basis">
                        {variant.parityBasis === 'none' ? (
                            <Tooltip
                                content="Never summed with siblings: derivative kind, non-redeemable claim, or unknown unit."
                                side="top"
                            >
                                <span className="cursor-help text-amber-700">none</span>
                            </Tooltip>
                        ) : (
                            variant.parityBasis.replaceAll('_', ' ')
                        )}
                    </Field>
                    <Field label="Base price">{variant.curve.baseEffectivePrice ?? '—'}</Field>
                    <Field label="Proven depth">
                        {variant.curve.maxProvenSizeUsd === null ? '—' : formatUsd(variant.curve.maxProvenSizeUsd)}
                    </Field>
                    <Field label="Peg divergence">
                        {variant.curve.parityDivergenceBps === null
                            ? '—'
                            : `${variant.curve.parityDivergenceBps.toFixed(1)} bps`}
                    </Field>
                    <Field label="Tier">{variant.stockVariantTier ?? '—'}</Field>
                    <Field label="Mint">
                        <span title={variant.mint}>
                            {variant.mint.slice(0, 4)}…{variant.mint.slice(-4)}
                        </span>
                    </Field>
                </dl>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-text-extra-low">Routers that answered:</span>
                    {tally.quoted.length === 0 ? <Chip tone="warn">none</Chip> : null}
                    {tally.quoted.map(entry => (
                        <Chip key={entry.key} tone={entry.wins > 0 ? 'good' : 'neutral'}>
                            {entry.key} ×{entry.count}
                            {entry.wins > 0 ? ` · won ${entry.wins}` : ''}
                        </Chip>
                    ))}
                    {tally.failed.map(entry => (
                        <Chip key={entry.key} tone="warn">
                            {entry.key} ×{entry.count}
                        </Chip>
                    ))}
                </div>

                <div className="mt-3 space-y-3">
                    {variant.quotes.map(row => (
                        <div
                            key={row.request.rawAmount}
                            className="overflow-hidden rounded-xl border border-border-light bg-white"
                        >
                            <div className="flex items-baseline justify-between border-b border-border-extra-light px-3 py-2">
                                <span className="text-[11px] font-medium text-text-extra-high tabular-nums">
                                    {formatUsd(Number(row.request.amount))}
                                </span>
                                <span className="text-[10px] text-text-low">
                                    {row.status === 'available'
                                        ? `won by ${providerLabel(row.best.provider)} · ${formatExecutionRouterLabel(row.best.router)}`
                                        : `no quote (${row.reason})`}
                                </span>
                            </div>
                            <CandidateComparison candidates={row.providerQuotes} />
                        </div>
                    ))}
                </div>
            </td>
        </tr>
    );
}

function VariantMatrix({ data }: { data: ExecutionRouteResponse }) {
    const sizes = data.meta.probeLadderUsd;
    const [expandedMint, setExpandedMint] = React.useState<string | null>(null);
    // Variant label + one column per rung + liquidity + the toggle.
    const colSpan = sizes.length + 3;
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
                        <th className="px-3 py-2.5 text-right text-[11px] font-medium text-text-extra-low">
                            Liquidity
                        </th>
                        <th className="py-2.5 pl-3 pr-4 text-right text-[11px] font-medium text-text-extra-low">
                            Quotes
                        </th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border-extra-light">
                    {data.variants.map((variant: RoutedVariant) => {
                        const isExpanded = expandedMint === variant.mint;
                        return (
                            <React.Fragment key={variant.mint}>
                                <tr>
                                    <td className="py-2.5 pl-4 pr-3">
                                        <span className="text-[13px] font-medium text-text-extra-high">
                                            {variant.symbol}
                                        </span>
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
                                                    <Tooltip
                                                        content={
                                                            rung?.reason === 'no_route'
                                                                ? 'No route found at this size — the market genuinely lacks depth here.'
                                                                : 'Quotes failed at this size (provider error or rate limit) — depth is unknown, not proven absent.'
                                                        }
                                                        side="top"
                                                    >
                                                        <span className="cursor-help">—</span>
                                                    </Tooltip>
                                                ) : (
                                                    `${impact.toFixed(impact >= 100 ? 0 : 1)} bps`
                                                )}
                                            </td>
                                        );
                                    })}
                                    <td className="px-3 py-2.5 text-right text-[12px] text-text-medium tabular-nums">
                                        {variant.market?.liquidity ? (
                                            formatUsd(variant.market.liquidity)
                                        ) : (
                                            <Tooltip
                                                content="No market snapshot for this mint — token details were resolved via metadata instead."
                                                side="top"
                                                align="end"
                                            >
                                                <span className="cursor-help text-text-extra-low">n/a</span>
                                            </Tooltip>
                                        )}
                                    </td>
                                    <td className="py-2.5 pl-3 pr-4 text-right">
                                        <button
                                            type="button"
                                            aria-expanded={isExpanded}
                                            onClick={() => setExpandedMint(isExpanded ? null : variant.mint)}
                                            className="inline-flex items-center gap-1 rounded-full border border-border-light px-2 py-0.5 text-[10px] font-medium text-text-medium hover:bg-gray-50"
                                        >
                                            {isExpanded ? 'Hide' : 'Every quote'}
                                            <ChevronDown className={`size-3 ${isExpanded ? 'rotate-180' : ''}`} />
                                        </button>
                                    </td>
                                </tr>
                                {isExpanded ? <VariantDetail variant={variant} colSpan={colSpan} /> : null}
                            </React.Fragment>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/**
 * The judgment inputs behind the plan: the gates this request ran under, what
 * the providers actually delivered, and every raw warning. Collapsed by
 * default because it is testing detail, not a customer-facing summary.
 */
function PlanDiagnostics({ data }: { data: ExecutionRouteResponse }) {
    const [isOpen, setIsOpen] = React.useState(false);
    const { meta, allocation } = data;
    const overlap = allocation?.legIndependence;
    return (
        <div className="border-t border-border-extra-light">
            <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setIsOpen(!isOpen)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-gray-50/60"
            >
                <span className="text-[11px] font-medium text-text-medium">
                    Diagnostics · {meta.tuning.profile} gates · {meta.upstreamQuotes} upstream quotes
                    {meta.warnings.length > 0 ? ` · ${meta.warnings.length} warnings` : ''}
                </span>
                <ChevronDown className={`size-3.5 text-text-low ${isOpen ? 'rotate-180' : ''}`} />
            </button>
            {isOpen ? (
                <div className="space-y-4 bg-gray-50/40 px-4 py-4">
                    <div>
                        <p className="mb-1.5 text-[10px] font-medium text-text-extra-low">
                            Thresholds this request ran under
                        </p>
                        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
                            <Field label="Profile">{meta.tuning.profile}</Field>
                            <Field label="Parity gate">{meta.tuning.parityDivergenceMaxBps} bps</Field>
                            <Field label="Collapse threshold">{meta.tuning.collapseThresholdBps} bps</Field>
                            <Field label="Peg warn">{meta.tuning.pegWarnBps} bps</Field>
                            <Field label="Market closed ×2">
                                {meta.tuning.marketClosedMultiplierApplied ? (
                                    <span className="text-amber-700">applied</span>
                                ) : (
                                    'no'
                                )}
                            </Field>
                        </dl>
                    </div>

                    <div>
                        <p className="mb-1.5 text-[10px] font-medium text-text-extra-low">Provider delivery</p>
                        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
                            {Object.entries(meta.providerStats).map(([provider, stat]) => (
                                <Field key={provider} label={providerLabel(provider as 'jupiter' | 'titan')}>
                                    {stat.quoted} quoted · {stat.unavailable} failed · won {stat.wins} · sole{' '}
                                    {stat.soleQuotes}
                                </Field>
                            ))}
                            <Field label="Probe ladder">{meta.probeLadderUsd.map(formatUsd).join(' · ')}</Field>
                            <Field label="Variants">
                                {meta.selectedVariants} of max {meta.maxVariants}
                            </Field>
                        </dl>
                    </div>

                    {allocation ? (
                        <div>
                            <p className="mb-1.5 text-[10px] font-medium text-text-extra-low">Plan internals</p>
                            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
                                <Field label="Chunk size">{formatUsd(allocation.chunkUsd)}</Field>
                                <Field label="Dust floor">{formatUsd(allocation.minLegUsd)}</Field>
                                <Field label="Totals basis">{allocation.edge.basis.replaceAll('_', ' ')}</Field>
                                <Field label="Share stability">
                                    {allocation.shareStability === 'firm' ? (
                                        allocation.shareStability
                                    ) : (
                                        <span className="text-amber-700">{allocation.shareStability}</span>
                                    )}
                                </Field>
                                <Field label="Blended impact">
                                    {allocation.blendedImpactBps === null
                                        ? '—'
                                        : `${allocation.blendedImpactBps.toFixed(2)} bps · ${allocation.blendedImpactGrade ?? ''}`}
                                </Field>
                                <Field label="Peg spread">
                                    {allocation.pegSpreadBps === null
                                        ? '—'
                                        : `${allocation.pegSpreadBps.toFixed(1)} bps`}
                                </Field>
                                <Field label="Repaired">{allocation.repaired ? 'yes' : 'no'}</Field>
                                <Field label="Fell back to single">
                                    {allocation.fellBackToSingleVariant ? 'yes' : 'no'}
                                </Field>
                                <Field label="Routing version">{meta.routingVersion}</Field>
                            </dl>
                        </div>
                    ) : null}

                    {overlap && !overlap.independent ? (
                        <div>
                            <p className="mb-1.5 text-[10px] font-medium text-text-extra-low">
                                Leg overlap (why the edge is an upper bound)
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {overlap.passThrough.map(entry => (
                                    <Chip key={`${entry.legMint}-${entry.viaVariantMint}`} tone="warn">
                                        {entry.legMint.slice(0, 4)}… routes through {entry.viaVariantMint.slice(0, 4)}…
                                    </Chip>
                                ))}
                                {overlap.sharedPools.map(pool => (
                                    <Chip key={pool.ammKey} tone="warn">
                                        {pool.label ?? pool.ammKey.slice(0, 6)} shared by{' '}
                                        {pool.legMints.map(mint => mint.slice(0, 4)).join(' + ')}
                                    </Chip>
                                ))}
                            </div>
                        </div>
                    ) : null}

                    {meta.warnings.length > 0 ? (
                        <div>
                            <p className="mb-1.5 text-[10px] font-medium text-text-extra-low">Raw warnings</p>
                            <div className="flex flex-wrap gap-1.5">
                                {meta.warnings.map(warning => (
                                    <Chip key={warning} tone="warn">
                                        {warning}
                                    </Chip>
                                ))}
                            </div>
                        </div>
                    ) : null}
                </div>
            ) : null}
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
                    <PlanDiagnostics data={data} />
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
                                Some legs share liquidity (one leg&apos;s route passes through another leg&apos;s token
                                or pools) — the edge is an upper bound. Execute the largest leg first.
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
