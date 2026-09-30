import { Effect } from 'effect';

import { listAssetIdRenames, type CloudRunError, type ListAssetIdRenamesResult } from '@/lib/cloudrun';

/**
 * API-side cache over admin asset-id renames (cloudrun-assets
 * `listAssetIdRenames`), modeled on `advisories.ts`: short TTL, single-flight
 * refresh, last-good served while stale.
 *
 * Why it exists: the static registry is resolved in-memory, ahead of the
 * database, and it keeps an asset's original id until its data is changed in
 * code. After an admin renames `bitcoin` to `btc`, the registry still answers
 * `bitcoin` and every database read keyed by that id comes back empty. The
 * resolver maps registry ids through this table so both ids reach the asset.
 *
 * Always fail-open: a rename lookup must never take a route down. When the
 * table cannot be loaded the registry id is used as-is, which is today's
 * behaviour for every asset that was not renamed.
 */
const TTL_MS = Number(process.env.ASSET_ID_RENAMES_TTL_MS) || 60_000;

/** After a failed cold load, skip the RPC briefly instead of paying its latency per request. */
const COLD_RETRY_BACKOFF_MS = 5_000;

type RenamesLoader = () => Effect.Effect<ListAssetIdRenamesResult, CloudRunError>;

const EMPTY: ReadonlyMap<string, string> = new Map();

let snapshot: ReadonlyMap<string, string> | null = null;
let loadedAtMs = 0;
let inflight: Promise<ReadonlyMap<string, string>> | null = null;
let lastFailureAtMs = 0;
let loader: RenamesLoader = listAssetIdRenames;

function toSnapshot(rows: ListAssetIdRenamesResult): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    if (!Array.isArray(rows)) return out;
    for (const row of rows) {
        const from = typeof row?.from === 'string' ? row.from.trim().toLowerCase() : '';
        const to = typeof row?.to === 'string' ? row.to.trim() : '';
        if (from && to && from !== to) out.set(from, to);
    }
    return out;
}

function logFailure(event: 'asset_id_renames_refresh_failed' | 'asset_id_renames_load_failed', err: unknown): void {
    console.error(
        JSON.stringify({
            event,
            side: 'api',
            staleness_ms: loadedAtMs > 0 ? Date.now() - loadedAtMs : null,
            error: err instanceof Error ? err.message : String(err),
        }),
    );
}

function startLoad(): Promise<ReadonlyMap<string, string>> {
    const promise = Effect.runPromise(loader())
        .then(rows => {
            snapshot = toSnapshot(rows);
            loadedAtMs = Date.now();
            lastFailureAtMs = 0;
            return snapshot;
        })
        .catch((err: unknown) => {
            lastFailureAtMs = Date.now();
            throw err;
        })
        .finally(() => {
            if (inflight === promise) inflight = null;
        });
    inflight = promise;
    return promise;
}

function refreshInBackground(): void {
    if (inflight) return;
    if (Date.now() - loadedAtMs < TTL_MS) return;
    startLoad().catch(err => logFailure('asset_id_renames_refresh_failed', err));
}

async function getRenames(): Promise<ReadonlyMap<string, string>> {
    if (snapshot) {
        refreshInBackground();
        return snapshot;
    }
    try {
        if (inflight) return await inflight;
        if (lastFailureAtMs > 0 && Date.now() - lastFailureAtMs < COLD_RETRY_BACKOFF_MS) return EMPTY;
        return await startLoad();
    } catch (err) {
        logFailure('asset_id_renames_load_failed', err);
        return EMPTY;
    }
}

/** Former id (lowercased) -> current id. Never fails; empty when unavailable. */
export function loadAssetIdRenames(): Effect.Effect<ReadonlyMap<string, string>, never> {
    return Effect.promise(() => getRenames());
}

/** The asset's current id: `assetId` itself unless an admin renamed it. */
export function currentAssetId(renames: ReadonlyMap<string, string>, assetId: string): string {
    return renames.get(assetId.trim().toLowerCase()) ?? assetId;
}

/** Test hook: seed the cache (`null` clears it back to cold). */
export function __setAssetIdRenamesForTests(renames: Record<string, string> | null): void {
    snapshot = renames ? toSnapshot(Object.entries(renames).map(([from, to]) => ({ from, to }))) : null;
    loadedAtMs = renames ? Date.now() : 0;
    inflight = null;
    lastFailureAtMs = 0;
}

/** Test hook: swap the loader (`null` restores the Cloud Run query). */
export function __setAssetIdRenamesLoaderForTests(next: RenamesLoader | null): void {
    loader = next ?? listAssetIdRenames;
}
