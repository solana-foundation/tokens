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
import { resolveVariantIssuance } from '@tokens/asset-registry/issuance';
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

/**
 * One CoinGecko coin the derivation reads deployments from, under one asset:
 * the asset's own reference coin (`role: 'reference'`, `assets.coingecko_id`)
 * or a coin one of its active variants links to (`role: 'variant'`,
 * `v2_asset_variants.coingecko_id`: an Ondo / Backpack / xStock issue, an LST,
 * a wrapper). `source` describes that linking variant so the derivation can
 * decide whether the coin's other deployments are issued supply.
 */
export interface V2AssetCoinSourceRow {
    assetId: string;
    category: string;
    coinId: string;
    role: 'reference' | 'variant';
    source: {
        chain: ChainKind;
        address: string;
        kind: string;
        tags: string[];
        label: string | null;
    } | null;
    /** False when the coin id is not in `coingecko_coins` (the asset still counts as scanned). Absent = known. */
    coinKnown?: boolean;
    /** CoinGecko `platforms` map: platform id → contract address ('' for the coin's home chain). */
    platforms: Record<string, string>;
    /** CoinGecko `detail_platforms`: platform id → decimals, when the per-coin metadata was fetched. */
    decimalsByPlatform: Record<string, number>;
    assetPlatformId: string | null;
    /** CoinGecko ticker symbol for the coin (label fallback). */
    coinSymbol: string | null;
    coinLastSyncedAt: number | null;
}

/** Coins read per asset beyond this are dropped with a `coinSourcesCapped` warning (an LST-heavy asset could otherwise fan out to hundreds). */
export const MAX_COIN_SOURCES_PER_ASSET = 8;

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
    /** The CoinGecko coin this row was derived from (null for native-coin config rows of assets without a reference id). */
    coingeckoId: string | null;
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

    /**
     * Link rows to their CoinGecko coin by contract address (`coingecko_coins.platforms`),
     * only where no id is set or the resolver set it earlier; returns rows updated per chain.
     */
    resolveVariantCoinIds(nowMs: number): Promise<Partial<Record<ChainKind, number>>>;
    /**
     * (asset, coin) pairs for active, non-tombstoned assets: the reference coin
     * plus every distinct coin its active variants link to, each joined to the
     * synced coin row; reference first, then coin id order. Bounded by asset.
     */
    listAssetCoinSources(maxAssets: number): Promise<V2AssetCoinSourceRow[]>;
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
     * assets whose v2 market snapshot is missing or older than the cutoff
     * (`beforeEmptyFetchedAt` for rows whose last Birdeye answer was empty),
     * stalest first. Excludes the EIP-7528 native address.
     */
    listStaleActiveVariantsByChains(
        chains: readonly ChainKind[],
        cutoffs: { beforeOverviewFetchedAt: number; beforeEmptyFetchedAt?: number },
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
    /** Run only the coin-id resolution step (links existing rows to CoinGecko coins) and stop. */
    resolveOnly: { kind: 'bool', fallback: false },
} satisfies JobArgSpecs;

/**
 * Variant kind for a CoinGecko-derived deployment of a registered asset.
 *
 * `assetPlatformId` (the coin's home chain) only exists once the per-coin
 * metadata was fetched, which the curated refresh does for curated assets
 * only. When it is missing the `platforms` map decides: a Solana deployment
 * means the EVM copies are bridged (this registry is Solana-first), a single
 * deployment anywhere is native by definition, and anything else stays
 * `spot` so the token is not excluded from supply on a guess.
 */
export function deriveVariantKindForChain(args: {
    category: string;
    assetPlatformId: string | null;
    chain: ChainKind;
    platforms?: Record<string, string>;
    /** Kind of the variant whose coin is being derived (an Ondo equity mint's EVM deployments are equity too). */
    sourceKind?: string | null;
}): string {
    if (args.sourceKind === 'tokenized_equity' || args.sourceKind === 'stablecoin') return args.sourceKind;
    switch (args.category) {
        case 'stablecoin':
            return 'stablecoin';
        case 'lst':
            return 'lst';
        case 'equity':
            return 'tokenized_equity';
        default: {
            const homePlatform = CHAINS[args.chain].providers.coingeckoPlatform;
            if (args.assetPlatformId !== null) return args.assetPlatformId === homePlatform ? 'native' : 'bridged';
            const deployed = Object.entries(args.platforms ?? {}).filter(([, address]) => address.trim() !== '');
            if (deployed.some(([platform]) => platform === CHAINS.solana.providers.coingeckoPlatform)) return 'bridged';
            if (deployed.length === 1 && deployed[0]![0] === homePlatform) return 'native';
            return 'spot';
        }
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
    /** Rows kept because their asset's coin set was cut at `MAX_COIN_SOURCES_PER_ASSET` this run. */
    keptCapped: number;
    /** Rows due for deactivation but kept because a replacement row for the same asset was not written this run. */
    keptPendingWrite: number;
    failed: number;
    byChain: Partial<Record<ChainKind, { desired: number }>>;
    /** Rows linked to a CoinGecko coin by the resolution step, per chain. */
    resolved: Partial<Record<ChainKind, number>>;
    /** (asset, coin) pairs read; `coinSourcesSkipped` are variant coins whose linking variant is not issued supply. */
    coinSources: number;
    coinSourcesSkipped: number;
    /** (asset, coin) pairs whose coin id is not in `coingecko_coins`: nothing derived, existing rows kept. */
    coinSourcesUnknown: number;
    /** Assets whose coin list was cut at MAX_COIN_SOURCES_PER_ASSET. */
    coinSourcesCapped: number;
    /** Two coins of one asset listing the same (chain, address): the first (reference, then coin id order) won. */
    coinConflicts: number;
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

    // Step 0: link rows to their CoinGecko coin by address so the scan below
    // sees every issuer's coin, not only the asset's reference coin.
    const resolved = args.dryRun ? {} : await deps.repo.resolveVariantCoinIds(start);
    if (args.resolveOnly) {
        const duration = deps.now() - start;
        console.log(
            JSON.stringify({ job: V2_EVM_VARIANTS_SYNC_JOB, event: V2_EVM_VARIANTS_SYNC_EVENT, ok: true, resolveOnly: true, resolved, duration_ms: duration }),
        );
        return { ok: true, processed: 0, durationMs: duration, dryRun: args.dryRun, resolveOnly: true, resolved };
    }

    const sources = await deps.repo.listAssetCoinSources(args.maxAssets);
    // Every scoped asset is returned, including one whose coin id is unknown to
    // coingecko_coins (coinKnown false, no platforms), so this is the bounded
    // selection itself: `maxAssets` bounds the scan, an asset outside the window
    // was never examined, and "no longer linked to a coin" is only a DB fact
    // when the scan came back short of the bound (i.e. it saw everything).
    const scannedAssetIds = new Set(sources.map(s => s.assetId));
    const scanComplete = scannedAssetIds.size < args.maxAssets;
    const activeAssets = await deps.repo.listActiveAssets();
    const existing = await deps.repo.listDerivedVariants(chains);

    const desired = new Map<string, V2DerivedVariantUpsert>();
    const assetsWithVariants = new Set<string>();
    let skippedInvalid = 0;
    let coinConflicts = 0;

    const add = (upsert: V2DerivedVariantUpsert) => {
        const key = desiredKey(upsert.assetId, upsert.chain, upsert.address);
        const prior = desired.get(key);
        if (prior) {
            if (prior.coingeckoId !== upsert.coingeckoId) {
                coinConflicts += 1;
                console.warn(
                    `[${V2_EVM_VARIANTS_SYNC_JOB}] ${upsert.assetId} ${upsert.chain}:${upsert.address} claimed by ${prior.coingeckoId} and ${upsert.coingeckoId}; keeping ${prior.coingeckoId}`,
                );
            }
            return;
        }
        desired.set(key, upsert);
        assetsWithVariants.add(upsert.assetId);
    };

    // Group the (asset, coin) pairs: reference coin first, then variant coins in
    // coin-id order (the repo returns them that way), so that when two coins list
    // one address the outcome does not depend on scan order.
    const sourcesByAsset = new Map<string, V2AssetCoinSourceRow[]>();
    for (const source of sources) {
        const list = sourcesByAsset.get(source.assetId) ?? [];
        list.push(source);
        sourcesByAsset.set(source.assetId, list);
    }
    const referenceCoinByAsset = new Map<string, string>();
    /**
     * Per asset, the LEAST fresh coin row among the sources that contribute
     * deployments (null when any is unknown). Deactivation keys on it: a row
     * missing from `desired` is only "gone" when every source it could have come
     * from was read fresh; a fresh sibling coin says nothing about a stale one's rows.
     */
    const sourceFreshness = new Map<string, number | null>();
    let coinSourcesSkipped = 0;
    let coinSourcesCapped = 0;
    let coinSourcesUnknown = 0;
    /** Assets whose coin set was cut at the cap: their derived rows were not all re-examined, so none is deactivated. */
    const cappedAssets = new Set<string>();
    for (const [assetId, list] of sourcesByAsset) {
        let leastFresh: number | null = null;
        let anyUnknown = false;
        let coinsUsed = 0;
        let capped = false;
        for (const source of list) {
            if (source.role === 'reference') referenceCoinByAsset.set(assetId, source.coinId);
            if (source.coinKnown === false) {
                // Not in the coin list (an invalid id, or one the Sunday sync has not
                // seen yet): nothing to derive from, and with no synced-at the asset's
                // existing derived rows are kept rather than deactivated.
                coinSourcesUnknown += 1;
                anyUnknown = true;
                continue;
            }
            // A variant coin only contributes deployments when the linking variant is
            // itself issued supply: an LST's or ETF's other-chain copies are not the
            // asset's supply anywhere, and a bridged copy's coin is the bridge's.
            if (source.role === 'variant') {
                const issuance = source.source ? resolveVariantIssuance(source.source) : 'native';
                if (issuance !== 'native') {
                    coinSourcesSkipped += 1;
                    continue;
                }
            }
            if (coinsUsed >= MAX_COIN_SOURCES_PER_ASSET) {
                capped = true;
                cappedAssets.add(assetId);
                continue;
            }
            coinsUsed += 1;
            if (source.coinLastSyncedAt === null) anyUnknown = true;
            else if (leastFresh === null || source.coinLastSyncedAt < leastFresh) leastFresh = source.coinLastSyncedAt;
            const issuerLabel = source.source?.label?.trim() ? `issuer:${source.source.label.trim()}` : null;
            for (const chain of chains) {
                const platform = CHAINS[chain].providers.coingeckoPlatform;
                const rawAddress = source.platforms[platform];
                if (!rawAddress || !rawAddress.trim()) continue;
                const address = normalizeAddressForChain(chain, rawAddress);
                if (!address) {
                    skippedInvalid += 1;
                    console.warn(
                        `[${V2_EVM_VARIANTS_SYNC_JOB}] invalid ${chain} address for ${assetId} (${source.coinId}): ${rawAddress}`,
                    );
                    continue;
                }
                add({
                    assetId,
                    chain,
                    address,
                    variantId: chainAddressKey(chain, address),
                    kind: deriveVariantKindForChain({
                        category: source.category,
                        assetPlatformId: source.assetPlatformId,
                        chain,
                        platforms: source.platforms,
                        sourceKind: source.source?.kind ?? null,
                    }),
                    trustTier: 'tier3',
                    tags: [DERIVED_VARIANT_TAG, `coin:${source.coinId}`, ...(issuerLabel ? [issuerLabel] : [])],
                    label: upperLabel(source.coinSymbol),
                    decimals: source.decimalsByPlatform[platform] ?? null,
                    origin: 'coingecko',
                    coingeckoId: source.coinId,
                    nowMs: start,
                });
            }
        }
        if (capped) coinSourcesCapped += 1;
        sourceFreshness.set(assetId, anyUnknown ? null : leastFresh);
    }
    if (coinSourcesCapped > 0) {
        console.warn(
            JSON.stringify({ job: V2_EVM_VARIANTS_SYNC_JOB, event: 'v2_evm_variants_coin_sources_capped', coinSourcesCapped, cap: MAX_COIN_SOURCES_PER_ASSET }),
        );
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
                    coingeckoId: coin.coinId,
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
                coingeckoId: referenceCoinByAsset.get(assetId) ?? null,
                nowMs: start,
            });
        }
    }

    const toDeactivate: Array<V2VariantKeyRef & { assetId: string }> = [];
    let keptStale = 0;
    let keptUnscanned = 0;
    let keptCapped = 0;
    for (const row of existing) {
        if (!row.isActive) continue;
        if (desired.has(desiredKey(row.assetId, row.chain, row.address))) continue;
        const scannedSyncedAt = sourceFreshness.get(row.assetId);
        const aggregateSyncedAt = aggregateFreshness.get(row.assetId);
        if (!activeById.has(row.assetId)) {
            // No longer active / registered: `listActiveAssets` is unbounded, so this is a DB fact.
            toDeactivate.push({ chain: row.chain, address: row.address, assetId: row.assetId });
            continue;
        }
        if (cappedAssets.has(row.assetId)) {
            // A coin past the cap was never read this run; reaching the cap is not
            // evidence that its deployments disappeared.
            keptCapped += 1;
            continue;
        }
        if (scannedSyncedAt === undefined && aggregateSyncedAt === undefined) {
            if (scanComplete) {
                // Active but no longer linked to any coin id: a DB fact only because the scan saw every linked asset.
                toDeactivate.push({ chain: row.chain, address: row.address, assetId: row.assetId });
            } else {
                keptUnscanned += 1;
            }
            continue;
        }
        const syncedAt = scannedSyncedAt !== undefined ? scannedSyncedAt : (aggregateSyncedAt ?? null);
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
    // CronResult contract: writes attempted and none succeeded is a failed run, so the
    // dispatcher answers 500 and Cloud Scheduler retries instead of waiting a day.
    const allWritesFailed = !args.dryRun && failed > 0 && inserted + updated + skippedOwned === 0;
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
            JSON.stringify({
                job: V2_EVM_VARIANTS_SYNC_JOB,
                event: 'v2_evm_variants_kept_unscanned',
                keptUnscanned,
                maxAssets: args.maxAssets,
            }),
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
        ok: !allWritesFailed,
        dryRun: args.dryRun,
        chains,
        assetsScanned: scannedAssetIds.size,
        assetsWithVariants: assetsWithVariants.size,
        desired: desired.size,
        inserted,
        updated,
        skippedOwned,
        skippedInvalid,
        deactivated: args.dryRun ? toDeactivate.length : deactivated,
        keptStale,
        keptUnscanned,
        keptCapped,
        keptPendingWrite,
        failed,
        byChain,
        resolved,
        coinSources: sources.length,
        coinSourcesSkipped,
        coinSourcesUnknown,
        coinSourcesCapped,
        coinConflicts,
        duration_ms: deps.now() - start,
    };
    console.log(JSON.stringify(summary));

    return {
        ok: !allWritesFailed,
        processed: scannedAssetIds.size,
        durationMs: summary.duration_ms,
        ...(allWritesFailed ? { reason: 'upserts_failed' } : {}),
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
        keptCapped,
        keptPendingWrite,
        failed,
        byChain,
        resolved,
        coinSources: sources.length,
        coinSourcesSkipped,
        coinSourcesUnknown,
        coinSourcesCapped,
        coinConflicts,
        ...(failed > 0 ? { partial: true } : {}),
    };
}

// ---------------------------------------------------------------------------
// refresh-v2-evm-variant-markets
// ---------------------------------------------------------------------------

const EVM_MARKETS_ARG_SPECS = {
    maxVariants: { kind: 'int', fallback: 250, min: 1, max: 1_000 },
    minAgeMs: { kind: 'int', fallback: 10 * 60_000, min: 0, max: 24 * 60 * 60_000 },
    /** Minimum age for rows whose last Birdeye answer was empty (dead deployments); defaults to 1h. */
    emptyMinAgeMs: { kind: 'int', fallback: 60 * 60_000, min: 0, max: 24 * 60 * 60_000 },
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

    const refs = await deps.repo.listStaleActiveVariantsByChains(
        chains,
        { beforeOverviewFetchedAt: start - args.minAgeMs, beforeEmptyFetchedAt: start - Math.max(args.minAgeMs, args.emptyMinAgeMs) },
        args.maxVariants,
    );
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
