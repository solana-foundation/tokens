import type { VariantAdvisory } from '@tokens/asset-registry';
import { isHiddenAdvisory } from '@tokens/asset-registry';

import type { LaunchpadTokenResult } from '@/lib/cloudrun';

/** stonk.fun coin page; the only place the external URL shape is known. */
export const STONKFUN_TOKEN_URL_BASE = 'https://www.stonkfun.xyz/token/';

export function stonkfunTokenUrl(mint: string): string {
    return `${STONKFUN_TOKEN_URL_BASE}${encodeURIComponent(mint)}`;
}

export interface AssetLaunchEntry {
    mint: string;
    symbol: string | null;
    name: string | null;
    logoURI: string | null;
    quoteMint: string;
    quoteSymbol: string | null;
    launchpad: string;
    price: number | null;
    marketCap: number | null;
    fdv: number | null;
    liquidity: number | null;
    volume24hUSD: number | null;
    priceChange24hPercent: number | null;
    launchedAt: number | null;
    graduatedAt: number | null;
    externalUrl: string;
    advisory: VariantAdvisory | null;
}

export interface AssetLaunchesResponse {
    assetId: string;
    total: number;
    limit: number;
    launches: AssetLaunchEntry[];
    lastUpdatedAt: number | null;
}

function toFiniteOrZero(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Shapes launchpad rows for the asset page: drops hidden (blocked) mints,
 * attaches advisories, orders by 24h volume, and caps to `limit`. `total`
 * counts every visible launch so the UI can show "View all".
 */
export function buildAssetLaunchesResponse(input: {
    assetId: string;
    rows: readonly LaunchpadTokenResult[];
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>;
    limit: number;
    externalUrlFor?: (mint: string) => string;
}): AssetLaunchesResponse {
    const externalUrlFor = input.externalUrlFor ?? stonkfunTokenUrl;
    const seen = new Set<string>();
    const visible: AssetLaunchEntry[] = [];
    let lastUpdatedAt: number | null = null;

    for (const row of input.rows) {
        if (seen.has(row.mint)) continue;
        const advisory = input.advisoriesByMint.get(row.mint) ?? null;
        if (isHiddenAdvisory(advisory)) continue;
        seen.add(row.mint);
        if (row.lastSyncedAt > 0) {
            lastUpdatedAt = lastUpdatedAt === null ? row.lastSyncedAt : Math.max(lastUpdatedAt, row.lastSyncedAt);
        }
        visible.push({
            mint: row.mint,
            symbol: row.symbol,
            name: row.name,
            logoURI: row.logoURI,
            quoteMint: row.quoteMint,
            quoteSymbol: row.quoteSymbol,
            launchpad: row.launchpad,
            price: row.price,
            marketCap: row.marketCap,
            fdv: row.fdv,
            liquidity: row.liquidity,
            volume24hUSD: row.volume24hUSD,
            priceChange24hPercent: row.priceChange24hPercent,
            launchedAt: row.launchedAt,
            graduatedAt: row.graduatedAt,
            externalUrl: externalUrlFor(row.mint),
            advisory,
        });
    }

    visible.sort(
        (a, b) =>
            toFiniteOrZero(b.volume24hUSD) - toFiniteOrZero(a.volume24hUSD) ||
            toFiniteOrZero(b.marketCap) - toFiniteOrZero(a.marketCap) ||
            a.mint.localeCompare(b.mint),
    );

    return {
        assetId: input.assetId,
        total: visible.length,
        limit: input.limit,
        launches: visible.slice(0, input.limit),
        lastUpdatedAt,
    };
}
