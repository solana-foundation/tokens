/**
 * Comparison math for the multi-provider quote surface.
 *
 * Kept separate from the route so the arithmetic that produces the product's
 * headline number — how much the winning router actually beat the alternative
 * by — is unit-testable without an HTTP layer or a Cloud Run stub.
 *
 * Everything works in BigInt space: raw amounts on an 18-decimal mint exceed
 * Number.MAX_SAFE_INTEGER, so `Number(rawAmount)` silently loses precision.
 */

export const COMPARISON_VERSION = 'quote-compare-v1';

/** Providers we compare, in the order that breaks ties (earlier wins). */
export const QUOTE_PROVIDERS = ['jupiter', 'titan'] as const;
export type QuoteProvider = (typeof QUOTE_PROVIDERS)[number];

/** Where a quote's price impact came from — the two are not interchangeable. */
export type PriceImpactSource = 'provider' | 'unavailable';

export interface ComparableQuote {
    provider: QuoteProvider;
    outAmountRaw: string;
}

export interface QuoteEdge {
    runnerUp: QuoteProvider;
    comparedProviders: number;
    outAmountDiffRaw: string;
    outAmountDiff: string;
    bps: number;
    usd: number;
}

/** Fixed-point scale for the ratio; 1e6 keeps 2dp of bps without floats. */
const RATIO_SCALE = 1_000_000n;
const USDC_DECIMALS = 6;

/**
 * Format a raw integer amount with the mint's decimals. Exported because the
 * edge's decimal rendering must use exactly the same formatting as the amounts
 * it was derived from.
 */
export function formatRawAmount(rawAmount: string, decimals: number): string {
    const raw = BigInt(rawAmount);
    if (decimals === 0) return raw.toString();
    const padded = raw.toString().padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals);
    const fraction = padded.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Rank available quotes best-first by output, so `[1]` is the runner-up.
 * Ties keep provider order (Jupiter first), matching the handler's winner
 * selection — `meta.tieBreak` advertises that rule.
 */
export function rankQuotes<T extends ComparableQuote>(quotes: readonly T[]): T[] {
    return [...quotes].sort((a, b) => {
        const left = BigInt(a.outAmountRaw);
        const right = BigInt(b.outAmountRaw);
        if (left !== right) return right > left ? 1 : -1;
        return QUOTE_PROVIDERS.indexOf(a.provider) - QUOTE_PROVIDERS.indexOf(b.provider);
    });
}

/**
 * How much the winner beat the runner-up by.
 *
 * `bps` is the winner's gain over the alternative: `(best/runnerUp - 1) * 1e4`
 * — the form behind "Titan beat Jupiter by 12bps".
 *
 * `usd` is a fraction of the trade's own notional, so it needs no oracle:
 * - sell: output is USDC, so the surplus *is* dollars.
 * - buy: the winner got X tokens for $N and the runner-up got Y, so the
 *   surplus is worth `(1 - Y/X) * N`.
 *
 * The two ratio bases differ by O(bps²) (12.00 vs 11.99); documented, not hidden.
 *
 * Returns null when fewer than two providers quoted — never 0, which would
 * wrongly read as "we compared them and they tied".
 */
export function computeEdge(args: {
    ranked: readonly ComparableQuote[];
    /** Output mint decimals, for the human-readable diff. */
    outputDecimals: number;
    side: 'buy' | 'sell';
    /** Requested input, raw. On buys this is the USDC notional. */
    requestRawAmount: string;
}): QuoteEdge | null {
    if (args.ranked.length < 2) return null;
    const best = args.ranked[0]!;
    const runnerUp = args.ranked[1]!;

    const bestOut = BigInt(best.outAmountRaw);
    const runnerUpOut = BigInt(runnerUp.outAmountRaw);
    if (runnerUpOut <= 0n) return null;

    const diff = bestOut - runnerUpOut;
    // Fixed-point gain: RATIO_SCALE units are 1e-6 of the ratio, so dividing by
    // 100 lands on bps with two decimal places of resolution.
    const ratio = (bestOut * RATIO_SCALE) / runnerUpOut - RATIO_SCALE;
    const bps = Number(ratio) / 100;

    const shortfall = 1 - Number((runnerUpOut * RATIO_SCALE) / bestOut) / Number(RATIO_SCALE);
    const usd =
        args.side === 'sell'
            ? Number(formatRawAmount(diff.toString(), USDC_DECIMALS))
            : Number(formatRawAmount(args.requestRawAmount, USDC_DECIMALS)) * shortfall;

    return {
        runnerUp: runnerUp.provider,
        comparedProviders: args.ranked.length,
        outAmountDiffRaw: diff.toString(),
        outAmountDiff: formatRawAmount(diff.toString(), args.outputDecimals),
        bps,
        usd: Math.round(usd * 100) / 100,
    };
}

export interface ProviderStat {
    quoted: number;
    unavailable: number;
    /** Beat at least one other provider. Uncontested sizes are not wins. */
    wins: number;
    /** Sizes where this provider was the only one that quoted. */
    soleQuotes: number;
    meanEdgeBps: number | null;
    medianEdgeBps: number | null;
}

export interface ComparisonSummary {
    bestProvider: QuoteProvider | null;
    bestProviderReason: 'most_wins' | 'aggregate_edge' | 'only_provider' | 'tie' | 'no_comparison';
    /** Sizes where at least two providers quoted — the only comparable ones. */
    comparableEntries: number;
    meanEdgeBps: number | null;
    medianEdgeBps: number | null;
    maxEdgeBps: number | null;
    maxEdgeAt: { unit: 'usd' | 'token'; amount: string } | null;
}

function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const value = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return Math.round(value * 100) / 100;
}

function mean(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

export interface SummarizableEntry {
    request: { unit: 'usd' | 'token'; amount: string };
    availableProviders: QuoteProvider[];
    unavailableProviders: QuoteProvider[];
    winner: QuoteProvider | null;
    edgeBps: number | null;
}

/**
 * Per-provider counters and the headline verdict.
 *
 * Every aggregate is computed over *comparable* entries only (≥2 providers
 * quoted). Averaging across uncontested sizes would report a confident 0bps
 * edge that actually means "only one provider answered".
 */
export function summarizeComparison(args: {
    providers: readonly QuoteProvider[];
    entries: readonly SummarizableEntry[];
}): { providerStats: Record<QuoteProvider, ProviderStat>; summary: ComparisonSummary } {
    const comparable = args.entries.filter(entry => entry.availableProviders.length >= 2);
    const edges = comparable.map(entry => entry.edgeBps).filter((bps): bps is number => bps !== null);

    const providerStats = Object.fromEntries(
        QUOTE_PROVIDERS.map(provider => {
            const queried = args.providers.includes(provider);
            const providerEdges = comparable
                .filter(entry => entry.winner === provider && entry.edgeBps !== null)
                .map(entry => entry.edgeBps!);
            return [
                provider,
                {
                    quoted: queried ? args.entries.filter(e => e.availableProviders.includes(provider)).length : 0,
                    unavailable: queried
                        ? args.entries.filter(e => e.unavailableProviders.includes(provider)).length
                        : 0,
                    wins: comparable.filter(entry => entry.winner === provider).length,
                    soleQuotes: args.entries.filter(
                        entry => entry.availableProviders.length === 1 && entry.availableProviders[0] === provider,
                    ).length,
                    meanEdgeBps: mean(providerEdges),
                    medianEdgeBps: median(providerEdges),
                } satisfies ProviderStat,
            ];
        }),
    ) as Record<QuoteProvider, ProviderStat>;

    const maxEntry = comparable.reduce<SummarizableEntry | null>((best, entry) => {
        if (entry.edgeBps === null) return best;
        if (!best || best.edgeBps === null || entry.edgeBps > best.edgeBps) return entry;
        return best;
    }, null);

    let bestProvider: QuoteProvider | null = null;
    let bestProviderReason: ComparisonSummary['bestProviderReason'] = 'no_comparison';
    if (comparable.length === 0) {
        // Nothing was contested: name a sole provider if exactly one ever quoted.
        const everQuoted = QUOTE_PROVIDERS.filter(provider => providerStats[provider].quoted > 0);
        if (everQuoted.length === 1) {
            bestProvider = everQuoted[0]!;
            bestProviderReason = 'only_provider';
        }
    } else {
        const ranked = [...QUOTE_PROVIDERS].sort((a, b) => providerStats[b].wins - providerStats[a].wins);
        const [first, second] = ranked;
        if (first && second && providerStats[first].wins === providerStats[second].wins) {
            // Same number of wins: fall back to who won by more, then declare a tie.
            const firstEdge = providerStats[first].meanEdgeBps ?? 0;
            const secondEdge = providerStats[second].meanEdgeBps ?? 0;
            if (firstEdge === secondEdge) {
                bestProviderReason = 'tie';
            } else {
                bestProvider = firstEdge > secondEdge ? first : second;
                bestProviderReason = 'aggregate_edge';
            }
        } else if (first) {
            bestProvider = first;
            bestProviderReason = 'most_wins';
        }
    }

    return {
        providerStats,
        summary: {
            bestProvider,
            bestProviderReason,
            comparableEntries: comparable.length,
            meanEdgeBps: mean(edges),
            medianEdgeBps: median(edges),
            maxEdgeBps: maxEntry?.edgeBps ?? null,
            maxEdgeAt: maxEntry ? { unit: maxEntry.request.unit, amount: maxEntry.request.amount } : null,
        },
    };
}
