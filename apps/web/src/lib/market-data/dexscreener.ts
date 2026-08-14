import 'server-only';

import { sanitizeLiquidity, type ChainId } from './chains';
import type { DexPair, DexPairWindow } from './dex-pairs';

/**
 * DexScreener client.
 *
 * Used for two things GeckoTerminal's keyless tier is bad at: refreshing the
 * metrics of pools we already know about (30 pools per call, ~500ms, no key),
 * and resolving a contract address a visitor pasted into search. It is *not*
 * used to rank a chain's pools — its `/search` endpoint answers by relevance,
 * and measured against GeckoTerminal's volume-sorted pool list it misses the
 * real top pools by two orders of magnitude.
 *
 * Documented limits (no key): 300 req/min for `/latest/dex/*`, 60 req/min for
 * the token-profile endpoints. Everything here stays well inside the first.
 */

const BASE_URL = 'https://api.dexscreener.com';

/** Pair addresses accepted by one `/latest/dex/pairs` call, fixed upstream. */
export const DEXSCREENER_PAIR_BATCH = 30;

/**
 * Chain ids as DexScreener spells them. Stellar is absent from their index, so
 * pools on it keep whatever GeckoTerminal reported and are never enriched.
 */
const DEXSCREENER_CHAIN: Record<ChainId, string | null> = {
    solana: 'solana',
    ethereum: 'ethereum',
    base: 'base',
    bsc: 'bsc',
    arbitrum: 'arbitrum',
    stellar: null,
    robinhood: 'robinhood',
};

export function toDexScreenerChain(chain: ChainId): string | null {
    return DEXSCREENER_CHAIN[chain];
}

export function fromDexScreenerChain(chainId: string): ChainId | null {
    const match = (Object.keys(DEXSCREENER_CHAIN) as ChainId[]).find(
        chain => DEXSCREENER_CHAIN[chain] === chainId,
    );
    return match ?? null;
}

export interface DexScreenerToken {
    address?: string;
    name?: string;
    symbol?: string;
}

export interface DexScreenerPair {
    chainId?: string;
    dexId?: string;
    url?: string;
    pairAddress?: string;
    baseToken?: DexScreenerToken;
    quoteToken?: DexScreenerToken;
    priceUsd?: string;
    priceNative?: string;
    txns?: Record<string, { buys?: number; sells?: number } | undefined>;
    volume?: Record<string, number | undefined>;
    priceChange?: Record<string, number | undefined>;
    liquidity?: { usd?: number; base?: number; quote?: number };
    fdv?: number;
    marketCap?: number;
    pairCreatedAt?: number;
    info?: { imageUrl?: string; websites?: { url?: string }[]; socials?: { type?: string; url?: string }[] };
}

interface DexScreenerResponse {
    pairs?: DexScreenerPair[] | null;
    pair?: DexScreenerPair | null;
}

/** Upstream stalls are the common failure here, not errors — keep the leash short. */
const REQUEST_TIMEOUT_MS = 8_000;

async function fetchJson(path: string): Promise<DexScreenerResponse | null> {
    try {
        const response = await fetch(`${BASE_URL}${path}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        return (await response.json()) as DexScreenerResponse;
    } catch {
        return null;
    }
}

function readPairs(payload: DexScreenerResponse | null): DexScreenerPair[] {
    if (!payload) return [];
    if (Array.isArray(payload.pairs)) return payload.pairs;
    if (payload.pair) return [payload.pair];
    return [];
}

/**
 * Live metrics for known pools, keyed by lowercased pair address.
 *
 * Addresses that upstream does not know are simply absent from the map — a
 * partial answer is normal (27 of 30 on a measured Solana batch) and callers
 * must keep their existing values for the misses rather than blanking them.
 */
export async function fetchDexScreenerPairs(
    chain: ChainId,
    pairAddresses: readonly string[],
): Promise<Map<string, DexScreenerPair>> {
    const chainId = toDexScreenerChain(chain);
    const found = new Map<string, DexScreenerPair>();
    if (!chainId || pairAddresses.length === 0) return found;

    const batches: string[][] = [];
    for (let index = 0; index < pairAddresses.length; index += DEXSCREENER_PAIR_BATCH) {
        batches.push([...pairAddresses.slice(index, index + DEXSCREENER_PAIR_BATCH)]);
    }

    const results = await Promise.all(
        batches.map(batch => fetchJson(`/latest/dex/pairs/${chainId}/${batch.join(',')}`)),
    );

    for (const payload of results) {
        for (const pair of readPairs(payload)) {
            const address = pair.pairAddress?.toLowerCase();
            if (address) found.set(address, pair);
        }
    }

    return found;
}

/**
 * Free-text search across every chain DexScreener indexes. Accepts a token
 * contract address, a symbol, a name, or a `BASE/QUOTE` pair expression.
 */
export async function searchDexScreener(query: string): Promise<DexScreenerPair[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    return readPairs(await fetchJson(`/latest/dex/search?q=${encodeURIComponent(trimmed)}`));
}

/** Every pool a token trades in on one chain. */
export async function fetchDexScreenerTokenPairs(
    chain: ChainId,
    tokenAddress: string,
): Promise<DexScreenerPair[]> {
    const chainId = toDexScreenerChain(chain);
    if (!chainId || !tokenAddress.trim()) return [];

    const payload = await fetchJson(`/token-pairs/v1/${chainId}/${encodeURIComponent(tokenAddress.trim())}`);
    // This endpoint answers with a bare array rather than the `{pairs}` envelope.
    if (Array.isArray(payload)) return payload as DexScreenerPair[];
    return readPairs(payload);
}

function num(value: unknown): number | null {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function toWindow(source: Record<string, number | undefined> | undefined): DexPairWindow {
    return { m5: num(source?.m5), h1: num(source?.h1), h6: num(source?.h6), h24: num(source?.h24) };
}

/**
 * A DexScreener pool in the app's own pair shape, so pools that were never
 * ranked (search hits, pasted addresses) render through the same table and page
 * as the ranked ones.
 */
export function dexScreenerPairToDexPair(
    chain: ChainId,
    live: DexScreenerPair,
    fallbackAddress = '',
): DexPair {
    const base = live.baseToken ?? {};
    const quote = live.quoteToken ?? {};
    const h24 = live.txns?.h24;

    return {
        chain,
        address: live.pairAddress ?? fallbackAddress,
        name: `${base.symbol ?? '—'} / ${quote.symbol ?? '—'}`,
        dex: live.dexId ?? null,
        base: {
            address: base.address ?? '',
            symbol: base.symbol ?? '—',
            name: base.name ?? '',
            imageUrl: live.info?.imageUrl ?? null,
        },
        quote: {
            address: quote.address ?? '',
            symbol: quote.symbol ?? '—',
            name: quote.name ?? '',
            imageUrl: null,
        },
        priceUsd: num(live.priceUsd),
        priceChange: toWindow(live.priceChange),
        volume: toWindow(live.volume),
        liquidityUsd: sanitizeLiquidity(live.liquidity?.usd),
        fdvUsd: num(live.fdv) ?? num(live.marketCap),
        buys24h: num(h24?.buys),
        sells24h: num(h24?.sells),
        createdAt: num(live.pairCreatedAt),
    };
}

/** A single pool by its pair address. */
export async function fetchDexScreenerPair(
    chain: ChainId,
    pairAddress: string,
): Promise<DexScreenerPair | null> {
    const found = await fetchDexScreenerPairs(chain, [pairAddress]);
    return found.get(pairAddress.toLowerCase()) ?? null;
}
