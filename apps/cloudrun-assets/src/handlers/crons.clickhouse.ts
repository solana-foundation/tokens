import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { runJobPool } from '@tokens/effect/job-runner';
import type { CronResult, CuratedMintsSource } from './crons';
import { InvalidArgsError, parseExplicitTargets } from './crons';

export interface ClickhouseStockInstrumentRow {
    symbol: string;
    name: string | null;
    assetId: string | null;
    instrumentId: number | null;
    dataset: string | null;
}

export interface ClickhouseStockSnapshot {
    priceUsd: number | null;
    volume24hUsd: number | null;
    priceChange24hPercent: number | null;
    asOf: number | null;
}

export interface ClickhouseSharesOutstandingRow {
    symbol: string;
    sharesOutstanding: number | null;
    asOfMs: number | null;
}

export interface ClickhouseMintSnapshot {
    mint: string;
    priceUsd: number | null;
    volume1hUsd: number;
    volume24hUsd: number;
    trade1h: number;
    trade24h: number;
    uniqueTrader1h: number;
    uniqueTrader24h: number;
    priceChange1hPercent: number | null;
    priceChange24hPercent: number | null;
    lastTradeAt: number | null;
    asOf: number | null;
}

export interface ClickhouseClient {
    fetchStockInstruments(params: { limit: number }): Promise<ClickhouseStockInstrumentRow[]>;
    fetchStockSnapshot(symbol: string): Promise<ClickhouseStockSnapshot | null>;
    fetchSharesOutstanding(symbols: readonly string[]): Promise<ClickhouseSharesOutstandingRow[]>;
    fetchSolanaTradesAsOfMs(): Promise<number | null>;
    fetchSolanaMintSnapshots(params: {
        mints: readonly string[];
        stableMints: readonly string[];
        asOfMs?: number;
    }): Promise<ClickhouseMintSnapshot[]>;
    queryPreset<T = Record<string, unknown>>(name: string, params: Record<string, unknown>): Promise<T[]>;
}

export interface StockInstrumentUpsert {
    assetId: string;
    symbol: string;
    normalizedSymbol: string;
    name?: string;
    instrumentId?: number;
    dataset?: string;
    isActive: boolean;
    lastSyncedAt: number;
}

export interface StockPriceUpsert {
    assetId: string;
    symbol: string;
    normalizedSymbol: string;
    priceUsd: number | null;
    volume24hUsd: number | null;
    priceChange24hPercent: number | null;
    asOf: number | null;
    lastFetchedAt: number;
}

export interface SolanaTradeSnapshotUpsert {
    mint: string;
    symbol?: string;
    name?: string;
    price: number | null;
    volume1hUSD: number;
    volume24hUSD: number;
    trade1h: number;
    trade24h: number;
    uniqueWallet1h: number;
    uniqueWallet24h: number;
    priceChange1hPercent: number | null;
    priceChange24hPercent: number | null;
    lastTradeAt: number | null;
    asOf: number | null;
    lastFetchedAt: number;
}

export interface ActiveStockMapping {
    assetId: string;
    symbol: string;
    normalizedSymbol: string;
}

export interface StockSharesOutstandingUpdate {
    assetId: string;
    sharesOutstanding: number | null;
    sharesAsOf: number | null;
    sharesLastFetchedAt: number;
}

export interface ClickhouseRepo {
    upsertStockInstruments(rows: readonly StockInstrumentUpsert[]): Promise<{ upserted: number; skipped: number }>;
    listStockMappableAssets(): Promise<
        Array<{ assetId: string; category: string; name?: string; symbol?: string; aliases?: string[] }>
    >;
    listActiveStockMappings(limit: number): Promise<ActiveStockMapping[]>;
    upsertStockPriceLatest(args: StockPriceUpsert): Promise<void>;
    updateStockSharesOutstanding(args: StockSharesOutstandingUpdate): Promise<{ updated: number }>;
    upsertVariantMarketFromClickhouse(args: SolanaTradeSnapshotUpsert): Promise<void>;
    getStableMints(): Promise<string[]>;
    getRegistryIdentityByMint(mint: string): Promise<{ symbol?: string; name?: string } | null>;
}

export type CuratedMintsForClickhouse = Pick<CuratedMintsSource, 'getAllCuratedMintsInOrder'>;

export interface ClickhouseCronDeps {
    clickhouseRepo: ClickhouseRepo;
    curated: CuratedMintsForClickhouse;
    clickhouse: ClickhouseClient;
    now: () => number;
    env: () => NodeJS.ProcessEnv;
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

function clampBool(value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new InvalidArgsError('boolean arg must be a boolean');
    return value;
}

function normalizeSymbol(value: string): string {
    return value.trim().toUpperCase();
}

function normalizeText(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
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
    for (const v of values) {
        const t = v.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

function chunkArr<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function isStockRefreshEnabled(env: NodeJS.ProcessEnv): boolean {
    return (env.CLICKHOUSE_STOCK_REFRESH_ENABLED ?? '').trim().toLowerCase() === 'true';
}

function isSolanaTradesRefreshEnabled(env: NodeJS.ProcessEnv): boolean {
    return (env.CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED ?? '').trim().toLowerCase() === 'true';
}

const NON_PUBLIC_EQUITY_ASSET_ID_PREFIXES = ['pre-', 'stock-', 'private-'] as const;
const NON_PUBLIC_EQUITY_METADATA_PATTERN = /(^|[\s:_-])(pre[-\s]?ipo|pre[-\s]?stocks?|private|unlisted)($|[\s:_-])/;
const CLICKHOUSE_EQUITY_ASSET_ID_ALLOWLIST = new Set(['spacex']);

/**
 * Commodity canonical assets map to their ClickHouse benchmark ticker EXPLICITLY.
 * They intentionally bypass the equity symbol/alias/name matching: gold's `gold`
 * alias would otherwise collide with Barrick Gold's `GOLD` ticker, and the
 * equity ETF-name blocklist would reject "iShares Silver Trust" style names.
 * Do not "improve" this to alias-based matching.
 */
const CLICKHOUSE_COMMODITY_TICKER_BY_ASSET_ID: Record<string, string> = {
    gold: 'GLD',
    silver: 'SLV',
    oil: 'USO',
    copper: 'COPX',
};

interface EquityCandidate {
    assetId: string;
    category?: string;
    name?: string;
    symbol?: string;
    aliases?: string[];
}

function hasNonPublicEquitySignal(asset: EquityCandidate): boolean {
    const identifiers = [asset.assetId, asset.symbol, asset.name, ...(asset.aliases ?? [])];
    return identifiers.some(value => {
        const normalized = normalizeText(value);
        return (
            NON_PUBLIC_EQUITY_ASSET_ID_PREFIXES.some(prefix => normalized.startsWith(prefix)) ||
            NON_PUBLIC_EQUITY_METADATA_PATTERN.test(normalized)
        );
    });
}

function isPublicEquityAsset(asset: EquityCandidate): boolean {
    const assetId = asset.assetId.trim();
    if (!assetId) return false;
    if (CLICKHOUSE_EQUITY_ASSET_ID_ALLOWLIST.has(assetId)) return true;
    if (hasNonPublicEquitySignal(asset)) return false;
    const haystack = normalizeText(`${assetId} ${asset.name ?? ''}`);
    if (/\b(etf|fund|trust|nasdaq|russell|vanguard|ishares|spdr|proshares)\b/.test(haystack)) return false;
    return true;
}

export async function syncClickhouseStockMappings(
    deps: ClickhouseCronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const args = asObject(rawArgs);
    const limit = clampInt(args.limit, 5000, 1, 10_000);
    const requireRefreshEnabled = clampBool(args.requireRefreshEnabled, true);

    const start = deps.now();
    if (requireRefreshEnabled && !isStockRefreshEnabled(deps.env())) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            skipped: true,
            reason: 'disabled',
            scanned: 0,
            matched: 0,
            upserted: 0,
        };
    }

    const mappableAssets = await deps.clickhouseRepo.listStockMappableAssets();
    const equityAssets = mappableAssets.filter(asset => asset.category !== 'commodity');
    const commodityAssets = mappableAssets.filter(asset => asset.category === 'commodity');

    // Commodities match ONLY via the explicit benchmark ticker map (never symbol/alias/name).
    const commodityAssetByTicker = new Map<string, EquityCandidate>();
    for (const asset of commodityAssets) {
        const ticker = CLICKHOUSE_COMMODITY_TICKER_BY_ASSET_ID[asset.assetId];
        if (ticker) commodityAssetByTicker.set(normalizeSymbol(ticker), asset);
    }

    const publicAssets = equityAssets.filter(isPublicEquityAsset);
    const assetById = new Map<string, EquityCandidate>();
    const assetBySymbol = new Map<string, EquityCandidate>();
    const assetByAlias = new Map<string, EquityCandidate>();
    const assetByName = new Map<string, EquityCandidate>();
    for (const asset of publicAssets) {
        assetById.set(asset.assetId, asset);
        const normSym = normalizeText(asset.symbol);
        if (normSym && !assetBySymbol.has(normSym)) assetBySymbol.set(normSym, asset);
        for (const alias of asset.aliases ?? []) {
            const normAlias = normalizeText(alias);
            if (normAlias && !assetByAlias.has(normAlias)) assetByAlias.set(normAlias, asset);
        }
        const normName = normalizeText(asset.name);
        if (normName && !assetByName.has(normName)) assetByName.set(normName, asset);
    }

    const rows = await deps.clickhouse.fetchStockInstruments({ limit });

    const mappings: StockInstrumentUpsert[] = [];
    for (const row of rows) {
        const commodityAsset = commodityAssetByTicker.get(normalizeSymbol(row.symbol));
        const directAsset = !commodityAsset && row.assetId ? assetById.get(row.assetId) : undefined;
        const symbolAsset = !commodityAsset && !directAsset ? assetBySymbol.get(normalizeText(row.symbol)) : undefined;
        const aliasAsset =
            !commodityAsset && !directAsset && !symbolAsset ? assetByAlias.get(normalizeText(row.symbol)) : undefined;
        const namedAsset =
            !commodityAsset && !directAsset && !symbolAsset && !aliasAsset && row.name
                ? assetByName.get(normalizeText(row.name))
                : undefined;
        const asset = commodityAsset ?? directAsset ?? symbolAsset ?? aliasAsset ?? namedAsset;
        if (!asset) continue;
        const symbol = normalizeSymbol(row.symbol);
        if (!symbol) continue;

        mappings.push({
            assetId: asset.assetId,
            symbol,
            normalizedSymbol: symbol,
            ...(row.name ? { name: row.name } : asset.name ? { name: asset.name } : {}),
            ...(row.instrumentId !== null ? { instrumentId: row.instrumentId } : {}),
            ...(row.dataset ? { dataset: row.dataset } : {}),
            isActive: true,
            lastSyncedAt: start,
        });
    }

    const result = await deps.clickhouseRepo.upsertStockInstruments(mappings);

    return {
        ok: true,
        processed: result.upserted,
        durationMs: deps.now() - start,
        scanned: rows.length,
        matched: mappings.length,
        upserted: result.upserted,
        skippedRows: result.skipped,
    };
}

export async function refreshPublicEquityStockPrices(
    deps: ClickhouseCronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const args = asObject(rawArgs);
    const maxAssets = clampInt(args.maxAssets, 250, 1, 1000);
    const concurrency = clampInt(args.concurrency, 2, 1, 5);
    const delayMs = clampInt(args.delayMs, 50, 0, 5_000);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 5 * 60_000, 10_000, 24 * 60 * 60_000);
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);
    const requireRefreshEnabled = clampBool(args.requireRefreshEnabled, true);
    const explicitAssetIds = parseExplicitTargets(args.assetIds, 'assetIds');

    const start = deps.now();
    if (requireRefreshEnabled && !isStockRefreshEnabled(deps.env())) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            skipped: true,
            reason: 'disabled',
            refreshed: 0,
            failed: 0,
        };
    }

    const mappings = await deps.clickhouseRepo.listActiveStockMappings(1000);
    if (mappings.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            refreshed: 0,
            skippedNoSnapshot: 0,
            failed: 0,
        };
    }
    let selected: ActiveStockMapping[];
    if (explicitAssetIds) {
        const wanted = new Set(explicitAssetIds);
        selected = mappings.filter(m => wanted.has(m.assetId));
    } else {
        selected = pickDeterministicBatch(mappings, maxAssets, selectionWindowMs, start);
    }

    let refreshed = 0;
    let skippedNoSnapshot = 0;

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'refreshPublicEquityStockPrices',
            items: selected,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: mapping =>
                Effect.tryPromise(async () => {
                    const snapshot = await deps.clickhouse.fetchStockSnapshot(mapping.symbol);
                    if (!snapshot) {
                        skippedNoSnapshot += 1;
                        return;
                    }
                    await deps.clickhouseRepo.upsertStockPriceLatest({
                        assetId: mapping.assetId,
                        symbol: mapping.symbol,
                        normalizedSymbol: mapping.normalizedSymbol,
                        priceUsd: snapshot.priceUsd,
                        volume24hUsd: snapshot.volume24hUsd,
                        priceChange24hPercent: snapshot.priceChange24hPercent,
                        asOf: snapshot.asOf,
                        lastFetchedAt: start,
                    });
                    refreshed += 1;
                }),
        }),
    );

    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && skippedNoSnapshot === 0 && summary.failed >= summary.attempted),
        processed: selected.length,
        durationMs: deps.now() - start,
        refreshed,
        skippedNoSnapshot,
        failed: summary.failed,
        ...(summary.partial ? { partial: true } : {}),
    };
}

/**
 * Daily refresh of underlying-company shares outstanding for public equities.
 * Fetches from the clickhouse-api gateway preset `yfinance_shares_outstanding_latest`
 * in symbol batches and updates `stock_prices_latest`. Company market cap is
 * derived at read time (price_usd * shares_outstanding), so shares only need a
 * daily cadence while prices refresh every 5 minutes.
 */
export async function refreshPublicEquitySharesOutstanding(
    deps: ClickhouseCronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const args = asObject(rawArgs);
    const maxAssets = clampInt(args.maxAssets, 1000, 1, 5000);
    const chunkSize = clampInt(args.chunkSize, 200, 1, 500);
    const requireRefreshEnabled = clampBool(args.requireRefreshEnabled, true);
    const explicitAssetIds = parseExplicitTargets(args.assetIds, 'assetIds');

    const start = deps.now();
    if (requireRefreshEnabled && !isStockRefreshEnabled(deps.env())) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            skipped: true,
            reason: 'disabled',
            refreshed: 0,
            missing: 0,
            failed: 0,
        };
    }

    const mappings = await deps.clickhouseRepo.listActiveStockMappings(maxAssets);
    let selected: ActiveStockMapping[];
    if (explicitAssetIds) {
        const wanted = new Set(explicitAssetIds);
        selected = mappings.filter(m => wanted.has(m.assetId));
    } else {
        selected = mappings;
    }
    if (selected.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            refreshed: 0,
            missing: 0,
            failed: 0,
        };
    }

    const mappingsByNormalizedSymbol = new Map<string, ActiveStockMapping[]>();
    for (const mapping of selected) {
        const key = normalizeSymbol(mapping.symbol);
        const list = mappingsByNormalizedSymbol.get(key);
        if (list) list.push(mapping);
        else mappingsByNormalizedSymbol.set(key, [mapping]);
    }

    const symbols = uniqueStrings(selected.map(m => normalizeSymbol(m.symbol)));
    let refreshed = 0;
    let missing = 0;
    let failed = 0;

    for (const chunk of chunkArr(symbols, chunkSize)) {
        let rows: ClickhouseSharesOutstandingRow[];
        try {
            rows = await deps.clickhouse.fetchSharesOutstanding(chunk);
        } catch (err) {
            failed += chunk.length;
            console.error(
                `[refreshPublicEquitySharesOutstanding] chunk size=${chunk.length}`,
                err instanceof Error ? err.message : String(err),
            );
            continue;
        }
        const rowBySymbol = new Map(rows.map(r => [normalizeSymbol(r.symbol), r] as const));
        for (const symbol of chunk) {
            const row = rowBySymbol.get(symbol);
            const mappingsForSymbol = mappingsByNormalizedSymbol.get(symbol) ?? [];
            if (!row || row.sharesOutstanding === null) {
                // Symbol absent from the feed (e.g. dot-tickers like BRK.B) or
                // shares not populated — leave existing values untouched.
                missing += mappingsForSymbol.length;
                continue;
            }
            for (const mapping of mappingsForSymbol) {
                try {
                    const result = await deps.clickhouseRepo.updateStockSharesOutstanding({
                        assetId: mapping.assetId,
                        sharesOutstanding: row.sharesOutstanding,
                        sharesAsOf: row.asOfMs !== null ? row.asOfMs / 1000 : null,
                        sharesLastFetchedAt: start,
                    });
                    if (result.updated > 0) refreshed += 1;
                    else missing += 1; // no stock_prices_latest row yet for this asset
                } catch (err) {
                    failed += 1;
                    console.error(
                        `[refreshPublicEquitySharesOutstanding] assetId=${mapping.assetId} symbol=${mapping.symbol}`,
                        err instanceof Error ? err.message : String(err),
                    );
                }
            }
        }
    }

    return {
        ok: true,
        processed: selected.length,
        durationMs: deps.now() - start,
        refreshed,
        missing,
        failed,
    };
}

export async function refreshSolanaClickhouseTradeSnapshots(
    deps: ClickhouseCronDeps,
    rawArgs: unknown,
): Promise<CronResult> {
    const args = asObject(rawArgs);
    const maxMints = clampInt(args.maxMints, 250, 1, 500);
    const priorityCount = clampInt(args.priorityCount, 50, 0, 100);
    const concurrency = clampInt(args.concurrency, 3, 1, 8);
    const delayMs = clampInt(args.delayMs, 25, 0, 5_000);
    const selectionWindowMs = clampInt(args.selectionWindowMs, 5 * 60_000, 10_000, 24 * 60 * 60_000);
    const chunkSize = clampInt(args.chunkSize, 50, 1, 250);
    const budgetMs = clampInt(args.budgetMs, 0, 0, 3_600_000);
    const requireRefreshEnabled = clampBool(args.requireRefreshEnabled, true);

    const start = deps.now();
    if (requireRefreshEnabled && !isSolanaTradesRefreshEnabled(deps.env())) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            skipped: true,
            reason: 'disabled',
            refreshed: 0,
            noTrades: 0,
            failed: 0,
        };
    }

    const allMints = deps.curated.getAllCuratedMintsInOrder();
    const priorityMints = priorityCount > 0 ? allMints.slice(0, priorityCount) : [];
    const selectedMints = pickDeterministicBatch(allMints, maxMints, selectionWindowMs, start);
    const mints = uniqueStrings([...priorityMints, ...selectedMints]).slice(0, maxMints);

    if (mints.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            refreshed: 0,
            noTrades: 0,
            failed: 0,
        };
    }

    const stableMints = await deps.clickhouseRepo.getStableMints();
    const asOfMs = await deps.clickhouse.fetchSolanaTradesAsOfMs();
    const chunks = chunkArr(mints, chunkSize);
    const seen = new Set<string>();
    let refreshed = 0;
    let softFailed = 0;

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'refreshSolanaClickhouseTradeSnapshots',
            items: chunks,
            concurrency,
            delayMs,
            ...(budgetMs > 0 ? { budgetMs } : {}),
            shouldStop: isShuttingDown,
            process: mintsChunk =>
                Effect.tryPromise(async () => {
                const snapshots = await deps.clickhouse.fetchSolanaMintSnapshots({
                    mints: mintsChunk,
                    stableMints,
                    ...(asOfMs !== null ? { asOfMs } : {}),
                });
                for (const snapshot of snapshots) {
                    seen.add(snapshot.mint);
                    const identity = (await deps.clickhouseRepo.getRegistryIdentityByMint(snapshot.mint)) ?? {};
                    await deps.clickhouseRepo.upsertVariantMarketFromClickhouse({
                        mint: snapshot.mint,
                        ...(identity.symbol ? { symbol: identity.symbol } : {}),
                        ...(identity.name ? { name: identity.name } : {}),
                        price: snapshot.priceUsd,
                        volume1hUSD: snapshot.volume1hUsd,
                        volume24hUSD: snapshot.volume24hUsd,
                        trade1h: snapshot.trade1h,
                        trade24h: snapshot.trade24h,
                        uniqueWallet1h: snapshot.uniqueTrader1h,
                        uniqueWallet24h: snapshot.uniqueTrader24h,
                        priceChange1hPercent: snapshot.priceChange1hPercent,
                        priceChange24hPercent: snapshot.priceChange24hPercent,
                        lastTradeAt: snapshot.lastTradeAt,
                        asOf: snapshot.asOf,
                        lastFetchedAt: start,
                    });
                    refreshed += 1;
                }
                }),
            onItemError: mintsChunk =>
                Effect.sync(() => {
                    // Preserve the per-mint failure accounting the old catch kept.
                    softFailed += mintsChunk.length;
                }),
        }),
    );

    const failed = softFailed;
    return {
        ok: !(summary.attempted > 0 && refreshed === 0 && summary.failed >= summary.attempted),
        processed: mints.length,
        durationMs: deps.now() - start,
        refreshed,
        noTrades: Math.max(0, mints.length - seen.size - failed),
        failed,
        asOfMs: asOfMs ?? null,
        ...(summary.partial ? { partial: true } : {}),
    };
}

export type ClickhouseJobHandler = (deps: ClickhouseCronDeps, rawArgs: unknown) => Promise<CronResult>;

export const clickhouseJobs: Record<string, ClickhouseJobHandler> = {
    'sync-clickhouse-stock-mappings': syncClickhouseStockMappings,
    'refresh-public-equity-stock-prices': refreshPublicEquityStockPrices,
    'refresh-public-equity-shares-outstanding': refreshPublicEquitySharesOutstanding,
    'refresh-solana-clickhouse-trade-snapshots': refreshSolanaClickhouseTradeSnapshots,
};

export const __testing = {
    isPublicEquityAsset,
    CLICKHOUSE_COMMODITY_TICKER_BY_ASSET_ID,
    pickDeterministicBatch,
    uniqueStrings,
    chunkArr,
    normalizeSymbol,
    normalizeText,
    isStockRefreshEnabled,
    isSolanaTradesRefreshEnabled,
};
