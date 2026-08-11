import 'server-only';

import { withTtl } from './cache';
import { stringOrNull } from './types';

/**
 * CoinGecko's full coin list, indexed for resolving a registry asset onto a
 * CoinGecko id. The list is ~18k entries and changes slowly, so it is cached
 * for hours; the keyless tier rate-limits well before that matters.
 */

export const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';

export interface CoinGeckoIndex {
    ids: Set<string>;
    bySymbol: Map<string, string>;
    byName: Map<string, string>;
}

/**
 * Must stay identical to the asset registry's slug rules — notably `&` becomes
 * `and`, so "S&P Global" is `sandp-global`. Diverging here silently breaks every
 * ampersand name (AT&T, Procter & Gamble, Hims & Hers).
 */
export function slugify(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replaceAll('&', 'and')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export const loadCoinGeckoIndex = withTtl(12 * 60 * 60_000, async (): Promise<CoinGeckoIndex> => {
    const res = await fetch(`${COINGECKO_BASE_URL}/coins/list`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
        cache: 'no-store',
    });
    if (!res.ok) throw new Error(`CoinGecko coins/list HTTP ${res.status}`);

    const list = (await res.json()) as { id?: unknown; symbol?: unknown; name?: unknown }[];
    const ids = new Set<string>();
    const bySymbol = new Map<string, string>();
    const byName = new Map<string, string>();

    for (const coin of list) {
        const id = stringOrNull(coin.id);
        if (!id) continue;
        ids.add(id);
        const symbol = stringOrNull(coin.symbol)?.toUpperCase();
        if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, id);
        const name = stringOrNull(coin.name);
        if (name) {
            const key = slugify(name);
            if (key && !byName.has(key)) byName.set(key, id);
        }
    }
    return { ids, bySymbol, byName };
});

export interface ResolvableAsset {
    assetId: string;
    symbol: string;
    aliases: readonly string[];
    coingeckoId: string | null;
}

export function resolveCoinGeckoId(asset: ResolvableAsset, index: CoinGeckoIndex): string | null {
    if (asset.coingeckoId && index.ids.has(asset.coingeckoId)) return asset.coingeckoId;

    const symbol = asset.symbol.toUpperCase();
    if (symbol && index.bySymbol.has(symbol)) return index.bySymbol.get(symbol) ?? null;

    for (const alias of asset.aliases) {
        const key = slugify(alias);
        if (index.ids.has(key)) return key;
        const byName = index.byName.get(key);
        if (byName) return byName;
    }

    return index.byName.get(asset.assetId) ?? null;
}
