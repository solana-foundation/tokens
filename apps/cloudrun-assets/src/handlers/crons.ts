import { Effect } from 'effect';
import { runJobPool } from '@tokens/effect/job-runner';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';

export interface CronResult {
    /**
     * `false` means total failure — work was attempted and none of it
     * succeeded. The dispatcher maps it to HTTP 500 so Cloud Scheduler can
     * retry. Partial failures stay `ok: true` with counters.
     */
    ok: boolean;
    processed: number;
    durationMs: number;
    /** Present (true) when a deadline budget or shutdown stopped the run early. */
    partial?: boolean;
    [extra: string]: unknown;
}

export { InvalidArgsError } from '@tokens/cloudrun-shutdown/http-errors';
import { InvalidArgsError } from '@tokens/cloudrun-shutdown/http-errors';

export interface VariantMarketUpsertFromBirdeye {
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
    price?: number;
    priceChange24hPercent?: number;
    priceChange1hPercent?: number;
    volume1hUSD?: number;
    volume24hUSD?: number;
    trade1h?: number;
    trade24h?: number;
    uniqueWallet1h?: number;
    uniqueWallet24h?: number;
    liquidity?: number;
    marketCap?: number;
    fdv?: number;
    holder?: number;
    totalSupply?: number;
    circulatingSupply?: number;
    lastTradeHumanTime?: string;
    lastTradeAt?: number;
    extensions?: Record<string, string>;
    lastFetchedAt: number;
}

export interface AssetAggregateUpsert {
    assetId: string;
    liquidity: number;
    volume24hUSD: number;
    volume30dUSD: number | null;
    primaryMint?: string;
    lastComputedAt: number;
    minVariantLastFetchedAt?: number;
    maxVariantLastFetchedAt?: number;
}

export interface SanctumLstUpsert {
    mint: string;
    symbol?: string;
    name?: string;
    logoURI?: string;
    websiteUrl?: string;
    tvlUsd?: number;
    apy?: number;
    sourceRank: number;
    rawJson: string;
    isActive: boolean;
    lastSeenAt: number;
    lastSyncedAt: number;
}

export interface AssetRiskUpsert {
    assetId: string;
    chain: string;
    mint: string;
    ok: boolean;
    reason?: string;
    message?: string;
    marketScoreInput?: unknown;
    marketScore?: unknown;
    tags?: unknown;
    riskScore10?: number | null;
    safetyScore10?: number | null;
    lpLockedPercent?: number | null;
    top10HoldersPercent?: number | null;
    holderCount?: number | null;
    tokenMintTime?: string | null;
    lastFetchedAt: number;
}

export interface VariantMarketForRiskRow {
    liquidity: number | null;
    marketCap: number | null;
    volume24hUSD: number | null;
    holder: number | null;
}

export interface WebacyCacheUpsert {
    chain: string;
    address: string;
    ok: boolean;
    status: number;
    payloadJson?: string;
    errorMessage?: string;
    lastFetchedAt: number;
}

export interface RwaXyzAssetLatestExisting {
    assetId: number;
    name: string | null;
    ticker: string | null;
    slug: string | null;
    iconUrl: string | null;
    website: string | null;
    issuerId: string | null;
    issuerName: string | null;
    assetClassId: number | null;
    assetClassName: string | null;
    assetClassSlug: string | null;
    payloadJson: string | null;
    lastFetchedAt: number;
}

export interface RwaXyzTokenLatestExisting {
    networkSlug: string;
    address: string;
    rwaId: number | null;
    rwaTokenId: number | null;
    assetId: number | null;
    name: string | null;
    decimals: number | null;
    priceDollar: number | null;
    marketValueDollar: number | null;
    netAssetValueDollar: number | null;
    totalAssetValueDollar: number | null;
    circulatingAssetValueDollar: number | null;
    circulatingMarketValueDollar: number | null;
    apy7Day: number | null;
    apy30Day: number | null;
    totalSupplyToken: number | null;
    circulatingSupplyToken: number | null;
    holdingAddressesCount: number | null;
    payloadJson: string | null;
    lastFetchedAt: number;
}

export interface RwaXyzAssetLatestUpsert {
    assetId: number;
    payloadJson: string;
    lastFetchedAt: number;
    name?: string;
    ticker?: string;
    slug?: string;
    iconUrl?: string;
    website?: string;
    issuerId?: string;
    issuerName?: string;
    assetClassId?: number;
    assetClassName?: string;
    assetClassSlug?: string;
}

export interface RwaXyzTokenLatestUpsert {
    networkSlug: 'solana';
    address: string;
    payloadJson: string;
    lastFetchedAt: number;
    rwaId?: number;
    rwaTokenId?: number;
    assetId?: number;
    name?: string;
    decimals?: number;
    priceDollar?: number;
    marketValueDollar?: number;
    netAssetValueDollar?: number;
    totalAssetValueDollar?: number;
    circulatingAssetValueDollar?: number;
    circulatingMarketValueDollar?: number;
    apy7Day?: number;
    apy30Day?: number;
    totalSupplyToken?: number;
    circulatingSupplyToken?: number;
    holdingAddressesCount?: number;
}

export interface AssetVariantSummary {
    mint: string;
    assetId: string;
    chain: string;
    kind: string;
    trustTier: string;
    liquidity: number;
    volume24hUSD: number;
    lastFetchedAt: number | null;
}

export interface AssetVariantsForRollup {
    assetId: string;
    variants: AssetVariantSummary[];
}

export interface ApiRequestEvent {
    projectId: string;
    endpoint: string;
    status: number;
    latencyMs: number;
    ts: number;
    creationTime: number;
}

export interface DailyRollupDelta {
    projectId: string;
    day: string;
    totalCalls: number;
    assetCalls: number;
    successCalls: number;
    sumLatencyMs: number;
}

export interface EndpointDailyRollupDelta {
    projectId: string;
    day: string;
    endpoint: string;
    calls: number;
    successCalls: number;
    sumLatencyMs: number;
    latencyHistogram: number[];
}

export interface OhlcvBoundsRow {
    address: string;
    minTime: number | null;
    maxTime: number | null;
}

export interface OhlcvCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface OhlcvUpsertResult {
    inserted: number;
    updated: number;
    skipped: number;
}

export interface JobsRepo {
    upsertVariantMarketFromBirdeye(args: VariantMarketUpsertFromBirdeye): Promise<void>;
    touchVariantMarket(mint: string, lastFetchedAt: number): Promise<void>;
    getOverviewLastFetchedAtByMint(mint: string): Promise<number | null>;
    listStaleVariantMints(beforeLastFetchedAt: number, limit: number): Promise<string[]>;

    listCuratedAssetIds(): Promise<string[]>;
    listVariantsForRollup(assetIds: readonly string[]): Promise<AssetVariantsForRollup[]>;
    listVariantLastComputedByAssetIds(
        assetIds: readonly string[],
    ): Promise<Map<string, number | null>>;
    sumDailyOhlcvVolumeByAddresses(
        addresses: readonly string[],
        fromSeconds: number,
        toSeconds: number,
    ): Promise<Map<string, number | null>>;
    upsertAssetAggregate(args: AssetAggregateUpsert): Promise<void>;

    listActiveSanctumLstCount(): Promise<number>;
    listSanctumSourceRanks(mints: readonly string[]): Promise<Map<string, number>>;
    upsertSanctumLstLatest(args: SanctumLstUpsert): Promise<void>;
    deactivateMissingSanctumLsts(activeMints: readonly string[], lastSyncedAt: number): Promise<number>;

    findVariantByMint(mint: string): Promise<{ assetId: string; chain: string } | null>;
    getAssetRiskLastFetchedAtByMint(mint: string): Promise<number | null>;
    upsertAssetRiskLatest(args: AssetRiskUpsert): Promise<void>;
    findVariantMarketForRiskByMint(mint: string): Promise<VariantMarketForRiskRow | null>;
    upsertWebacyTokenLatest(args: WebacyCacheUpsert): Promise<void>;
    upsertWebacyTradingLiteLatest(args: WebacyCacheUpsert): Promise<void>;
    upsertWebacyHolderAnalysisLatest(args: WebacyCacheUpsert): Promise<void>;

    findRwaXyzAssetLatestByAssetId(assetId: number): Promise<RwaXyzAssetLatestExisting | null>;
    findRwaXyzTokenLatestByNetworkAndAddress(
        networkSlug: string,
        address: string,
    ): Promise<RwaXyzTokenLatestExisting | null>;
    upsertRwaXyzAssetLatest(args: RwaXyzAssetLatestUpsert): Promise<void>;
    upsertRwaXyzTokenLatest(args: RwaXyzTokenLatestUpsert): Promise<void>;

    listRecentActiveProjects(sinceCreationTime: number, maxScanEvents: number, maxProjects: number): Promise<string[]>;
    getRollupStateForProject(projectId: string): Promise<{ cursorCreationTime: number; lockedUntil: number } | null>;
    tryAcquireRollupLock(projectId: string, now: number, lockMs: number): Promise<boolean>;
    releaseRollupLock(projectId: string, nextCursor: number, now: number): Promise<void>;
    listProjectEventsForRollup(
        projectId: string,
        afterCreationTime: number,
        beforeCreationTime: number,
        limit: number,
    ): Promise<ApiRequestEvent[]>;
    applyDailyRollupDelta(delta: DailyRollupDelta, updatedAt: number): Promise<void>;
    applyEndpointDailyRollupDelta(delta: EndpointDailyRollupDelta, updatedAt: number): Promise<void>;
    applyRollupBatchAtomic(args: {
        projectId: string;
        daily: readonly DailyRollupDelta[];
        endpointDaily: readonly EndpointDailyRollupDelta[];
        expectedCursor: number;
        nextCursor: number;
        nowMs: number;
        updatedAt: number;
    }): Promise<boolean>;

    listAllProjectIds(maxProjects: number): Promise<string[]>;
    pruneApiRequestEventsForProject(
        projectId: string,
        cutoffTs: number,
        beforeCreationTime: number,
        batchSize: number,
    ): Promise<number>;

    getOhlcvBounds(address: string, interval: string): Promise<{ minTime: number | null; maxTime: number | null }>;
    upsertOhlcvCandles(
        address: string,
        interval: string,
        candles: readonly OhlcvCandle[],
    ): Promise<OhlcvUpsertResult>;
}

// eslint-disable-next-line import/no-cycle -- type-only
import type { CuratedMembershipSource } from './curatedMembershipReads';

export interface CuratedMintsSource {
    getAllCuratedMintsInOrder(): string[];
    getCuratedMintRank(): Map<string, number>;
}

export interface BirdeyeOverview {
    symbol?: unknown;
    name?: unknown;
    decimals?: unknown;
    logoURI?: unknown;
    price?: unknown;
    priceChange24hPercent?: unknown;
    priceChange1hPercent?: unknown;
    v1hUSD?: unknown;
    v24hUSD?: unknown;
    trade1h?: unknown;
    trade24h?: unknown;
    uniqueWallet1h?: unknown;
    uniqueWallet24h?: unknown;
    liquidity?: unknown;
    marketCap?: unknown;
    fdv?: unknown;
    holder?: unknown;
    totalSupply?: unknown;
    circulatingSupply?: unknown;
    lastTradeHumanTime?: unknown;
    lastTradeUnixTime?: unknown;
    extensions?: unknown;
}

export interface BirdeyeClient {
    fetchTokenOverview(mint: string): Promise<BirdeyeOverview | null>;
}

export interface RwaXyzTokenSnapshot {
    rwaId?: number;
    rwaTokenId?: number;
    assetId?: number;
    name?: string;
    decimals?: number;
    priceDollar?: number;
    marketValueDollar?: number;
    netAssetValueDollar?: number;
    totalAssetValueDollar?: number;
    circulatingAssetValueDollar?: number;
    circulatingMarketValueDollar?: number;
    apy7Day?: number;
    apy30Day?: number;
    totalSupplyToken?: number;
    circulatingSupplyToken?: number;
    holdingAddressesCount?: number;
    payloadJson: string;
}

export interface RwaXyzAssetSnapshot {
    assetId: number;
    name?: string;
    ticker?: string;
    slug?: string;
    iconUrl?: string;
    website?: string;
    issuerId?: string;
    issuerName?: string;
    assetClassId?: number;
    assetClassName?: string;
    assetClassSlug?: string;
    payloadJson: string;
}

export interface RwaXyzClient {
    fetchSolanaTokenAndAssetByMint(
        mint: string,
    ): Promise<{ token: RwaXyzTokenSnapshot; asset: RwaXyzAssetSnapshot | null } | null>;
}

export interface NormalizedSanctumItem {
    parsed: {
        mint: string;
        symbol?: string | null;
        name?: string | null;
        logoURI?: string | null;
        websiteUrl?: string | null;
        tvlUsd?: number | null;
        apy?: number | null;
    };
    raw: unknown;
}

export type SanctumFetchResult =
    | { ok: true; items: NormalizedSanctumItem[] }
    | {
          ok: false;
          reason: 'http_error' | 'invalid_payload' | 'error' | 'missing_env';
          status?: number;
          message?: string;
      };

export interface SanctumClient {
    fetchAndNormalizeLsts(): Promise<SanctumFetchResult>;
}

export interface WebacyClient {
    isConfigured(): boolean;
    fetchAll(mint: string): Promise<{
        token: { ok: boolean; status: number; data?: unknown; message?: string };
        trading: { ok: boolean; status: number; data?: unknown; message?: string };
        holder: { ok: boolean; status: number; data?: unknown; message?: string };
    }>;
}

export type BirdeyeInterval = '1m' | '5m' | '15m' | '1H' | '4H' | '1D' | '1W';

export interface BirdeyeOhlcvClient {
    fetchOhlcv(args: {
        address: string;
        interval: BirdeyeInterval;
        from: number;
        to: number;
    }): Promise<OhlcvCandle[]>;
}

export interface CronDeps {
    repo: JobsRepo;
    curated: CuratedMembershipSource;
    birdeye: BirdeyeClient;
    birdeyeOhlcv: BirdeyeOhlcvClient;
    sanctum: SanctumClient;
    webacy: WebacyClient;
    rwaXyz?: RwaXyzClient;
    now: () => number;
    computeMarketScore?: (input: ComputedAssetRisk['marketScoreInput']) => unknown;
}

function asObject(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object') throw new InvalidArgsError('args must be an object');
    return raw as Record<string, unknown>;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined) return Math.min(max, Math.max(min, fallback));
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError('numeric arg must be a finite number');
    }
    return Math.min(max, Math.max(min, Math.floor(value)));
}

function toFiniteNonNegativeNumber(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return value >= 0 ? value : 0;
}

function pickDeterministicBatch<T>(items: readonly T[], maxItems: number, windowMs: number, nowMs: number): T[] {
    if (items.length === 0) return [];
    const batchSize = Math.min(Math.max(maxItems, 1), items.length);
    const slot = Math.floor(nowMs / Math.max(windowMs, 1));
    const start = (slot * batchSize) % items.length;
    const out: T[] = [];
    for (let i = 0; i < batchSize; i++) out.push(items[(start + i) % items.length]!);
    return out;
}

function uniqueStrings(values: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

const EXPLICIT_TARGETS_MAX = 250;

/**
 * Parses an optional explicit-target list (e.g. `args.mints`, `args.coinIds`,
 * `args.assetIds`). Returns `null` when the arg is absent so callers fall back
 * to their curated selection. When present the list is validated, trimmed,
 * deduped, and capped at 250 entries.
 */
export function parseExplicitTargets(value: unknown, label: string): string[] | null {
    if (value === undefined) return null;
    if (!Array.isArray(value)) {
        throw new InvalidArgsError(`${label} must be an array of strings`);
    }
    for (const item of value) {
        if (typeof item !== 'string') {
            throw new InvalidArgsError(`${label} must be an array of strings`);
        }
    }
    return uniqueStrings(value as string[]).slice(0, EXPLICIT_TARGETS_MAX);
}

function normalizeUnixTimeMs(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return value < 1_000_000_000_000 ? Math.floor(value * 1000) : Math.floor(value);
}

function birdeyeOverviewToUpsert(
    mint: string,
    overview: BirdeyeOverview,
    lastFetchedAt: number,
): VariantMarketUpsertFromBirdeye | null {
    const symbol = typeof overview.symbol === 'string' ? overview.symbol.trim() : '';
    const rawName = typeof overview.name === 'string' ? overview.name.trim() : '';
    if (!symbol || !rawName) return null;
    const decimals =
        typeof overview.decimals === 'number' && Number.isFinite(overview.decimals) ? overview.decimals : 9;
    const lastTradeAt = normalizeUnixTimeMs(overview.lastTradeUnixTime);
    const out: VariantMarketUpsertFromBirdeye = {
        mint,
        symbol,
        name: rawName,
        decimals,
        lastFetchedAt,
    };
    const logo = typeof overview.logoURI === 'string' ? overview.logoURI.trim() : '';
    if (logo) out.logoURI = logo;
    if (typeof overview.price === 'number' && Number.isFinite(overview.price)) out.price = overview.price;
    if (typeof overview.priceChange24hPercent === 'number' && Number.isFinite(overview.priceChange24hPercent))
        out.priceChange24hPercent = overview.priceChange24hPercent;
    if (typeof overview.priceChange1hPercent === 'number' && Number.isFinite(overview.priceChange1hPercent))
        out.priceChange1hPercent = overview.priceChange1hPercent;
    if (typeof overview.v1hUSD === 'number' && Number.isFinite(overview.v1hUSD)) out.volume1hUSD = overview.v1hUSD;
    if (typeof overview.v24hUSD === 'number' && Number.isFinite(overview.v24hUSD)) out.volume24hUSD = overview.v24hUSD;
    if (typeof overview.trade1h === 'number' && Number.isFinite(overview.trade1h)) out.trade1h = overview.trade1h;
    if (typeof overview.trade24h === 'number' && Number.isFinite(overview.trade24h)) out.trade24h = overview.trade24h;
    if (typeof overview.uniqueWallet1h === 'number' && Number.isFinite(overview.uniqueWallet1h))
        out.uniqueWallet1h = overview.uniqueWallet1h;
    if (typeof overview.uniqueWallet24h === 'number' && Number.isFinite(overview.uniqueWallet24h))
        out.uniqueWallet24h = overview.uniqueWallet24h;
    if (typeof overview.liquidity === 'number' && Number.isFinite(overview.liquidity)) out.liquidity = overview.liquidity;
    if (typeof overview.marketCap === 'number' && Number.isFinite(overview.marketCap)) out.marketCap = overview.marketCap;
    if (typeof overview.fdv === 'number' && Number.isFinite(overview.fdv)) out.fdv = overview.fdv;
    if (typeof overview.holder === 'number' && Number.isFinite(overview.holder)) out.holder = overview.holder;
    if (typeof overview.totalSupply === 'number' && Number.isFinite(overview.totalSupply))
        out.totalSupply = overview.totalSupply;
    if (typeof overview.circulatingSupply === 'number' && Number.isFinite(overview.circulatingSupply))
        out.circulatingSupply = overview.circulatingSupply;
    if (typeof overview.lastTradeHumanTime === 'string' && overview.lastTradeHumanTime.trim())
        out.lastTradeHumanTime = overview.lastTradeHumanTime.trim();
    if (lastTradeAt !== undefined) out.lastTradeAt = lastTradeAt;
    if (overview.extensions && typeof overview.extensions === 'object' && !Array.isArray(overview.extensions)) {
        const ext: Record<string, string> = {};
        for (const [k, v] of Object.entries(overview.extensions as Record<string, unknown>)) {
            if (typeof v === 'string' && v.trim()) ext[k] = v.trim();
        }
        if (Object.keys(ext).length > 0) out.extensions = ext;
    }
    return out;
}

const RWA_XYZ_MIN_REFRESH_MS = 60_000;

function normalizeRwaString(value: string | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function computeRwaXyzAssetUpdates(
    existing: RwaXyzAssetLatestExisting | null,
    args: RwaXyzAssetLatestUpsert,
): Record<string, unknown> {
    const updates: Record<string, unknown> = {};

    const name = normalizeRwaString(args.name);
    if (args.name !== undefined && name && existing?.name !== name) updates.name = name;
    const ticker = normalizeRwaString(args.ticker);
    if (args.ticker !== undefined && ticker && existing?.ticker !== ticker) updates.ticker = ticker;
    const slug = normalizeRwaString(args.slug);
    if (args.slug !== undefined && slug && existing?.slug !== slug) updates.slug = slug;
    const iconUrl = normalizeRwaString(args.iconUrl);
    if (args.iconUrl !== undefined && iconUrl && existing?.iconUrl !== iconUrl) updates.iconUrl = iconUrl;
    const website = normalizeRwaString(args.website);
    if (args.website !== undefined && website && existing?.website !== website) updates.website = website;
    const issuerId = normalizeRwaString(args.issuerId);
    if (args.issuerId !== undefined && issuerId && existing?.issuerId !== issuerId) updates.issuerId = issuerId;
    const issuerName = normalizeRwaString(args.issuerName);
    if (args.issuerName !== undefined && issuerName && existing?.issuerName !== issuerName)
        updates.issuerName = issuerName;

    if (args.assetClassId !== undefined && existing?.assetClassId !== args.assetClassId)
        updates.assetClassId = args.assetClassId;
    const assetClassName = normalizeRwaString(args.assetClassName);
    if (args.assetClassName !== undefined && assetClassName && existing?.assetClassName !== assetClassName)
        updates.assetClassName = assetClassName;
    const assetClassSlug = normalizeRwaString(args.assetClassSlug);
    if (args.assetClassSlug !== undefined && assetClassSlug && existing?.assetClassSlug !== assetClassSlug)
        updates.assetClassSlug = assetClassSlug;

    if (existing?.payloadJson !== args.payloadJson) updates.payloadJson = args.payloadJson;

    return updates;
}

export function computeRwaXyzTokenUpdates(
    existing: RwaXyzTokenLatestExisting | null,
    args: RwaXyzTokenLatestUpsert,
): Record<string, unknown> {
    const updates: Record<string, unknown> = {};

    if (args.rwaId !== undefined && existing?.rwaId !== args.rwaId) updates.rwaId = args.rwaId;
    if (args.rwaTokenId !== undefined && existing?.rwaTokenId !== args.rwaTokenId)
        updates.rwaTokenId = args.rwaTokenId;
    if (args.assetId !== undefined && existing?.assetId !== args.assetId) updates.assetId = args.assetId;

    const name = normalizeRwaString(args.name);
    if (args.name !== undefined && name && existing?.name !== name) updates.name = name;
    if (args.decimals !== undefined && existing?.decimals !== args.decimals) updates.decimals = args.decimals;

    if (args.priceDollar !== undefined && existing?.priceDollar !== args.priceDollar)
        updates.priceDollar = args.priceDollar;
    if (args.marketValueDollar !== undefined && existing?.marketValueDollar !== args.marketValueDollar)
        updates.marketValueDollar = args.marketValueDollar;
    if (args.netAssetValueDollar !== undefined && existing?.netAssetValueDollar !== args.netAssetValueDollar)
        updates.netAssetValueDollar = args.netAssetValueDollar;
    if (args.totalAssetValueDollar !== undefined && existing?.totalAssetValueDollar !== args.totalAssetValueDollar)
        updates.totalAssetValueDollar = args.totalAssetValueDollar;
    if (
        args.circulatingAssetValueDollar !== undefined &&
        existing?.circulatingAssetValueDollar !== args.circulatingAssetValueDollar
    )
        updates.circulatingAssetValueDollar = args.circulatingAssetValueDollar;
    if (
        args.circulatingMarketValueDollar !== undefined &&
        existing?.circulatingMarketValueDollar !== args.circulatingMarketValueDollar
    )
        updates.circulatingMarketValueDollar = args.circulatingMarketValueDollar;
    if (args.apy7Day !== undefined && existing?.apy7Day !== args.apy7Day) updates.apy7Day = args.apy7Day;
    if (args.apy30Day !== undefined && existing?.apy30Day !== args.apy30Day) updates.apy30Day = args.apy30Day;
    if (args.totalSupplyToken !== undefined && existing?.totalSupplyToken !== args.totalSupplyToken)
        updates.totalSupplyToken = args.totalSupplyToken;
    if (
        args.circulatingSupplyToken !== undefined &&
        existing?.circulatingSupplyToken !== args.circulatingSupplyToken
    )
        updates.circulatingSupplyToken = args.circulatingSupplyToken;
    if (args.holdingAddressesCount !== undefined && existing?.holdingAddressesCount !== args.holdingAddressesCount)
        updates.holdingAddressesCount = args.holdingAddressesCount;

    if (existing?.payloadJson !== args.payloadJson) updates.payloadJson = args.payloadJson;

    return updates;
}

export function shouldWriteRwaXyzRow(
    existing: { lastFetchedAt: number } | null,
    nowMs: number,
    updates: Record<string, unknown>,
): boolean {
    if (!existing) return true;
    if (Object.keys(updates).length > 0) return true;
    return nowMs - existing.lastFetchedAt >= RWA_XYZ_MIN_REFRESH_MS;
}

async function shadowWriteRwaXyzSnapshot(
    repo: JobsRepo,
    mint: string,
    snapshot: { token: RwaXyzTokenSnapshot; asset: RwaXyzAssetSnapshot | null },
    nowMs: number,
): Promise<void> {
    const trimmedAddress = mint.trim();
    if (!trimmedAddress) return;

    const tokenArgs: RwaXyzTokenLatestUpsert = {
        networkSlug: 'solana',
        address: trimmedAddress,
        payloadJson: snapshot.token.payloadJson,
        lastFetchedAt: nowMs,
        ...(snapshot.token.rwaId !== undefined ? { rwaId: snapshot.token.rwaId } : {}),
        ...(snapshot.token.rwaTokenId !== undefined ? { rwaTokenId: snapshot.token.rwaTokenId } : {}),
        ...(snapshot.token.assetId !== undefined ? { assetId: snapshot.token.assetId } : {}),
        ...(snapshot.token.name !== undefined ? { name: snapshot.token.name } : {}),
        ...(snapshot.token.decimals !== undefined ? { decimals: snapshot.token.decimals } : {}),
        ...(snapshot.token.priceDollar !== undefined ? { priceDollar: snapshot.token.priceDollar } : {}),
        ...(snapshot.token.marketValueDollar !== undefined
            ? { marketValueDollar: snapshot.token.marketValueDollar }
            : {}),
        ...(snapshot.token.netAssetValueDollar !== undefined
            ? { netAssetValueDollar: snapshot.token.netAssetValueDollar }
            : {}),
        ...(snapshot.token.totalAssetValueDollar !== undefined
            ? { totalAssetValueDollar: snapshot.token.totalAssetValueDollar }
            : {}),
        ...(snapshot.token.circulatingAssetValueDollar !== undefined
            ? { circulatingAssetValueDollar: snapshot.token.circulatingAssetValueDollar }
            : {}),
        ...(snapshot.token.circulatingMarketValueDollar !== undefined
            ? { circulatingMarketValueDollar: snapshot.token.circulatingMarketValueDollar }
            : {}),
        ...(snapshot.token.apy7Day !== undefined ? { apy7Day: snapshot.token.apy7Day } : {}),
        ...(snapshot.token.apy30Day !== undefined ? { apy30Day: snapshot.token.apy30Day } : {}),
        ...(snapshot.token.totalSupplyToken !== undefined
            ? { totalSupplyToken: snapshot.token.totalSupplyToken }
            : {}),
        ...(snapshot.token.circulatingSupplyToken !== undefined
            ? { circulatingSupplyToken: snapshot.token.circulatingSupplyToken }
            : {}),
        ...(snapshot.token.holdingAddressesCount !== undefined
            ? { holdingAddressesCount: snapshot.token.holdingAddressesCount }
            : {}),
    };
    await repo.upsertRwaXyzTokenLatest(tokenArgs);

    const asset = snapshot.asset;
    if (asset && Number.isFinite(asset.assetId)) {
        const assetArgs: RwaXyzAssetLatestUpsert = {
            assetId: Math.floor(asset.assetId),
            payloadJson: asset.payloadJson,
            lastFetchedAt: nowMs,
            ...(asset.name !== undefined ? { name: asset.name } : {}),
            ...(asset.ticker !== undefined ? { ticker: asset.ticker } : {}),
            ...(asset.slug !== undefined ? { slug: asset.slug } : {}),
            ...(asset.iconUrl !== undefined ? { iconUrl: asset.iconUrl } : {}),
            ...(asset.website !== undefined ? { website: asset.website } : {}),
            ...(asset.issuerId !== undefined ? { issuerId: asset.issuerId } : {}),
            ...(asset.issuerName !== undefined ? { issuerName: asset.issuerName } : {}),
            ...(asset.assetClassId !== undefined ? { assetClassId: asset.assetClassId } : {}),
            ...(asset.assetClassName !== undefined ? { assetClassName: asset.assetClassName } : {}),
            ...(asset.assetClassSlug !== undefined ? { assetClassSlug: asset.assetClassSlug } : {}),
        };
        await repo.upsertRwaXyzAssetLatest(assetArgs);
    }
}

async function tryShadowWriteFromRwaXyz(
    deps: Pick<CronDeps, 'repo' | 'rwaXyz'>,
    mint: string,
    nowMs: number,
    label: string,
): Promise<void> {
    const client = deps.rwaXyz;
    if (!client) return;
    try {
        const snapshot = await client.fetchSolanaTokenAndAssetByMint(mint);
        if (!snapshot) return;
        await shadowWriteRwaXyzSnapshot(deps.repo, mint, snapshot, nowMs);
    } catch (err) {
        console.error(
            `[${label}] rwa.xyz shadow write failed for ${mint}`,
            err instanceof Error ? err.message : String(err),
        );
    }
}

export async function refreshCuratedVariantMarkets(deps: CronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = asObject(rawArgs);
    const priorityCount = clampInt(args.priorityCount, 50, 0, 100);
    const maxMints = clampInt(args.maxMints, 250, 1, 250);
    const minAgeMs = clampInt(args.minAgeMs, 110_000, 0, 24 * 60 * 60_000);
    const concurrency = clampInt(args.concurrency, 3, 1, 5);
    const delayMs = clampInt(args.delayMs, 100, 0, 5_000);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 2 * 60_000, 10_000, 24 * 60 * 60_000);
    // Deadline budget (0 = disabled); wired from terraform body_json alongside attempt_deadline.
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);

    const explicitMints = parseExplicitTargets(args.mints, 'mints');

    const start = deps.now();
    let mints: string[];
    if (explicitMints) {
        mints = explicitMints;
    } else {
        const allMints = deps.curated.getAllCuratedMintsInOrder();
        const selected = pickDeterministicBatch(allMints, maxMints, selectionWindowMs, start);
        const priorityMints = priorityCount > 0 ? allMints.slice(0, priorityCount) : [];
        mints = uniqueStrings([...priorityMints, ...selected]).slice(0, 250);
    }

    let refreshed = 0;
    let skipped = 0;
    let softFailed = 0;

    if (mints.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.now() - start, refreshed, skipped, failed: 0 };
    }

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'refreshCuratedVariantMarkets',
            items: mints,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: mint =>
                Effect.tryPromise(async () => {
                    const last = await deps.repo.getOverviewLastFetchedAtByMint(mint);
                    if (last !== null && start - last < minAgeMs) {
                        skipped += 1;
                        return;
                    }
                    const overview = await deps.birdeye.fetchTokenOverview(mint);
                    if (!overview) {
                        softFailed += 1;
                        await deps.repo.touchVariantMarket(mint, start);
                        return;
                    }
                    const upsert = birdeyeOverviewToUpsert(mint, overview, start);
                    if (!upsert) {
                        softFailed += 1;
                        await deps.repo.touchVariantMarket(mint, start);
                        return;
                    }
                    await deps.repo.upsertVariantMarketFromBirdeye(upsert);
                    await tryShadowWriteFromRwaXyz(deps, mint, start, 'refreshCuratedVariantMarkets');
                    refreshed += 1;
                }),
            onItemError: mint =>
                Effect.tryPromise(async () => {
                    await tryShadowWriteFromRwaXyz(deps, mint, start, 'refreshCuratedVariantMarkets');
                    await deps.repo.touchVariantMarket(mint, start);
                }),
        }),
    );

    const failed = softFailed + summary.failed;
    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && skipped === 0 && failed >= summary.attempted),
        processed: mints.length,
        durationMs: deps.now() - start,
        refreshed,
        skipped,
        failed,
        ...(summary.partial ? { partial: true } : {}),
    };
}

export async function refreshStaleVariantMarkets(deps: CronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = asObject(rawArgs);
    const maxVariants = clampInt(args.maxVariants, 50, 1, 250);
    const minAgeMs = clampInt(args.minAgeMs, 60_000, 10_000, 24 * 60 * 60_000);
    const concurrency = clampInt(args.concurrency, 2, 1, 5);
    const delayMs = clampInt(args.delayMs, 200, 0, 5_000);
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);

    const start = deps.now();
    const beforeLastFetchedAt = start - minAgeMs;
    const mints = await deps.repo.listStaleVariantMints(beforeLastFetchedAt, maxVariants);

    let refreshed = 0;
    let softFailed = 0;

    if (mints.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.now() - start, refreshed, failed: 0 };
    }

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'refreshStaleVariantMarkets',
            items: mints,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: mint =>
                Effect.tryPromise(async () => {
                    const overview = await deps.birdeye.fetchTokenOverview(mint);
                    if (!overview) {
                        softFailed += 1;
                        await deps.repo.touchVariantMarket(mint, start);
                        return;
                    }
                    const upsert = birdeyeOverviewToUpsert(mint, overview, start);
                    if (!upsert) {
                        softFailed += 1;
                        await deps.repo.touchVariantMarket(mint, start);
                        return;
                    }
                    await deps.repo.upsertVariantMarketFromBirdeye(upsert);
                    await tryShadowWriteFromRwaXyz(deps, mint, start, 'refreshStaleVariantMarkets');
                    refreshed += 1;
                }),
            onItemError: mint =>
                Effect.tryPromise(async () => {
                    await tryShadowWriteFromRwaXyz(deps, mint, start, 'refreshStaleVariantMarkets');
                    await deps.repo.touchVariantMarket(mint, start);
                }),
        }),
    );

    const failed = softFailed + summary.failed;
    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && failed >= summary.attempted),
        processed: mints.length,
        durationMs: deps.now() - start,
        refreshed,
        failed,
        ...(summary.partial ? { partial: true } : {}),
    };
}

function isSpotLikeKind(kind: string): boolean {
    return (
        kind === 'native' ||
        kind === 'wrapped' ||
        kind === 'bridged' ||
        kind === 'spot' ||
        kind === 'stablecoin' ||
        kind === 'lst' ||
        kind === 'tokenized_equity' ||
        kind === 'basket'
    );
}

function trustTierRank(tier: string): number {
    if (tier === 'tier1') return 3;
    if (tier === 'tier2') return 2;
    return 1;
}

export async function refreshCuratedAssetMarkets(deps: CronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = asObject(rawArgs);
    const maxAssets = clampInt(args.maxAssets, 1000, 1, 1000);
    const minAgeMs = clampInt(args.minAgeMs, 4 * 60_000, 0, 24 * 60 * 60_000);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 5 * 60_000, 10_000, 24 * 60 * 60_000);

    const start = deps.now();
    const mintRank = deps.curated.getCuratedMintRank();

    const allAssetIds = await deps.repo.listCuratedAssetIds();
    if (allAssetIds.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.now() - start, refreshed: 0, skipped: 0, failed: 0 };
    }

    const selectedAssetIds = pickDeterministicBatch(allAssetIds, maxAssets, selectionWindowMs, start);

    const lastComputedByAsset = await deps.repo.listVariantLastComputedByAssetIds(selectedAssetIds);

    const staleAssetIds: string[] = [];
    let skipped = 0;
    for (const assetId of selectedAssetIds) {
        const last = lastComputedByAsset.get(assetId) ?? null;
        if (last !== null && start - last < minAgeMs) {
            skipped += 1;
        } else {
            staleAssetIds.push(assetId);
        }
    }

    if (staleAssetIds.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.now() - start, refreshed: 0, skipped, failed: 0 };
    }

    const variantRows = await deps.repo.listVariantsForRollup(staleAssetIds);
    const variantsByAsset = new Map<string, AssetVariantSummary[]>();
    const allMints = new Set<string>();
    for (const row of variantRows) {
        variantsByAsset.set(row.assetId, row.variants);
        for (const v of row.variants) allMints.add(v.mint);
    }

    const fromSeconds = Math.floor((start - 30 * 24 * 60 * 60_000) / 1000);
    const toSeconds = Math.floor(start / 1000);
    const volume30dByMint = await deps.repo.sumDailyOhlcvVolumeByAddresses(
        Array.from(allMints),
        fromSeconds,
        toSeconds,
    );

    let refreshed = 0;
    let failed = 0;

    for (const assetId of staleAssetIds) {
        const variants = variantsByAsset.get(assetId) ?? [];
        const spotLike = variants.filter(v => isSpotLikeKind(v.kind));
        const effective = spotLike.length > 0 ? spotLike : variants;

        let liquidity = 0;
        let volume24hUSD = 0;
        let volume30dUSD = 0;
        let hasVolume30d = false;
        let minVariantLastFetchedAt: number | null = null;
        let maxVariantLastFetchedAt: number | null = null;

        for (const v of effective) {
            liquidity += toFiniteNonNegativeNumber(v.liquidity);
            volume24hUSD += toFiniteNonNegativeNumber(v.volume24hUSD);
            const v30 = volume30dByMint.get(v.mint) ?? null;
            if (v30 !== null) {
                hasVolume30d = true;
                volume30dUSD += toFiniteNonNegativeNumber(v30);
            }
            const last = v.lastFetchedAt ?? null;
            if (last !== null) {
                minVariantLastFetchedAt =
                    minVariantLastFetchedAt === null ? last : Math.min(minVariantLastFetchedAt, last);
                maxVariantLastFetchedAt =
                    maxVariantLastFetchedAt === null ? last : Math.max(maxVariantLastFetchedAt, last);
            }
        }

        let primaryMint: string | undefined;
        if (effective.length > 0) {
            let best = effective[0]!;
            for (let i = 1; i < effective.length; i++) {
                const cand = effective[i]!;
                const liqDelta = toFiniteNonNegativeNumber(cand.liquidity) - toFiniteNonNegativeNumber(best.liquidity);
                if (liqDelta !== 0) {
                    if (liqDelta > 0) best = cand;
                    continue;
                }
                const trustDelta = trustTierRank(cand.trustTier) - trustTierRank(best.trustTier);
                if (trustDelta !== 0) {
                    if (trustDelta > 0) best = cand;
                    continue;
                }
                const volDelta =
                    toFiniteNonNegativeNumber(cand.volume24hUSD) - toFiniteNonNegativeNumber(best.volume24hUSD);
                if (volDelta !== 0) {
                    if (volDelta > 0) best = cand;
                    continue;
                }
                const candRank = mintRank.get(cand.mint) ?? Number.POSITIVE_INFINITY;
                const bestRank = mintRank.get(best.mint) ?? Number.POSITIVE_INFINITY;
                if (candRank < bestRank) best = cand;
            }
            primaryMint = best.mint;
        }

        const upsert: AssetAggregateUpsert = {
            assetId,
            liquidity: toFiniteNonNegativeNumber(liquidity),
            volume24hUSD: toFiniteNonNegativeNumber(volume24hUSD),
            volume30dUSD: hasVolume30d ? toFiniteNonNegativeNumber(volume30dUSD) : null,
            lastComputedAt: start,
        };
        if (primaryMint) upsert.primaryMint = primaryMint;
        if (minVariantLastFetchedAt !== null) upsert.minVariantLastFetchedAt = minVariantLastFetchedAt;
        if (maxVariantLastFetchedAt !== null) upsert.maxVariantLastFetchedAt = maxVariantLastFetchedAt;

        try {
            await deps.repo.upsertAssetAggregate(upsert);
            refreshed += 1;
        } catch (err) {
            failed += 1;
            console.error(`[refreshCuratedAssetMarkets] asset=${assetId}`, err);
        }
    }

    return {
        ok: !(staleAssetIds.length > 0 && refreshed === 0 && failed >= staleAssetIds.length),
        processed: staleAssetIds.length,
        durationMs: deps.now() - start,
        refreshed,
        skipped,
        failed,
    };
}

export async function syncSanctumLsts(deps: CronDeps, _rawArgs: unknown): Promise<CronResult> {
    void _rawArgs;
    const start = deps.now();
    const result = await deps.sanctum.fetchAndNormalizeLsts();
    if (!result.ok) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            skipped: true,
            reason: result.reason,
            ...(result.status !== undefined ? { status: result.status } : {}),
        };
    }

    const byMint = new Map<string, NormalizedSanctumItem & { sourceIndex: number }>();
    for (let i = 0; i < result.items.length; i++) {
        const item = result.items[i]!;
        const mint = item.parsed.mint.trim();
        if (!mint || byMint.has(mint)) continue;
        byMint.set(mint, { ...item, sourceIndex: i });
    }

    const entries = Array.from(byMint.values());
    if (entries.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            skipped: true,
            reason: 'invalid_payload',
        };
    }

    const existingActive = await deps.repo.listActiveSanctumLstCount();
    if (existingActive > 0 && entries.length < existingActive * 0.7) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            skipped: true,
            reason: 'suspicious_drop',
            existingActiveCount: existingActive,
            nextActiveCount: entries.length,
        };
    }

    const mints = entries.map(e => e.parsed.mint);
    const existingRankByMint = await deps.repo.listSanctumSourceRanks(mints);

    const withTvl = entries
        .filter(e => typeof e.parsed.tvlUsd === 'number' && Number.isFinite(e.parsed.tvlUsd))
        .sort((a, b) => (b.parsed.tvlUsd ?? 0) - (a.parsed.tvlUsd ?? 0));
    const withoutTvl = entries
        .filter(e => !(typeof e.parsed.tvlUsd === 'number' && Number.isFinite(e.parsed.tvlUsd)))
        .sort((a, b) => {
            const aPrev = existingRankByMint.get(a.parsed.mint) ?? Number.POSITIVE_INFINITY;
            const bPrev = existingRankByMint.get(b.parsed.mint) ?? Number.POSITIVE_INFINITY;
            const prevDelta = aPrev - bPrev;
            if (prevDelta !== 0) return prevDelta;
            return a.sourceIndex - b.sourceIndex;
        });

    const ordered = [...withTvl, ...withoutTvl];

    let synced = 0;
    let failed = 0;
    const activeMints: string[] = [];
    for (let i = 0; i < ordered.length; i++) {
        const entry = ordered[i]!;
        const parsed = entry.parsed;
        const mint = parsed.mint.trim();
        if (!mint) continue;
        activeMints.push(mint);
        try {
            await deps.repo.upsertSanctumLstLatest({
                mint,
                ...(parsed.symbol ? { symbol: String(parsed.symbol).trim() } : {}),
                ...(parsed.name ? { name: String(parsed.name).trim() } : {}),
                ...(parsed.logoURI ? { logoURI: String(parsed.logoURI).trim() } : {}),
                ...(parsed.websiteUrl ? { websiteUrl: String(parsed.websiteUrl).trim() } : {}),
                ...(typeof parsed.tvlUsd === 'number' && Number.isFinite(parsed.tvlUsd)
                    ? { tvlUsd: parsed.tvlUsd }
                    : {}),
                ...(typeof parsed.apy === 'number' && Number.isFinite(parsed.apy) ? { apy: parsed.apy } : {}),
                sourceRank: i,
                rawJson: JSON.stringify(entry.raw),
                isActive: true,
                lastSeenAt: start,
                lastSyncedAt: start,
            });
            synced += 1;
        } catch (err) {
            failed += 1;
            console.error(`[syncSanctumLsts] mint=${mint}`, err instanceof Error ? err.message : String(err));
        }
    }

    const deactivated = await deps.repo.deactivateMissingSanctumLsts(activeMints, start);

    return {
        ok: true,
        processed: synced,
        durationMs: deps.now() - start,
        synced,
        deactivated,
        failed,
    };
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumberOrNull(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
}

function isRiskRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sumLiquidityUsd(liquidityData: unknown): number | null {
    if (!Array.isArray(liquidityData) || liquidityData.length === 0) return null;
    let sum = 0;
    for (const pool of liquidityData) {
        if (!isRiskRecord(pool)) continue;
        const value = asFiniteNumberOrNull(pool.totalLiquidity);
        if (value == null || value <= 0) continue;
        sum += value;
    }
    return sum > 0 ? sum : null;
}

function riskClamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
}

function computeLpLockedPercent(liquidityData: unknown): number | null {
    if (!Array.isArray(liquidityData) || liquidityData.length === 0) return null;
    const rows = liquidityData
        .map(item => {
            if (!isRiskRecord(item)) return null;
            const totalLiquidity = asFiniteNumberOrNull(item.totalLiquidity);
            const lockedLiquidityPercent = asFiniteNumberOrNull(item.lockedLiquidityPercent);
            if (totalLiquidity == null || lockedLiquidityPercent == null) return null;
            if (totalLiquidity <= 0) return null;
            return { totalLiquidity, lockedLiquidityPercent };
        })
        .filter((row): row is { totalLiquidity: number; lockedLiquidityPercent: number } => row !== null);
    if (rows.length === 0) return null;
    const total = rows.reduce((acc, row) => acc + row.totalLiquidity, 0);
    if (total <= 0) return null;
    const weighted = rows.reduce((acc, row) => acc + row.totalLiquidity * row.lockedLiquidityPercent, 0);
    const maxLocked = rows.reduce((acc, row) => Math.max(acc, row.lockedLiquidityPercent), 0);
    const normalized = maxLocked <= 1 ? (weighted / total) * 100 : weighted / total;
    return riskClamp(normalized, 0, 100);
}

interface RiskTag {
    key: string;
    name: string;
    type: string;
    severity: number;
    description: string;
}

function getUniqueRiskTags(tokenData: unknown): RiskTag[] {
    if (!isRiskRecord(tokenData)) return [];
    const risk = isRiskRecord(tokenData.risk) ? tokenData.risk : null;
    const issues = risk && Array.isArray(risk.issues) ? (risk.issues as unknown[]) : [];
    const seen = new Set<string>();
    const out: RiskTag[] = [];
    for (const issue of issues) {
        if (!isRiskRecord(issue)) continue;
        const tags = Array.isArray(issue.tags) ? (issue.tags as unknown[]) : [];
        for (const tag of tags) {
            if (!isRiskRecord(tag)) continue;
            const key = asNonEmptyString(tag.key);
            if (!key || seen.has(key)) continue;
            const name = asNonEmptyString(tag.name) ?? key;
            const type = asNonEmptyString(tag.type) ?? 'risk';
            const severity = asFiniteNumberOrNull(tag.severity) ?? 0;
            const description = asNonEmptyString(tag.description) ?? '';
            seen.add(key);
            out.push({ key, name, type, severity, description });
        }
    }
    return out;
}

function computeRiskScore10(tags: ReadonlyArray<{ severity: number }>): number | null {
    if (tags.length === 0) return null;
    const totalSeverity = tags.reduce((acc, tag) => acc + (Number.isFinite(tag.severity) ? tag.severity : 0), 0);
    return riskClamp(Math.ceil(totalSeverity / 10), 0, 10);
}

function toSafetyScore10(riskScore10: number | null): number | null {
    if (riskScore10 == null) return null;
    return riskClamp(10 - riskScore10, 0, 10);
}

export interface ComputeAssetRiskInput {
    mint: string;
    market: VariantMarketForRiskRow | null;
    tokenData: unknown;
    tradingData: unknown;
    holderData: unknown;
}

export interface ComputedAssetRisk {
    marketScoreInput: {
        tokenAddress: string;
        liquidityUsd: number | null;
        marketCapUsd: number | null;
        holderCount: number | null;
        top10HoldersPercent: number | null;
        volume24hUsd: number | null;
        volume7dUsd: number | null;
        tokenMintTime: string | null;
    };
    tags: RiskTag[];
    riskScore10: number | null;
    safetyScore10: number | null;
    lpLockedPercent: number | null;
    top10HoldersPercent: number | null;
    holderCount: number | null;
    tokenMintTime: string | null;
}

export function computeAssetRiskFromWebacy(input: ComputeAssetRiskInput): ComputedAssetRisk {
    const tokenData = input.tokenData;
    const tradingData = input.tradingData;
    const holderData = input.holderData;
    const market = input.market;
    const marketData =
        tokenData && isRiskRecord(tokenData) &&
        isRiskRecord((tokenData as { risk?: { details?: { marketData?: unknown } } }).risk?.details?.marketData)
            ? ((tokenData as { risk: { details: { marketData: unknown } } }).risk.details.marketData as unknown)
            : null;
    const liquidityUsd =
        sumLiquidityUsd(
            marketData && isRiskRecord(marketData) ? (marketData as { liquidityData?: unknown }).liquidityData : null,
        ) ?? (market && market.liquidity !== null ? market.liquidity : null);
    const marketCapUsd =
        (market && market.marketCap !== null ? market.marketCap : null) ??
        (marketData && isRiskRecord(marketData)
            ? asFiniteNumberOrNull((marketData as { market_cap?: unknown }).market_cap)
            : null);
    const volume24hUsd =
        (market && market.volume24hUSD !== null ? market.volume24hUSD : null) ??
        (marketData && isRiskRecord(marketData)
            ? asFiniteNumberOrNull((marketData as { total_volume?: unknown }).total_volume)
            : null);
    const volume7dUsd = volume24hUsd != null && volume24hUsd > 0 ? volume24hUsd * 7 : null;
    const top10HoldersPercent = tradingData && isRiskRecord(tradingData)
        ? asFiniteNumberOrNull((tradingData as { Top10Holders?: unknown }).Top10Holders)
        : null;
    const holderCount =
        (tradingData && isRiskRecord(tradingData)
            ? asFiniteNumberOrNull((tradingData as { TotalHolders?: unknown }).TotalHolders)
            : null) ?? (market && market.holder !== null ? market.holder : null);
    const tokenMintTime = holderData && isRiskRecord(holderData)
        ? asNonEmptyString((holderData as { token_mint_time?: unknown }).token_mint_time)
        : null;
    const tags = getUniqueRiskTags(tokenData);
    const riskScore10 = computeRiskScore10(tags);
    const safetyScore10 = toSafetyScore10(riskScore10);
    const lpLockedPercent = computeLpLockedPercent(
        marketData && isRiskRecord(marketData) ? (marketData as { liquidityData?: unknown }).liquidityData : null,
    );
    return {
        marketScoreInput: {
            tokenAddress: input.mint,
            liquidityUsd,
            marketCapUsd,
            holderCount,
            top10HoldersPercent,
            volume24hUsd,
            volume7dUsd,
            tokenMintTime,
        },
        tags,
        riskScore10,
        safetyScore10,
        lpLockedPercent,
        top10HoldersPercent,
        holderCount,
        tokenMintTime,
    };
}

export async function refreshCuratedAssetRisk(deps: CronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = asObject(rawArgs);
    const maxMints = clampInt(args.maxMints, 20, 1, 250);
    const minAgeMs = clampInt(args.minAgeMs, 6 * 60 * 60_000, 0, 24 * 60 * 60_000);
    const concurrency = clampInt(args.concurrency, 2, 1, 5);
    const delayMs = clampInt(args.delayMs, 250, 0, 5_000);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 6 * 60 * 60_000, 10_000, 24 * 60 * 60_000);
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);

    const start = deps.now();
    if (!deps.webacy.isConfigured()) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            refreshed: 0,
            skipped: 0,
            failed: 0,
            disabled: true,
            reason: 'webacy_not_configured',
        };
    }
    const explicitMints = parseExplicitTargets(args.mints, 'mints');
    const mints =
        explicitMints ??
        uniqueStrings(
            pickDeterministicBatch(deps.curated.getAllCuratedMintsInOrder(), maxMints, selectionWindowMs, start),
        ).slice(0, 250);

    let refreshed = 0;
    let skipped = 0;
    let softFailed = 0;

    if (mints.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.now() - start, refreshed, skipped, failed: 0 };
    }

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'refreshCuratedAssetRisk',
            items: mints,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: mint =>
                Effect.tryPromise(async () => {
                const variant = await deps.repo.findVariantByMint(mint);
                if (!variant) {
                    skipped += 1;
                    return;
                }
                const last = await deps.repo.getAssetRiskLastFetchedAtByMint(mint);
                if (minAgeMs > 0 && last !== null && start - last < minAgeMs) {
                    return void (skipped += 1);
                }
                const all = await deps.webacy.fetchAll(mint);

                const cacheUpserts: Promise<void>[] = [
                    deps.repo.upsertWebacyTokenLatest({
                        chain: 'sol',
                        address: mint,
                        ok: all.token.ok,
                        status: all.token.status,
                        ...(all.token.ok && all.token.data !== undefined
                            ? { payloadJson: JSON.stringify(all.token.data) }
                            : {}),
                        ...(!all.token.ok && all.token.message
                            ? { errorMessage: all.token.message }
                            : {}),
                        lastFetchedAt: start,
                    }),
                    deps.repo.upsertWebacyTradingLiteLatest({
                        chain: 'sol',
                        address: mint,
                        ok: all.trading.ok,
                        status: all.trading.status,
                        ...(all.trading.ok && all.trading.data !== undefined
                            ? { payloadJson: JSON.stringify(all.trading.data) }
                            : {}),
                        ...(!all.trading.ok && all.trading.message
                            ? { errorMessage: all.trading.message }
                            : {}),
                        lastFetchedAt: start,
                    }),
                    deps.repo.upsertWebacyHolderAnalysisLatest({
                        chain: 'sol',
                        address: mint,
                        ok: all.holder.ok,
                        status: all.holder.status,
                        ...(all.holder.ok && all.holder.data !== undefined
                            ? { payloadJson: JSON.stringify(all.holder.data) }
                            : {}),
                        ...(!all.holder.ok && all.holder.message
                            ? { errorMessage: all.holder.message }
                            : {}),
                        lastFetchedAt: start,
                    }),
                ];
                await Promise.all(cacheUpserts);

                if (!all.token.ok && !all.trading.ok && !all.holder.ok) {
                    await deps.repo.upsertAssetRiskLatest({
                        assetId: variant.assetId,
                        chain: variant.chain,
                        mint,
                        ok: false,
                        reason: 'upstream_error',
                        message:
                            all.token.message ??
                            all.trading.message ??
                            all.holder.message ??
                            'all upstreams failed',
                        lastFetchedAt: start,
                    });
                    softFailed += 1;
                    return;
                }

                const market = await deps.repo.findVariantMarketForRiskByMint(mint);
                const computed = computeAssetRiskFromWebacy({
                    mint,
                    market,
                    tokenData: all.token.ok ? all.token.data : null,
                    tradingData: all.trading.ok ? all.trading.data : null,
                    holderData: all.holder.ok ? all.holder.data : null,
                });
                const marketScore = deps.computeMarketScore
                    ? deps.computeMarketScore(computed.marketScoreInput)
                    : null;
                await deps.repo.upsertAssetRiskLatest({
                    assetId: variant.assetId,
                    chain: variant.chain,
                    mint,
                    ok: true,
                    marketScoreInput: computed.marketScoreInput,
                    marketScore,
                    tags: computed.tags,
                    riskScore10: computed.riskScore10,
                    safetyScore10: computed.safetyScore10,
                    lpLockedPercent: computed.lpLockedPercent,
                    top10HoldersPercent: computed.top10HoldersPercent,
                    holderCount: computed.holderCount,
                    tokenMintTime: computed.tokenMintTime,
                    lastFetchedAt: start,
                });
                refreshed += 1;
                }),
        }),
    );

    const failed = softFailed + summary.failed;
    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && skipped === 0 && failed >= summary.attempted),
        processed: mints.length,
        durationMs: deps.now() - start,
        refreshed,
        skipped,
        failed,
        ...(summary.partial ? { partial: true } : {}),
    };
}

const LATENCY_BOUNDS_MS: readonly number[] = [
    25, 50, 75, 100, 150, 200, 300, 400, 600, 1_000, 2_000, 5_000, 10_000,
];

function emptyLatencyHistogram(): number[] {
    return new Array(LATENCY_BOUNDS_MS.length + 1).fill(0);
}

function binLatencyMs(latencyMs: number): number {
    const v = Number.isFinite(latencyMs) ? Math.max(0, Math.floor(latencyMs)) : 0;
    for (let i = 0; i < LATENCY_BOUNDS_MS.length; i++) {
        const bound = LATENCY_BOUNDS_MS[i] ?? 0;
        if (v <= bound) return i;
    }
    return LATENCY_BOUNDS_MS.length;
}

function dateKeyUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function isAssetEndpoint(endpoint: string): boolean {
    return endpoint.startsWith('/api/v1/assets');
}

const ROLLUP_LOCK_MS = 120_000;
const ROLLUP_EVENT_SETTLE_MS = 2 * 60_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function rollupProjectApiUsage(
    deps: CronDeps,
    projectId: string,
    maxEvents: number,
    nowMs: number,
): Promise<{ processed: number; updatedDays: number; updatedEndpointDays: number; advancedCursorTo: number }> {
    const acquired = await deps.repo.tryAcquireRollupLock(projectId, nowMs, ROLLUP_LOCK_MS);
    if (!acquired) {
        const state = await deps.repo.getRollupStateForProject(projectId);
        return {
            processed: 0,
            updatedDays: 0,
            updatedEndpointDays: 0,
            advancedCursorTo: state?.cursorCreationTime ?? 0,
        };
    }

    const stateAfterLock = await deps.repo.getRollupStateForProject(projectId);
    const cursor = stateAfterLock?.cursorCreationTime ?? 0;
    const settledBefore = nowMs - ROLLUP_EVENT_SETTLE_MS;

    const events = await deps.repo.listProjectEventsForRollup(projectId, cursor, settledBefore, maxEvents);
    if (events.length === 0) {
        await deps.repo.releaseRollupLock(projectId, cursor, deps.now());
        return { processed: 0, updatedDays: 0, updatedEndpointDays: 0, advancedCursorTo: cursor };
    }

    const daily = new Map<string, DailyRollupDelta>();
    const endpointDaily = new Map<string, EndpointDailyRollupDelta>();

    for (const event of events) {
        const day = dateKeyUtc(event.ts);
        const isAsset = isAssetEndpoint(event.endpoint);
        const isSuccess = event.status < 400;
        const latencyMs = Number.isFinite(event.latencyMs) ? Math.max(0, Math.floor(event.latencyMs)) : 0;

        const dailyKey = day;
        const dayAcc =
            daily.get(dailyKey) ??
            ({
                projectId,
                day,
                totalCalls: 0,
                assetCalls: 0,
                successCalls: 0,
                sumLatencyMs: 0,
            } satisfies DailyRollupDelta);
        dayAcc.totalCalls += 1;
        if (isAsset) dayAcc.assetCalls += 1;
        if (isSuccess) dayAcc.successCalls += 1;
        dayAcc.sumLatencyMs += latencyMs;
        daily.set(dailyKey, dayAcc);

        const endpointKey = `${day}\n${event.endpoint}`;
        const epAcc =
            endpointDaily.get(endpointKey) ??
            ({
                projectId,
                day,
                endpoint: event.endpoint,
                calls: 0,
                successCalls: 0,
                sumLatencyMs: 0,
                latencyHistogram: emptyLatencyHistogram(),
            } satisfies EndpointDailyRollupDelta);
        epAcc.calls += 1;
        if (isSuccess) epAcc.successCalls += 1;
        epAcc.sumLatencyMs += latencyMs;
        const bin = binLatencyMs(latencyMs);
        epAcc.latencyHistogram[bin] = (epAcc.latencyHistogram[bin] ?? 0) + 1;
        endpointDaily.set(endpointKey, epAcc);
    }

    const updatedAt = deps.now();
    const lastCreationTime = events[events.length - 1]?.creationTime ?? cursor;
    const committed = await deps.repo.applyRollupBatchAtomic({
        projectId,
        daily: Array.from(daily.values()),
        endpointDaily: Array.from(endpointDaily.values()),
        expectedCursor: cursor,
        nextCursor: lastCreationTime,
        nowMs: deps.now(),
        updatedAt,
    });
    if (!committed) {
        return { processed: 0, updatedDays: 0, updatedEndpointDays: 0, advancedCursorTo: cursor };
    }

    return {
        processed: events.length,
        updatedDays: daily.size,
        updatedEndpointDays: endpointDaily.size,
        advancedCursorTo: lastCreationTime,
    };
}

export async function rollupActiveApiUsage(deps: CronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = asObject(rawArgs);
    const lookbackMinutes = clampInt(args.lookbackMinutes, 15, 1, 24 * 60);
    const maxProjects = clampInt(args.maxProjects, 100, 1, 500);
    const maxEventsPerProject = clampInt(args.maxEventsPerProject, 5_000, 1, 10_000);
    const maxEventsToScan = clampInt(args.maxEventsToScan, 10_000, 100, 50_000);
    const concurrency = clampInt(args.concurrency, 3, 1, 4);

    const start = deps.now();
    const since = start - lookbackMinutes * 60_000 - ROLLUP_EVENT_SETTLE_MS;

    const projectIds = await deps.repo.listRecentActiveProjects(since, maxEventsToScan, maxProjects);

    let rolledUp = 0;
    let processed = 0;
    let updatedDays = 0;
    let updatedEndpointDays = 0;
    let failed = 0;

    const queue = [...projectIds];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
            const projectId = queue.shift();
            if (projectId === undefined) return;
            try {
                const result = await rollupProjectApiUsage(deps, projectId, maxEventsPerProject, deps.now());
                processed += result.processed;
                updatedDays += result.updatedDays;
                updatedEndpointDays += result.updatedEndpointDays;
                if (result.processed > 0) rolledUp += 1;
            } catch (err) {
                failed += 1;
                console.error(
                    `[rollupActiveApiUsage] projectId=${projectId}`,
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
    });
    await Promise.all(workers);

    return {
        ok: true,
        processed,
        durationMs: deps.now() - start,
        projectsScanned: projectIds.length,
        projectsRolledUp: rolledUp,
        updatedDays,
        updatedEndpointDays,
        failed,
    };
}

export async function pruneApiRequestEvents(deps: CronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = asObject(rawArgs);
    const retentionDays = clampInt(args.retentionDays, 30, 1, 3650);
    const batchSizePerProject = clampInt(args.batchSizePerProject, 5_000, 1, 10_000);
    const maxProjects = clampInt(args.maxProjects, 100, 1, 500);

    const start = deps.now();
    const cutoffTs = start - retentionDays * MS_PER_DAY;

    const projectIds = await deps.repo.listAllProjectIds(maxProjects);

    let deleted = 0;
    let failed = 0;
    for (const projectId of projectIds) {
        try {
            const state = await deps.repo.getRollupStateForProject(projectId);
            const cursor = state?.cursorCreationTime ?? 0;
            const removed = await deps.repo.pruneApiRequestEventsForProject(
                projectId,
                cutoffTs,
                cursor,
                batchSizePerProject,
            );
            deleted += removed;
        } catch (err) {
            failed += 1;
            console.error(
                `[pruneApiRequestEvents] projectId=${projectId}`,
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    return {
        ok: true,
        processed: projectIds.length,
        durationMs: deps.now() - start,
        deleted,
        cutoffTs,
        failed,
    };
}

const OHLCV_INTERVALS = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'] as const;

function parseOhlcvInterval(value: unknown): BirdeyeInterval {
    if (typeof value !== 'string') {
        throw new InvalidArgsError('interval must be a string');
    }
    if (!(OHLCV_INTERVALS as readonly string[]).includes(value)) {
        throw new InvalidArgsError(`interval must be one of: ${OHLCV_INTERVALS.join(',')}`);
    }
    return value as BirdeyeInterval;
}

function intervalToSeconds(interval: BirdeyeInterval): number {
    switch (interval) {
        case '1m':
            return 60;
        case '5m':
            return 5 * 60;
        case '15m':
            return 15 * 60;
        case '1H':
            return 60 * 60;
        case '4H':
            return 4 * 60 * 60;
        case '1D':
            return 24 * 60 * 60;
        case '1W':
            return 7 * 24 * 60 * 60;
    }
}

function chunkArr<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

export async function refreshCuratedOhlcv(deps: CronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = asObject(rawArgs);
    const interval = parseOhlcvInterval(args.interval);
    const days = clampInt(args.days, 90, 1, 3650);
    const priorityCount = clampInt(args.priorityCount, 25, 0, 100);
    const maxMints = clampInt(args.maxMints, 25, 1, 250);
    const concurrency = clampInt(args.concurrency, 2, 1, 5);
    const delayMs = clampInt(args.delayMs, 200, 0, 5_000);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 60_000, 10_000, 24 * 60 * 60_000);
    const upsertChunkSize = clampInt(args.upsertChunkSize, 500, 50, 2_000);
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);

    const explicitMints = parseExplicitTargets(args.mints, 'mints');

    const start = deps.now();
    let mints: string[];
    if (explicitMints) {
        mints = explicitMints;
    } else {
        const allMints = deps.curated.getAllCuratedMintsInOrder();
        const priorityMints = priorityCount > 0 ? allMints.slice(0, priorityCount) : [];
        const selectedMints = pickDeterministicBatch(allMints, maxMints, selectionWindowMs, start);
        mints = uniqueStrings([...priorityMints, ...selectedMints]).slice(0, 250);
    }

    let refreshed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    if (mints.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            interval,
            refreshed,
            failed: 0,
            inserted,
            updated,
            skipped,
        };
    }

    const intervalSeconds = intervalToSeconds(interval);
    const requestedFrom = Math.floor(start / 1000) - days * 24 * 60 * 60;
    const requestedTo = Math.floor(start / 1000);

    const summary = await Effect.runPromise(
        runJobPool({
            label: `refreshCuratedOhlcv:${interval}`,
            items: mints,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: address =>
                Effect.tryPromise(async () => {
                const bounds = await deps.repo.getOhlcvBounds(address, interval);
                const segments: Array<{ from: number; to: number }> = [];
                if (bounds.minTime === null || bounds.maxTime === null) {
                    segments.push({ from: requestedFrom, to: requestedTo });
                } else {
                    if (bounds.minTime > requestedFrom + intervalSeconds) {
                        segments.push({ from: requestedFrom, to: bounds.minTime });
                    }
                    if (bounds.maxTime < requestedTo - intervalSeconds) {
                        segments.push({ from: bounds.maxTime, to: requestedTo });
                    }
                }
                if (segments.length === 0) {
                    skipped += 1;
                    return;
                }
                for (const segment of segments) {
                    const candles = await deps.birdeyeOhlcv.fetchOhlcv({
                        address,
                        interval,
                        from: segment.from,
                        to: segment.to,
                    });
                    for (const candlesChunk of chunkArr(candles, upsertChunkSize)) {
                        const result = await deps.repo.upsertOhlcvCandles(address, interval, candlesChunk);
                        inserted += result.inserted;
                        updated += result.updated;
                        skipped += result.skipped;
                    }
                }
                refreshed += 1;
                }),
        }),
    );

    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && skipped === 0 && summary.failed >= summary.attempted),
        processed: mints.length,
        durationMs: deps.now() - start,
        interval,
        refreshed,
        failed: summary.failed,
        inserted,
        updated,
        skipped,
        ...(summary.partial ? { partial: true } : {}),
    };
}

export const __testing = {
    pickDeterministicBatch,
    uniqueStrings,
    parseExplicitTargets,
    birdeyeOverviewToUpsert,
    isSpotLikeKind,
    trustTierRank,
    binLatencyMs,
    emptyLatencyHistogram,
    dateKeyUtc,
    isAssetEndpoint,
    parseOhlcvInterval,
    intervalToSeconds,
};
