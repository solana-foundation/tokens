import 'server-only';

import { sanitizeLiquidity, type ChainDefinition } from './chains';
import { withKeyedTtl } from './cache';
import { numberOrNull, stringOrNull } from './types';

/**
 * GeckoTerminal is CoinGecko's on-chain DEX API. It covers every network this
 * app tracks — including Robinhood Chain, which DefiLlama does not index yet —
 * and needs no key.
 *
 * The keyless tier rate-limits hard: sequential calls 2.5s apart still answer
 * 429. Requests are therefore serialized through one queue with backoff, and
 * results are cached per network.
 */

const GECKOTERMINAL_BASE_URL = 'https://api.geckoterminal.com/api/v2';

const REQUEST_SPACING_MS = 1_500;
const RATE_LIMIT_BACKOFF_MS = 8_000;
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

let queue: Promise<unknown> = Promise.resolve();

/**
 * Serializes every GeckoTerminal call and spaces them out. Parallel requests
 * are what trip the keyless limiter, so concurrency is deliberately 1.
 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
        const result = await task();
        await new Promise(resolve => setTimeout(resolve, REQUEST_SPACING_MS));
        return result;
    });
    // Keep the chain alive even if one task rejects.
    queue = run.catch(() => undefined);
    return run;
}

/**
 * Shared entry point so every GeckoTerminal caller goes through the same queue
 * and backoff. Bypassing it with a direct fetch re-introduces the 429s.
 */
export async function fetchGeckoTerminalJson(path: string): Promise<unknown> {
    return await enqueue(async () => {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            const res = await fetch(`${GECKOTERMINAL_BASE_URL}${path}`, {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(25_000),
                cache: 'no-store',
            });

            if (res.status === 429) {
                if (attempt === MAX_ATTEMPTS) throw new Error('GeckoTerminal rate limited');
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS * attempt));
                continue;
            }
            if (!res.ok) throw new Error(`GeckoTerminal ${path} HTTP ${res.status}`);

            return await res.json();
        }
        throw new Error('GeckoTerminal rate limited');
    });
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
