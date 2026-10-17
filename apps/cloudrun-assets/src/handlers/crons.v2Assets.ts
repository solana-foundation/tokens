import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { AGGREGATE_COIN_IDS, NATIVE_COIN_DEPLOYMENTS } from '@tokens/asset-registry/chain-deployments';
import {
    CHAINS,
    EVM_CHAIN_KINDS,
    EVM_NATIVE_ASSET_ADDRESS,
    chainAddressKey,
    isChainKind,
    normalizeAddressForChain,
    type ChainKind,
} from '@tokens/asset-registry/chains';
import { decodeJobArgs, type JobArgSpecs } from '@tokens/effect/job-args';
import { runJobPool } from '@tokens/effect/job-runner';

import { InvalidArgsError } from './assets';
import {
    birdeyeOverviewToUpsert,
    type BirdeyeClient,
    type CronResult,
    type VariantMarketUpsertFromBirdeye,
} from './crons';

// v2 multichain assets: the three worker jobs that populate the chain-first
// tables from migration 0033 (`v2_asset_variants`, `v2_variant_markets_latest`,
// `v2_asset_chain_markets_latest`). Runbook: docs/operations/v2-multichain-assets.md
//
//   sync-v2-solana-variants        mirrors v1's Solana rows (asset_variants,
//                                  variant_markets_latest, asset_markets_latest)
//                                  into the v2 tables: exact parity by copy, v1
//                                  stays the Solana writer. Set-based SQL, no
//                                  provider calls, every few minutes.
//   sync-v2-evm-variants           derives EVM variants for registered assets
//                                  from coingecko_coins.platforms plus the
//                                  registry's native-coin table. Daily.
//   refresh-v2-evm-variant-markets per-chain Birdeye token-overview snapshots
//                                  for the stalest EVM variants. Every 15 min.
//
// Ownership is the `origin` column: a job only updates / deactivates rows it
// wrote (solana_v1 | coingecko | config | birdeye), so the three never fight.

export const V2_SOLANA_SYNC_JOB = 'sync-v2-solana-variants';
export const V2_EVM_VARIANTS_SYNC_JOB = 'sync-v2-evm-variants';
export const V2_EVM_MARKETS_REFRESH_JOB = 'refresh-v2-evm-variant-markets';

export const V2_SOLANA_SYNC_EVENT = 'v2_solana_sync';
export const V2_EVM_VARIANTS_SYNC_EVENT = 'v2_evm_variants_sync';
export const V2_EVM_VARIANTS_KEPT_STALE_EVENT = 'v2_evm_variants_kept_stale';
export const V2_EVM_MARKETS_REFRESH_EVENT = 'v2_evm_markets_refresh';
export const V2_EVM_MARKETS_CHAIN_DOWN_EVENT = 'v2_evm_markets_chain_down';

export const DERIVED_VARIANT_TAG = 'coingecko-derived';
export const NATIVE_COIN_TAG = 'native-coin';

/**
 * Coin-list rows not re-synced within this window are treated as unknown:
 * sync-coingecko-coin-list runs weekly, so cover two cadences plus a day of
 * slack. A stale coin row must never deactivate a variant (the data may just
 * be old), only a fresh row that stopped listing the chain may.
 */
export const COIN_LIST_FRESHNESS_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

export interface V2DerivationAssetRow {
    assetId: string;
    category: string;
    coingeckoId: string;
    /** CoinGecko `platforms` map: platform id → contract address ('' for the coin's home chain). */
    platforms: Record<string, string>;
    /** CoinGecko `detail_platforms`: platform id → decimals, when the per-coin metadata was fetched. */
    decimalsByPlatform: Record<string, number>;
    assetPlatformId: string | null;
    /** CoinGecko ticker symbol for the coin (label fallback). */
    coinSymbol: string | null;
    coinLastSyncedAt: number | null;
}

export interface V2CoinPlatformsRow {
    coinId: string;
    symbol: string | null;
    platforms: Record<string, string>;
    decimalsByPlatform: Record<string, number>;
    coinLastSyncedAt: number | null;
}

export interface V2DerivedVariantRow {
    chain: ChainKind;
    address: string;
    assetId: string;
    variantId: string;
    isActive: boolean;
}

export interface V2DerivedVariantUpsert {
    chain: ChainKind;
    address: string;
    assetId: string;
    variantId: string;
    kind: string;
    trustTier: string;
    tags: readonly string[];
    label: string | null;
    decimals: number | null;
    origin: 'coingecko' | 'config';
    nowMs: number;
}

export interface V2VariantKeyRef {
    chain: ChainKind;
    address: string;
}

/** Birdeye overview mapped for a v2 market row: no decimals default (EVM tokens are not 9). */
export type V2VariantMarketUpsert = Omit<VariantMarketUpsertFromBirdeye, 'mint' | 'decimals'> & {
    chain: ChainKind;
    address: string;
    decimals: number | null;
};

export interface V2AssetsJobsRepo {
    /**
     * Upsert every Solana `asset_variants` row (active or not) into
     * `v2_asset_variants` with `origin='solana_v1'` and `last_seen_at=nowMs`.
     * Must not touch rows another origin owns, and must not let an older
     * overlapping run (smaller nowMs) overwrite a newer one. Mirror rows whose
     * variant_id v1 now carries on a different mint are removed first
     * (`replaced`) so the (asset_id, variant_id) unique index cannot reject
     * the whole statement.
     */
    mirrorSolanaVariants(nowMs: number): Promise<{ inserted: number; updated: number; replaced: number }>;
    /** Deactivate solana_v1 rows no run has seen since `seenBeforeMs` (hard-deleted in v1); returns the count. */
    deactivateUnseenSolanaVariants(seenBeforeMs: number, nowMs: number): Promise<number>;
    /** Copy `variant_markets_latest` rows for mirrored Solana variants whose fetch stamps changed; returns rows written. */
    mirrorSolanaMarkets(): Promise<number>;
    /** Copy `asset_markets_latest` into the chain='solana' rollup rows; returns rows written. */
    mirrorSolanaRollups(): Promise<number>;

    /** Active, non-tombstoned assets with a coingecko_id, joined to their synced coin row. */
    listAssetsWithCoinPlatforms(limit: number): Promise<V2DerivationAssetRow[]>;
    /** Active, non-tombstoned assets regardless of coingecko_id (for AGGREGATE_COIN_IDS / NATIVE_COIN_DEPLOYMENTS). */
    listActiveAssets(): Promise<Array<{ assetId: string; category: string }>>;
    /** Platform maps for explicit coin ids (missing ids are simply absent). */
    findCoinPlatformsByCoinIds(coinIds: readonly string[]): Promise<V2CoinPlatformsRow[]>;
    /** Every derived (`origin` coingecko | config) variant on the given chains, active or not. */
    listDerivedVariants(chains: readonly ChainKind[]): Promise<V2DerivedVariantRow[]>;
    /** Insert-or-update on (chain, address, asset_id), touching ONLY derived rows (`skipped` otherwise). */
    upsertDerivedVariant(args: V2DerivedVariantUpsert): Promise<'inserted' | 'updated' | 'skipped'>;
    /** Soft-deactivate derived rows (never hard-deletes); returns the count. */
    deactivateDerivedVariants(
        keys: ReadonlyArray<V2VariantKeyRef & { assetId: string }>,
        nowMs: number,
    ): Promise<number>;

    /**
     * Distinct (chain, address) of active variants on active, non-tombstoned
     * assets whose v2 market snapshot is missing or older than the cutoff,
     * stalest first. Excludes the EIP-7528 native address.
     */
    listStaleActiveVariantsByChains(
        chains: readonly ChainKind[],
        beforeOverviewFetchedAt: number,
        limit: number,
    ): Promise<V2VariantKeyRef[]>;
    upsertVariantMarketFromBirdeye(args: V2VariantMarketUpsert): Promise<void>;
    /** Stamp a (chain, address) so it leaves the stale set even when Birdeye had nothing. */
    touchVariantMarket(chain: ChainKind, address: string, lastFetchedAt: number): Promise<void>;
    /** Write-through of Birdeye decimals into derived rows that had none from CoinGecko. */
    setVariantDecimalsIfNull(chain: ChainKind, address: string, decimals: number): Promise<void>;
}

export interface V2AssetsCronDeps {
    repo: V2AssetsJobsRepo;
    /** One Birdeye client per chain with a `providers.birdeyeChain` slug (built in index.ts). */
    birdeyeByChain: Partial<Record<ChainKind, BirdeyeClient>>;
    now: () => number;
}

function asObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null) throw new InvalidArgsError('args must be an object');
    return value as Record<string, unknown>;
}

/** `chains` arg: EVM chain ids only (Solana variants come from the v1 mirror). Default = every EVM chain. */
export function parseEvmChainsArg(raw: unknown): ChainKind[] {
    if (raw === undefined) return [...EVM_CHAIN_KINDS];
    if (!Array.isArray(raw)) throw new InvalidArgsError('chains must be an array of chain ids');
    const out: ChainKind[] = [];
    for (const item of raw) {
        if (!isChainKind(item)) throw new InvalidArgsError(`chains contains an unsupported chain: ${String(item)}`);
        if (item === 'solana')
            throw new InvalidArgsError('chains must not include solana (Solana variants are mirrored from v1)');
        if (!out.includes(item)) out.push(item);
    }
    if (out.length === 0) throw new InvalidArgsError('chains must not be empty');
    return out;
}

// ---------------------------------------------------------------------------
// sync-v2-solana-variants
// ---------------------------------------------------------------------------

interface SolanaSyncSummary {
    job: typeof V2_SOLANA_SYNC_JOB;
    event: typeof V2_SOLANA_SYNC_EVENT;
    ok: boolean;
    reason?: string;
    variantsInserted: number;
    variantsUpdated: number;
    variantsReplaced: number;
    variantsDeactivated: number;
    marketsWritten: number;
    rollupsWritten: number;
    duration_ms: number;
}

/**
 * Three idempotent set-based statements: variants (then age out rows v1 no
 * longer has), markets (only rows whose v1 fetch stamp changed), rollups.
 * A failed variants mirror aborts the run (`ok: false`) so markets never
 * reference variants that were not copied; a failed markets or rollups copy
 * is reported but keeps `ok: true` (the next tick repairs it).
 */
export async function syncSolanaVariants(deps: V2AssetsCronDeps, rawArgs: unknown): Promise<CronResult> {
    asObject(rawArgs ?? {});
    const start = deps.now();
    const log = (summary: SolanaSyncSummary) => console.log(JSON.stringify(summary));
    const base = {
        job: V2_SOLANA_SYNC_JOB,
        event: V2_SOLANA_SYNC_EVENT,
        variantsInserted: 0,
        variantsUpdated: 0,
        variantsReplaced: 0,
        variantsDeactivated: 0,
        marketsWritten: 0,
        rollupsWritten: 0,
    } satisfies Omit<SolanaSyncSummary, 'ok' | 'duration_ms'>;

    let variants: { inserted: number; updated: number; replaced: number };
    try {
        variants = await deps.repo.mirrorSolanaVariants(start);
    } catch (err) {
        console.error(
            `[${V2_SOLANA_SYNC_JOB}] variants mirror failed`,
            err instanceof Error ? err.message : String(err),
        );
        log({ ...base, ok: false, reason: 'mirror_failed', duration_ms: deps.now() - start });
        return { ok: false, processed: 0, durationMs: deps.now() - start, reason: 'mirror_failed' };
    }
    const deactivated = await deps.repo.deactivateUnseenSolanaVariants(start, start);

    let marketsWritten = 0;
    let rollupsWritten = 0;
    const failures: string[] = [];
    try {
        marketsWritten = await deps.repo.mirrorSolanaMarkets();
    } catch (err) {
        failures.push('markets');
        console.error(
            `[${V2_SOLANA_SYNC_JOB}] markets mirror failed`,
            err instanceof Error ? err.message : String(err),
        );
    }
    try {
        rollupsWritten = await deps.repo.mirrorSolanaRollups();
    } catch (err) {
        failures.push('rollups');
        console.error(
            `[${V2_SOLANA_SYNC_JOB}] rollups mirror failed`,
            err instanceof Error ? err.message : String(err),
        );
    }

    const summary: SolanaSyncSummary = {
        ...base,
        ok: true,
        ...(failures.length > 0 ? { reason: `${failures.join('+')}_failed` } : {}),
        variantsInserted: variants.inserted,
        variantsUpdated: variants.updated,
        variantsReplaced: variants.replaced,
        variantsDeactivated: deactivated,
        marketsWritten,
        rollupsWritten,
        duration_ms: deps.now() - start,
    };
    log(summary);
    return {
        ok: true,
        processed: variants.inserted + variants.updated,
        durationMs: summary.duration_ms,
        variantsInserted: variants.inserted,
        variantsUpdated: variants.updated,
        variantsReplaced: variants.replaced,
        variantsDeactivated: deactivated,
        marketsWritten,
        rollupsWritten,
        ...(failures.length > 0 ? { partial: true, failed: failures } : {}),
    };
}

// ---------------------------------------------------------------------------
// sync-v2-evm-variants
// ---------------------------------------------------------------------------

const EVM_VARIANTS_ARG_SPECS = {
    dryRun: { kind: 'bool', fallback: false },
    maxAssets: { kind: 'int', fallback: 5_000, min: 1, max: 50_000 },
} satisfies JobArgSpecs;

/** Variant kind for a CoinGecko-derived deployment of a registered asset. */
export function deriveVariantKindForChain(args: {
    category: string;
    assetPlatformId: string | null;
    chain: ChainKind;
}): string {
    switch (args.category) {
        case 'stablecoin':
            return 'stablecoin';
        case 'lst':
            return 'lst';
        case 'equity':
            return 'tokenized_equity';
        default:
            return args.assetPlatformId === CHAINS[args.chain].providers.coingeckoPlatform ? 'native' : 'bridged';
    }
}

function aggregateVariantKind(category: string): string {
    switch (category) {
        case 'stablecoin':
            return 'stablecoin';
        case 'commodity':
            return 'spot';
        default:
            return 'wrapped';
    }
}

function upperLabel(symbol: string | null | undefined): string | null {
    const trimmed = (symbol ?? '').trim().toUpperCase();
    return trimmed || null;
}

function desiredKey(assetId: string, chain: ChainKind, address: string): string {
    return `${assetId}\n${chainAddressKey(chain, address)}`;
}

interface EvmVariantsSyncSummary {
    job: typeof V2_EVM_VARIANTS_SYNC_JOB;
    event: typeof V2_EVM_VARIANTS_SYNC_EVENT;
    ok: boolean;
    dryRun: boolean;
    chains: ChainKind[];
    assetsScanned: number;
    assetsWithVariants: number;
    desired: number;
    inserted: number;
    updated: number;
    skippedOwned: number;
    skippedInvalid: number;
    deactivated: number;
    keptStale: number;
    /** Active derived rows left alone because their asset fell outside a bounded (`maxAssets`) scan. */
    keptUnscanned: number;
    /** Rows due for deactivation but kept because a replacement row for the same asset was not written this run. */
    keptPendingWrite: number;
    failed: number;
    byChain: Partial<Record<ChainKind, { desired: number }>>;
    duration_ms: number;
}

/**
 * Derive EVM variants for registered assets from `coingecko_coins.platforms`
 * (the chain → contract map CoinGecko syncs for every coin), plus the
 * registry's aggregate coin ids and native-coin deployments. Identity only:
 * markets come from refresh-v2-evm-variant-markets.
 *
 * Every active asset with a coingecko_id takes part, not only curated ones
 * (curation is list membership, not identity), so a chain's native coin shows
 * up as soon as its asset is registered.
 *
 * Deactivation (never deletion) happens when the coin's platforms no longer
 * list the chain AND the coin row is fresh, or when the asset is no longer
 * active / linked to a coin id. Rows whose coin row is stale are kept and
 * counted as `keptStale`.
 */
export async function syncEvmVariants(deps: V2AssetsCronDeps, rawArgs: unknown): Promise<CronResult> {
    const raw = asObject(rawArgs ?? {});
    const chains = parseEvmChainsArg(raw.chains);
    const args = await Effect.runPromise(decodeJobArgs(EVM_VARIANTS_ARG_SPECS, rawArgs ?? {}));
    const start = deps.now();
    const freshnessCutoff = start - COIN_LIST_FRESHNESS_WINDOW_MS;

    const assets = await deps.repo.listAssetsWithCoinPlatforms(args.maxAssets);
    // `maxAssets` bounds the scan. An asset outside the window was never
    // examined, so "no longer linked to a coin" is only a DB fact when the
    // scan came back short of the bound (i.e. it saw everything).
    const scanComplete = assets.length < args.maxAssets;
    const activeAssets = await deps.repo.listActiveAssets();
    const existing = await deps.repo.listDerivedVariants(chains);

    const desired = new Map<string, V2DerivedVariantUpsert>();
    const assetsWithVariants = new Set<string>();
    let skippedInvalid = 0;

    const add = (upsert: V2DerivedVariantUpsert) => {
        const key = desiredKey(upsert.assetId, upsert.chain, upsert.address);
        if (desired.has(key)) return;
        desired.set(key, upsert);
        assetsWithVariants.add(upsert.assetId);
    };

    for (const asset of assets) {
        for (const chain of chains) {
            const platform = CHAINS[chain].providers.coingeckoPlatform;
            const rawAddress = asset.platforms[platform];
            if (!rawAddress || !rawAddress.trim()) continue;
            const address = normalizeAddressForChain(chain, rawAddress);
            if (!address) {
                skippedInvalid += 1;
                console.warn(
                    `[${V2_EVM_VARIANTS_SYNC_JOB}] invalid ${chain} address for ${asset.assetId} (${asset.coingeckoId}): ${rawAddress}`,
                );
                continue;
            }
            add({
                assetId: asset.assetId,
                chain,
                address,
                variantId: chainAddressKey(chain, address),
                kind: deriveVariantKindForChain({
                    category: asset.category,
                    assetPlatformId: asset.assetPlatformId,
                    chain,
                }),
                trustTier: 'tier3',
                tags: [DERIVED_VARIANT_TAG, `coin:${asset.coingeckoId}`],
                label: upperLabel(asset.coinSymbol),
                decimals: asset.decimalsByPlatform[platform] ?? null,
                origin: 'coingecko',
                nowMs: start,
            });
        }
    }

    // Aggregate canonicals (usd, bitcoin, …) and native coins: keyed by asset id,
    // only for assets that are actually registered and active.
    const activeById = new Map(activeAssets.map(a => [a.assetId, a] as const));
    const aggregateFreshness = new Map<string, number | null>();
    for (const [assetId, coinIds] of Object.entries(AGGREGATE_COIN_IDS)) {
        const asset = activeById.get(assetId);
        if (!asset || coinIds.length === 0) continue;
        const coins = await deps.repo.findCoinPlatformsByCoinIds(coinIds);
        let freshest: number | null = null;
        for (const coin of coins) {
            if (coin.coinLastSyncedAt !== null && (freshest === null || coin.coinLastSyncedAt > freshest)) {
                freshest = coin.coinLastSyncedAt;
            }
            for (const chain of chains) {
                const platform = CHAINS[chain].providers.coingeckoPlatform;
                const rawAddress = coin.platforms[platform];
                if (!rawAddress || !rawAddress.trim()) continue;
                const address = normalizeAddressForChain(chain, rawAddress);
                if (!address) {
                    skippedInvalid += 1;
                    continue;
                }
                add({
                    assetId,
                    chain,
                    address,
                    variantId: chainAddressKey(chain, address),
                    kind: aggregateVariantKind(asset.category),
                    trustTier: 'tier3',
                    tags: [DERIVED_VARIANT_TAG, `coin:${coin.coinId}`],
                    label: upperLabel(coin.symbol),
                    decimals: coin.decimalsByPlatform[platform] ?? null,
                    origin: 'coingecko',
                    nowMs: start,
                });
            }
        }
        aggregateFreshness.set(assetId, freshest);
    }
    for (const [assetId, deployments] of Object.entries(NATIVE_COIN_DEPLOYMENTS)) {
        if (!activeById.has(assetId)) continue;
        for (const native of deployments) {
            if (!chains.includes(native.chain)) continue;
            add({
                assetId,
                chain: native.chain,
                address: native.address,
                variantId: chainAddressKey(native.chain, native.address),
                kind: native.kind,
                trustTier: 'tier3',
                tags: [NATIVE_COIN_TAG],
                label: native.label,
                decimals: 18,
                origin: 'config',
                nowMs: start,
            });
        }
    }

    const assetById = new Map(assets.map(a => [a.assetId, a] as const));
    const toDeactivate: Array<V2VariantKeyRef & { assetId: string }> = [];
    let keptStale = 0;
    let keptUnscanned = 0;
    for (const row of existing) {
        if (!row.isActive) continue;
        if (desired.has(desiredKey(row.assetId, row.chain, row.address))) continue;
        const asset = assetById.get(row.assetId);
        const aggregateSyncedAt = aggregateFreshness.get(row.assetId);
        if (!activeById.has(row.assetId)) {
            // No longer active / registered: `listActiveAssets` is unbounded, so this is a DB fact.
            toDeactivate.push({ chain: row.chain, address: row.address, assetId: row.assetId });
            continue;
        }
        if (!asset && aggregateSyncedAt === undefined) {
            if (scanComplete) {
                // Active but no longer linked to a coin id: a DB fact only because the scan saw every linked asset.
                toDeactivate.push({ chain: row.chain, address: row.address, assetId: row.assetId });
            } else {
                keptUnscanned += 1;
            }
            continue;
        }
        const syncedAt = asset ? asset.coinLastSyncedAt : (aggregateSyncedAt ?? null);
        if (syncedAt !== null && syncedAt >= freshnessCutoff) {
            toDeactivate.push({ chain: row.chain, address: row.address, assetId: row.assetId });
        } else {
            keptStale += 1;
        }
    }

    let inserted = 0;
    let updated = 0;
    let skippedOwned = 0;
    let failed = 0;
    // Assets whose desired rows were not all written this run (a failed upsert,
    // or a shutdown before their turn). When CoinGecko moves a token to a new
    // address the old row is in `toDeactivate`; removing it before the new row
    // exists would hide the token until the next successful run.
    const unwrittenAssets = new Set<string>();
    if (!args.dryRun) {
        const pending = Array.from(desired.values());
        for (let i = 0; i < pending.length; i++) {
            const upsert = pending[i]!;
            if (isShuttingDown()) {
                for (const rest of pending.slice(i)) unwrittenAssets.add(rest.assetId);
                break;
            }
            try {
                const outcome = await deps.repo.upsertDerivedVariant(upsert);
                if (outcome === 'inserted') inserted += 1;
                else if (outcome === 'updated') updated += 1;
                else skippedOwned += 1;
            } catch (err) {
                failed += 1;
                unwrittenAssets.add(upsert.assetId);
                console.error(
                    `[${V2_EVM_VARIANTS_SYNC_JOB}] upsert failed for ${upsert.assetId} ${upsert.chain}:${upsert.address}`,
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
    }
    const safeToDeactivate = toDeactivate.filter(row => !unwrittenAssets.has(row.assetId));
    const keptPendingWrite = toDeactivate.length - safeToDeactivate.length;
    const deactivated =
        args.dryRun || safeToDeactivate.length === 0
            ? 0
            : await deps.repo.deactivateDerivedVariants(safeToDeactivate, start);

    const byChain: Partial<Record<ChainKind, { desired: number }>> = {};
    for (const upsert of desired.values()) {
        const entry = (byChain[upsert.chain] ??= { desired: 0 });
        entry.desired += 1;
    }
    if (keptUnscanned > 0) {
        console.warn(
            JSON.stringify({ job: V2_EVM_VARIANTS_SYNC_JOB, event: 'v2_evm_variants_kept_unscanned', keptUnscanned, maxAssets: args.maxAssets }),
        );
    }
    if (keptStale > 0) {
        console.warn(
            JSON.stringify({ job: V2_EVM_VARIANTS_SYNC_JOB, event: V2_EVM_VARIANTS_KEPT_STALE_EVENT, keptStale }),
        );
    }

    const summary: EvmVariantsSyncSummary = {
        job: V2_EVM_VARIANTS_SYNC_JOB,
        event: V2_EVM_VARIANTS_SYNC_EVENT,
        ok: true,
        dryRun: args.dryRun,
        chains,
        assetsScanned: assets.length,
        assetsWithVariants: assetsWithVariants.size,
        desired: desired.size,
        inserted,
        updated,
        skippedOwned,
        skippedInvalid,
        deactivated: args.dryRun ? toDeactivate.length : deactivated,
        keptStale,
        keptUnscanned,
        keptPendingWrite,
        failed,
        byChain,
        duration_ms: deps.now() - start,
    };
    console.log(JSON.stringify(summary));

    return {
        ok: true,
        processed: assets.length,
        durationMs: summary.duration_ms,
        dryRun: args.dryRun,
        chains,
        assetsWithVariants: summary.assetsWithVariants,
        desired: desired.size,
        inserted,
        updated,
        skippedOwned,
        skippedInvalid,
        deactivated: summary.deactivated,
        keptStale,
        keptUnscanned,
        keptPendingWrite,
        failed,
        byChain,
        ...(failed > 0 ? { partial: true } : {}),
    };
}

// ---------------------------------------------------------------------------
// refresh-v2-evm-variant-markets
// ---------------------------------------------------------------------------

const EVM_MARKETS_ARG_SPECS = {
    maxVariants: { kind: 'int', fallback: 250, min: 1, max: 1_000 },
    minAgeMs: { kind: 'int', fallback: 10 * 60_000, min: 0, max: 24 * 60 * 60_000 },
    concurrency: { kind: 'int', fallback: 2, min: 1, max: 5 },
    delayMs: { kind: 'int', fallback: 150, min: 0, max: 5_000 },
    budgetMs: { kind: 'int', fallback: 500_000, min: 0, max: 3_600_000 },
} satisfies JobArgSpecs;

export interface EvmChainRunStats {
    attempted: number;
    refreshed: number;
    failed: number;
    noClient: number;
}

/** A chain is "down" for the run when it was tried a few times and nothing refreshed. */
export function isEvmChainDown(stats: EvmChainRunStats | undefined): boolean {
    return !!stats && stats.attempted >= 3 && stats.refreshed === 0;
}

/** Birdeye overview → v2 market upsert. Decimals are taken verbatim (null when Birdeye omits them). */
export function birdeyeOverviewToV2Upsert(
    chain: ChainKind,
    address: string,
    overview: Parameters<typeof birdeyeOverviewToUpsert>[1],
    lastFetchedAt: number,
): V2VariantMarketUpsert | null {
    const base = birdeyeOverviewToUpsert(address, overview, lastFetchedAt);
    if (!base) return null;
    const rest: Partial<VariantMarketUpsertFromBirdeye> = { ...base };
    delete rest.mint;
    delete rest.decimals;
    const decimals =
        typeof overview.decimals === 'number' && Number.isFinite(overview.decimals) ? overview.decimals : null;
    return { ...(rest as Omit<VariantMarketUpsertFromBirdeye, 'mint' | 'decimals'>), chain, address, decimals };
}

interface EvmMarketsSummary {
    job: typeof V2_EVM_MARKETS_REFRESH_JOB;
    event: typeof V2_EVM_MARKETS_REFRESH_EVENT;
    ok: boolean;
    chains: ChainKind[];
    processed: number;
    refreshed: number;
    failed: number;
    noClient: number;
    byChain: Partial<Record<ChainKind, EvmChainRunStats>>;
    downChains: ChainKind[];
    partial: boolean;
    duration_ms: number;
}

/**
 * Stale-first per-chain Birdeye refresh for EVM variants. Default `chains` =
 * every EVM chain with `capabilities.markets` and a Birdeye client. A chain
 * that was attempted ≥3 times with zero successes is reported in `downChains`
 * and flips the run to `ok: false` (one chain's outage must not hide behind a
 * healthy chain). Rows Birdeye has nothing for are touched so the batch keeps
 * moving through the tail.
 */
export async function refreshEvmVariantMarkets(deps: V2AssetsCronDeps, rawArgs: unknown): Promise<CronResult> {
    const raw = asObject(rawArgs ?? {});
    const requested =
        raw.chains === undefined
            ? EVM_CHAIN_KINDS.filter(
                  chain => CHAINS[chain].capabilities.markets && CHAINS[chain].providers.birdeyeChain,
              )
            : parseEvmChainsArg(raw.chains);
    const chains = [...requested];
    const args = await Effect.runPromise(decodeJobArgs(EVM_MARKETS_ARG_SPECS, rawArgs ?? {}));
    const start = deps.now();

    const refs = await deps.repo.listStaleActiveVariantsByChains(chains, start - args.minAgeMs, args.maxVariants);
    let refreshed = 0;
    let softFailed = 0;
    let noClient = 0;
    const byChain: Partial<Record<ChainKind, EvmChainRunStats>> = {};
    const chainStats = (chain: ChainKind): EvmChainRunStats =>
        (byChain[chain] ??= { attempted: 0, refreshed: 0, failed: 0, noClient: 0 });

    const log = (summary: EvmMarketsSummary) => console.log(JSON.stringify(summary));
    if (refs.length === 0) {
        log({
            job: V2_EVM_MARKETS_REFRESH_JOB,
            event: V2_EVM_MARKETS_REFRESH_EVENT,
            ok: true,
            chains,
            processed: 0,
            refreshed: 0,
            failed: 0,
            noClient: 0,
            byChain,
            downChains: [],
            partial: false,
            duration_ms: deps.now() - start,
        });
        return { ok: true, processed: 0, durationMs: deps.now() - start, chains, refreshed: 0, failed: 0 };
    }

    const summary = await Effect.runPromise(
        runJobPool({
            label: V2_EVM_MARKETS_REFRESH_JOB,
            items: refs,
            concurrency: args.concurrency,
            delayMs: args.delayMs,
            ...(args.budgetMs > 0 ? { budgetMs: args.budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: ({ chain, address }) =>
                Effect.tryPromise(async () => {
                    const stats = chainStats(chain);
                    const client = deps.birdeyeByChain[chain];
                    if (!client) {
                        noClient += 1;
                        stats.noClient += 1;
                        return;
                    }
                    stats.attempted += 1;
                    const overview = await client.fetchTokenOverview(address);
                    const upsert = overview ? birdeyeOverviewToV2Upsert(chain, address, overview, start) : null;
                    if (!upsert) {
                        softFailed += 1;
                        stats.failed += 1;
                        await deps.repo.touchVariantMarket(chain, address, start);
                        return;
                    }
                    await deps.repo.upsertVariantMarketFromBirdeye(upsert);
                    if (upsert.decimals !== null) {
                        await deps.repo.setVariantDecimalsIfNull(chain, address, upsert.decimals);
                    }
                    refreshed += 1;
                    stats.refreshed += 1;
                }),
            onItemError: ({ chain, address }) =>
                Effect.tryPromise(async () => {
                    chainStats(chain).failed += 1;
                    await deps.repo.touchVariantMarket(chain, address, start);
                }).pipe(Effect.catch(() => Effect.void)),
        }),
    );

    const failed = softFailed + summary.failed;
    const downChains = chains.filter(chain => isEvmChainDown(byChain[chain]));
    if (downChains.length > 0) {
        console.warn(
            JSON.stringify({
                job: V2_EVM_MARKETS_REFRESH_JOB,
                event: V2_EVM_MARKETS_CHAIN_DOWN_EVENT,
                chains: downChains,
                byChain,
            }),
        );
    }
    const out: EvmMarketsSummary = {
        job: V2_EVM_MARKETS_REFRESH_JOB,
        event: V2_EVM_MARKETS_REFRESH_EVENT,
        ok: downChains.length === 0,
        chains,
        processed: refs.length,
        refreshed,
        failed,
        noClient,
        byChain,
        downChains,
        partial: summary.partial,
        duration_ms: deps.now() - start,
    };
    log(out);
    return {
        ok: out.ok,
        processed: refs.length,
        durationMs: out.duration_ms,
        chains,
        refreshed,
        failed,
        byChain,
        ...(downChains.length > 0 ? { downChains } : {}),
        ...(noClient > 0 ? { noClient } : {}),
        ...(summary.partial ? { partial: true } : {}),
    };
}

export type V2AssetsJobHandler = (deps: V2AssetsCronDeps, args: unknown) => Promise<CronResult>;

export const v2AssetsJobs: Record<string, V2AssetsJobHandler> = {
    [V2_SOLANA_SYNC_JOB]: syncSolanaVariants,
    [V2_EVM_VARIANTS_SYNC_JOB]: syncEvmVariants,
    [V2_EVM_MARKETS_REFRESH_JOB]: refreshEvmVariantMarkets,
};

export { EVM_NATIVE_ASSET_ADDRESS };
