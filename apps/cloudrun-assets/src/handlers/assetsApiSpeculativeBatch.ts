/**
 * Speculative batch for apps/api multi-hop routes.
 *
 * Mirror of the apps/api decision trees:
 * - `resolve`      → `resolve/route.ts` + `_resolve-asset-ref.ts`
 * - `variants`     → `[assetId]/variants/route.ts`
 * - `detail`       → `[assetId]/route.ts` + `_load-variant-markets.ts` + `_singleton-identity.ts`
 * - `price-chart`  → `[assetId]/price-chart/route.ts`
 * Divergence = memo miss, never a different value.
 *
 * Those routes decide each Cloud Run call from the previous result, so from
 * Vercel they pay 4–9 sequential round-trips. This handler walks the same
 * decision tree here, in-process, calling the very same single-purpose
 * handler functions with the very same arg objects the route would send,
 * and returns every raw result as `{ name, args, result }`. apps/api keys a
 * request-scoped memo by (name, args) and its unchanged route code hits
 * the memo instead of the network.
 *
 * Rules that keep this safe:
 * - Only call existing handler functions; never compute a result here.
 * - Emit `args` with exactly the keys the route sends (no defaults like
 *   `includeInactive`), in the same shape (`{ mints: [...] }` in the route's
 *   order, chunked exactly as the route chunks).
 * - When the route makes the same call twice, emit it twice (entries are
 *   single-use on the API side).
 * - A step that throws ends the walk; what was gathered is still returned.
 * - A soft deadline bounds the walk so the batch never becomes the tail.
 * - Anything this handler cannot know (admin renames, Redis-backed coin-id
 *   searches, live provider data, filtered variant lists) is not guessed:
 *   the route pays those calls as today.
 */

import { getVariantByMint, resolveAlias } from '@tokens/asset-registry';

import type { AssetsRepo } from './assets';
import { InvalidArgsError, getByAssetId, resolveAssetRefForApi } from './assets';
import { getLatestByAssetId as assetMarketsGetLatestByAssetId, type AssetMarketsRepo } from './assetMarkets';
import { normalizeCoinGeckoCoinIdForAsset } from './assetsApiSearchPrefetch';
import {
    getByMint as assetVariantsGetByMint,
    getSolanaDefaultVariantsViewForApi,
    listByAssetIds as assetVariantsListByAssetIds,
    type AssetVariantsRepo,
} from './assetVariants';
import { listDeletedRefs, type AssetDeletionTombstonesRepo } from './assetDeletionTombstones';
import {
    getCoinById as coingeckoReadsGetCoinById,
    getPriceLatestByCoinId as coingeckoReadsGetPriceLatestByCoinId,
    type CoingeckoReadsRepo,
} from './coingeckoReads';
import { getLatestByMints as variantFillQualityGetLatestByMints, type FillQualityReadsRepo } from './fillQualityReads';
import { listActive as sanctumListActive, resolveRef as sanctumResolveRef, type SanctumLstsRepo } from './sanctumLsts';
import {
    getInstrumentByAssetId as stockInstrumentsGetByAssetId,
    getPriceLatestByAssetId as stockPricesGetLatestByAssetId,
    type StockReadsRepo,
} from './stockReads';
import {
    getTokenByAddress as tokensGetByAddress,
    getTokenMarketsLatestByMint as tokenMarketsGetLatestByMint,
    getTokenMarketsLatestByMints as tokenMarketsGetLatestByMints,
    getTopMarketsByMints as tokenMarketsGetTopMarketsByMints,
    type TokensReadsRepo,
} from './tokensReads';
import { getLatestByMints as variantMarketsGetLatestByMints, type VariantMarketsRepo } from './variantMarkets';

export interface SpeculativeBatchDeps {
    assetsRepo: AssetsRepo;
    assetVariantsRepo: AssetVariantsRepo;
    deletionTombstonesRepo: AssetDeletionTombstonesRepo;
    sanctumLstsRepo: SanctumLstsRepo;
    stockReadsRepo: StockReadsRepo;
    tokensReadsRepo: TokensReadsRepo;
    variantMarketsRepo: VariantMarketsRepo;
    fillQualityReadsRepo: FillQualityReadsRepo;
    assetMarketsRepo: AssetMarketsRepo;
    coingeckoReadsRepo: CoingeckoReadsRepo;
    /** Clock injection for the deadline (tests). */
    now?: () => number;
}

export type SpeculativeBatchProfile = 'resolve' | 'variants' | 'detail' | 'price-chart';

export interface SpeculativeBatchArgs {
    profile: SpeculativeBatchProfile;
    ref?: string;
    mint?: string;
    /** `variants`: any filter param changes the mint list, so stop after the variant rows. */
    hasFilters?: boolean;
}

export interface SpeculativeBatchEntry {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
}

export interface SpeculativeBatchResult {
    entries: SpeculativeBatchEntry[];
    /** Set when the walk stopped early: the failing step's name, or `deadline`. Diagnostic only. */
    endedBy?: string;
}

/** Soft deadline, checked between steps. */
const DEADLINE_MS = 500;
const PROFILES: ReadonlySet<string> = new Set(['resolve', 'variants', 'detail', 'price-chart']);

// --- mirrored apps/api constants ---------------------------------------------
const SINGLETON_ASSET_ID_PREFIX = 'solana-';
const VARIANT_MARKETS_CHUNK_SIZE = 250;
const TOKEN_MARKETS_CHUNK_SIZE = 50;
const DETAIL_MAX_FALLBACK_MINTS = 25;
const STOCK_PRICED_CATEGORIES: ReadonlySet<string> = new Set(['equity', 'commodity']);
/** `canonicalizeAssetVariants` rewrites this asset's variant list; not mirrored. */
const SUI_ASSET_ID = 'sui';
/** price-chart: assets whose chart prefers the on-chain fallback over CoinGecko. */
const ASSET_IDS_PREFERRING_ONCHAIN_CHART_FALLBACK: ReadonlySet<string> = new Set(['spacex']);

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function singletonAssetIdToMint(assetId: string): string | null {
    const trimmed = assetId.trim();
    if (!trimmed.startsWith(SINGLETON_ASSET_ID_PREFIX)) return null;
    const mint = trimmed.slice(SINGLETON_ASSET_ID_PREFIX.length).trim();
    return looksLikeSolanaMintAddress(mint) ? mint : null;
}

function lc(ref: string): string {
    return ref.trim().toLowerCase();
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function uniqueNonEmpty(items: readonly string[]): string[] {
    const seen = new Set<string>();
    for (const item of items) {
        const trimmed = item.trim();
        if (trimmed) seen.add(trimmed);
    }
    return Array.from(seen);
}

interface VariantLike {
    mint: string;
    kind?: string;
}

/**
 * Mirror of the routes' registry merge: DB variants keep their order, registry
 * variants already present stay in place, registry-only variants are appended.
 */
function mergedVariantMints(
    dbVariants: readonly VariantLike[],
    registryVariants: readonly VariantLike[] | null,
): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    for (const variant of dbVariants) {
        if (seen.has(variant.mint)) continue;
        seen.add(variant.mint);
        order.push(variant.mint);
    }
    for (const variant of registryVariants ?? []) {
        if (seen.has(variant.mint)) continue;
        seen.add(variant.mint);
        order.push(variant.mint);
    }
    return order;
}

/** Mirror of `_asset-helpers.ts` `matchRegistryAssetForDbAsset`. */
function matchRegistryAssetForDbAsset(args: {
    registryAsset: ReturnType<typeof resolveAlias>;
    assetId: string;
    coingeckoId: string | null;
    mints: readonly string[];
}): ReturnType<typeof resolveAlias> {
    const registryAsset = args.registryAsset ?? null;
    if (!registryAsset) return null;
    const assetId = args.assetId.trim();
    if (registryAsset.assetId === assetId) return registryAsset;
    const coingeckoId = (args.coingeckoId ?? '').trim();
    if (coingeckoId && registryAsset.coingeckoId === coingeckoId) return registryAsset;
    if (registryAsset.coingeckoId && registryAsset.coingeckoId === assetId) return registryAsset;
    const mints = new Set(args.mints.map(mint => mint.trim()).filter(Boolean));
    if (mints.size > 0 && registryAsset.variants.some(variant => mints.has(variant.mint))) return registryAsset;
    return null;
}

/** Mirror of `_load-variant-markets.ts`: a market row that still needs the DEX fallback. */
function lacksDisplayMeta(market: { symbol?: unknown; name?: unknown; decimals?: unknown } | null): boolean {
    if (!market) return true;
    const hasDisplayMeta =
        typeof market.symbol === 'string' &&
        market.symbol.trim() &&
        typeof market.name === 'string' &&
        market.name.trim() &&
        typeof market.decimals === 'number' &&
        Number.isFinite(market.decimals);
    return !hasDisplayMeta;
}

function parseArgs(raw: unknown): SpeculativeBatchArgs {
    if (typeof raw !== 'object' || raw === null) throw new InvalidArgsError('args must be an object');
    const a = raw as Record<string, unknown>;
    if (typeof a.profile !== 'string' || !PROFILES.has(a.profile)) {
        throw new InvalidArgsError('profile must be one of resolve, variants, detail, price-chart');
    }
    const ref = typeof a.ref === 'string' ? a.ref.trim() : '';
    const mint = typeof a.mint === 'string' ? a.mint.trim() : '';
    if (!ref && !mint) throw new InvalidArgsError('ref or mint is required');
    return {
        profile: a.profile as SpeculativeBatchProfile,
        ...(mint ? { mint } : {}),
        ...(ref ? { ref } : {}),
        ...(a.hasFilters === true ? { hasFilters: true } : {}),
    };
}

class WalkEnded extends Error {}

type Resolved = { assetId: string } | { singletonMint: string };

export async function assetsApiSpeculativeBatchForApi(
    deps: SpeculativeBatchDeps,
    rawArgs: unknown,
): Promise<SpeculativeBatchResult> {
    const args = parseArgs(rawArgs);
    const now = deps.now ?? Date.now;
    const startedAt = now();
    const entries: SpeculativeBatchEntry[] = [];

    /** Run one handler exactly as the route would; record it; end the walk on failure or deadline. */
    async function step<T>(name: string, stepArgs: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
        if (now() - startedAt > DEADLINE_MS) throw new WalkEnded('deadline');
        let result: T;
        try {
            result = await run();
        } catch {
            throw new WalkEnded(name);
        }
        entries.push({ name, args: stepArgs, result });
        return result;
    }

    // --- the single-purpose calls, with the exact args the routes send -------
    const reads = {
        variantMarkets: (mints: string[]) =>
            step('variantMarketsGetLatestByMints', { mints }, () =>
                variantMarketsGetLatestByMints(deps.variantMarketsRepo, { mints }),
            ),
        fillQuality: (mints: string[]) =>
            step('variantFillQualityGetLatestByMints', { mints }, () =>
                variantFillQualityGetLatestByMints(deps.fillQualityReadsRepo, { mints }),
            ),
        tokenByAddress: (address: string) =>
            step('tokensGetByAddress', { address }, () => tokensGetByAddress(deps.tokensReadsRepo, { address })),
        tokenMarketsByMint: (mint: string) =>
            step('tokenMarketsGetLatestByMint', { mint }, () =>
                tokenMarketsGetLatestByMint(deps.tokensReadsRepo, { mint }),
            ),
        tokenMarketsByMints: (mints: string[]) =>
            step('tokenMarketsGetLatestByMints', { mints }, () =>
                tokenMarketsGetLatestByMints(deps.tokensReadsRepo, { mints }),
            ),
        topMarketsByMints: (mints: string[]) =>
            step('tokenMarketsGetTopMarketsByMints', { mints }, () =>
                tokenMarketsGetTopMarketsByMints(deps.tokensReadsRepo, { mints }),
            ),
        assetById: (assetId: string) =>
            step('getByAssetId', { assetId }, () => getByAssetId(deps.assetsRepo, { assetId })),
        variantsByAssetIds: (assetIds: string[]) =>
            step('assetVariantsListByAssetIds', { assetIds }, () =>
                assetVariantsListByAssetIds(deps.assetVariantsRepo, { assetIds }),
            ),
        variantByMint: (mint: string) =>
            step('assetVariantsGetByMint', { mint }, () => assetVariantsGetByMint(deps.assetVariantsRepo, { mint })),
        stockInstrument: (assetId: string) =>
            step('stockInstrumentsGetByAssetId', { assetId }, () =>
                stockInstrumentsGetByAssetId(deps.stockReadsRepo, { assetId }),
            ),
        stockPrice: (assetId: string) =>
            step('stockPricesGetLatestByAssetId', { assetId }, () =>
                stockPricesGetLatestByAssetId(deps.stockReadsRepo, { assetId }),
            ),
        assetMarket: (assetId: string) =>
            step('assetMarketsGetLatestByAssetId', { assetId }, () =>
                assetMarketsGetLatestByAssetId(deps.assetMarketsRepo, { assetId }),
            ),
        coinById: (id: string) =>
            step('coingeckoReadsGetCoinById', { id }, () => coingeckoReadsGetCoinById(deps.coingeckoReadsRepo, { id })),
        coinPrice: (coinId: string) =>
            step('coingeckoReadsGetPriceLatestByCoinId', { coinId }, () =>
                coingeckoReadsGetPriceLatestByCoinId(deps.coingeckoReadsRepo, { coinId }),
            ),
        sanctumActive: () =>
            step('sanctumListActive', { limit: 5000 }, () => sanctumListActive(deps.sanctumLstsRepo, { limit: 5000 })),
        sanctumResolve: (ref: string) =>
            step('sanctumResolveRef', { ref }, () => sanctumResolveRef(deps.sanctumLstsRepo, { ref })),
        resolveRefForApi: (ref: string) =>
            step('resolveAssetRefForApi', { ref }, () => resolveAssetRefForApi(deps.assetsRepo, { ref })),
        solanaDefaultView: () =>
            step('assetVariantsGetSolanaDefaultVariantsViewForApi', {}, () =>
                getSolanaDefaultVariantsViewForApi(deps.assetVariantsRepo, {}),
            ),
    };

    // The routes memoise tombstone answers per request, so a ref they already
    // checked never produces a second call; mirror that here.
    const deletedByRef = new Map<string, boolean>();
    const isDeleted = async (ref: string): Promise<boolean> => {
        const normalized = lc(ref);
        if (!normalized) return false;
        const known = deletedByRef.get(normalized);
        if (known !== undefined) return known;
        const rows = await step('listDeletedRefs', { refs: [normalized] }, () =>
            listDeletedRefs(deps.deletionTombstonesRepo, { refs: [normalized] }),
        );
        const deleted = rows.includes(normalized);
        deletedByRef.set(normalized, deleted);
        return deleted;
    };

    /** `resolveKnownMintRef` in `_resolve-asset-ref.ts`. */
    const resolveKnownMint = async (mint: string): Promise<Resolved> => {
        const variant = await reads.variantByMint(mint);
        if (variant) {
            if (looksLikeSolanaMintAddress(variant.assetId)) return { singletonMint: variant.assetId };
            return { assetId: variant.assetId };
        }
        const registryMatch = getVariantByMint(mint);
        if (registryMatch) {
            const deleted = await isDeleted(registryMatch.asset.coingeckoId ?? registryMatch.asset.assetId);
            // The route maps this through admin renames, which we do not
            // know here; a renamed asset simply misses the memo.
            if (!deleted) return { assetId: registryMatch.asset.assetId };
        }
        const sanctum = await reads.sanctumResolve(mint);
        if (sanctum) return { assetId: 'solana' };
        return { singletonMint: mint };
    };

    /** `resolveAssetRefContext` in `_resolve-asset-ref.ts`; `null` = the route 404s. */
    const walkResolveRef = async (ref: string): Promise<Resolved | null> => {
        if (await isDeleted(ref)) return null;
        const singletonMint = singletonAssetIdToMint(ref);
        if (singletonMint) return resolveKnownMint(singletonMint);
        if (looksLikeSolanaMintAddress(ref)) return resolveKnownMint(ref);
        const registry = resolveAlias(ref);
        if (registry) {
            if (await isDeleted(registry.coingeckoId ?? registry.assetId)) return null;
            return looksLikeSolanaMintAddress(registry.assetId)
                ? { singletonMint: registry.assetId }
                : { assetId: registry.assetId }; // renames not applied (see above)
        }
        const sanctum = await reads.sanctumResolve(ref);
        if (sanctum) return { assetId: 'solana' };
        const result = await reads.resolveRefForApi(ref);
        if (!result) return null;
        return looksLikeSolanaMintAddress(result.assetId)
            ? { singletonMint: result.assetId }
            : { assetId: result.assetId };
    };

    // --- profiles -------------------------------------------------------------

    /** `resolve/route.ts`. */
    const walkResolve = async (): Promise<void> => {
        const singletonReads = async (mint: string): Promise<void> => {
            // `buildSingletonResponse`: market snapshot, then `loadSingletonIdentity`
            // which always reads the tokens row first (provider metadata is live
            // and never guessed here).
            await reads.variantMarkets([mint]);
            await reads.tokenByAddress(mint);
        };

        if (args.mint) {
            const mint = args.mint;
            if (await isDeleted(mint)) return;
            if (!looksLikeSolanaMintAddress(mint)) return; // route 400s
            const variant = await reads.variantByMint(mint);
            if (!variant) {
                const registryMatch = getVariantByMint(mint);
                if (registryMatch) {
                    const deleted = await isDeleted(registryMatch.asset.coingeckoId ?? registryMatch.asset.assetId);
                    if (!deleted) return; // registry-built response, no more calls
                }
                await singletonReads(mint);
                return;
            }
            const doc = await reads.assetById(variant.assetId);
            if (!doc) return;
            if (looksLikeSolanaMintAddress(doc.assetId)) {
                await singletonReads(doc.assetId);
                return;
            }
            if (doc.category === 'equity') await reads.stockInstrument(doc.assetId);
            await reads.variantMarkets([variant.mint]);
            return;
        }

        const resolved = await walkResolveRef(args.ref ?? '');
        if (!resolved) return;
        if ('singletonMint' in resolved) {
            await singletonReads(resolved.singletonMint);
            return;
        }
        const doc = await reads.assetById(resolved.assetId);
        if (!doc) return; // route falls back to the registry without further calls
        if (doc.category === 'equity') await reads.stockInstrument(doc.assetId);
        const rows = await reads.variantsByAssetIds([doc.assetId]);
        const variants = rows[0]?.variants ?? [];
        if (variants.length > 0) await reads.variantMarkets(variants.map(variant => variant.mint));
    };

    /** `[assetId]/variants/route.ts`. */
    const walkVariants = async (): Promise<void> => {
        const resolved = await walkResolveRef(args.ref ?? '');
        if (!resolved) return;

        if ('singletonMint' in resolved) {
            const mint = resolved.singletonMint;
            await reads.variantMarkets([mint]);
            await reads.tokenMarketsByMint(mint);
            await reads.tokenByAddress(mint);
            await reads.fillQuality([mint]);
            return;
        }

        const assetId = resolved.assetId;
        if (assetId === 'solana') {
            // Filters route to `listSolanaVariantsForApi` with request-specific
            // args; only the unfiltered default view is pre-answered.
            if (args.hasFilters) return;
            const view = await reads.solanaDefaultView();
            if (!view) return;
            const mints = uniqueNonEmpty((view.variants as Array<{ mint: string }>).map(variant => variant.mint));
            for (const part of chunk(mints, 250)) await reads.fillQuality(part);
            return;
        }

        const registryAsset = resolveAlias(assetId);
        const doc = await reads.assetById(assetId);
        let dbVariants: VariantLike[] = [];
        if (registryAsset) {
            const rows = await reads.variantsByAssetIds([registryAsset.assetId]);
            dbVariants = doc ? (rows[0]?.variants ?? []) : [];
        } else if (doc) {
            const rows = await reads.variantsByAssetIds([doc.assetId]);
            dbVariants = rows[0]?.variants ?? [];
        }
        if (args.hasFilters) return;

        const registryVariants = registryAsset && registryAsset.variants.length > 0 ? registryAsset.variants : null;
        const outAssetId = doc?.assetId ?? registryAsset?.assetId ?? assetId;
        if (outAssetId === SUI_ASSET_ID) return;

        // Kind per mint, for the solana yield pre-cap below (DB wins, registry fills).
        const kindByMint = new Map<string, string | undefined>();
        for (const variant of registryVariants ?? []) kindByMint.set(variant.mint, variant.kind);
        for (const variant of dbVariants) kindByMint.set(variant.mint, variant.kind);
        const allMints = mergedVariantMints(dbVariants, registryVariants);
        if (allMints.length === 0) return;

        const marketRows = (
            await Promise.all(chunk(allMints, VARIANT_MARKETS_CHUNK_SIZE).map(part => reads.variantMarkets(part)))
        ).flat();
        const fillMints = uniqueNonEmpty(allMints);
        for (const part of chunk(fillMints, 250)) await reads.fillQuality(part);

        // `toVariant`: a variant has no market when the row is missing or its
        // `lastFetchedAt` is not a positive number.
        const hasMarket = new Set<string>();
        for (const row of marketRows) {
            const market = row.market as { lastFetchedAt?: unknown } | null;
            if (
                market &&
                typeof market.lastFetchedAt === 'number' &&
                Number.isFinite(market.lastFetchedAt) &&
                market.lastFetchedAt > 0
            ) {
                hasMarket.add(row.mint);
            }
        }
        const precapSolanaYield = outAssetId === 'solana';
        const missing = allMints.filter(
            mint => !hasMarket.has(mint) && (!precapSolanaYield || kindByMint.get(mint) === 'yield'),
        );
        const uniqueMissing = uniqueNonEmpty(missing);
        await Promise.all(chunk(uniqueMissing, TOKEN_MARKETS_CHUNK_SIZE).map(part => reads.topMarketsByMints(part)));
    };

    /** `_load-variant-markets.ts` `loadVariantMarkets`. */
    const loadVariantMarkets = async (mints: string[]): Promise<void> => {
        if (mints.length === 0) return;
        const rows = await reads.variantMarkets(mints);
        const missing: string[] = [];
        for (const row of rows) {
            if (lacksDisplayMeta(row.market as { symbol?: unknown; name?: unknown; decimals?: unknown } | null)) {
                missing.push(row.mint);
            }
        }
        const uniqueMissing = uniqueNonEmpty(missing).slice(0, DETAIL_MAX_FALLBACK_MINTS);
        if (uniqueMissing.length === 0) return;
        await reads.tokenMarketsByMints(uniqueMissing);
    };

    /** `[assetId]/route.ts`. */
    const walkDetail = async (): Promise<void> => {
        const resolved = await walkResolveRef(args.ref ?? '');
        if (!resolved) return;
        const assetId =
            'singletonMint' in resolved ? `${SINGLETON_ASSET_ID_PREFIX}${resolved.singletonMint}` : resolved.assetId;

        const doc = await reads.assetById(assetId);
        let category: string;
        let canonicalAssetId: string;
        let mints: string[];
        let coingeckoId: string | null = null;

        if (!doc) {
            const singletonMint = singletonAssetIdToMint(assetId);
            if (singletonMint) {
                // `loadSingletonIdentity`: tokens row, then the market snapshot
                // only when the row gives no identity; provider metadata is live.
                const token = await reads.tokenByAddress(singletonMint);
                const hasIdentity =
                    !!token &&
                    ((typeof token.symbol === 'string' && token.symbol.trim() !== '') ||
                        (typeof token.name === 'string' && token.name.trim() !== ''));
                if (!hasIdentity) await reads.variantMarkets([singletonMint]);
                category = 'crypto';
                canonicalAssetId = assetId;
                mints = [singletonMint];
            } else {
                const registryAsset = resolveAlias(assetId);
                if (!registryAsset) return; // route 404s
                category = registryAsset.category;
                canonicalAssetId = registryAsset.assetId;
                coingeckoId = registryAsset.coingeckoId ?? null;
                mints = registryAsset.variants.map(variant => variant.mint);
            }
        } else {
            coingeckoId = (doc.coingeckoId ?? '').trim() || null;
            const rows = await reads.variantsByAssetIds([doc.assetId]);
            const dbVariants = rows[0]?.variants ?? [];
            const registryAsset = matchRegistryAssetForDbAsset({
                registryAsset: resolveAlias(doc.assetId) ?? (coingeckoId ? resolveAlias(coingeckoId) : null),
                assetId: doc.assetId,
                coingeckoId,
                mints: dbVariants.map(variant => variant.mint),
            });
            const registryName = (registryAsset?.name ?? '').trim() || null;
            const registrySymbol = (registryAsset?.symbol ?? '').trim() || null;
            if (coingeckoId && (!registryName || !registrySymbol)) await reads.coinById(coingeckoId);
            if (doc.assetId === SUI_ASSET_ID) return;
            category = doc.category;
            canonicalAssetId = doc.assetId;
            mints = mergedVariantMints(dbVariants, registryAsset?.variants ?? null);
        }

        await loadVariantMarkets(mints);

        // The concurrent batch that follows the canonical asset.
        const [, , instrument] = await Promise.all([
            reads.fillQuality(mints),
            reads.assetMarket(canonicalAssetId),
            STOCK_PRICED_CATEGORIES.has(category) ? reads.stockInstrument(canonicalAssetId) : Promise.resolve(null),
            canonicalAssetId === 'solana' ? reads.sanctumActive() : Promise.resolve(null),
        ]);

        if (instrument) {
            await reads.stockPrice(canonicalAssetId);
            return;
        }
        // Equity / ETF without a coin id resolve it through a Redis-backed
        // search we cannot see; everything else uses the normalised id.
        const coinId = normalizeCoinGeckoCoinIdForAsset({ assetId: canonicalAssetId, coinId: coingeckoId });
        if (coinId) await reads.coinPrice(coinId);
    };

    /** `[assetId]/price-chart/route.ts`. */
    const walkPriceChart = async (): Promise<void> => {
        const resolved = await walkResolveRef(args.ref ?? '');
        if (!resolved) return;
        const assetId =
            'singletonMint' in resolved ? `${SINGLETON_ASSET_ID_PREFIX}${resolved.singletonMint}` : resolved.assetId;

        const doc = await reads.assetById(assetId);
        let category: string;
        let canonicalAssetId: string;
        let coingeckoId: string | null;
        let variants: Array<{ mint: string; stockVariantTier?: string }>;

        if (doc) {
            const rows = await reads.variantsByAssetIds([doc.assetId]);
            const dbVariants = rows[0]?.variants ?? [];
            const registryAsset = resolveAlias(doc.assetId);
            const tierByMint = new Map<string, string | undefined>();
            for (const variant of registryAsset?.variants ?? []) tierByMint.set(variant.mint, variant.stockVariantTier);
            for (const variant of dbVariants) {
                tierByMint.set(variant.mint, variant.stockVariantTier ?? tierByMint.get(variant.mint));
            }
            category = doc.category;
            canonicalAssetId = doc.assetId;
            coingeckoId = doc.coingeckoId ?? null;
            variants = mergedVariantMints(dbVariants, registryAsset?.variants ?? null).map(mint => ({
                mint,
                ...(tierByMint.get(mint) ? { stockVariantTier: tierByMint.get(mint) } : {}),
            }));
        } else {
            const singletonMint = singletonAssetIdToMint(assetId);
            if (singletonMint) {
                const token = await reads.tokenByAddress(singletonMint);
                if (!token) return; // route 404s
                category = 'crypto';
                canonicalAssetId = assetId;
                coingeckoId = null;
                variants = [{ mint: singletonMint }];
            } else {
                const registryAsset = resolveAlias(assetId);
                if (!registryAsset) return; // route 404s
                category = registryAsset.category;
                canonicalAssetId = registryAsset.assetId;
                coingeckoId = registryAsset.coingeckoId ?? null;
                variants = registryAsset.variants.map(variant => ({
                    mint: variant.mint,
                    ...(variant.stockVariantTier ? { stockVariantTier: variant.stockVariantTier } : {}),
                }));
            }
        }

        if (STOCK_PRICED_CATEGORIES.has(category)) {
            // The stock chart usually answers from here; the on-chain fallback
            // below only runs when it has no candles, which we cannot know.
            await reads.stockInstrument(canonicalAssetId);
            return;
        }
        if (!ASSET_IDS_PREFERRING_ONCHAIN_CHART_FALLBACK.has(canonicalAssetId)) {
            const coinId = normalizeCoinGeckoCoinIdForAsset({ assetId: canonicalAssetId, coinId: coingeckoId });
            // A coin id (or an equity/ETF Redis-backed lookup) takes the CoinGecko
            // chart; its OHLCV args carry the request's time range, not mirrored.
            if (coinId || category === 'equity' || category === 'etf') return;
        }

        const fallbackVariants = ASSET_IDS_PREFERRING_ONCHAIN_CHART_FALLBACK.has(canonicalAssetId)
            ? (() => {
                  const redeemable = variants.filter(
                      variant =>
                          variant.stockVariantTier === 'share_redeemable' ||
                          variant.stockVariantTier === 'cash_redeemable',
                  );
                  return redeemable.length > 0 ? redeemable : variants;
              })()
            : variants;
        const mints = uniqueNonEmpty(fallbackVariants.map(variant => variant.mint));
        if (mints.length > 0) await reads.variantMarkets(mints);
    };

    try {
        switch (args.profile) {
            case 'resolve':
                await walkResolve();
                break;
            case 'variants':
                await walkVariants();
                break;
            case 'detail':
                await walkDetail();
                break;
            case 'price-chart':
                await walkPriceChart();
                break;
        }
        return { entries };
    } catch (error) {
        if (error instanceof WalkEnded) return { entries, endedBy: error.message };
        throw error;
    }
}
