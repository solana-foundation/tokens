import 'server-only';

import { sanitizeLiquidity, type ChainDefinition } from './chains';
import { withKeyedTtl } from './cache';
import { numberOrNull, stringOrNull } from './types';

/**
 * GeckoTerminal is CoinGecko's on-chain DEX API. It covers every network this
 * app tracks — including Robinhood Chain, which DefiLlama does not index yet.
 *
 * It runs keyless, but barely. Measured against the pools endpoint from one IP,
 * the public tier answers 429 to roughly half of all calls even at six-second
 * spacing, and the `Retry-After` header it sends back reads `0`, so there is
 * nothing useful to obey. A cold five-page read costs about a minute of
 * backoff. Setting `COINGECKO_API_KEY` (the Pro key the rest of the app already
 * reads, 500 calls/min) or the free `COINGECKO_DEMO_API_KEY` (30/min) switches
 * to the keyed hosts and to spacing those tiers actually allow — the app works
 * without one, just slower and with fewer rows per sweep.
 */

interface ProviderTier {
    baseUrl: string;
    headers: Record<string, string>;
    /** Minimum gap between calls, chosen to sit inside the tier's quota. */
    spacingMs: number;
    label: string;
}

function resolveTier(): ProviderTier {
    const pro = process.env.COINGECKO_API_KEY?.trim();
    if (pro) {
        return {
            baseUrl: 'https://pro-api.coingecko.com/api/v3/onchain',
            headers: { 'x-cg-pro-api-key': pro },
            spacingMs: 150,
            label: 'pro',
        };
    }

    const demo = process.env.COINGECKO_DEMO_API_KEY?.trim();
    if (demo) {
        return {
            baseUrl: 'https://api.coingecko.com/api/v3/onchain',
            headers: { 'x-cg-demo-api-key': demo },
            spacingMs: 2_100,
            label: 'demo',
        };
    }

    return {
        baseUrl: 'https://api.geckoterminal.com/api/v2',
        headers: {},
        // Wider than the tier nominally needs. Nothing makes the public tier
        // reliable, but pacing this far apart keeps the retry budget for the
        // calls that will actually go through.
        spacingMs: 3_000,
        label: 'keyless',
    };
}

const TIER = resolveTier();

/**
 * Backoff for a 429, doubling per attempt. Deliberately short at the start:
 * with the public tier a rejection says nothing about when the next call will
 * be allowed, so waiting eight seconds up front mostly wastes time.
 */
const RATE_LIMIT_BACKOFF_MS = 2_000;
const MAX_ATTEMPTS = 3;

export interface DexPool {
    /** Pool name as reported upstream, e.g. `USDC / XLM`. */
    name: string;
    dex: string | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    priceChange24hPercent: number | null;
}

export interface NetworkDexSnapshot {
    /**
     * Sum of sanitized reserves across the sampled pools — NOT the chain's total
     * DEX depth. The API exposes no reserve sort, so the sample is the 20
     * highest-volume pools; anything below that is invisible here.
     */
    sampledLiquidityUsd: number;
    sampledVolume24hUsd: number;
    /** Pools sampled — the API pages at 20, which is the sample size here. */
    poolCount: number;
    /** Pools whose reported reserve was negative or unparseable. */
    invalidLiquidityCount: number;
    topPools: DexPool[];
}

/**
 * `interactive` work is something a reader is waiting on; `background` is a
 * warm-up sweep that only has to finish eventually.
 *
 * The distinction matters because the queue below is strictly serial. The
 * curated liquidity sweep is ~20 calls, so a `/dex` render arriving mid-sweep
 * used to sit behind all of them — measured at 33.8s for a page whose own work
 * is five calls. Letting interactive work jump the queue caps that wait at the
 * one call already in flight.
 */
type RequestPriority = 'interactive' | 'background';

interface QueuedRequest {
    task: () => Promise<unknown>;
    priority: RequestPriority;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
}

const pending: QueuedRequest[] = [];
let isDraining = false;

/**
 * Serializes every GeckoTerminal call and spaces them out. Parallel requests
 * are what trip the keyless limiter, so concurrency is deliberately 1.
 */
function enqueue<T>(task: () => Promise<T>, priority: RequestPriority): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        pending.push({
            task: task as () => Promise<unknown>,
            priority,
            resolve: resolve as (value: unknown) => void,
            reject,
        });
        void drain();
    });
}

async function drain(): Promise<void> {
    if (isDraining) return;
    isDraining = true;
    try {
        while (pending.length > 0) {
            const interactive = pending.findIndex(request => request.priority === 'interactive');
            const [request] = pending.splice(interactive >= 0 ? interactive : 0, 1);
            if (!request) continue;

            try {
                request.resolve(await request.task());
            } catch (error) {
                request.reject(error);
            }
            if (pending.length > 0) {
                await new Promise(resolve => setTimeout(resolve, TIER.spacingMs));
            }
        }
    } finally {
        isDraining = false;
    }
}

/**
 * Shared entry point so every GeckoTerminal caller goes through the same queue
 * and backoff. Bypassing it with a direct fetch re-introduces the 429s.
 */
export async function fetchGeckoTerminalJson(
    path: string,
    priority: RequestPriority = 'interactive',
): Promise<unknown> {
    return await enqueue(async () => {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            const startedAt = performance.now();
            const res = await fetch(`${TIER.baseUrl}${path}`, {
                headers: { accept: 'application/json', ...TIER.headers },
                signal: AbortSignal.timeout(25_000),
                cache: 'no-store',
            });
            const body = res.ok ? await res.json() : null;

            // The same `external_call` shape the Effect fetch helper emits. This
            // queue is serial and paced, so when a page feels slow the only way
            // to tell upstream latency from time spent waiting in line is to
            // have the per-call duration written down.
            console.log(
                JSON.stringify({
                    event: 'external_call',
                    provider: 'geckoterminal',
                    endpoint: path.split('?')[0],
                    status: res.status,
                    duration_ms: Math.round(performance.now() - startedAt),
                    ok: res.ok,
                    priority,
                    tier: TIER.label,
                    attempt,
                }),
            );

            if (res.status === 429) {
                if (attempt === MAX_ATTEMPTS) throw new Error('GeckoTerminal rate limited');
                await new Promise(resolve =>
                    setTimeout(resolve, RATE_LIMIT_BACKOFF_MS * 2 ** (attempt - 1)),
                );
                continue;
            }
            if (!res.ok) throw new Error(`GeckoTerminal ${path} HTTP ${res.status}`);

            return body;
        }
        throw new Error('GeckoTerminal rate limited');
    }, priority);
}

function toPool(raw: unknown): { pool: DexPool; liquidityValid: boolean } | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const attributes = (raw as { attributes?: Record<string, unknown> }).attributes;
    if (!attributes) return null;

    const liquidityUsd = sanitizeLiquidity(attributes.reserve_in_usd);
    const volume = attributes.volume_usd as Record<string, unknown> | undefined;
    const priceChange = attributes.price_change_percentage as Record<string, unknown> | undefined;

    return {
        pool: {
            name: stringOrNull(attributes.name) ?? 'Unknown pool',
            dex: stringOrNull((raw as { relationships?: Record<string, { data?: { id?: unknown } }> }).relationships?.dex?.data?.id),
            liquidityUsd,
            volume24hUsd: numberOrNull(Number(volume?.h24 ?? Number.NaN)),
            priceChange24hPercent: numberOrNull(Number(priceChange?.h24 ?? Number.NaN)),
        },
        liquidityValid: liquidityUsd !== null,
    };
}

async function loadNetworkPools(network: string): Promise<NetworkDexSnapshot> {
    // Sorting by 24h volume matters: the default ordering returns trending and
    // newly created pools, which reported Solana at $664k against Base's $63M
    // purely because the samples were not comparable. Volume-sorted samples are.
    const payload = await fetchGeckoTerminalJson(
        `/networks/${encodeURIComponent(network)}/pools?page=1&sort=h24_volume_usd_desc`,
    );
    const rows = (payload as { data?: unknown })?.data;
    const entries = Array.isArray(rows) ? rows : [];

    const pools: DexPool[] = [];
    let sampledLiquidityUsd = 0;
    let sampledVolume24hUsd = 0;
    let invalidLiquidityCount = 0;

    for (const entry of entries) {
        const parsed = toPool(entry);
        if (!parsed) continue;
        if (!parsed.liquidityValid) invalidLiquidityCount += 1;
        sampledLiquidityUsd += parsed.pool.liquidityUsd ?? 0;
        sampledVolume24hUsd += parsed.pool.volume24hUsd ?? 0;
        pools.push(parsed.pool);
    }

    pools.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

    return {
        sampledLiquidityUsd,
        sampledVolume24hUsd,
        poolCount: pools.length,
        invalidLiquidityCount,
        topPools: pools.slice(0, 5),
    };
}

const loadNetworkPoolsCached = withKeyedTtl(5 * 60_000, loadNetworkPools);

export async function fetchNetworkDexSnapshot(chain: ChainDefinition): Promise<NetworkDexSnapshot | null> {
    try {
        return await loadNetworkPoolsCached(chain.geckoterminalNetwork);
    } catch (error) {
        console.warn(
            `[geckoterminal] ${chain.id} pools unavailable:`,
            error instanceof Error ? error.message : String(error),
        );
        return null;
    }
}
