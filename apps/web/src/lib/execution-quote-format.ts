/** The API normalizes provider impact to a decimal ratio (0.9846 = 98.46%). */
export function formatPriceImpactRatio(priceImpactRatio: number | null): string {
    if (priceImpactRatio === null || !Number.isFinite(priceImpactRatio)) return '—';
    const percentage = priceImpactRatio * 100;
    if (percentage > 0 && percentage < 0.001) return '<0.001%';
    return `${percentage.toFixed(Math.abs(percentage) < 1 ? 3 : 2)}%`;
}

export function fullPriceImpactRatio(priceImpactRatio: number | null): string | undefined {
    if (priceImpactRatio === null || !Number.isFinite(priceImpactRatio)) return undefined;
    return `${priceImpactRatio * 100}%`;
}

/** Friendly names for known Jupiter engines while preserving future ids. */
export function formatExecutionRouterLabel(router: string | null): string {
    if (!router) return '—';
    const known: Record<string, string> = {
        metis: 'Metis',
        jupiterz: 'JupiterZ',
        dflow: 'Dflow',
        okx: 'OKX',
    };
    return known[router.toLowerCase()] ?? router;
}

/**
 * Pure quote-formatting helpers, kept out of the component modules that render
 * them so Fast Refresh can preserve those components' state.
 */

import type {
    ExecutionProviderQuote,
    ExecutionQuoteProvider,
    ExecutionQuoteRouteStep,
} from '@/hooks/queries/use-execution-evaluation';

// Built once: constructing an Intl formatter is expensive relative to the
// format call, and these run per cell on every render.
const TOKEN_AMOUNT_FORMATTERS = {
    fine: new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }),
    medium: new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }),
    coarse: new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }),
} as const;

/**
 * Pinned to UTC so the server and the browser render identical text. The
 * default (host timezone) differs across that boundary and desyncs hydration;
 * UTC also matches the raw ISO timestamp shown in the cell's tooltip.
 */
const QUOTE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
});

export function formatTokenAmount(amount: string): string {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric)) return amount;
    const formatter =
        numeric < 1
            ? TOKEN_AMOUNT_FORMATTERS.fine
            : numeric < 1_000
              ? TOKEN_AMOUNT_FORMATTERS.medium
              : TOKEN_AMOUNT_FORMATTERS.coarse;
    return formatter.format(numeric);
}

export function providerLabel(provider: ExecutionQuoteProvider): string {
    return provider === 'titan' ? 'Titan' : 'Jupiter';
}

export function feeMintLabel(
    candidate: Extract<ExecutionProviderQuote, { status: 'available' }>,
    mint: string | null,
): string {
    if (!mint) return 'Unknown mint';
    if (mint === candidate.input.mint) return candidate.input.symbol;
    if (mint === candidate.output.mint) return candidate.output.symbol;
    return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function routeLabel(route: readonly ExecutionQuoteRouteStep[], provider: ExecutionQuoteProvider): string {
    const labels = route.map(step => step.label).filter((label): label is string => Boolean(label));
    return labels.length > 0 ? labels.join(' → ') : `${providerLabel(provider)} route`;
}

export function routeDetails(route: readonly ExecutionQuoteRouteStep[], contextSlot: number | null): string {
    const steps = route.map((step, index) => {
        const percent = step.percent === null ? '' : ` (${step.percent}%)`;
        return `${index + 1}. ${step.label ?? 'Unknown venue'}${percent}\n${step.inputMint ?? '—'} → ${step.outputMint ?? '—'}`;
    });
    if (contextSlot !== null) steps.push(`Context slot: ${contextSlot}`);
    return steps.join('\n\n');
}

export function formatQuoteTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return QUOTE_TIME_FORMATTER.format(date);
}
