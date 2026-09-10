import { InvalidArgsError } from './assets';
import type { ConcurrencyLimiter } from '../concurrencyLimiter';
import {
    DEPTH_USDC_QUOTE_MINT,
    sampleMintLadder,
    type DepthCronRepo,
    type DepthQuoteClient,
    type DepthQuoteSourceId,
} from './crons.depth';
import type { DepthCurveReadsRepo } from './depthCurveReads';

const MAX_QUOTE_AMOUNTS = 9;
const MIN_BUY_RAW_AMOUNT = 1_000_000n;
const MAX_BUY_RAW_AMOUNT = 50_000_000n * 1_000_000n;
const MAX_U64 = 18_446_744_073_709_551_615n;
const QUOTE_CONCURRENCY = 2;
/**
 * Total wall-clock budget for one fan-out. Sits under the API's cloudRunQuery
 * timeout (15s) which sits under the web proxy's (20s), so the innermost layer
 * gives up first and we can return partial results instead of a blanket 500.
 */
const DEFAULT_FANOUT_BUDGET_MS = 12_000;
const MIN_FANOUT_BUDGET_MS = 2_000;
const MAX_FANOUT_BUDGET_MS = 20_000;
/** Floor for a single provider call, so the last batch is never starved. */
const MIN_PROVIDER_TIMEOUT_MS = 1_500;
const USDC_DECIMALS = 6;

export type ExecutionQuoteSide = 'buy' | 'sell';
export type ExecutionQuoteProvider = 'jupiter' | 'titan';

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

export interface ExactQuoteFees {
    feeBps: number | null;
    feeMint: string | null;
    platformFee: {
        amountRaw: string | null;
        feeBps: number | null;
        feeMint: string | null;
    } | null;
}

export interface ExactQuote {
    inAmountRaw: string;
    outAmountRaw: string;
    priceImpactPct: number | null;
    route: ExecutionRouteStep[];
    contextSlot: number | null;
    /** Provider-internal routing engine, e.g. Jupiter's metis or jupiterz. */
    router: string | null;
    /** Provider quote mode, e.g. Jupiter Swap V2's ultra mode. */
    mode: string | null;
    fees: ExactQuoteFees | null;
}

export interface JupiterTokenMetadata {
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
}

/**
 * Routing restrictions for a restricted re-quote (the leg-overlap fix).
 * Effect-verified levers only: Titan honors excludeDexes as CSV of exact
 * venue labels; Jupiter's only guaranteed intermediate-free lever is
 * onlyDirectRoutes on its classic quote endpoint (its excludeDexes reroutes
 * but siblings reappear via other venues).
 */
export interface QuoteRestrictions {
    onlyDirectRoutes?: boolean;
    excludeDexes?: string[];
}

export interface ExactQuoteClient {
    id: ExecutionQuoteProvider;
    fetchQuote(args: {
        inputMint: string;
        outputMint: string;
        amountRaw: string;
        /** Per-call deadline so the caller can enforce its own budget. */
        timeoutMs?: number;
        restrictions?: QuoteRestrictions;
    }): Promise<ExactQuote | null>;
}

export interface JupiterSwapV2QuoteClient extends ExactQuoteClient {
    id: 'jupiter';
}

export interface JupiterTokenMetadataClient {
    fetchTokenMetadata(mint: string): Promise<JupiterTokenMetadata | null>;
}

/**
 * Cap in-flight quote calls per provider. Per-instance and best-effort; a
 * shed request degrades to an unavailable rung, never a failure.
 */
export function limitQuoteConcurrency<T extends ExactQuoteClient>(client: T, limit: ConcurrencyLimiter): T {
    return {
        ...client,
        fetchQuote: (args: Parameters<ExactQuoteClient['fetchQuote']>[0]) => limit(() => client.fetchQuote(args)),
    };
}

/**
 * Space out fetchQuote starts so a burst never exceeds the provider's
 * per-second budget (Jupiter's paid tier allows ~10 req/s). Composes with
 * limitQuoteConcurrency: the limiter caps in-flight, this paces starts.
 */
export function paceQuoteStarts<T extends ExactQuoteClient>(client: T, minIntervalMs: number): T {
    let nextSlot = 0;
    return {
        ...client,
        fetchQuote: async (args: Parameters<ExactQuoteClient['fetchQuote']>[0]) => {
            const now = Date.now();
            const slot = Math.max(now, nextSlot);
            nextSlot = slot + minIntervalMs;
            if (slot > now) await new Promise(resolve => setTimeout(resolve, slot - now));
            return client.fetchQuote(args);
        },
    };
}

export interface LiveQuoteDeps {
    jupiterTokenMetadataSource: JupiterTokenMetadataClient;
    jupiterQuoteSource?: JupiterSwapV2QuoteClient;
    titanQuoteSource?: ExactQuoteClient;
    now: () => number;
}

/**
 * Why a provider produced no usable quote. `no_route` is a real market answer;
 * everything else is an operational failure we should be able to see.
 */
export const QUOTE_UNAVAILABLE_REASONS = ['no_route', 'timeout', 'auth', 'malformed', 'error'] as const;
export type QuoteUnavailableReason = (typeof QUOTE_UNAVAILABLE_REASONS)[number];

/** Errors may carry a reason so callers classify without importing each client. */
export interface QuoteReasonCarrier {
    quoteReason: QuoteUnavailableReason;
}

export function quoteReasonOf(error: unknown): QuoteUnavailableReason {
    if (typeof error === 'object' && error !== null) {
        const carried = (error as Partial<QuoteReasonCarrier>).quoteReason;
        if (carried && QUOTE_UNAVAILABLE_REASONS.includes(carried)) return carried;

        const tag = (error as { _tag?: unknown })._tag;
        if (tag === 'UpstreamDataError' || tag === 'JsonParseError') return 'malformed';
        if (tag === 'FetchFailedError' && (error as { cause?: unknown }).cause === 'timeout') return 'timeout';
        if (tag === 'RequestTimeoutError' || tag === 'TimeoutException') return 'timeout';
        if (tag === 'UpstreamHttpError') {
            const status = (error as { status?: unknown }).status;
            if (status === 401 || status === 403) return 'auth';
        }
        const name = (error as { name?: unknown }).name;
        if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
    }
    return 'error';
}

export interface ExecutionQuoteRequest {
    unit: 'usd' | 'token';
    amount: string;
    rawAmount: string;
}

export type ExecutionQuoteCandidate =
    | {
          provider: ExecutionQuoteProvider;
          status: 'available';
          inAmountRaw: string;
          outAmountRaw: string;
          priceImpactPct: number | null;
          route: ExecutionRouteStep[];
          contextSlot: number | null;
          router: string | null;
          mode: string | null;
          fees: ExactQuoteFees | null;
          quotedAt: string;
      }
    | {
          provider: ExecutionQuoteProvider;
          status: 'unavailable';
          reason: QuoteUnavailableReason;
          inAmountRaw: null;
          outAmountRaw: null;
          priceImpactPct: null;
          route: [];
          contextSlot: null;
          router: null;
          mode: null;
          fees: null;
          quotedAt: string;
      };

export type ExecutionQuoteEntry =
    | {
          request: ExecutionQuoteRequest;
          status: 'available';
          provider: ExecutionQuoteProvider;
          inAmountRaw: string;
          outAmountRaw: string;
          priceImpactPct: number | null;
          route: ExecutionRouteStep[];
          contextSlot: number | null;
          router: string | null;
          mode: string | null;
          fees: ExactQuoteFees | null;
          quotedAt: string;
          candidates: ExecutionQuoteCandidate[];
      }
    | {
          request: ExecutionQuoteRequest;
          status: 'unavailable';
          reason: QuoteUnavailableReason;
          provider: null;
          inAmountRaw: null;
          outAmountRaw: null;
          priceImpactPct: null;
          route: [];
          contextSlot: null;
          router: null;
          mode: null;
          fees: null;
          quotedAt: string;
          candidates: ExecutionQuoteCandidate[];
      };

export interface ExecutionQuotesLiveResult {
    /** Providers actually queried, in deterministic order. */
    providers: ExecutionQuoteProvider[];
    mint: string;
    side: ExecutionQuoteSide;
    quoteMint: string;
    entries: ExecutionQuoteEntry[];
}

export async function executionQuoteTokenMetadata(deps: LiveQuoteDeps, args: unknown): Promise<JupiterTokenMetadata | null> {
    if (typeof args !== 'object' || args === null) throw new InvalidArgsError('args must be an object');
    const mint = (args as { mint?: unknown }).mint;
    if (typeof mint !== 'string' || !mint.trim()) throw new InvalidArgsError('mint must be a string');
    return deps.jupiterTokenMetadataSource.fetchTokenMetadata(mint.trim());
}

function parseSide(raw: unknown): ExecutionQuoteSide {
    if (raw !== 'buy' && raw !== 'sell') throw new InvalidArgsError('side must be buy or sell');
    return raw;
}

export function formatRawAmount(rawAmount: string, decimals: number): string {
    const raw = BigInt(rawAmount);
    if (decimals === 0) return raw.toString();
    const padded = raw.toString().padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals);
    const fraction = padded.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

export function parseDecimalAmount(raw: string, decimals: number): ExecutionQuoteRequest {
    const value = raw.trim();
    const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
    if (!match) throw new InvalidArgsError('amounts must be positive decimal strings');
    const fraction = match[2] ?? '';
    if (fraction.length > decimals) {
        throw new InvalidArgsError(`amount has more than ${decimals} decimal places`);
    }
    const amountRaw = BigInt(`${match[1]}${fraction.padEnd(decimals, '0')}`);
    if (amountRaw <= 0n || amountRaw > MAX_U64) throw new InvalidArgsError('amount is outside the supported range');
    return { unit: decimals === USDC_DECIMALS ? 'usd' : 'token', amount: formatRawAmount(amountRaw.toString(), decimals), rawAmount: amountRaw.toString() };
}

function unavailableCandidate(
    provider: ExecutionQuoteProvider,
    quotedAt: string,
    reason: QuoteUnavailableReason = 'no_route',
): Extract<ExecutionQuoteCandidate, { status: 'unavailable' }> {
    return {
        provider,
        status: 'unavailable',
        reason,
        inAmountRaw: null,
        outAmountRaw: null,
        priceImpactPct: null,
        route: [],
        contextSlot: null,
        router: null,
        mode: null,
        fees: null,
        quotedAt,
    };
}

async function fetchCandidate(
    deps: LiveQuoteDeps,
    client: ExactQuoteClient | undefined,
    provider: ExecutionQuoteProvider,
    args: {
        inputMint: string;
        outputMint: string;
        amountRaw: string;
        timeoutMs?: number;
        restrictions?: QuoteRestrictions;
    },
): Promise<ExecutionQuoteCandidate> {
    // No client configured is an operational gap, not a market answer.
    if (!client) return unavailableCandidate(provider, new Date(deps.now()).toISOString(), 'error');
    try {
        const quote = await client.fetchQuote(args);
        const quotedAt = new Date(deps.now()).toISOString();
        if (!quote) return unavailableCandidate(provider, quotedAt, 'no_route');
        return {
            provider,
            status: 'available',
            inAmountRaw: quote.inAmountRaw,
            outAmountRaw: quote.outAmountRaw,
            priceImpactPct: quote.priceImpactPct,
            route: quote.route,
            contextSlot: quote.contextSlot,
            router: quote.router,
            mode: quote.mode,
            fees: quote.fees,
            quotedAt,
        };
    } catch (error) {
        const reason = quoteReasonOf(error);
        // Market conditions are expected; misconfiguration and schema drift are not.
        if (reason === 'auth' || reason === 'malformed') {
            console.warn(
                JSON.stringify({
                    event: 'execution_quote_failed',
                    provider,
                    reason,
                    message: error instanceof Error ? error.message : String(error),
                }),
            );
        }
        return unavailableCandidate(provider, new Date(deps.now()).toISOString(), reason);
    }
}

/** Compare fresh Jupiter and Titan quotes for one mint and up to nine sizes. */
export async function executionQuotesLive(deps: LiveQuoteDeps, args: unknown): Promise<ExecutionQuotesLiveResult> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as {
        mint?: unknown;
        side?: unknown;
        amounts?: unknown;
        tokenDecimals?: unknown;
        timeoutMs?: unknown;
        providers?: unknown;
        restrictions?: unknown;
    };
    if (typeof a.mint !== 'string' || !a.mint.trim()) throw new InvalidArgsError('mint must be a string');
    const side = parseSide(a.side);
    if (!Array.isArray(a.amounts) || a.amounts.some(item => typeof item !== 'string')) {
        throw new InvalidArgsError('amounts must be an array of strings');
    }
    if (!Number.isInteger(a.tokenDecimals) || (a.tokenDecimals as number) < 0 || (a.tokenDecimals as number) > 18) {
        throw new InvalidArgsError('tokenDecimals must be an integer between 0 and 18');
    }

    const decimals = side === 'buy' ? USDC_DECIMALS : (a.tokenDecimals as number);
    const unit = side === 'buy' ? 'usd' : 'token';
    const requests: ExecutionQuoteRequest[] = [];
    const seenRaw = new Set<string>();
    for (const amount of a.amounts as string[]) {
        const request: ExecutionQuoteRequest = { ...parseDecimalAmount(amount, decimals), unit };
        if (
            side === 'buy' &&
            (BigInt(request.rawAmount) < MIN_BUY_RAW_AMOUNT || BigInt(request.rawAmount) > MAX_BUY_RAW_AMOUNT)
        ) {
            throw new InvalidArgsError('amountUsd must be between 1 and 50000000');
        }
        if (seenRaw.has(request.rawAmount)) continue;
        seenRaw.add(request.rawAmount);
        requests.push(request);
    }
    const restrictionsRaw =
        a.restrictions !== null && typeof a.restrictions === 'object'
            ? (a.restrictions as Record<string, { onlyDirectRoutes?: unknown; excludeDexes?: unknown }>)
            : {};
    const restrictionsFor = (provider: ExecutionQuoteProvider): QuoteRestrictions | undefined => {
        const raw = restrictionsRaw[provider];
        if (!raw || typeof raw !== 'object') return undefined;
        const excludeDexes = Array.isArray(raw.excludeDexes)
            ? raw.excludeDexes.filter((label): label is string => typeof label === 'string' && label.length > 0)
            : undefined;
        const onlyDirectRoutes = raw.onlyDirectRoutes === true ? true : undefined;
        if (!onlyDirectRoutes && (!excludeDexes || excludeDexes.length === 0)) return undefined;
        return { onlyDirectRoutes, excludeDexes };
    };

    if (requests.length === 0) throw new InvalidArgsError('at least one amount is required');
    if (requests.length > MAX_QUOTE_AMOUNTS) throw new InvalidArgsError('at most 9 unique amounts are allowed');

    // Callers can narrow the provider set to trade comparison breadth for cost.
    const allProviders: ExecutionQuoteProvider[] = ['jupiter', 'titan'];
    let providers = allProviders;
    if (a.providers !== undefined) {
        if (!Array.isArray(a.providers) || a.providers.some(item => typeof item !== 'string')) {
            throw new InvalidArgsError('providers must be an array of strings');
        }
        const requested = new Set(a.providers as string[]);
        for (const provider of requested) {
            if (!allProviders.includes(provider as ExecutionQuoteProvider)) {
                throw new InvalidArgsError(`Unknown provider: ${provider}`);
            }
        }
        if (requested.size === 0) throw new InvalidArgsError('providers must name at least one provider');
        providers = allProviders.filter(provider => requested.has(provider));
    }

    const mint = a.mint.trim();
    const inputMint = side === 'buy' ? DEPTH_USDC_QUOTE_MINT : mint;
    const outputMint = side === 'buy' ? mint : DEPTH_USDC_QUOTE_MINT;

    const budgetMs =
        typeof a.timeoutMs === 'number' && Number.isFinite(a.timeoutMs)
            ? Math.min(MAX_FANOUT_BUDGET_MS, Math.max(MIN_FANOUT_BUDGET_MS, Math.floor(a.timeoutMs)))
            : DEFAULT_FANOUT_BUDGET_MS;
    const startedAt = deps.now();
    const deadline = startedAt + budgetMs;
    const batchCount = Math.ceil(requests.length / QUOTE_CONCURRENCY);

    const entries: ExecutionQuoteEntry[] = [];
    for (let i = 0; i < requests.length; i += QUOTE_CONCURRENCY) {
        const batch = requests.slice(i, i + QUOTE_CONCURRENCY);
        const remainingMs = deadline - deps.now();

        // Out of budget: report the rest as timed out rather than throwing away
        // the quotes we already have.
        if (remainingMs < MIN_PROVIDER_TIMEOUT_MS) {
            const quotedAt = new Date(deps.now()).toISOString();
            for (const request of batch) {
                entries.push({
                    request,
                    status: 'unavailable' as const,
                    reason: 'timeout' as const,
                    provider: null,
                    inAmountRaw: null,
                    outAmountRaw: null,
                    priceImpactPct: null,
                    route: [] as [],
                    contextSlot: null,
                    router: null,
                    mode: null,
                    fees: null,
                    quotedAt,
                    candidates: providers.map(provider => unavailableCandidate(provider, quotedAt, 'timeout')),
                });
            }
            continue;
        }

        // Spread what's left over the batches still to run.
        const batchesLeft = Math.max(1, batchCount - Math.floor(i / QUOTE_CONCURRENCY));
        const providerTimeoutMs = Math.max(MIN_PROVIDER_TIMEOUT_MS, Math.floor(remainingMs / batchesLeft));

        entries.push(
            ...(await Promise.all(
                batch.map(async request => {
                    const candidates = await Promise.all(
                        providers.map(provider =>
                            fetchCandidate(
                                deps,
                                provider === 'jupiter' ? deps.jupiterQuoteSource : deps.titanQuoteSource,
                                provider,
                                {
                                    inputMint,
                                    outputMint,
                                    amountRaw: request.rawAmount,
                                    timeoutMs: providerTimeoutMs,
                                    restrictions: restrictionsFor(provider),
                                },
                            ),
                        ),
                    );
                    const available = candidates.filter(
                        (candidate): candidate is Extract<ExecutionQuoteCandidate, { status: 'available' }> =>
                            candidate.status === 'available',
                    );
                    const winner = available.reduce<(typeof available)[number] | null>((best, candidate) => {
                        if (!best) return candidate;
                        // Candidate order is Jupiter then Titan, so equal output
                        // deterministically keeps Jupiter.
                        return BigInt(candidate.outAmountRaw) > BigInt(best.outAmountRaw) ? candidate : best;
                    }, null);
                    if (!winner) {
                        return {
                            request,
                            status: 'unavailable' as const,
                            // Both providers answered; neither had a route.
                            reason: 'no_route' as const,
                            provider: null,
                            inAmountRaw: null,
                            outAmountRaw: null,
                            priceImpactPct: null,
                            route: [] as [],
                            contextSlot: null,
                            router: null,
                            mode: null,
                            fees: null,
                            quotedAt: candidates[0]!.quotedAt,
                            candidates,
                        };
                    }
                    return {
                        request,
                        status: 'available' as const,
                        provider: winner.provider,
                        inAmountRaw: winner.inAmountRaw,
                        outAmountRaw: winner.outAmountRaw,
                        priceImpactPct: winner.priceImpactPct,
                        route: winner.route,
                        contextSlot: winner.contextSlot,
                        router: winner.router,
                        mode: winner.mode,
                        fees: winner.fees,
                        quotedAt: winner.quotedAt,
                        candidates,
                    };
                }),
            )),
        );
    }

    return {
        providers,
        mint,
        side,
        quoteMint: DEPTH_USDC_QUOTE_MINT,
        entries,
    };
}

const SAMPLE_MAX_MINTS = 4;
const SAMPLE_MIN_AGE_MS = 30 * 60 * 1000;
const SAMPLE_RUNG_DELAY_MS = 250;
const SAMPLE_MINT_CONCURRENCY = 2;

export interface DepthSampleDeps {
    quoteSource: DepthQuoteClient;
    curvesRepo: DepthCronRepo;
    readsRepo: DepthCurveReadsRepo;
    now: () => number;
}

export interface DepthSampleResult {
    source: DepthQuoteSourceId;
    sampled: string[];
    skippedFresh: string[];
    failed: string[];
}

/**
 * On-demand depth sampling for mints the cron hasn't covered yet. Currently
 * uncalled (the `sample=missing` param went away); kept working so the graded
 * surface can return without a rebuild. Bounded: ≤ SAMPLE_MAX_MINTS per call,
 * recently sampled mints skipped.
 */
export async function depthSampleMints(deps: DepthSampleDeps, args: unknown): Promise<DepthSampleResult> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { mints?: unknown };
    if (!Array.isArray(a.mints) || a.mints.some(item => typeof item !== 'string')) {
        throw new InvalidArgsError('mints must be an array of strings');
    }
    const requested = [...new Set((a.mints as string[]).map(m => m.trim()).filter(Boolean))].slice(0, SAMPLE_MAX_MINTS);

    const existing = await deps.readsRepo.findLatestByMints({
        mints: requested,
        quoteMint: DEPTH_USDC_QUOTE_MINT,
        side: 'buy',
        source: deps.quoteSource.id as DepthQuoteSourceId,
    });
    const freshEnough = new Set(
        existing
            .filter(row => deps.now() - Number(row.last_computed_at) < SAMPLE_MIN_AGE_MS)
            .map(row => row.mint),
    );
    const toSample = requested.filter(mint => !freshEnough.has(mint));

    const sampled: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < toSample.length; i += SAMPLE_MINT_CONCURRENCY) {
        const batch = toSample.slice(i, i + SAMPLE_MINT_CONCURRENCY);
        await Promise.all(
            batch.map(async mint => {
                try {
                    const { ladder, failedPoints } = await sampleMintLadder({
                        quoteSource: deps.quoteSource,
                        mint,
                        delayMs: SAMPLE_RUNG_DELAY_MS,
                    });
                    await deps.curvesRepo.upsertVariantDepthCurve({
                        mint,
                        quoteMint: DEPTH_USDC_QUOTE_MINT,
                        side: 'buy',
                        source: deps.quoteSource.id as DepthQuoteSourceId,
                        ladder,
                        points: ladder.length,
                        failedPoints,
                        asOf: Math.floor(deps.now() / 1000),
                        lastComputedAt: deps.now(),
                    });
                    sampled.push(mint);
                } catch {
                    failed.push(mint);
                }
            }),
        );
    }

    return {
        source: deps.quoteSource.id as DepthQuoteSourceId,
        sampled,
        skippedFresh: [...freshEnough],
        failed,
    };
}
