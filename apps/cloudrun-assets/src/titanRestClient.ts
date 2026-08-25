import { decode } from '@msgpack/msgpack';
import bs58 from 'bs58';

import { withExternalTiming } from './externalTiming';
import type {
    ExactQuote,
    ExactQuoteClient,
    ExecutionRouteStep,
    QuoteReasonCarrier,
    QuoteUnavailableReason,
} from './handlers/liveQuotes';

export const TITAN_DEMO_BASE_URL = 'https://us1.api.demo.titan.exchange';
export const TITAN_DEFAULT_QUOTE_USER_PUBLIC_KEY = 'Fake111111111111111111111111111111111111111';

const QUOTE_PATH = '/api/v1/quote/swap';

export interface TitanRestClientOptions {
    authToken: string;
    /**
     * Required: TITAN_DEMO_BASE_URL points at Titan's demo cluster, so silently
     * defaulting to it would quote demo liquidity in production.
     */
    baseUrl: string;
    userPublicKey?: string;
    fetch?: typeof globalThis.fetch;
    maxRetries?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

export class TitanRestHttpError extends Error implements QuoteReasonCarrier {
    readonly quoteReason: QuoteUnavailableReason;

    constructor(
        readonly status: number,
        readonly responseBody: string,
    ) {
        super(`Titan REST quote failed with HTTP ${status}`);
        this.name = 'TitanRestHttpError';
        this.quoteReason = status === 401 || status === 403 ? 'auth' : 'error';
    }
}

export class TitanRestMalformedResponseError extends Error implements QuoteReasonCarrier {
    readonly quoteReason: QuoteUnavailableReason = 'malformed';

    constructor(cause: unknown) {
        super('Titan REST returned malformed MessagePack', { cause });
        this.name = 'TitanRestMalformedResponseError';
    }
}

function normalizeBaseUrl(value: string): string {
    const trimmed = value.trim();
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return withProtocol.replace(/\/+$/, '');
}

export function isValidTitanQuotePublicKey(value: string): boolean {
    try {
        return bs58.decode(value).length === 32;
    } catch {
        return false;
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function integerString(value: unknown, allowZero = false): string | null {
    if (typeof value === 'bigint') return value > 0n || (allowZero && value === 0n) ? value.toString() : null;
    if (typeof value === 'number' && Number.isSafeInteger(value) && (value > 0 || (allowZero && value === 0))) {
        return String(value);
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const parsed = BigInt(value);
        return parsed > 0n || (allowZero && parsed === 0n) ? value : null;
    }
    return null;
}

function finiteNumber(value: unknown): number | null {
    const parsed = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

function publicKey(value: unknown): string | null {
    if (typeof value === 'string') return isValidTitanQuotePublicKey(value) ? value : null;
    return value instanceof Uint8Array && value.length === 32 ? bs58.encode(value) : null;
}

function routeSteps(value: unknown): ExecutionRouteStep[] {
    if (!Array.isArray(value)) return [];
    return value.map(raw => {
        const step = asRecord(raw) ?? {};
        const allocation = finiteNumber(step.allocPpb);
        return {
            ammKey: publicKey(step.ammKey),
            label: typeof step.label === 'string' && step.label ? step.label : null,
            percent: allocation === null ? null : allocation / 10_000_000,
            inputMint: publicKey(step.inputMint),
            outputMint: publicKey(step.outputMint),
            inAmountRaw: integerString(step.inAmount),
            outAmountRaw: integerString(step.outAmount),
            feeAmountRaw: integerString(step.feeAmount, true),
            feeMint: publicKey(step.feeMint),
        };
    });
}

/**
 * Pick the best quote for the pair/amount we actually requested. Titan echoes
 * the trade it priced, so an exact-out or otherwise mismatched response is
 * dropped rather than allowed to win the comparison.
 */
/**
 * The route's declared endpoints must match the requested pair when Titan
 * reports them. Steps that omit mints are tolerated (the field is optional).
 */
function routeMatchesPair(
    steps: ExecutionRouteStep[],
    expected: { inputMint: string; outputMint: string },
): boolean {
    if (steps.length === 0) return true;
    const first = steps[0]!;
    const last = steps[steps.length - 1]!;
    if (first.inputMint !== null && first.inputMint !== expected.inputMint) return false;
    if (last.outputMint !== null && last.outputMint !== expected.outputMint) return false;
    return true;
}

function normalizeQuote(
    value: unknown,
    expected: { inputMint: string; outputMint: string; amountRaw: string },
): ExactQuote | null {
    const root = asRecord(value);
    const quotes = asRecord(root?.quotes);
    if (!quotes) return null;

    let winner: ExactQuote | null = null;
    for (const raw of Object.values(quotes)) {
        const quote = asRecord(raw);
        if (!quote) continue;
        const inAmountRaw = integerString(quote.inAmount);
        const outAmountRaw = integerString(quote.outAmount);
        if (!inAmountRaw || !outAmountRaw) continue;
        // Exact-in: the priced input must be exactly what we asked for.
        if (inAmountRaw !== expected.amountRaw) continue;
        const steps = routeSteps(quote.steps);
        if (!routeMatchesPair(steps, expected)) continue;
        const contextSlotRaw = finiteNumber(quote.contextSlot);
        const candidate: ExactQuote = {
            inAmountRaw,
            outAmountRaw,
            // Titan's quote payload carries no price-impact field; the caller
            // derives a comparable impact from a reference quote instead.
            priceImpactPct: null,
            route: steps,
            contextSlot:
                contextSlotRaw !== null && Number.isSafeInteger(contextSlotRaw) && contextSlotRaw > 0
                    ? contextSlotRaw
                    : null,
            router: null,
            mode: null,
            fees: null,
        };
        if (!winner || BigInt(candidate.outAmountRaw) > BigInt(winner.outAmountRaw)) winner = candidate;
    }
    return winner;
}

function shouldRetryStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

export function makeTitanRestQuoteClient(options: TitanRestClientOptions): ExactQuoteClient {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const userPublicKey = (options.userPublicKey ?? TITAN_DEFAULT_QUOTE_USER_PUBLIC_KEY).trim();
    if (!isValidTitanQuotePublicKey(userPublicKey)) throw new Error('Invalid TITAN_QUOTE_USER_PUBLIC_KEY');
    const authToken = options.authToken.trim();
    const fetchImpl = options.fetch ?? globalThis.fetch;
    // One retry by default: this sits on an interactive request path, where a
    // second retry costs more latency than the attempt is worth.
    const maxRetries = options.maxRetries ?? 1;
    const defaultTimeoutMs = options.timeoutMs ?? 8_000;
    const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));

    return {
        id: 'titan',
        async fetchQuote(args): Promise<ExactQuote | null> {
            // Split the caller's budget across attempts so retries can't
            // overshoot the deadline it gave us.
            const budgetMs = args.timeoutMs ?? defaultTimeoutMs;
            const attemptTimeoutMs = Math.max(1_000, Math.floor(budgetMs / (maxRetries + 1)));
            const params = new URLSearchParams({
                inputMint: args.inputMint,
                outputMint: args.outputMint,
                amount: args.amountRaw,
                userPublicKey,
                slippageBps: '50',
            });
            const url = `${baseUrl}${QUOTE_PATH}?${params}`;

            for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
                try {
                    const response = await withExternalTiming('titan', url, () =>
                        fetchImpl(url, {
                            headers: { Authorization: `Bearer ${authToken}` },
                            signal: AbortSignal.timeout(attemptTimeoutMs),
                        }),
                    );
                    if (!response.ok) {
                        const body = (await response.text().catch(() => '')).slice(0, 1024);
                        if (shouldRetryStatus(response.status) && attempt < maxRetries) {
                            await sleep(150 * 2 ** attempt);
                            continue;
                        }
                        if (response.status === 400 || response.status === 404) return null;
                        throw new TitanRestHttpError(response.status, body);
                    }
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    let decoded: unknown;
                    try {
                        decoded = decode(bytes, { useBigInt64: true });
                    } catch (error) {
                        throw new TitanRestMalformedResponseError(error);
                    }
                    return normalizeQuote(decoded, {
                        inputMint: args.inputMint,
                        outputMint: args.outputMint,
                        amountRaw: args.amountRaw,
                    });
                } catch (error) {
                    if (
                        error instanceof TitanRestHttpError ||
                        error instanceof TitanRestMalformedResponseError ||
                        attempt >= maxRetries
                    ) {
                        throw error;
                    }
                    await sleep(150 * 2 ** attempt);
                }
            }
            // The loop either returns or throws on its final attempt.
            throw new Error('Titan REST quote exhausted retries without a result');
        },
    };
}
