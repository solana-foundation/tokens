import 'server-only';

import { withTtl } from './cache';
import { numberOrNull, stringOrNull } from './types';

/**
 * DefiLlama supplies protocol TVL per chain. It is keyless and unmetered, but
 * it only lists chains it has integrated — Robinhood Chain has no entry, so
 * callers must treat a missing TVL as "not tracked" rather than "zero".
 */

const DEFILLAMA_CHAINS_URL = 'https://api.llama.fi/v2/chains';

const loadChainTvls = withTtl(10 * 60_000, async (): Promise<Map<string, number>> => {
    const res = await fetch(DEFILLAMA_CHAINS_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
        cache: 'no-store',
    });
    if (!res.ok) throw new Error(`DefiLlama chains HTTP ${res.status}`);

    const rows = (await res.json()) as unknown;
    const byName = new Map<string, number>();
    if (!Array.isArray(rows)) return byName;

    for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        const record = row as { name?: unknown; tvl?: unknown };
        const name = stringOrNull(record.name);
        const tvl = numberOrNull(record.tvl);
        if (name && tvl !== null) byName.set(name.toLowerCase(), tvl);
    }
    return byName;
});

/** Returns null when DefiLlama does not track the chain at all. */
export async function fetchChainTvl(defillamaChain: string | null): Promise<number | null> {
    if (!defillamaChain) return null;
    try {
        const byName = await loadChainTvls();
        return byName.get(defillamaChain.toLowerCase()) ?? null;
    } catch (error) {
        console.warn('[defillama] chain TVL unavailable:', error instanceof Error ? error.message : String(error));
        return null;
    }
}
