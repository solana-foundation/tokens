/**
 * Candidate sourcing + enrichment for the curator-assist token search
 * (ported from the archive repo's v2 search PR; the asset-risk cache was
 * dropped — risk falls back to computeMarketScore over candidate market data).
 *
 * Candidates come from three places (merged, deduped by mint):
 * - `provider`: live Birdeye v3 search (broad long-tail coverage)
 * - `db`:       Cloud Run `tokens` full-text search (curated corpus)
 * - `registry`: checked-in canonical registry aliases
 *
 * Enrichment overlays Cloud Run market/fill-quality snapshots, registry
 * variant metadata, curated-list membership, and deletion tombstones. A
 * provider outage degrades to db/registry candidates — it never fails the
 * request.
 */

import { Effect } from 'effect';

import { tapErrorAndDefault } from '@tokens/effect';
import { getVariantByMint, resolveAlias, searchAssets } from '@tokens/asset-registry';
import { CURATED_TOKEN_LISTS, getCuratedTokenList } from '@tokens/asset-registry/compat';

import { searchProviderTokens, type ProviderSearchToken } from '@/lib/birdeye-search';
import {
    listDeletedRefs,
    tokensSearchTokens,
    variantFillQualityGetLatestByMints,
    variantMarketsGetLatestByMints,
} from '@/lib/cloudrun';

import {
    executionQualitySnapshotFromConvexFillQuality,
    tokenMarketSnapshotFromConvexMarket,
} from '@/app/api/v1/assets/_asset-helpers';
import { looksLikeSolanaMintAddress } from '@/app/api/v1/assets/_singleton-asset-id';
import { registryClaimedSymbol } from './protected-symbols';
import type { CandidateSource, EnrichedCandidate, QueryInterpretation } from './types';

const MAX_CANDIDATES = 40;
const CLOUDRUN_CHUNK = 250;

export interface CandidateSourcesStatus {
    provider: 'ok' | 'degraded' | 'disabled';
    db: 'ok' | 'degraded';
    registry: 'ok';
}

interface RawCandidate {
    mint: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    logoURI: string | null;
    price: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    marketCapUsd: number | null;
    priceChange24hPercent: number | null;
    holderCount: number | null;
    tokenMintTime: string | null;
    sources: Set<CandidateSource>;
}

function newRawCandidate(mint: string): RawCandidate {
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
        sources: new Set(),
    };
}

function mergeProviderToken(candidate: RawCandidate, token: ProviderSearchToken): void {
    candidate.sources.add('provider');
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
    candidate.sources.add('db');
    candidate.symbol ??= token.symbol || null;
    candidate.name ??= token.name || null;
    candidate.decimals ??= Number.isFinite(token.decimals) ? token.decimals : null;
    candidate.logoURI ??= token.logoURI ?? null;
    candidate.price ??= token.price > 0 ? token.price : null;
    candidate.liquidityUsd ??= token.liquidity > 0 ? token.liquidity : null;
    candidate.volume24hUsd ??= token.volume24hUSD > 0 ? token.volume24hUSD : null;
    candidate.marketCapUsd ??= token.marketCap > 0 ? token.marketCap : null;
    candidate.priceChange24hPercent ??= token.priceChange24hPercent;
}

let curatedListIdsByMintCache: Map<string, string[]> | null = null;

function curatedListIdsByMint(): Map<string, string[]> {
    if (curatedListIdsByMintCache) return curatedListIdsByMintCache;
    const map = new Map<string, string[]>();
    for (const listId of Object.keys(CURATED_TOKEN_LISTS) as Array<keyof typeof CURATED_TOKEN_LISTS>) {
        const list = getCuratedTokenList(listId);
        for (const mint of list.addresses) {
            const existing = map.get(mint);
            if (existing) existing.push(list.id);
            else map.set(mint, [list.id]);
        }
    }
    curatedListIdsByMintCache = map;
    return map;
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

export interface GatheredCandidates {
    candidates: EnrichedCandidate[];
    sources: CandidateSourcesStatus;
}

export function gatherCandidates(
    query: string,
    interpretation: QueryInterpretation,
): Effect.Effect<GatheredCandidates, unknown> {
    return Effect.gen(function* () {
        const providerConfigured = Boolean((process.env.BIRDEYE_API_KEY ?? '').trim());

        const [providerResult, dbResult] = yield* Effect.all(
            [
                providerConfigured
                    ? searchProviderTokens(query, { limit: 20 }).pipe(
                          Effect.map(tokens => ({ ok: true as const, tokens })),
                          tapErrorAndDefault('v2.lists.searchTokens.provider', { ok: false as const, tokens: [] }, { query }),
                      )
                    : Effect.succeed({ ok: false as const, tokens: [] as ProviderSearchToken[] }),
                tokensSearchTokens({ query, limit: 20 }).pipe(
                    Effect.map(tokens => ({ ok: true as const, tokens: tokens as DbSearchToken[] })),
                    tapErrorAndDefault('v2.lists.searchTokens.db', { ok: false as const, tokens: [] as DbSearchToken[] }, { query }),
                ),
            ],
            { concurrency: 2 },
        );

        // Merge/dedupe by mint. Provider ordering (liquidity-sorted) first, then
        // db, then registry mints the other sources missed.
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

        for (const mint of registryCandidateMints(query, interpretation)) {
            const candidate = byMint.get(mint) ?? newRawCandidate(mint);
            candidate.sources.add('registry');
            byMint.set(mint, candidate);
        }

        const raws = Array.from(byMint.values()).slice(0, MAX_CANDIDATES);
        const mints = raws.map(raw => raw.mint);

        // ---- Enrichment fan-in (best-effort; absence means unknown, not bad) ----

        const marketRows =
            mints.length > 0
                ? yield* Effect.all(
                      chunk(mints, CLOUDRUN_CHUNK).map(part =>
                          variantMarketsGetLatestByMints({ mints: part }).pipe(
                              tapErrorAndDefault('v2.lists.searchTokens.variantMarkets', [], { count: part.length }),
                          ),
                      ),
                      { concurrency: 2 },
                  ).pipe(Effect.map(rows => rows.flat()))
                : [];

        const fillQualityRows =
            mints.length > 0
                ? yield* Effect.all(
                      chunk(mints, CLOUDRUN_CHUNK).map(part =>
                          variantFillQualityGetLatestByMints({ mints: part }).pipe(
                              tapErrorAndDefault('v2.lists.searchTokens.fillQuality', [], { count: part.length }),
                          ),
                      ),
                      { concurrency: 2 },
                  ).pipe(Effect.map(rows => rows.flat()))
                : [];

        const tombstonedRefs = new Set(
            mints.length > 0
                ? yield* listDeletedRefs({ refs: mints }).pipe(
                      tapErrorAndDefault('v2.lists.searchTokens.tombstones', [], { count: mints.length }),
                  )
                : [],
        );

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

        const curatedByMint = curatedListIdsByMint();

        // Live provider (Birdeye search) data was fetched seconds ago — a
        // candidate served from it without a cached market row is the
        // *freshest* data we have, not stale/unknown.
        const enrichedAtMs = Date.now();

        const candidates: EnrichedCandidate[] = raws.map(raw => {
            const market = marketByMint.get(raw.mint) ?? null;
            const registryMatch = getVariantByMint(raw.mint);
            const fillQuality = fillQualityByMint.get(raw.mint) ?? null;

            return {
                mint: raw.mint,
                symbol: market?.symbol ?? raw.symbol,
                name: market?.name ?? raw.name,
                decimals: market?.decimals ?? raw.decimals,
                logoURI: market?.logoURI ?? raw.logoURI,
                price: market?.price ?? raw.price,
                liquidityUsd: market?.liquidity ?? raw.liquidityUsd,
                volume24hUsd: market?.volume24hUSD ?? raw.volume24hUsd,
                marketCapUsd: market?.marketCap ?? raw.marketCapUsd,
                priceChange24hPercent: market?.priceChange24hPercent ?? raw.priceChange24hPercent,
                holderCount: market?.holder ?? raw.holderCount,
                // The asset-risk cache is not ported; holder-concentration and
                // cached risk grades are unknown here (score falls back to
                // computeMarketScore over the market fields above).
                top10HoldersPercent: null,
                tokenMintTime: raw.tokenMintTime,
                sources: Array.from(raw.sources.size > 0 ? raw.sources : new Set<CandidateSource>(['db'])),
                registry: registryMatch
                    ? {
                          assetId: registryMatch.asset.assetId,
                          // Derivative variants (LSTs, ETFs…) must not inherit the
                          // asset symbol — bSOL is not 'SOL' (see registryClaimedSymbol).
                          symbol: registryClaimedSymbol(registryMatch.variant, registryMatch.asset),
                          name: registryMatch.variant.name ?? registryMatch.asset.name ?? null,
                          kind: registryMatch.variant.kind ?? null,
                          trustTier: registryMatch.variant.trustTier ?? null,
                          curatedListIds: curatedByMint.get(raw.mint) ?? [],
                      }
                    : null,
                risk: null,
                fillQuality,
                tombstoned: tombstonedRefs.has(raw.mint.toLowerCase()) || tombstonedRefs.has(raw.mint),
                dataAsOf:
                    marketAsOfByMint.get(raw.mint) ??
                    (raw.sources.has('provider') && raw.price !== null ? enrichedAtMs : null),
            };
        });

        const sources: CandidateSourcesStatus = {
            provider: providerConfigured ? (providerResult.ok ? 'ok' : 'degraded') : 'disabled',
            db: dbResult.ok ? 'ok' : 'degraded',
            registry: 'ok',
        };

        return { candidates, sources };
    });
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}
