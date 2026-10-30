import { PRE_STOCKS, type PreStockListing } from '@tokens/asset-registry';

import type { CronResult } from './crons';

// PreStocks reference data for tokenized pre-IPO equities, from
// `GET https://prestocks.com/api/prestocks` (unauthenticated), which returns
// every listed token in one array. The payload has no timestamp, so
// `lastFetchedAt` is stamped by the cron.

export interface PreStocksApiSnapshot {
    symbol: string;
    name: string | null;
    mint: string;
    markPriceUsd: number | null;
    markValuationUsd: number | null;
    tokenPriceUsd: number | null;
    impliedValuationUsd: number | null;
    supply: number | null;
    imageUrl: string | null;
    externalUrl: string | null;
}

export interface PreStocksClient {
    fetchAll(): Promise<PreStocksApiSnapshot[]>;
}

export interface PrestocksPriceUpsert extends PreStocksApiSnapshot {
    lastFetchedAt: number;
}

export interface PrestocksRepo {
    upsertLatest(row: PrestocksPriceUpsert): Promise<void>;
}

export interface PrestocksCronDeps {
    prestocks: PreStocksClient;
    repo: PrestocksRepo;
    now: () => number;
    listings?: readonly PreStockListing[];
    isRefreshEnabled?: () => boolean;
}

function defaultIsRefreshEnabled(): boolean {
    return (process.env.PRESTOCKS_REFRESH_ENABLED ?? '').trim().toLowerCase() === 'true';
}

const DIVERGENCE_LOG_THRESHOLD = 0.01;

export interface PrestocksRefreshResult extends CronResult {
    requested: number;
    succeeded: number;
    failed: number;
    disabled: boolean;
}

export async function refreshPrestocksPrices(
    deps: PrestocksCronDeps,
    rawArgs: unknown,
): Promise<PrestocksRefreshResult> {
    const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
    const start = deps.now();
    const requireRefreshEnabled = args.requireRefreshEnabled === false ? false : true;
    const isEnabled = (deps.isRefreshEnabled ?? defaultIsRefreshEnabled)();
    if (requireRefreshEnabled && !isEnabled) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            requested: 0,
            succeeded: 0,
            failed: 0,
            disabled: true,
        };
    }

    const listings = deps.listings ?? PRE_STOCKS;
    let succeeded = 0;
    let failed = 0;

    // Our listings are the allowlist: provider entries for any other mint are
    // never written.
    const snapshotByMint = await deps.prestocks.fetchAll().then(
        entries => new Map(entries.map(entry => [entry.mint, entry] as const)),
        (err: unknown) => {
            console.error('[refreshPrestocksPrices] refresh failed', err);
            return null;
        },
    );

    for (const listing of listings) {
        if (!snapshotByMint) {
            failed += 1;
            continue;
        }
        try {
            const snapshot = snapshotByMint.get(listing.mint);
            if (!snapshot) {
                failed += 1;
                console.warn('[refreshPrestocksPrices] listing missing from provider response', {
                    symbol: listing.symbol,
                    mint: listing.mint,
                });
                continue;
            }
            logImpliedValuationDivergence(snapshot);
            // Upsert on success only: a provider outage keeps the last snapshot.
            await deps.repo.upsertLatest({ ...snapshot, lastFetchedAt: deps.now() });
            succeeded += 1;
        } catch (err) {
            failed += 1;
            console.error('[refreshPrestocksPrices] refresh failed', { symbol: listing.symbol }, err);
        }
    }

    return {
        ok: !(listings.length > 0 && succeeded === 0 && failed >= listings.length),
        processed: succeeded + failed,
        durationMs: deps.now() - start,
        requested: listings.length,
        succeeded,
        failed,
        disabled: false,
    };
}

function logImpliedValuationDivergence(snapshot: PreStocksApiSnapshot): void {
    const { markPriceUsd, markValuationUsd, tokenPriceUsd, impliedValuationUsd } = snapshot;
    if (
        markPriceUsd === null ||
        markPriceUsd <= 0 ||
        markValuationUsd === null ||
        markValuationUsd <= 0 ||
        tokenPriceUsd === null ||
        tokenPriceUsd <= 0 ||
        impliedValuationUsd === null ||
        impliedValuationUsd <= 0
    ) {
        return;
    }
    const computed = (markValuationUsd * tokenPriceUsd) / markPriceUsd;
    const divergence = Math.abs(computed - impliedValuationUsd) / impliedValuationUsd;
    if (divergence > DIVERGENCE_LOG_THRESHOLD) {
        console.warn('[refreshPrestocksPrices] implied valuation diverges from provider value', {
            symbol: snapshot.symbol,
            computed,
            provider: impliedValuationUsd,
            divergence,
        });
    }
}

export type PrestocksJobHandler = (deps: PrestocksCronDeps, args: unknown) => Promise<CronResult>;

export const prestocksJobs: Record<string, PrestocksJobHandler> = {
    'refresh-prestocks-prices': refreshPrestocksPrices,
};
