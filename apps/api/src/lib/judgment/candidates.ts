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

import { Effect } from 'effect';

import { tapErrorAndDefault } from '@tokens/effect';
import { getVariantByMint, resolveAlias, searchAssets } from '@tokens/asset-registry';

import { loadAdvisoriesOrEmpty } from '@/lib/advisories';
import { getCuratedListSlugsByMint } from '@/lib/curated-membership';

import { searchProviderTokens, type ProviderSearchToken } from '@/lib/birdeye-search';
import { tokensSearchTokens, variantFillQualityGetLatestByMints, variantMarketsGetLatestByMints } from '@/lib/cloudrun';
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
import { registryClaimedSymbol } from './protected-symbols';
import { riskFromMarket } from './risk';
import type { CandidateSource, EnrichedCandidate, QueryInterpretation } from './types';

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

export interface RawCandidates {
    raws: RawCandidate[];
    sources: RawSourcesStatus;
}

/**
 * Find candidates for a query from the live provider, the token index and
 * the registry. Provider and index run concurrently; either failing degrades
 * that source rather than the call. The result is capped at
 * `MAX_CANDIDATES`, provider (liquidity-sorted) first, then index, then
 * registry mints the other sources missed.
 */
export function collectRawCandidates(
    query: string,
    interpretation: QueryInterpretation,
): Effect.Effect<RawCandidates, never> {
    return Effect.gen(function* () {
        const providerConfigured = Boolean((process.env.BIRDEYE_API_KEY ?? '').trim());
        // What the sources are asked must match what the cache key describes.
        const source = sourceQueryFor(query, interpretation);

        const [providerResult, dbResult] = yield* Effect.all(
            [
                providerConfigured
                    ? searchProviderTokens(source, { limit: 20 }).pipe(
                          Effect.map(tokens => ({ ok: true as const, tokens })),
                          tapErrorAndDefault(
                              'v2.lists.searchTokens.provider',
                              { ok: false as const, tokens: [] },
                              { query },
                          ),
                      )
                    : Effect.succeed({ ok: false as const, tokens: [] as ProviderSearchToken[] }),
                tokensSearchTokens({ query: source, limit: 20 }).pipe(
                    Effect.map(tokens => ({ ok: true as const, tokens: tokens as DbSearchToken[] })),
                    tapErrorAndDefault(
                        'v2.lists.searchTokens.db',
                        { ok: false as const, tokens: [] as DbSearchToken[] },
                        { query },
                    ),
                ),
            ],
            { concurrency: 2 },
        );

        const byMint = new Map<string, RawCandidate>();

        for (const token of providerResult.tokens) {
            if (!looksLikeSolanaMintAddress(token.address)) continue;
            const candidate = byMint.get(token.address) ?? newRawCandidate(token.address);
            mergeProviderToken(candidate, token);
            byMint.set(token.address, candidate);
        }

        for (const token of dbResult.tokens) {
            if (!looksLikeSolanaMintAddress(token.address)) continue;
            const candidate = byMint.get(token.address) ?? newRawCandidate(token.address);
            mergeDbToken(candidate, token);
            byMint.set(token.address, candidate);
        }

        for (const mint of registryCandidateMints(source, interpretation)) {
            const candidate = byMint.get(mint) ?? newRawCandidate(mint);
            addSource(candidate, 'registry');
            byMint.set(mint, candidate);
        }

        const raws = Array.from(byMint.values()).slice(0, MAX_CANDIDATES);
        const sources: RawSourcesStatus = {
            provider: providerConfigured ? (providerResult.ok ? 'ok' : 'degraded') : 'disabled',
            db: dbResult.ok ? 'ok' : 'degraded',
        };
        return { raws, sources };
    });
}

/**
 * Overlay live enrichment onto raw candidates. Best-effort throughout:
 * absence means unknown, not bad. The three Cloud Run reads are independent
 * and run concurrently; advisories and curated membership come from their
 * own in-process caches.
 */
export interface EnrichOptions {
    /**
     * When the raw set was collected. Provider-sourced market fields without a
     * stored market row are stamped with this as `dataAsOf`, so a cache hit
     * reports the price's real age instead of looking freshly fetched.
     * Defaults to now (an uncached collect).
     */
    collectedAtMs?: number;
}

export function enrichCandidates(
    raws: readonly RawCandidate[],
    options: EnrichOptions = {},
): Effect.Effect<EnrichedCandidate[], never> {
    return Effect.gen(function* () {
        const mints = raws.map(raw => raw.mint);
        if (mints.length === 0) return [];

        const [marketRows, fillQualityRows, tombstonedList] = yield* Effect.all(
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
            ],
            { concurrency: 3 },
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

        const fillQualityByMint = new Map<string, { executionScore: number; botVolumeRatio: number }>();
        for (const row of fillQualityRows) {
            const snapshot = executionQualitySnapshotFromConvexFillQuality(
                (row as { fillQuality?: object | null }).fillQuality,
            );
            if (snapshot) {
                fillQualityByMint.set((row as { mint: string }).mint, {
                    executionScore: snapshot.executionScore,
                    botVolumeRatio: snapshot.botVolumeRatio,
                });
            }
        }

        // DB-backed effective membership; a transient failure degrades to
        // no curated attestations for this request (last-good cache absorbs
        // most outages) rather than failing the search.
        const curatedByMint = yield* Effect.promise(() =>
            getCuratedListSlugsByMint().catch((error: unknown) => {
                console.error('[judgment] curated membership unavailable', error);
                return new Map<string, string[]>();
            }),
        );

        // Provider (Birdeye search) data is as old as the collect that
        // produced it — fresh on a miss, `cachedAt` on a hit. A candidate
        // served from it without a stored market row is still the freshest
        // data we have, not unknown.
        const enrichedAtMs = options.collectedAtMs ?? Date.now();

        return raws.map((raw): EnrichedCandidate => {
            const market = marketByMint.get(raw.mint) ?? null;
            const registryMatch = getVariantByMint(raw.mint);
            const fillQuality = fillQualityByMint.get(raw.mint) ?? null;
            // Outside the registry conditional: DB-only admin tokens get
            // curated attestations/badges too.
            const curatedListIds = curatedByMint.get(raw.mint) ?? [];
            const liquidityUsd = market?.liquidity ?? raw.liquidityUsd;
            const volume24hUsd = market?.volume24hUSD ?? raw.volume24hUsd;
            const marketCapUsd = market?.marketCap ?? raw.marketCapUsd;
            const holderCount = market?.holder ?? raw.holderCount;
            // The asset-risk cache is not ported: holder concentration and
            // Webacy tags are unknown here. The market score/grade is computed
            // from the overlaid market fields so `minMarketScore`,
            // `weak_market_score` and `grade:*` badges reflect real data.
            const top10HoldersPercent = null;

            return {
                mint: raw.mint,
                symbol: market?.symbol ?? raw.symbol,
                name: market?.name ?? raw.name,
                decimals: market?.decimals ?? raw.decimals,
                logoURI: market?.logoURI ?? raw.logoURI,
                price: market?.price ?? raw.price,
                liquidityUsd,
                volume24hUsd,
                marketCapUsd,
                priceChange24hPercent: market?.priceChange24hPercent ?? raw.priceChange24hPercent,
                holderCount,
                top10HoldersPercent,
                tokenMintTime: raw.tokenMintTime,
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
                risk: riskFromMarket({
                    mint: raw.mint,
                    liquidityUsd,
                    marketCapUsd,
                    holderCount,
                    top10HoldersPercent,
                    volume24hUsd,
                    tokenMintTime: raw.tokenMintTime,
                    curatedListIds,
                }),
                fillQuality,
                tombstoned: tombstonedRefs.has(raw.mint.toLowerCase()) || tombstonedRefs.has(raw.mint),
                advisory: advisoriesByMint.get(raw.mint) ?? null,
                dataAsOf:
                    marketAsOfByMint.get(raw.mint) ??
                    (raw.sources.includes('provider') && raw.price !== null ? enrichedAtMs : null),
            };
        });
    });
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
}

export interface GatheredCandidates {
    candidates: EnrichedCandidate[];
    sources: CandidateSourcesStatus;
    timing: { collectMs: number; enrichMs: number };
}

/**
 * Cached collect → live enrich. The cache key is intent + normalized query,
 * so every route in the family shares one raw set per query regardless of
 * policy or limit.
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
        let raw: RawCandidates | null = null;
        let collectedAtMs = collectStart;

        const cached = yield* readRawCandidates(key, options.cache);
        if (cached) {
            cache = 'hit';
            raw = { raws: cached.raws, sources: cached.sources };
            collectedAtMs = cached.cachedAt;
        } else {
            if (options.budget) yield* options.budget;
            raw = yield* collectRawCandidates(query, interpretation);
            // One timestamp for the stored entry and this request's dataAsOf,
            // so a later hit reports exactly the age a miss would have.
            collectedAtMs = Date.now();
            storeRawCandidates(key, { ...raw, cachedAt: collectedAtMs }, options.cache);
        }
        const collectMs = Date.now() - collectStart;

        const enrichStart = Date.now();
        const candidates = yield* enrichCandidates(raw.raws, { collectedAtMs });
        const enrichMs = Date.now() - enrichStart;

        return {
            candidates,
            sources: { ...raw.sources, registry: 'ok', cache },
            timing: { collectMs, enrichMs },
        };
    });
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}
