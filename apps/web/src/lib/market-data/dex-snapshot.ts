import 'server-only';

import { CHAIN_IDS, type ChainId } from './chains';
import { fetchDexPairs, type DexPair, type DexPairWindow } from './dex-pairs';
import { fetchDexScreenerPairs, type DexScreenerPair } from './dexscreener';

/**
 * Keeps every chain's pair list warm in memory so a page load never waits on an
 * upstream provider.
 *
 * The two providers are split by what each is good at. GeckoTerminal owns the
 * *ranking*: it is the only free source that returns a network's pools sorted by
 * 24h volume, but a cold two-page sweep measured at ~4s and its keyless tier
 * rejects roughly half of all calls, so it runs on a slow background timer and
 * never on the request path. DexScreener owns the *metrics*: 30 pools per call
 * in ~550ms with no key, which is cheap enough to re-run every three quarters of
 * a minute and keeps prices close to live between rankings.
 *
 * Readers always get whatever is in the store immediately, however old. Serving
 * a minute-old row beats blocking the page, and `fetchedAt` lets the UI say how
 * old it is.
 */

interface ChainSnapshot {
    pairs: DexPair[];
    /** When the ranking last came back from GeckoTerminal, epoch ms. */
    rankedAt: number;
    /** When metrics were last refreshed (either provider), epoch ms. */
    fetchedAt: number;
    /** True when the last ranking attempt returned nothing at all. */
    degraded: boolean;
    pagesLoaded: number;
    pagesRequested: number;
}

interface SnapshotStore {
    snapshots: Map<ChainId, ChainSnapshot>;
    /** In-flight ranking loads, so concurrent callers share one request. */
    ranking: Map<ChainId, Promise<void>>;
    timers: NodeJS.Timeout[];
    started: boolean;
}

/**
 * Held on `globalThis` because `next dev` re-evaluates modules on every edit:
 * a module-level `const` would strand the old timers and start a second set on
 * every hot reload.
 */
const STORE_KEY = Symbol.for('tokens.dex-snapshot-store');

function getStore(): SnapshotStore {
    const globalStore = globalThis as unknown as Record<symbol, SnapshotStore | undefined>;
    let store = globalStore[STORE_KEY];
    if (!store) {
        store = { snapshots: new Map(), ranking: new Map(), timers: [], started: false };
        globalStore[STORE_KEY] = store;
    }
    return store;
}

/** Pages of GeckoTerminal ranking per chain. Two is 40 pools. */
const RANK_PAGES = 2;

/** How often a chain's ranking is rebuilt. Pool composition moves slowly. */
const RANK_INTERVAL_MS = 8 * 60 * 1000;

/** How often known pools get fresh prices from DexScreener. */
const METRICS_INTERVAL_MS = 45 * 1000;

/**
 * Gap between chains when scheduling. GeckoTerminal serializes callers ~1.5s
 * apart and answers 429 to bursts, so seven chains starting together would
 * spend the first minute retrying each other's rejections.
 */
const CHAIN_STAGGER_MS = 12 * 1000;

/** Longest a cold request waits for the very first ranking before giving up. */
const COLD_START_TIMEOUT_MS = 6 * 1000;

function num(value: unknown): number | null {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/**
 * Overlays live DexScreener numbers on a ranked pair.
 *
 * Every field falls back to what GeckoTerminal reported: a partial answer is
 * the norm (27 of 30 on a measured Solana batch, some without a price), and
 * blanking a row because the enricher was quiet would look like the pool died.
 */
function mergePair(pair: DexPair, live: DexScreenerPair | undefined): DexPair {
    if (!live) return pair;

    const window = (source: Record<string, number | undefined> | undefined, fallback: DexPairWindow): DexPairWindow => ({
        m5: num(source?.m5) ?? fallback.m5,
        h1: num(source?.h1) ?? fallback.h1,
        h6: num(source?.h6) ?? fallback.h6,
        h24: num(source?.h24) ?? fallback.h24,
    });

    const h24Txns = live.txns?.h24;

    return {
        ...pair,
        dex: live.dexId ?? pair.dex,
        base: {
            ...pair.base,
            symbol: live.baseToken?.symbol ?? pair.base.symbol,
            name: live.baseToken?.name ?? pair.base.name,
            imageUrl: pair.base.imageUrl ?? live.info?.imageUrl ?? null,
        },
        quote: {
            ...pair.quote,
            symbol: live.quoteToken?.symbol ?? pair.quote.symbol,
            name: live.quoteToken?.name ?? pair.quote.name,
        },
        priceUsd: num(live.priceUsd) ?? pair.priceUsd,
        priceChange: window(live.priceChange, pair.priceChange),
        volume: window(live.volume, pair.volume),
        liquidityUsd: num(live.liquidity?.usd) ?? pair.liquidityUsd,
        fdvUsd: num(live.fdv) ?? num(live.marketCap) ?? pair.fdvUsd,
        buys24h: num(h24Txns?.buys) ?? pair.buys24h,
        sells24h: num(h24Txns?.sells) ?? pair.sells24h,
        createdAt: pair.createdAt ?? num(live.pairCreatedAt),
    };
}

async function refreshMetrics(chain: ChainId): Promise<void> {
    const store = getStore();
    const snapshot = store.snapshots.get(chain);
    if (!snapshot || snapshot.pairs.length === 0) return;

    const live = await fetchDexScreenerPairs(
        chain,
        snapshot.pairs.map(pair => pair.address),
    );
    if (live.size === 0) return;

    const current = store.snapshots.get(chain);
    // The ranking may have been replaced while this was in flight; merge onto
    // whatever is in the store now, not onto the list this started from.
    if (!current) return;

    store.snapshots.set(chain, {
        ...current,
        pairs: current.pairs.map(pair => mergePair(pair, live.get(pair.address.toLowerCase()))),
        fetchedAt: Date.now(),
    });
}

async function refreshRanking(chain: ChainId): Promise<void> {
    const store = getStore();
    const inFlight = store.ranking.get(chain);
    if (inFlight) return await inFlight;

    const load = (async () => {
        const result = await fetchDexPairs(chain, RANK_PAGES);
        const previous = store.snapshots.get(chain);

        // A failed sweep keeps the previous list rather than emptying the tab;
        // stale pools still beat an empty table, and `degraded` says so.
        if (result.degraded && previous && previous.pairs.length > 0) {
            store.snapshots.set(chain, { ...previous, degraded: true });
            return;
        }

        const now = Date.now();
        store.snapshots.set(chain, {
            pairs: result.pairs,
            rankedAt: now,
            fetchedAt: now,
            degraded: result.degraded,
            pagesLoaded: result.pagesLoaded,
            pagesRequested: result.pagesRequested,
        });

        // Ranked numbers are already a few seconds old by the time they land;
        // one enrichment pass right away starts the tab off live.
        await refreshMetrics(chain).catch(() => undefined);
    })().finally(() => {
        store.ranking.delete(chain);
    });

    store.ranking.set(chain, load);
    return await load;
}

function scheduleChain(chain: ChainId, offsetMs: number): void {
    const store = getStore();

    const rankTimer = setTimeout(() => {
        void refreshRanking(chain).catch(() => undefined);
        const interval = setInterval(() => {
            void refreshRanking(chain).catch(() => undefined);
        }, RANK_INTERVAL_MS);
        interval.unref?.();
        store.timers.push(interval);
    }, offsetMs);
    rankTimer.unref?.();

    const metricsTimer = setTimeout(() => {
        const interval = setInterval(() => {
            void refreshMetrics(chain).catch(() => undefined);
        }, METRICS_INTERVAL_MS);
        interval.unref?.();
        store.timers.push(interval);
    }, offsetMs + METRICS_INTERVAL_MS);
    metricsTimer.unref?.();

    store.timers.push(rankTimer, metricsTimer);
}

/**
 * Starts the background refresh loop once per process.
 *
 * `unref` on every timer keeps this from holding a build or a script open: the
 * loop should keep a running server warm, not keep a finished process alive.
 */
export function startDexSnapshotRefresh(): void {
    const store = getStore();
    if (store.started) return;
    store.started = true;

    CHAIN_IDS.forEach((chain, index) => {
        scheduleChain(chain, index * CHAIN_STAGGER_MS);
    });
}

export interface DexSnapshotResult {
    chain: ChainId;
    pairs: DexPair[];
    degraded: boolean;
    pagesLoaded: number;
    pagesRequested: number;
    /** Epoch ms of the last metric refresh, or null when nothing is cached yet. */
    fetchedAt: number | null;
}

function toResult(chain: ChainId, snapshot: ChainSnapshot | undefined): DexSnapshotResult {
    if (!snapshot) {
        return { chain, pairs: [], degraded: true, pagesLoaded: 0, pagesRequested: RANK_PAGES, fetchedAt: null };
    }
    return {
        chain,
        pairs: snapshot.pairs,
        degraded: snapshot.degraded,
        pagesLoaded: snapshot.pagesLoaded,
        pagesRequested: snapshot.pagesRequested,
        fetchedAt: snapshot.fetchedAt,
    };
}

/** Whatever is cached right now — never waits on a provider. */
export function readDexSnapshot(chain: ChainId): DexSnapshotResult {
    startDexSnapshotRefresh();
    return toResult(chain, getStore().snapshots.get(chain));
}

/**
 * The snapshot, filling it first if this chain has never loaded.
 *
 * Only the very first visitor after a cold start can wait here, and only up to
 * `COLD_START_TIMEOUT_MS`; every later call returns the cached list instantly
 * while the background loop keeps it fresh.
 */
export async function ensureDexSnapshot(chain: ChainId): Promise<DexSnapshotResult> {
    startDexSnapshotRefresh();
    const store = getStore();

    if (!store.snapshots.has(chain)) {
        await Promise.race([
            refreshRanking(chain).catch(() => undefined),
            new Promise(resolve => setTimeout(resolve, COLD_START_TIMEOUT_MS)),
        ]);
    }

    return toResult(chain, store.snapshots.get(chain));
}
