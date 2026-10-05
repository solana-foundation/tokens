import { Effect } from 'effect';

import { NotFoundError, tapErrorAndDefault } from '@tokens/effect';
import {
    assetVariantsGetByMint,
    listDeletedRefs,
    resolveAssetRefForApi as cloudRunResolveAssetRefForApi,
    sanctumResolveRef,
} from '@/lib/cloudrun';
import { currentAssetId, loadAssetIdRenames } from '@/lib/asset-id-renames';
import { getVariantByMint, resolveAlias as resolveRegistryAlias } from '@tokens/asset-registry';
import { looksLikeSolanaMintAddress, mintToSingletonAssetId, singletonAssetIdToMint } from './_singleton-asset-id';

export type AssetRefResolvedBy = 'assetId' | 'alias' | 'mint' | 'singletonMint' | 'registry' | 'sanctum' | 'singleton';

export interface AssetRefResolutionContext {
    assetId: string;
    ref: string;
    resolvedBy: AssetRefResolvedBy;
    mint: string | null;
}

export interface AssetRefResolutionOptions {
    deletedRefCache?: Map<string, boolean>;
}

function resolution(args: {
    assetId: string;
    ref: string;
    resolvedBy: AssetRefResolvedBy;
    mint?: string | null;
}): AssetRefResolutionContext {
    return {
        assetId: args.assetId,
        ref: args.ref,
        resolvedBy: args.resolvedBy,
        mint: args.mint ?? null,
    };
}

function normalizeDeletedRef(ref: string): string {
    return ref.trim().toLowerCase();
}

function createDeletedRefChecker(cache: Map<string, boolean>) {
    return (ref: string) =>
        Effect.gen(function* () {
            const normalizedRef = normalizeDeletedRef(ref);
            if (!normalizedRef) return false;

            const cached = cache.get(normalizedRef);
            if (cached !== undefined) return cached;

            const deletedRefs = yield* listDeletedRefs({ refs: [normalizedRef] }).pipe(Effect.catch(() => Effect.succeed([] as string[])));
            const isDeleted = deletedRefs.includes(normalizedRef);
            cache.set(normalizedRef, isDeleted);
            return isDeleted;
        });
}

function resolveKnownMintRef(
    ref: string,
    mint: string,
    resolvedBy: 'mint' | 'singletonMint',
    isDeletedRef: ReturnType<typeof createDeletedRefChecker>,
) {
    return Effect.gen(function* () {
        const variant = yield* assetVariantsGetByMint({ mint }).pipe(
            Effect.catch(() => Effect.succeed(null)),
        );
        if (variant) {
            if (looksLikeSolanaMintAddress(variant.assetId)) {
                return resolution({
                    assetId: mintToSingletonAssetId(variant.assetId),
                    ref,
                    resolvedBy: 'singleton',
                    mint,
                });
            }
            return resolution({ assetId: variant.assetId, ref, resolvedBy, mint });
        }

        const registryMatch = getVariantByMint(mint);
        if (registryMatch) {
            const registryDeleted = yield* isDeletedRef(registryMatch.asset.coingeckoId ?? registryMatch.asset.assetId);
            if (!registryDeleted) {
                const renames = yield* loadAssetIdRenames();
                return resolution({
                    assetId: currentAssetId(renames, registryMatch.asset.assetId),
                    ref,
                    resolvedBy,
                    mint,
                });
            }
        }

        const sanctum = yield* sanctumResolveRef({ ref: mint }).pipe(
            tapErrorAndDefault('assets.resolve.sanctumMintRef', null, { ref, mint }),
        );
        if (sanctum) return resolution({ assetId: 'solana', ref, resolvedBy: 'sanctum', mint });

        return resolution({ assetId: mintToSingletonAssetId(mint), ref, resolvedBy: 'singleton', mint });
    });
}

export function resolveAssetRefContext(assetRef: string, options: AssetRefResolutionOptions = {}) {
    const ref = (assetRef ?? '').trim();
    if (!ref) {
        return Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));
    }

    const isDeletedRef = createDeletedRefChecker(options.deletedRefCache ?? new Map<string, boolean>());

    return isDeletedRef(ref).pipe(
        Effect.flatMap(isDeleted => {
            if (isDeleted) {
                return Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));
            }

            const singletonMint = singletonAssetIdToMint(ref);
            if (singletonMint) {
                return resolveKnownMintRef(ref, singletonMint, 'singletonMint', isDeletedRef);
            }

            if (looksLikeSolanaMintAddress(ref)) {
                return resolveKnownMintRef(ref, ref, 'mint', isDeletedRef);
            }

            // Fast path: registry is in-memory and resolves common asset refs synchronously.
            // The registry keeps an asset's original id; an admin may have renamed it in
            // the database since, so map the registry id to the asset's current id.
            const registry = resolveRegistryAlias(ref);
            if (registry) {
                return Effect.all([isDeletedRef(registry.coingeckoId ?? registry.assetId), loadAssetIdRenames()], {
                    concurrency: 'unbounded',
                }).pipe(
                    Effect.flatMap(([isRegistryDeleted, renames]) => {
                        if (isRegistryDeleted) {
                            return Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));
                        }
                        if (looksLikeSolanaMintAddress(registry.assetId)) {
                            return Effect.succeed(
                                resolution({
                                    assetId: mintToSingletonAssetId(registry.assetId),
                                    ref,
                                    resolvedBy: 'singleton',
                                    mint: registry.assetId,
                                }),
                            );
                        }
                        const assetId = currentAssetId(renames, registry.assetId);
                        return Effect.succeed(
                            resolution({
                                assetId,
                                ref,
                                resolvedBy: assetId === ref ? 'assetId' : 'registry',
                            }),
                        );
                    }),
                );
            }

            // Second: Sanctum-backed LST discovery (mint or symbol) should resolve to canonical `solana`.
            return sanctumResolveRef({ ref })
                .pipe(tapErrorAndDefault('assets.resolve.sanctumLstRef', null, { ref }))
                .pipe(
                    Effect.flatMap(sanctum => {
                        if (sanctum)
                            return Effect.succeed(resolution({ assetId: 'solana', ref, resolvedBy: 'sanctum' }));

                        // Finally: Convex-backed assets/aliases.
                        return cloudRunResolveAssetRefForApi({ ref }).pipe(
                            Effect.flatMap(result => {
                                if (result) {
                                    if (looksLikeSolanaMintAddress(result.assetId))
                                        return Effect.succeed(
                                            resolution({
                                                assetId: mintToSingletonAssetId(result.assetId),
                                                ref,
                                                resolvedBy: 'singleton',
                                                mint: result.assetId,
                                            }),
                                        );
                                    return Effect.succeed(
                                        resolution({
                                            assetId: result.assetId,
                                            ref,
                                            resolvedBy: result.resolvedBy,
                                            mint: result.mint ?? null,
                                        }),
                                    );
                                }
                                return Effect.fail(
                                    new NotFoundError({ message: 'Asset not found', resource: 'asset' }),
                                );
                            }),
                        );
                    }),
                );
        }),
    );
}

export function resolveAssetIdFromRef(assetRef: string) {
    return resolveAssetRefContext(assetRef).pipe(Effect.map(result => result.assetId));
}
