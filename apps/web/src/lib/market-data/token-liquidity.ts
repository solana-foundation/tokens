import 'server-only';

import { sanitizeLiquidity, CHAINS, type ChainId } from './chains';
import { withKeyedTtl } from './cache';
import { fetchGeckoTerminalJson } from './geckoterminal';

/**
 * Per-token DEX depth, keyed by on-chain address.
 *
 * GeckoTerminal accepts up to 30 addresses per call, and the keyless tier is
 * slow enough that fetching every curated mint (~600) would take half a minute
 * on a cold cache. Callers are expected to ask only for the rows they render.
 */

const MAX_ADDRESSES_PER_CALL = 30;

export interface TokenLiquidity {
    address: string;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
}

function parseNumber(value: unknown): number | null {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

async function loadBatch(chain: ChainId, addresses: string[]): Promise<TokenLiquidity[]> {
    const network = CHAINS[chain].geckoterminalNetwork;
    const payload = await fetchGeckoTerminalJson(
        `/networks/${encodeURIComponent(network)}/tokens/multi/${addresses.map(encodeURIComponent).join(',')}`,
    );

    const rows = (payload as { data?: unknown })?.data;
    if (!Array.isArray(rows)) return [];

    const results: TokenLiquidity[] = [];
    for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        const attributes = (row as { attributes?: Record<string, unknown> }).attributes;
        if (!attributes) continue;

        const address = typeof attributes.address === 'string' ? attributes.address : null;
        if (!address) continue;

        const volume = attributes.volume_usd as Record<string, unknown> | undefined;
        results.push({
            address,
            liquidityUsd: sanitizeLiquidity(attributes.total_reserve_in_usd),
            volume24hUsd: parseNumber(volume?.h24),
        });
    }
    return results;
}

const loadBatchCached = withKeyedTtl(5 * 60_000, async (key: string): Promise<TokenLiquidity[]> => {
    const [chain, joined] = key.split('|');
    return await loadBatch(chain as ChainId, joined.split(','));
});

export interface TokenLiquidityResult {
    /** Lower-cased address -> depth. Addresses upstream did not know are absent. */
    byAddress: Map<string, TokenLiquidity>;
    /** Addresses requested but not returned, so callers can report the gap. */
    missing: string[];
}

export async function fetchTokenLiquidity(
    chain: ChainId,
    addresses: readonly string[],
): Promise<TokenLiquidityResult> {
    const unique = [...new Set(addresses.filter(Boolean))];
    const byAddress = new Map<string, TokenLiquidity>();
    if (unique.length === 0) return { byAddress, missing: [] };

    for (let offset = 0; offset < unique.length; offset += MAX_ADDRESSES_PER_CALL) {
        const batch = unique.slice(offset, offset + MAX_ADDRESSES_PER_CALL);
        try {
            const rows = await loadBatchCached(`${chain}|${batch.join(',')}`);
            for (const row of rows) byAddress.set(row.address.toLowerCase(), row);
        } catch (error) {
            console.warn(
                `[token-liquidity] ${chain} batch failed:`,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    const missing = unique.filter(address => !byAddress.has(address.toLowerCase()));
    return { byAddress, missing };
}
