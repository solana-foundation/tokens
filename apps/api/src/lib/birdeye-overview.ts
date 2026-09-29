import { Effect } from 'effect';

import { MissingEnvError } from '@tokens/effect';
import { fetchJsonWithRetry } from '@tokens/effect';

const BIRDEYE_API_URL = 'https://public-api.birdeye.so';

/**
 * Live market fields for one mint, in the variant-market snapshot's field
 * names so callers can treat it as a stand-in for a missing snapshot
 * (Birdeye specifics stay in this module).
 */
export interface ProviderMarketOverview {
    liquidity: number | null;
    marketCap: number | null;
    holder: number | null;
    volume24hUSD: number | null;
}

function toFinite(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return null;
}

/**
 * `null` when the provider has nothing scoreable for the mint: an unsuccessful
 * or empty payload, or neither liquidity nor market cap above zero. Market cap
 * deliberately has no `fdv` fallback — the snapshot pipeline doesn't use one
 * for scoring, and the score must not jump when a snapshot later appears.
 */
export function normalizeProviderOverview(payload: unknown): ProviderMarketOverview | null {
    if (!payload || typeof payload !== 'object') return null;
    const { success, data } = payload as { success?: unknown; data?: unknown };
    if (success !== true || !data || typeof data !== 'object') return null;

    const overview = data as Record<string, unknown>;
    const liquidity = toFinite(overview.liquidity);
    const marketCap = toFinite(overview.marketCap);
    if (!((liquidity ?? 0) > 0) && !((marketCap ?? 0) > 0)) return null;

    return {
        liquidity,
        marketCap,
        holder: toFinite(overview.holder),
        volume24hUSD: toFinite(overview.v24hUSD),
    };
}

/**
 * Live market overview via Birdeye `/defi/token_overview`. Resolves `null`
 * for a mint the provider doesn't know; fails with tagged errors on provider
 * trouble — callers are expected to degrade gracefully.
 */
export function fetchProviderMarketOverview(
    mint: string,
    options: { deadlineMs?: number } = {},
): Effect.Effect<ProviderMarketOverview | null, unknown> {
    const apiKey = (process.env.BIRDEYE_API_KEY ?? '').trim();
    if (!apiKey) {
        return Effect.fail(new MissingEnvError({ message: 'BIRDEYE_API_KEY is not set', name: 'BIRDEYE_API_KEY' }));
    }

    return fetchJsonWithRetry<unknown>({
        url: `${BIRDEYE_API_URL}/defi/token_overview?address=${encodeURIComponent(mint)}`,
        service: 'birdeye',
        init: {
            headers: {
                'X-API-KEY': apiKey,
                'x-chain': 'solana',
                Accept: 'application/json',
            },
            // Callers cache the normalized result themselves.
            cache: 'no-store',
        },
        // Keep the provider on a short leash: this runs inline on a request
        // that must answer "unscored" rather than block on a slow upstream.
        signal: AbortSignal.timeout(options.deadlineMs ?? 3_500),
        timeout: '2 seconds',
        maxRetries: 1,
        // Unknown or malformed address. Auth failures (401/403) stay errors so
        // a bad key is never mistaken for "token does not exist".
        recoverHttpError: error =>
            error.status === 400 || error.status === 404 ? { value: null, outcome: 'not_found' } : null,
    }).pipe(Effect.map(normalizeProviderOverview));
}
