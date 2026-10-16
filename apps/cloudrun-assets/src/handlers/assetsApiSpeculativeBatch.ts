/**
 * Speculative batch for apps/api multi-hop routes.
 *
 * Mirror of the apps/api resolve tree (`resolve/route.ts` +
 * `_resolve-asset-ref.ts`). Divergence = memo miss, never a different value.
 *
 * The route decides each Cloud Run call from the previous result, so from
 * Vercel it pays 4–9 sequential round-trips. This handler walks the same
 * decision tree here, in-process, calling the very same single-purpose
 * handler functions with the very same arg objects the route would send,
 * and returns every raw result as `{ name, args, result }`. apps/api keys a
 * request-scoped memo by (name, args) and its unchanged route code hits
 * the memo instead of the network.
 *
 * Rules that keep this safe:
 * - Only call existing handler functions; never compute a result here.
 * - Emit `args` with exactly the keys the route sends (no defaults like
 *   `includeInactive`), in the same shape (`{ mints: [...] }` in variant row
 *   order, unsliced — the handler slices internally).
 * - A step that throws ends the walk; what was gathered is still returned.
 * - A soft deadline bounds the walk so the batch never becomes the tail.
 * - Anything this handler cannot know (admin renames, live provider data)
 *   is simply not guessed: the route pays those calls as today.
 */

import { getVariantByMint, resolveAlias } from '@tokens/asset-registry';

import type { AssetsRepo } from './assets';
import { InvalidArgsError, getByAssetId, resolveAssetRefForApi } from './assets';
import {
    getByMint as assetVariantsGetByMint,
    listByAssetIds as assetVariantsListByAssetIds,
    type AssetVariantsRepo,
} from './assetVariants';
import { listDeletedRefs, type AssetDeletionTombstonesRepo } from './assetDeletionTombstones';
import { resolveRef as sanctumResolveRef, type SanctumLstsRepo } from './sanctumLsts';
import { getInstrumentByAssetId as stockInstrumentsGetByAssetId, type StockReadsRepo } from './stockReads';
import { getTokenByAddress as tokensGetByAddress, type TokensReadsRepo } from './tokensReads';
import { getLatestByMints as variantMarketsGetLatestByMints, type VariantMarketsRepo } from './variantMarkets';

export interface SpeculativeBatchDeps {
    assetsRepo: AssetsRepo;
    assetVariantsRepo: AssetVariantsRepo;
    deletionTombstonesRepo: AssetDeletionTombstonesRepo;
    sanctumLstsRepo: SanctumLstsRepo;
    stockReadsRepo: StockReadsRepo;
    tokensReadsRepo: TokensReadsRepo;
    variantMarketsRepo: VariantMarketsRepo;
    /** Clock injection for the deadline (tests). */
    now?: () => number;
}

export type SpeculativeBatchProfile = 'resolve';

export interface SpeculativeBatchArgs {
    profile: SpeculativeBatchProfile;
    ref?: string;
    mint?: string;
}

export interface SpeculativeBatchEntry {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
}

export interface SpeculativeBatchResult {
    entries: SpeculativeBatchEntry[];
}

/** Soft deadline, checked between steps. */
const DEADLINE_MS = 500;

// --- helpers mirrored from apps/api `_singleton-asset-id.ts` -----------------
const SINGLETON_ASSET_ID_PREFIX = 'solana-';

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

function parseArgs(raw: unknown): SpeculativeBatchArgs {
    if (typeof raw !== 'object' || raw === null) throw new InvalidArgsError('args must be an object');
    const a = raw as Record<string, unknown>;
    if (a.profile !== 'resolve') throw new InvalidArgsError('profile must be "resolve"');
    const ref = typeof a.ref === 'string' ? a.ref.trim() : '';
    const mint = typeof a.mint === 'string' ? a.mint.trim() : '';
    if (!ref && !mint) throw new InvalidArgsError('ref or mint is required');
    return { profile: 'resolve', ...(mint ? { mint } : {}), ...(ref ? { ref } : {}) };
}

class WalkEnded extends Error {}

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

    // The route memoises tombstone answers per request, so a ref it already
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

    const singletonReads = async (mint: string): Promise<void> => {
        // `buildSingletonResponse`: market snapshot, then `loadSingletonIdentity`
        // which always reads the tokens row first (provider metadata is live
        // and never guessed here).
        await step('variantMarketsGetLatestByMints', { mints: [mint] }, () =>
            variantMarketsGetLatestByMints(deps.variantMarketsRepo, { mints: [mint] }),
        );
        await step('tokensGetByAddress', { address: mint }, () =>
            tokensGetByAddress(deps.tokensReadsRepo, { address: mint }),
        );
    };

    const canonicalReads = async (assetId: string): Promise<void> => {
        const doc = await step('getByAssetId', { assetId }, () => getByAssetId(deps.assetsRepo, { assetId }));
        if (!doc) return; // route falls back to the registry without further calls
        if (doc.category === 'equity') {
            await step('stockInstrumentsGetByAssetId', { assetId: doc.assetId }, () =>
                stockInstrumentsGetByAssetId(deps.stockReadsRepo, { assetId: doc.assetId }),
            );
        }
        const rows = await step('assetVariantsListByAssetIds', { assetIds: [doc.assetId] }, () =>
            assetVariantsListByAssetIds(deps.assetVariantsRepo, { assetIds: [doc.assetId] }),
        );
        const variants = rows[0]?.variants ?? [];
        if (variants.length > 0) {
            const mints = variants.map(variant => variant.mint);
            await step('variantMarketsGetLatestByMints', { mints }, () =>
                variantMarketsGetLatestByMints(deps.variantMarketsRepo, { mints }),
            );
        }
    };

    /** `resolveKnownMintRef` in `_resolve-asset-ref.ts`: returns the asset id or a singleton mint. */
    const resolveKnownMint = async (mint: string): Promise<{ assetId: string } | { singletonMint: string }> => {
        const variant = await step('assetVariantsGetByMint', { mint }, () =>
            assetVariantsGetByMint(deps.assetVariantsRepo, { mint }),
        );
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
        const sanctum = await step('sanctumResolveRef', { ref: mint }, () =>
            sanctumResolveRef(deps.sanctumLstsRepo, { ref: mint }),
        );
        if (sanctum) return { assetId: 'solana' };
        return { singletonMint: mint };
    };

    try {
        if (args.mint) {
            // `resolve/route.ts` mint path.
            const mint = args.mint;
            if (await isDeleted(mint)) return { entries };
            if (!looksLikeSolanaMintAddress(mint)) return { entries }; // route 400s
            const variant = await step('assetVariantsGetByMint', { mint }, () =>
                assetVariantsGetByMint(deps.assetVariantsRepo, { mint }),
            );
            if (!variant) {
                const registryMatch = getVariantByMint(mint);
                if (registryMatch) {
                    const deleted = await isDeleted(registryMatch.asset.coingeckoId ?? registryMatch.asset.assetId);
                    if (!deleted) return { entries }; // registry-built response, no more calls
                }
                await singletonReads(mint);
                return { entries };
            }
            const doc = await step('getByAssetId', { assetId: variant.assetId }, () =>
                getByAssetId(deps.assetsRepo, { assetId: variant.assetId }),
            );
            if (!doc) return { entries };
            if (looksLikeSolanaMintAddress(doc.assetId)) {
                await singletonReads(doc.assetId);
                return { entries };
            }
            if (doc.category === 'equity') {
                await step('stockInstrumentsGetByAssetId', { assetId: doc.assetId }, () =>
                    stockInstrumentsGetByAssetId(deps.stockReadsRepo, { assetId: doc.assetId }),
                );
            }
            await step('variantMarketsGetLatestByMints', { mints: [variant.mint] }, () =>
                variantMarketsGetLatestByMints(deps.variantMarketsRepo, { mints: [variant.mint] }),
            );
            return { entries };
        }

        // `resolve/route.ts` ref path → `resolveAssetRefContext`.
        const ref = args.ref ?? '';
        if (await isDeleted(ref)) return { entries };

        let resolved: { assetId: string } | { singletonMint: string } | null = null;
        const singletonMint = singletonAssetIdToMint(ref);
        if (singletonMint) {
            resolved = await resolveKnownMint(singletonMint);
        } else if (looksLikeSolanaMintAddress(ref)) {
            resolved = await resolveKnownMint(ref);
        } else {
            const registry = resolveAlias(ref);
            if (registry) {
                if (await isDeleted(registry.coingeckoId ?? registry.assetId)) return { entries };
                resolved = looksLikeSolanaMintAddress(registry.assetId)
                    ? { singletonMint: registry.assetId }
                    : { assetId: registry.assetId }; // renames not applied (see above)
            } else {
                const sanctum = await step('sanctumResolveRef', { ref }, () =>
                    sanctumResolveRef(deps.sanctumLstsRepo, { ref }),
                );
                if (sanctum) {
                    resolved = { assetId: 'solana' };
                } else {
                    const result = await step('resolveAssetRefForApi', { ref }, () =>
                        resolveAssetRefForApi(deps.assetsRepo, { ref }),
                    );
                    if (!result) return { entries };
                    resolved = looksLikeSolanaMintAddress(result.assetId)
                        ? { singletonMint: result.assetId }
                        : { assetId: result.assetId };
                }
            }
        }

        if ('singletonMint' in resolved) await singletonReads(resolved.singletonMint);
        else await canonicalReads(resolved.assetId);
        return { entries };
    } catch (error) {
        if (error instanceof WalkEnded) return { entries };
        throw error;
    }
}
