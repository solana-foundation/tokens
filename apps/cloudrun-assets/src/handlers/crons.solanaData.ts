import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { decodeJobArgs, type JobArgSpecs } from '@tokens/effect/job-args';
import { runJobPool } from '@tokens/effect/job-runner';

import type { CronResult } from './crons';

// Project Canon asset registry: the data team's `GET data.solana.com/v1/assets`
// (~3.3k Solana mints with the Foundation taxonomy group > category > class plus
// Allium / RWA.xyz classifications and values). Synced hourly into
// `solana_data_assets_latest` (migration 0031) and served as GET /api/v2/registry;
// tokens.xyz's /registry page reads that endpoint instead of the upstream.
//
// Two phases per run:
//   1. pull the whole registry (all-or-nothing), upsert every row, deactivate
//      rows the upstream stopped returning;
//   2. for active mints the platform has no logo for (no variant_markets_latest /
//      tokens / mint_logos row), fill `provider_name` / `provider_logo_uri` from
//      Birdeye's batch meta-data endpoint, bounded by `providerLimit` + `budgetMs`.
//      logo-sync then re-hosts those logos first-party (LOGO_SOURCE_TABLES_SQL).

export const SOLANA_DATA_SYNC_JOB = 'sync-solana-data-assets';
export const DEFAULT_SOLANA_DATA_API_URL = 'https://data.solana.com/v1/assets';
/** Birdeye caps `/defi/v3/token/meta-data/multiple` at 50 addresses per call. */
export const BIRDEYE_METADATA_BATCH_SIZE = 50;
/** Rows per multi-row INSERT; keeps each statement well under the parameter limit. */
const UPSERT_CHUNK_SIZE = 200;

/** One normalized upstream row. Numeric fields arrive as strings ('6.68E9'); parsed here. */
export interface SolanaDataAssetRow {
    mint: string;
    symbol: string;
    group: string | null;
    category: string | null;
    assetClass: string | null;
    alliumClass: string | null;
    rwaClass: string | null;
    alliumValueUsd: number | null;
    rwaValueUsd: number | null;
    marketCapUsd: number | null;
    raw: unknown;
}

export interface SolanaDataAssetsPayload {
    /** Upstream `data.generatedAt`; null when the envelope omits it. */
    generatedAt: string | null;
    truncated: boolean;
    rows: SolanaDataAssetRow[];
    /** Rows dropped because `mint_address` was not a base58 mint (or `token` was empty). */
    invalidMint: number;
    /** Non-empty numeric strings that did not parse (kept as null on the row). */
    invalidNumeric: number;
    /** Later duplicates of a mint already seen (first occurrence wins). */
    duplicateMint: number;
}

export type SolanaDataFetchResult =
    | ({ ok: true } & SolanaDataAssetsPayload)
    | { ok: false; reason: 'error'; message?: string }
    | { ok: false; reason: 'http_error'; status: number }
    | { ok: false; reason: 'invalid_payload' };

export interface SolanaDataClient {
    fetchAssets(): Promise<SolanaDataFetchResult>;
}

export interface BirdeyeTokenMetadata {
    symbol: string | null;
    name: string | null;
    /** Raw upstream URL (https or ipfs://); never rewritten here so logo-sync can re-host it. */
    logoURI: string | null;
}

export type BirdeyeMetadataResult =
    { ok: true; byMint: Map<string, BirdeyeTokenMetadata> } | { ok: false; status: number; message: string };

export interface BirdeyeMetadataClient {
    /** Batch meta-data lookup; at most BIRDEYE_METADATA_BATCH_SIZE mints per call. */
    fetchTokenMetadataMultiple(mints: readonly string[]): Promise<BirdeyeMetadataResult>;
}

export interface SolanaDataAssetUpsert {
    mint: string;
    symbol: string;
    groupName: string | null;
    category: string | null;
    assetClass: string | null;
    alliumClass: string | null;
    rwaClass: string | null;
    alliumValueUsd: number | null;
    rwaValueUsd: number | null;
    marketCapUsd: number | null;
    sourceRank: number;
    /** ISO timestamp from the upstream envelope. */
    sourceGeneratedAt: string;
    rawJson: string;
    lastSeenAt: number;
    lastSyncedAt: number;
}

export interface SolanaDataProviderMetadataUpdate {
    mint: string;
    name: string | null;
    logoURI: string | null;
    /** Stamped on misses too, so no-image mints are not re-queried every run. */
    fetchedAt: number;
}

export interface SolanaDataJobsRepo {
    listActiveCount(): Promise<number>;
    /** Upsert; must NOT touch the `provider_*` columns (the Birdeye fallback outlives every sync). */
    upsertLatest(rows: readonly SolanaDataAssetUpsert[]): Promise<void>;
    /** Flags active rows whose mint is absent from `mints`; returns the count. */
    deactivateMissing(mints: readonly string[], lastSyncedAt: number): Promise<number>;
    /** Active mints with no platform logo whose provider fallback is unset or older than `staleBeforeMs`, by rank. */
    listMintsNeedingProviderMetadata(limit: number, staleBeforeMs: number): Promise<string[]>;
    updateProviderMetadata(rows: readonly SolanaDataProviderMetadataUpdate[]): Promise<void>;
}

export interface SolanaDataCronDeps {
    repo: SolanaDataJobsRepo;
    solanaData: SolanaDataClient;
    birdeye: BirdeyeMetadataClient;
    now: () => number;
}

// Literal specs (not the clampedInt() helper) so decodeJobArgs infers `number`
// per key — the helper's return type is the JobArgSpec union.
export const SOLANA_DATA_SYNC_ARG_SPECS = {
    /** Birdeye meta-data lookups per run (mints, not calls); 0 disables the provider phase. */
    providerLimit: { kind: 'int', fallback: 500, min: 0, max: 2000 },
    /** Provider pool lanes / pacing: the Birdeye key is shared with the market crons and the peg guard. */
    concurrency: { kind: 'int', fallback: 2, min: 1, max: 4 },
    delayMs: { kind: 'int', fallback: 200, min: 0, max: 5_000 },
    /** Re-query a mint's provider metadata after this many days (hits and misses alike). */
    providerRefreshDays: { kind: 'int', fallback: 7, min: 1, max: 90 },
    /** Whole-run deadline; the provider phase gets whatever is left after the upsert. */
    budgetMs: { kind: 'int', fallback: 300_000, min: 10_000, max: 520_000 },
} satisfies JobArgSpecs;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/** `'6.686697914433202E9'` → 6686697914.43; `''`/null → null; garbage → null + counted. */
function parseUsd(value: unknown, counters: { invalidNumeric: number }): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') {
        counters.invalidNumeric += 1;
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
        counters.invalidNumeric += 1;
        return null;
    }
    return parsed;
}

/**
 * Normalizes the `{ source, data: { generatedAt, truncated, rows } }` envelope.
 * Returns null when `data.rows` is not an array (contract drift / error page);
 * individual bad rows are dropped and counted rather than failing the pull.
 */
export function parseSolanaDataAssetsPayload(raw: unknown): SolanaDataAssetsPayload | null {
    if (!isRecord(raw) || !isRecord(raw.data)) return null;
    const data = raw.data;
    const rawRows: unknown = data.rows;
    if (!Array.isArray(rawRows)) return null;
    const counters = { invalidNumeric: 0 };
    const rows: SolanaDataAssetRow[] = [];
    const seen = new Set<string>();
    let invalidMint = 0;
    let duplicateMint = 0;

    for (const item of rawRows as unknown[]) {
        if (!isRecord(item)) {
            invalidMint += 1;
            continue;
        }
        const mint = asNonEmptyString(item.mint_address);
        const symbol = asNonEmptyString(item.token);
        if (!mint || !symbol || !looksLikeSolanaMintAddress(mint)) {
            invalidMint += 1;
            continue;
        }
        if (seen.has(mint)) {
            duplicateMint += 1;
            continue;
        }
        seen.add(mint);
        rows.push({
            mint,
            symbol,
            group: asNonEmptyString(item.group),
            category: asNonEmptyString(item.category),
            assetClass: asNonEmptyString(item.class),
            alliumClass: asNonEmptyString(item.allium_asset_class),
            rwaClass: asNonEmptyString(item.rwa_asset_class),
            alliumValueUsd: parseUsd(item.allium_asset_value_usd, counters),
            rwaValueUsd: parseUsd(item.rwa_asset_value_usd, counters),
            marketCapUsd: parseUsd(item.coingecko_market_cap, counters),
            raw: item,
        });
    }

    return {
        generatedAt: asNonEmptyString(data.generatedAt),
        truncated: data.truncated === true,
        rows,
        invalidMint,
        invalidNumeric: counters.invalidNumeric,
        duplicateMint,
    };
}

/** Birdeye `data` map → per-mint metadata; entries with neither name nor logo are kept as misses (null fields). */
export function parseBirdeyeMetadataPayload(
    raw: unknown,
    requested: readonly string[],
): Map<string, BirdeyeTokenMetadata> | null {
    if (!isRecord(raw) || raw.success !== true || !isRecord(raw.data)) return null;
    const out = new Map<string, BirdeyeTokenMetadata>();
    for (const mint of requested) {
        const item = raw.data[mint];
        if (!isRecord(item)) continue;
        const name = asNonEmptyString(item.name);
        const logoURI = asNonEmptyString(item.logo_uri) ?? asNonEmptyString(item.logoURI);
        out.set(mint, {
            symbol: asNonEmptyString(item.symbol),
            name: name && name.toLowerCase() !== 'unknown' ? name : null,
            logoURI: logoURI && /^(https?:\/\/|ipfs:\/\/)/i.test(logoURI) ? logoURI : null,
        });
    }
    return out;
}

export function solanaDataRowToUpsert(
    row: SolanaDataAssetRow,
    sourceRank: number,
    sourceGeneratedAt: string,
    now: number,
): SolanaDataAssetUpsert {
    return {
        mint: row.mint,
        symbol: row.symbol,
        groupName: row.group,
        category: row.category,
        assetClass: row.assetClass,
        alliumClass: row.alliumClass,
        rwaClass: row.rwaClass,
        alliumValueUsd: row.alliumValueUsd,
        rwaValueUsd: row.rwaValueUsd,
        marketCapUsd: row.marketCapUsd,
        sourceRank,
        sourceGeneratedAt,
        rawJson: JSON.stringify(row.raw),
        lastSeenAt: now,
        lastSyncedAt: now,
    };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
    return out;
}

interface SyncSummary {
    job: typeof SOLANA_DATA_SYNC_JOB;
    event: 'solana_data_assets_sync';
    ok: boolean;
    skipped?: string;
    fetched: number;
    synced: number;
    deactivated: number;
    invalidMint: number;
    invalidNumeric: number;
    duplicateMint: number;
    /** Drops to 0 if the upstream classification contract drifts (group/category/class renamed). */
    withGroup: number;
    providerLooked: number;
    providerHits: number;
    providerFailed: number;
    partial: boolean;
    generatedAt: string | null;
    duration_ms: number;
}

export async function syncSolanaDataAssets(deps: SolanaDataCronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = await Effect.runPromise(decodeJobArgs(SOLANA_DATA_SYNC_ARG_SPECS, rawArgs));
    const start = deps.now();
    const log = (summary: SyncSummary) => console.log(JSON.stringify(summary));
    const base = {
        job: SOLANA_DATA_SYNC_JOB,
        event: 'solana_data_assets_sync',
        fetched: 0,
        synced: 0,
        deactivated: 0,
        invalidMint: 0,
        invalidNumeric: 0,
        duplicateMint: 0,
        withGroup: 0,
        providerLooked: 0,
        providerHits: 0,
        providerFailed: 0,
        partial: false,
        generatedAt: null,
    } satisfies Omit<SyncSummary, 'ok' | 'duration_ms'>;

    const result = await deps.solanaData.fetchAssets();
    if (!result.ok) {
        // Total upstream failure: `ok: false` lets Cloud Scheduler retry instead of
        // acknowledging a tick that left the registry stale. Nothing is deactivated.
        log({ ...base, ok: false, skipped: result.reason, duration_ms: deps.now() - start });
        return {
            ok: false,
            processed: 0,
            durationMs: deps.now() - start,
            reason: result.reason,
            ...(result.reason === 'http_error' ? { status: result.status } : {}),
        };
    }

    const counts = {
        fetched: result.rows.length,
        invalidMint: result.invalidMint,
        invalidNumeric: result.invalidNumeric,
        duplicateMint: result.duplicateMint,
        withGroup: result.rows.filter(row => row.group !== null).length,
        generatedAt: result.generatedAt,
    };

    // Whole set or nothing: a truncated body would deactivate every row past the cut.
    if (result.truncated) {
        log({ ...base, ...counts, ok: true, skipped: 'invalid_payload', duration_ms: deps.now() - start });
        return { ok: true, processed: 0, durationMs: deps.now() - start, skipped: true, reason: 'invalid_payload' };
    }
    if (result.rows.length === 0) {
        log({ ...base, ...counts, ok: true, skipped: 'empty_payload', duration_ms: deps.now() - start });
        return { ok: true, processed: 0, durationMs: deps.now() - start, skipped: true, reason: 'empty_payload' };
    }

    const existingActive = await deps.repo.listActiveCount();
    if (existingActive > 0 && result.rows.length < existingActive * 0.7) {
        log({ ...base, ...counts, ok: true, skipped: 'suspicious_drop', duration_ms: deps.now() - start });
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            skipped: true,
            reason: 'suspicious_drop',
            existingActiveCount: existingActive,
            nextActiveCount: result.rows.length,
        };
    }

    const generatedAt = result.generatedAt ?? new Date(start).toISOString();
    const upserts = result.rows.map((row, index) => solanaDataRowToUpsert(row, index, generatedAt, start));
    let synced = 0;
    let upsertFailed = 0;
    for (const part of chunk(upserts, UPSERT_CHUNK_SIZE)) {
        try {
            await deps.repo.upsertLatest(part);
            synced += part.length;
        } catch (err) {
            upsertFailed += part.length;
            console.error(
                `[${SOLANA_DATA_SYNC_JOB}] upsert chunk failed`,
                err instanceof Error ? err.message : String(err),
            );
        }
    }
    if (synced === 0) {
        log({ ...base, ...counts, ok: false, skipped: 'upsert_failed', duration_ms: deps.now() - start });
        return {
            ok: false,
            processed: 0,
            durationMs: deps.now() - start,
            reason: 'upsert_failed',
            failed: upsertFailed,
        };
    }

    // Every parsed upstream mint counts as present, including the ones whose
    // chunk failed: a transient DB error must not flip a live row inactive.
    const deactivated = await deps.repo.deactivateMissing(
        result.rows.map(row => row.mint),
        start,
    );

    let providerLooked = 0;
    let providerHits = 0;
    let providerFailed = 0;
    let partial = false;
    if (args.providerLimit > 0) {
        const staleBefore = start - args.providerRefreshDays * 86_400_000;
        const pending = await deps.repo.listMintsNeedingProviderMetadata(args.providerLimit, staleBefore);
        const batches = chunk(pending, BIRDEYE_METADATA_BATCH_SIZE);
        if (batches.length > 0) {
            const summary = await Effect.runPromise(
                runJobPool({
                    label: `${SOLANA_DATA_SYNC_JOB}.provider`,
                    items: batches,
                    concurrency: args.concurrency,
                    delayMs: args.delayMs,
                    budgetMs: Math.max(0, args.budgetMs - (deps.now() - start)),
                    shouldStop: isShuttingDown,
                    process: batch =>
                        Effect.tryPromise(async () => {
                            const res = await deps.birdeye.fetchTokenMetadataMultiple(batch);
                            if (!res.ok) {
                                // Not stamped: the whole batch is retried next run.
                                throw new Error(`birdeye meta-data ${res.status}: ${res.message}`);
                            }
                            const fetchedAt = deps.now();
                            const updates: SolanaDataProviderMetadataUpdate[] = batch.map(mint => {
                                const meta = res.byMint.get(mint);
                                const name = meta?.name ?? null;
                                const logoURI = meta?.logoURI ?? null;
                                if (name || logoURI) providerHits += 1;
                                return { mint, name, logoURI, fetchedAt };
                            });
                            await deps.repo.updateProviderMetadata(updates);
                            providerLooked += batch.length;
                        }),
                    onItemError: batch =>
                        Effect.sync(() => {
                            providerFailed += batch.length;
                        }),
                }),
            );
            partial = summary.partial;
        }
    }

    const summary: SyncSummary = {
        ...base,
        ...counts,
        ok: true,
        synced,
        deactivated,
        providerLooked,
        providerHits,
        providerFailed,
        partial,
        duration_ms: deps.now() - start,
    };
    log(summary);

    return {
        ok: true,
        processed: synced,
        durationMs: summary.duration_ms,
        ...(partial ? { partial: true } : {}),
        fetched: counts.fetched,
        synced,
        upsertFailed,
        deactivated,
        invalidMint: counts.invalidMint,
        invalidNumeric: counts.invalidNumeric,
        duplicateMint: counts.duplicateMint,
        withGroup: counts.withGroup,
        providerLooked,
        providerHits,
        providerFailed,
        generatedAt,
    };
}

export type SolanaDataJobHandler = (deps: SolanaDataCronDeps, args: unknown) => Promise<CronResult>;

export const solanaDataJobs: Record<string, SolanaDataJobHandler> = {
    [SOLANA_DATA_SYNC_JOB]: syncSolanaDataAssets,
};
