/**
 * Candidate sourcing + enrichment for the judged-search family
 * (ported from the archive repo's v2 search PR; the asset-risk cache was
 * dropped — risk is computeMarketScore over candidate market data, see risk.ts).
 *
 * Two halves, so each can be reused and cached on its own:
 *
 * `collectRawCandidates` — the I/O that *finds* tokens for a query, merged
 * and deduped by mint:
 * - `provider`: live Birdeye v3 search (broad long-tail coverage)
 * - `db`:       Cloud Run `tokens` full-text search (curated corpus)
 * - `registry`: checked-in canonical registry aliases
 * This is the slow, provider-budgeted half; `gatherCandidates` caches its
 * output per normalized query (see candidate-cache.ts) and only charges the
 * caller's budget effect on a cache miss.
 *
 * `enrichCandidates` — overlays Cloud Run market/fill-quality snapshots,
 * registry variant metadata, curated-list membership, advisories and deletion
 * tombstones onto raw candidates. Always live, never cached, so editorial
 * state (a new `blocked` advisory, a hard delete) takes effect on the next
 * request. `POST /v2/judge` feeds caller-supplied raws straight into it.
 *
 * A provider outage degrades to db/registry candidates — it never fails the
 * request.
 */

import { Cause, Duration, Effect, Fiber, Option } from 'effect';

import { tapErrorAndDefault } from '@tokens/effect';

import { runAfterResponse } from '@/effect/after-response';
import { getVariantByMint, resolveAlias, searchAssets } from '@tokens/asset-registry';

import { loadAdvisoriesOrEmpty } from '@/lib/advisories';
import { getCuratedListSlugsByMint } from '@/lib/curated-membership';

import { searchProviderTokens, type ProviderSearchToken } from '@/lib/birdeye-search';
import {
    assetRiskGetLatestByMints,
    tokensSearchTokens,
    variantFillQualityGetLatestByMints,
    variantMarketsGetLatestByMints,
    type AssetRiskDoc,
} from '@/lib/cloudrun';
import { listDeletedRefs } from '@/lib/deleted-refs';

import {
    executionQualitySnapshotFromConvexFillQuality,
    tokenMarketSnapshotFromConvexMarket,
} from '@/app/api/v1/assets/_asset-helpers';
import { looksLikeSolanaMintAddress } from '@/app/api/v1/assets/_singleton-asset-id';
import {
    candidateCacheEnabled,
    rawCandidateCacheKey,
    readRawCandidates,
    sourceQueryFor,
    storeRawCandidates,
    type CandidateCacheOptions,
    type RawCandidate,
    type RawSourcesStatus,
} from './candidate-cache';
import { liveEnrich, type LiveEnrichmentOptions, type LiveOutcome } from './live-enrichment';
import { registryClaimedSymbol } from './protected-symbols';
import { riskFromMarket } from './risk';
import type { CandidateSource, DataSourceKind, EnrichedCandidate, QueryInterpretation } from './types';

export type { RawCandidate } from './candidate-cache';

export const MAX_CANDIDATES = 40;
const CLOUDRUN_CHUNK = 250;

export type CandidateCacheStatus = 'hit' | 'miss' | 'bypass';

export interface CandidateSourcesStatus extends RawSourcesStatus {
    registry: 'ok';
    /**
     * Whether the raw candidate set came from the per-query cache. `bypass`
     * means the cache is disabled (or the route never consults it).
     */
    cache: CandidateCacheStatus;
}

export function newRawCandidate(mint: string): RawCandidate {
    return {
        mint,
        symbol: null,
        name: null,
        decimals: null,
        logoURI: null,
        price: null,
        liquidityUsd: null,
        volume24hUsd: null,
        marketCapUsd: null,
        priceChange24hPercent: null,
        holderCount: null,
        tokenMintTime: null,
        sources: [],
    };
}

function addSource(candidate: RawCandidate, source: CandidateSource): void {
    if (!candidate.sources.includes(source)) candidate.sources.push(source);
}

function mergeProviderToken(candidate: RawCandidate, token: ProviderSearchToken): void {
    addSource(candidate, 'provider');
    candidate.symbol ??= token.symbol;
    candidate.name ??= token.name;
    candidate.decimals ??= token.decimals;
    candidate.logoURI ??= token.logoURI;
    candidate.price ??= token.price;
    candidate.liquidityUsd ??= token.liquidityUsd;
    candidate.volume24hUsd ??= token.volume24hUsd;
    candidate.marketCapUsd ??= token.marketCapUsd;
    candidate.priceChange24hPercent ??= token.priceChange24hPercent;
    candidate.holderCount ??= token.holderCount;
    candidate.tokenMintTime ??= token.createdAt;
}

interface DbSearchToken {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
    liquidity: number;
    volume24hUSD: number;
    price: number;
    priceChange24hPercent: number;
    marketCap: number;
}

function mergeDbToken(candidate: RawCandidate, token: DbSearchToken): void {
    addSource(candidate, 'db');
    candidate.symbol ??= token.symbol || null;
    candidate.name ??= token.name || null;
    candidate.decimals ??= Number.isFinite(token.decimals) ? token.decimals : null;
    // DB wins for logos: cloudrun-assets resolves the first-party copy
    // (mint_logos.logo_cdn_url) into logoURI, whereas the live Birdeye search
    // hit carries the raw registry URL (often a rate-limited IPFS gateway).
    if (token.logoURI) candidate.logoURI = token.logoURI;
    else candidate.logoURI ??= null;
    candidate.price ??= token.price > 0 ? token.price : null;
    candidate.liquidityUsd ??= token.liquidity > 0 ? token.liquidity : null;
    candidate.volume24hUsd ??= token.volume24hUSD > 0 ? token.volume24hUSD : null;
    candidate.marketCapUsd ??= token.marketCap > 0 ? token.marketCap : null;
    candidate.priceChange24hPercent ??= token.priceChange24hPercent;
}

function registryCandidateMints(query: string, interpretation: QueryInterpretation): string[] {
    const mints: string[] = [];

    if (interpretation.intent === 'mint') {
        return looksLikeSolanaMintAddress(query) ? [query] : [];
    }

    const aliasAsset = resolveAlias(query);
    const searched = searchAssets(query, { limit: 10 });
    const assets = aliasAsset ? [aliasAsset, ...searched] : searched;

    for (const asset of assets) {
        for (const variant of asset.variants) {
            if (looksLikeSolanaMintAddress(variant.mint)) mints.push(variant.mint);
        }
    }
    return mints.slice(0, 15);
}

/** How the live provider fared on this collect. `timeout` is reported to callers as `degraded`. */
export type ProviderOutcome = 'ok' | 'degraded' | 'disabled' | 'timeout';

export interface RawCandidates {
    raws: RawCandidate[];
    sources: RawSourcesStatus;
    providerOutcome: ProviderOutcome;
    /**
     * Set only when the provider missed its deadline: resolves to the full
     * raw set once the still-running provider call finishes (or `null` if it
     * then fails). The caller stores it off the response path so the next
     * request for this query is complete.
     */
    late: Effect.Effect<RawCandidates | null, never> | null;
}

const DEFAULT_PROVIDER_DEADLINE_MS = 500;
const MAX_PROVIDER_DEADLINE_MS = 10_000;

/**
 * Soft deadline for the live provider search, in ms. `0` disables it (the
 * request waits for the provider as before). Default 500: the provider's own
 * p50 is ~190 ms and p90 ~250 ms, so the deadline only trims its tail.
 */
export function providerDeadlineMs(): number {
    const raw = process.env.TOKENS_SEARCH_PROVIDER_DEADLINE_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_PROVIDER_DEADLINE_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(Math.floor(value), MAX_PROVIDER_DEADLINE_MS);
}

type ProviderResult = { ok: boolean; tokens: ProviderSearchToken[] };
type DbResult = { ok: boolean; tokens: DbSearchToken[] };

/** Pure merge: provider (liquidity-sorted) first, then index, then registry mints the others missed. */
function assembleRaws(
    query: string,
    interpretation: QueryInterpretation,
    providerTokens: readonly ProviderSearchToken[],
    dbTokens: readonly DbSearchToken[],
): RawCandidate[] {
    const byMint = new Map<string, RawCandidate>();

    for (const token of providerTokens) {
        if (!looksLikeSolanaMintAddress(token.address)) continue;
        const candidate = byMint.get(token.address) ?? newRawCandidate(token.address);
        mergeProviderToken(candidate, token);
        byMint.set(token.address, candidate);
    }

    for (const token of dbTokens) {
        if (!looksLikeSolanaMintAddress(token.address)) continue;
        const candidate = byMint.get(token.address) ?? newRawCandidate(token.address);
        mergeDbToken(candidate, token);
        byMint.set(token.address, candidate);
    }

    for (const mint of registryCandidateMints(query, interpretation)) {
        const candidate = byMint.get(mint) ?? newRawCandidate(mint);
        addSource(candidate, 'registry');
        byMint.set(mint, candidate);
    }

    return Array.from(byMint.values()).slice(0, MAX_CANDIDATES);
}

/**
 * Find candidates for a query from the live provider, the token index and
 * the registry. Provider and index run concurrently; either failing degrades
 * that source rather than the call.
 *
 * The provider gets a soft deadline (`providerDeadlineMs`). When it is late
 * the result is assembled from the index and registry alone and reported as
 * `degraded`, but the provider call keeps running: `late` resolves to the
 * complete set so the caller can warm the cache after the response.
 */
export function collectRawCandidates(
    query: string,
    interpretation: QueryInterpretation,
): Effect.Effect<RawCandidates, never> {
    return Effect.gen(function* () {
        const providerConfigured = Boolean((process.env.BIRDEYE_API_KEY ?? '').trim());
        // What the sources are asked must match what the cache key describes.
        const source = sourceQueryFor(query, interpretation);
        const deadlineMs = providerDeadlineMs();

        const providerEffect: Effect.Effect<ProviderResult, never> = providerConfigured
            ? searchProviderTokens(source, { limit: 20 }).pipe(
                  Effect.map(tokens => ({ ok: true, tokens })),
                  tapErrorAndDefault('v2.lists.searchTokens.provider', { ok: false, tokens: [] }, { query }),
              )
            : Effect.succeed({ ok: false, tokens: [] });

        const dbEffect: Effect.Effect<DbResult, never> = tokensSearchTokens({ query: source, limit: 20 }).pipe(
            Effect.map(tokens => ({ ok: true, tokens: tokens as DbSearchToken[] })),
            tapErrorAndDefault('v2.lists.searchTokens.db', { ok: false, tokens: [] }, { query }),
        );

        // With a deadline, the provider runs on a detached fiber so it can
        // outlive the race; without one it is awaited like any other source.
        const racedProvider: Effect.Effect<
            { result: ProviderResult | null; pending: Effect.Effect<ProviderResult, never> | null },
            never
        > =
            providerConfigured && deadlineMs > 0
                ? Effect.gen(function* () {
                      const fiber = yield* Effect.forkDetach(providerEffect);
                      const joined = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(Duration.millis(deadlineMs)));
                      return Option.isSome(joined)
                          ? { result: joined.value, pending: null }
                          : { result: null, pending: Fiber.join(fiber) };
                  })
                : providerEffect.pipe(Effect.map(result => ({ result, pending: null })));

        const [provider, dbResult] = yield* Effect.all([racedProvider, dbEffect], { concurrency: 2 });

        const providerTokens = provider.result?.tokens ?? [];
        const raws = assembleRaws(source, interpretation, providerTokens, dbResult.tokens);

        const providerOutcome: ProviderOutcome = !providerConfigured
            ? 'disabled'
            : provider.result === null
              ? 'timeout'
              : provider.result.ok
                ? 'ok'
                : 'degraded';
        const sources: RawSourcesStatus = {
            provider: providerOutcome === 'ok' ? 'ok' : providerOutcome === 'disabled' ? 'disabled' : 'degraded',
            db: dbResult.ok ? 'ok' : 'degraded',
        };

        const late: RawCandidates['late'] =
            provider.pending === null
                ? null
                : provider.pending.pipe(
                      Effect.map((lateResult): RawCandidates | null =>
                          lateResult.ok
                              ? {
                                    raws: assembleRaws(source, interpretation, lateResult.tokens, dbResult.tokens),
                                    sources: { provider: 'ok', db: sources.db },
                                    providerOutcome: 'ok',
                                    late: null,
                                }
                              : null,
                      ),
                  );

        return { raws, sources, providerOutcome, late };
    });
}

/**
 * Overlay live enrichment onto raw candidates. Best-effort throughout:
 * absence means unknown, not bad. The three Cloud Run reads are independent
 * and run concurrently; advisories and curated membership come from their
 * own in-process caches.
 */
export interface EnrichOptions<E = never> {
    /**
     * When the raw set was collected. Provider-sourced market fields without a
     * stored market row are stamped with this as `dataAsOf`, so a cache hit
     * reports the price's real age instead of looking freshly fetched.
     * Defaults to now (an uncached collect).
     */
    collectedAtMs?: number;
    /**
     * Live tier: mints with no stored market row / risk row are looked up at
     * the provider (cached), so every mint gets the same read-out. Off for the
     * gathered routes today; `POST /v2/judge` passes its budget here.
     */
    live?: {
        budget?: Effect.Effect<void, E>;
        deadlineMs?: number;
        /** Test seams. */
        getRedis?: LiveEnrichmentOptions<E>['getRedis'];
        scheduleAfterResponse?: LiveEnrichmentOptions<E>['scheduleAfterResponse'];
        now?: () => number;
    };
}

export interface EnrichedSet {
    candidates: EnrichedCandidate[];
    live: LiveOutcome;
    liveLookups: number;
}

/**
 * Overlay enrichment onto raw candidates. Best-effort throughout: absence
 * means unknown, not bad. Resolution order per field is stored snapshot →
 * live provider (when enabled for the route) → the raw candidate's claim.
 * The four Cloud Run reads are independent and run concurrently; advisories
 * and curated membership come from their own in-process caches.
 */
export function enrichCandidatesDetailed<E = never>(
    raws: readonly RawCandidate[],
    options: EnrichOptions<E> = {},
): Effect.Effect<EnrichedSet, E> {
    return Effect.gen(function* () {
        const mints = raws.map(raw => raw.mint);
        if (mints.length === 0) return { candidates: [], live: 'none' as const, liveLookups: 0 };

        const [marketRows, fillQualityRows, tombstonedList, riskRows] = yield* Effect.all(
            [
                Effect.all(
                    chunk(mints, CLOUDRUN_CHUNK).map(part =>
                        variantMarketsGetLatestByMints({ mints: part }).pipe(
                            tapErrorAndDefault('v2.lists.searchTokens.variantMarkets', [], { count: part.length }),
                        ),
                    ),
                    { concurrency: 2 },
                ).pipe(Effect.map(rows => rows.flat())),
                Effect.all(
                    chunk(mints, CLOUDRUN_CHUNK).map(part =>
                        variantFillQualityGetLatestByMints({ mints: part }).pipe(
                            tapErrorAndDefault('v2.lists.searchTokens.fillQuality', [], { count: part.length }),
                        ),
                    ),
                    { concurrency: 2 },
                ).pipe(Effect.map(rows => rows.flat())),
                listDeletedRefs({ refs: mints }).pipe(
                    tapErrorAndDefault('v2.lists.searchTokens.tombstones', [], { count: mints.length }),
                ),
                Effect.all(
                    chunk(mints, CLOUDRUN_CHUNK).map(part =>
                        assetRiskGetLatestByMints({ mints: part }).pipe(
                            tapErrorAndDefault('v2.lists.searchTokens.assetRisk', [], { count: part.length }),
                        ),
                    ),
                    { concurrency: 2 },
                ).pipe(Effect.map(rows => rows.flat())),
            ],
            { concurrency: 4 },
        );
        const tombstonedRefs = new Set(tombstonedList);

        // Admin advisories (fail-open: an outage means no advisory gates for
        // this request, logged loudly by the cache).
        const advisoriesByMint = yield* loadAdvisoriesOrEmpty();

        const marketByMint = new Map<string, ReturnType<typeof tokenMarketSnapshotFromConvexMarket>>();
        const marketAsOfByMint = new Map<string, number>();
        for (const row of marketRows) {
            const market = (row as { mint: string; market?: object | null }).market;
            if (!market) continue;
            const fields = market as { lastFetchedAt?: number };
            if (!Number.isFinite(fields.lastFetchedAt) || (fields.lastFetchedAt ?? 0) <= 0) continue;
            marketByMint.set(row.mint, tokenMarketSnapshotFromConvexMarket(row.mint, market));
            marketAsOfByMint.set(row.mint, fields.lastFetchedAt as number);
        }

        const fillQualityByMint = new Map<string, NonNullable<EnrichedCandidate['fillQuality']>>();
        for (const row of fillQualityRows) {
            const snapshot = executionQualitySnapshotFromConvexFillQuality(
                (row as { fillQuality?: object | null }).fillQuality,
            );
            if (snapshot) {
                fillQualityByMint.set((row as { mint: string }).mint, {
                    executionScore: snapshot.executionScore,
                    botVolumeRatio: snapshot.botVolumeRatio,
                    flowSourceCount: snapshot.flowSourceCount,
                    markoutBps: snapshot.markoutBps,
                });
            }
        }

        const riskByMint = new Map<string, AssetRiskDoc>();
        for (const row of riskRows) {
            const doc = (row as { mint: string; risk?: AssetRiskDoc | null }).risk;
            if (doc) riskByMint.set(row.mint, doc);
        }

        // Live tier: only what no stored row covers.
        const liveResult = options.live
            ? yield* liveEnrich(
                  raws.map(raw => ({
                      mint: raw.mint,
                      market: !marketByMint.has(raw.mint),
                      // A stored risk row without a security block (older
                      // cron rows) still needs the live authority facts.
                      security: !riskByMint.get(raw.mint)?.security,
                  })),
                  {
                      budget: options.live.budget,
                      deadlineMs: options.live.deadlineMs,
                      getRedis: options.live.getRedis,
                      scheduleAfterResponse: options.live.scheduleAfterResponse,
                      now: options.live.now,
                  },
              )
            : null;

        // DB-backed effective membership; a transient failure degrades to
        // no curated attestations for this request (last-good cache absorbs
        // most outages) rather than failing the search.
        const curatedByMint = yield* getCuratedListSlugsByMint().pipe(
            Effect.catchCause(cause =>
                Effect.sync(() => {
                    console.error('[judgment] curated membership unavailable', Cause.squash(cause));
                    return new Map<string, string[]>();
                }),
            ),
        );

        // Provider (Birdeye search) data is as old as the collect that
        // produced it — fresh on a miss, `cachedAt` on a hit. A candidate
        // served from it without a stored market row is still the freshest
        // data we have, not unknown.
        const enrichedAtMs = options.collectedAtMs ?? Date.now();

        const candidates = raws.map((raw): EnrichedCandidate => {
            const market = marketByMint.get(raw.mint) ?? null;
            const registryMatch = getVariantByMint(raw.mint);
            const fillQuality = fillQualityByMint.get(raw.mint) ?? null;
            const riskRow = riskByMint.get(raw.mint) ?? null;
            const live = liveResult?.byMint.get(raw.mint);
            const liveMarket = live?.market ?? null;
            const liveSecurity = live?.security ?? null;
            // Outside the registry conditional: DB-only admin tokens get
            // curated attestations/badges too.
            const curatedListIds = curatedByMint.get(raw.mint) ?? [];

            // ---- market: snapshot → live → claim
            const liquidityUsd = market?.liquidity ?? liveMarket?.liquidity ?? raw.liquidityUsd;
            const volume24hUsd = market?.volume24hUSD ?? liveMarket?.volume24hUSD ?? raw.volume24hUsd;
            const marketCapUsd = market?.marketCap ?? liveMarket?.marketCap ?? raw.marketCapUsd;
            const holderCount = market?.holder ?? liveMarket?.holder ?? riskRow?.holderCount ?? raw.holderCount;
            const rawLabel = rawSourceLabel(raw);
            const marketSource: DataSourceKind = market
                ? 'snapshot'
                : liveMarket
                  ? 'provider'
                  : raw.price !== null || raw.liquidityUsd !== null || raw.volume24hUsd !== null
                    ? rawLabel
                    : 'none';

            // ---- holders: stored risk row → live security → claim
            const top10HoldersPercent =
                riskRow?.top10HoldersPercent ?? liveSecurity?.top10HoldersPercent ?? raw.top10HoldersPercent ?? null;
            // Age is ours to assert: the stored row, then the live provider, then
            // the caller — a claim must not make a fresh mint look old.
            const tokenMintTime = riskRow?.tokenMintTime ?? liveSecurity?.tokenMintTime ?? raw.tokenMintTime ?? null;
            const holdersSource: DataSourceKind =
                riskRow?.top10HoldersPercent != null || riskRow?.tokenMintTime
                    ? 'snapshot'
                    : liveSecurity?.top10HoldersPercent != null || liveSecurity?.tokenMintTime
                      ? 'provider'
                      : raw.top10HoldersPercent != null || raw.tokenMintTime
                        ? rawLabel
                        : 'none';

            // ---- security: stored row → live → claim (per flag)
            const storedSec = riskRow?.security ?? null;
            const security: EnrichedCandidate['security'] =
                storedSec ||
                liveSecurity ||
                raw.mintable != null ||
                raw.freezable != null ||
                raw.lpLockedPercent != null
                    ? {
                          mintable: storedSec?.mintable ?? liveSecurity?.mintable ?? raw.mintable ?? null,
                          freezable: storedSec?.freezable ?? liveSecurity?.freezable ?? raw.freezable ?? null,
                          mutableMetadata: storedSec?.mutableMetadata ?? liveSecurity?.mutableMetadata ?? null,
                          transferTax: storedSec?.transferTax ?? liveSecurity?.transferTax ?? null,
                          lpLockedPercent:
                              riskRow?.lpLockedPercent ?? liveSecurity?.lpLockedPercent ?? raw.lpLockedPercent ?? null,
                          devHoldingPercent: storedSec?.devHoldingPercent ?? null,
                          sniperHoldingPercent: storedSec?.sniperHoldingPercent ?? null,
                          bundlerHoldingPercent: storedSec?.bundlerHoldingPercent ?? null,
                      }
                    : null;
            const securitySource: DataSourceKind = storedSec
                ? 'snapshot'
                : liveSecurity
                  ? 'provider'
                  : security
                    ? rawLabel
                    : 'none';

            const dataAsOf =
                marketAsOfByMint.get(raw.mint) ??
                (liveMarket ? (live?.marketAt ?? enrichedAtMs) : null) ??
                (raw.sources.includes('provider') && raw.price !== null ? enrichedAtMs : null) ??
                market?.lastTradeAt ??
                null;

            return {
                mint: raw.mint,
                symbol: market?.symbol ?? liveMarket?.symbol ?? raw.symbol,
                name: market?.name ?? liveMarket?.name ?? raw.name,
                decimals: market?.decimals ?? liveMarket?.decimals ?? raw.decimals,
                logoURI: market?.logoURI ?? liveMarket?.logoURI ?? raw.logoURI,
                price: market?.price ?? liveMarket?.price ?? raw.price,
                liquidityUsd,
                volume24hUsd,
                marketCapUsd,
                priceChange24hPercent:
                    market?.priceChange24hPercent ?? liveMarket?.priceChange24hPercent ?? raw.priceChange24hPercent,
                holderCount,
                top10HoldersPercent,
                tokenMintTime,
                uniqueWallet24h: market?.uniqueWallet24h ?? liveMarket?.uniqueWallet24h ?? raw.uniqueWallet24h ?? null,
                trade24h: market?.trade24h ?? liveMarket?.trade24h ?? raw.trade24h ?? null,
                fdv: market?.fdv ?? liveMarket?.fdv ?? raw.fdv ?? null,
                circulatingSupply:
                    market?.circulatingSupply ?? liveMarket?.circulatingSupply ?? raw.circulatingSupply ?? null,
                totalSupply: market?.totalSupply ?? liveMarket?.totalSupply ?? raw.totalSupply ?? null,
                lastTradeAt: market?.lastTradeAt ?? liveMarket?.lastTradeAt ?? null,
                category: registryMatch?.asset.category ?? null,
                security,
                dataSources: { market: marketSource, holders: holdersSource, security: securitySource },
                sources: raw.sources.length > 0 ? [...raw.sources] : ['db'],
                curatedListIds,
                registry: registryMatch
                    ? {
                          assetId: registryMatch.asset.assetId,
                          // Derivative variants (LSTs, ETFs…) must not inherit the
                          // asset symbol — bSOL is not 'SOL' (see registryClaimedSymbol).
                          symbol: registryClaimedSymbol(registryMatch.variant, registryMatch.asset),
                          name: registryMatch.variant.name ?? registryMatch.asset.name ?? null,
                          kind: registryMatch.variant.kind ?? null,
                          trustTier: registryMatch.variant.trustTier ?? null,
                      }
                    : null,
                risk: {
                    ...riskFromMarket({
                        mint: raw.mint,
                        liquidityUsd,
                        marketCapUsd,
                        holderCount,
                        top10HoldersPercent,
                        volume24hUsd,
                        tokenMintTime,
                        curatedListIds,
                    }),
                    webacyTags: riskRow?.tags ?? [],
                },
                fillQuality,
                tombstoned: tombstonedRefs.has(raw.mint.toLowerCase()) || tombstonedRefs.has(raw.mint),
                advisory: advisoriesByMint.get(raw.mint) ?? null,
                dataAsOf,
            };
        });

        return {
            candidates,
            live: liveResult?.outcome ?? 'none',
            liveLookups: liveResult?.liveLookups ?? 0,
        };
    });
}

/** Enrichment without the live tier (the gathered routes). */
export function enrichCandidates(
    raws: readonly RawCandidate[],
    options: Omit<EnrichOptions<never>, 'live'> = {},
): Effect.Effect<EnrichedCandidate[], never> {
    return enrichCandidatesDetailed(raws, options).pipe(Effect.map(set => set.candidates));
}

export interface GatherOptions<E> {
    /**
     * Charged once, before the live sources run, only when the raw set is
     * not served from cache. Its failure (e.g. the provider budget's
     * `RateLimitedError`) fails the gather.
     */
    budget?: Effect.Effect<void, E>;
    /** Cache injection for tests. */
    cache?: CandidateCacheOptions;
    /** Where the warm-on-degrade work runs. Defaults to `runAfterResponse`. */
    scheduleAfterResponse?: (effect: Effect.Effect<void, never>) => void;
}

export interface GatheredCandidates {
    candidates: EnrichedCandidate[];
    sources: CandidateSourcesStatus;
    /** `cached` when the raw set was served from the cache (no provider call this request). */
    providerOutcome: ProviderOutcome | 'cached';
    timing: { collectMs: number; enrichMs: number };
}

/**
 * Cached collect → live enrich. The cache key is intent + normalized query,
 * so every route in the family shares one raw set per query regardless of
 * policy or limit.
 *
 * When the provider missed its deadline, the degraded set is what this
 * request answers with (and what is cached right now), and the late provider
 * result is written over it after the response — so the *next* request for
 * the query inside the window is complete and fast.
 */
export function gatherCandidates<E = never>(
    query: string,
    interpretation: QueryInterpretation,
    options: GatherOptions<E> = {},
): Effect.Effect<GatheredCandidates, E> {
    return Effect.gen(function* () {
        const key = rawCandidateCacheKey(query, interpretation);
        const collectStart = Date.now();

        let cache: CandidateCacheStatus = candidateCacheEnabled() ? 'miss' : 'bypass';
        let raws: RawCandidate[];
        let sources: RawSourcesStatus;
        let providerOutcome: GatheredCandidates['providerOutcome'];
        let collectedAtMs = collectStart;

        const cached = yield* readRawCandidates(key, options.cache);
        if (cached) {
            cache = 'hit';
            raws = cached.raws;
            sources = cached.sources;
            providerOutcome = 'cached';
            collectedAtMs = cached.cachedAt;
        } else {
            if (options.budget) yield* options.budget;
            const collected = yield* collectRawCandidates(query, interpretation);
            raws = collected.raws;
            sources = collected.sources;
            providerOutcome = collected.providerOutcome;
            // One timestamp for the stored entry and this request's dataAsOf,
            // so a later hit reports exactly the age a miss would have.
            collectedAtMs = Date.now();
            storeRawCandidates(key, { ...collected, cachedAt: collectedAtMs }, options.cache);

            if (collected.late) {
                const late = collected.late;
                const schedule = options.scheduleAfterResponse ?? runAfterResponse;
                schedule(
                    late.pipe(
                        Effect.map(full => {
                            if (full) storeRawCandidates(key, full, options.cache);
                        }),
                    ),
                );
            }
        }
        const collectMs = Date.now() - collectStart;

        const enrichStart = Date.now();
        const candidates = yield* enrichCandidates(raws, { collectedAtMs });
        const enrichMs = Date.now() - enrichStart;

        return {
            candidates,
            sources: { ...sources, registry: 'ok', cache },
            providerOutcome,
            timing: { collectMs, enrichMs },
        };
    });
}

/**
 * What a raw candidate's own fields count as: a judge body is the caller's
 * claim; a Birdeye search hit is provider data; the token index / registry
 * is our own snapshot.
 */
function rawSourceLabel(raw: RawCandidate): DataSourceKind {
    if (raw.sources.includes('caller')) return 'caller';
    if (raw.sources.includes('provider')) return 'provider';
    return 'snapshot';
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}
