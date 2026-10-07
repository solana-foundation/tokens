import { PRE_STOCKS } from '@tokens/asset-registry';

import type { PrestocksPriceResult } from '@/lib/cloudrun/prestocksReads';

import type { PreStocksMintSnapshot } from './_asset-detail-response';
import { computePreStocksDerived } from './_asset-helpers';

const PRE_STOCKS_MINTS: ReadonlySet<string> = new Set(PRE_STOCKS.map(listing => listing.mint));

// PreStocks reference marks have no provider timestamp — treat a feed
// that hasn't refreshed in 24h as dead rather than displaying it forever.
const PRESTOCKS_MAX_AGE_MS = 24 * 60 * 60_000;

/** The subset of `mints` that are PreStocks tokens (deduped), i.e. worth a reference lookup. */
export function selectPreStocksMints(mints: Iterable<string>): string[] {
    const selected = new Set<string>();
    for (const mint of mints) {
        if (PRE_STOCKS_MINTS.has(mint)) selected.add(mint);
    }
    return [...selected];
}

/** Index `prestocksGetLatestByMints` rows by mint, dropping missing and stale snapshots. */
export function freshPreStocksByMint(
    entries: ReadonlyArray<{ mint: string; snapshot: PrestocksPriceResult | null }>,
    nowMs: number = Date.now(),
): Map<string, PreStocksMintSnapshot> {
    const byMint = new Map<string, PreStocksMintSnapshot>();
    for (const entry of entries) {
        const snapshot = entry.snapshot;
        if (!snapshot) continue;
        if (nowMs - snapshot.lastFetchedAt > PRESTOCKS_MAX_AGE_MS) continue;
        byMint.set(entry.mint, {
            symbol: snapshot.symbol,
            markPriceUsd: snapshot.markPriceUsd,
            markValuationUsd: snapshot.markValuationUsd,
            tokenPriceUsd: snapshot.tokenPriceUsd,
            lastFetchedAt: snapshot.lastFetchedAt,
        });
    }
    return byMint;
}

export interface PreStocksCanonicalMarket {
    source: 'prestocks';
    symbol: string;
    mint: string;
    price: number | null;
    marketCap: number | null;
    markPriceUsd: number | null;
    markValuationUsd: number | null;
    impliedValuationUsd: number | null;
    premiumToMarkPercent: number | null;
    volume24hUSD: null;
    priceChange24hPercent: null;
    lastFetchedAt: number;
    providerLastUpdatedAt: number;
    asOf: number;
}

/**
 * Canonical market for tokenized pre-IPO exposure. There is no public market
 * to quote, so the company-level benchmark is the valuation implied by the
 * token price against the PreStocks reference mark, derived from OUR on-chain
 * price so it never disagrees with the displayed price.
 *
 * At most one PreStocks mint exists per asset today; the first variant with a
 * fresh snapshot wins if that ever changes. Returns null when none has one.
 */
export function buildPreStocksCanonicalMarket(params: {
    variantMints: readonly string[];
    preStocksByMint: ReadonlyMap<string, PreStocksMintSnapshot>;
    onChainPriceUsd: (mint: string) => number | null | undefined;
}): PreStocksCanonicalMarket | null {
    const mint = params.variantMints.find(candidate => params.preStocksByMint.has(candidate));
    const snapshot = mint ? params.preStocksByMint.get(mint) : undefined;
    if (!mint || !snapshot) return null;

    const derived = computePreStocksDerived(snapshot, params.onChainPriceUsd(mint));
    return {
        source: 'prestocks',
        symbol: snapshot.symbol,
        mint,
        price: derived.basisPriceUsd,
        marketCap: derived.impliedValuationUsd,
        markPriceUsd: snapshot.markPriceUsd,
        markValuationUsd: snapshot.markValuationUsd,
        impliedValuationUsd: derived.impliedValuationUsd,
        premiumToMarkPercent: derived.premiumToMarkPercent,
        volume24hUSD: null,
        priceChange24hPercent: null,
        lastFetchedAt: snapshot.lastFetchedAt,
        providerLastUpdatedAt: snapshot.lastFetchedAt,
        asOf: snapshot.lastFetchedAt,
    };
}
