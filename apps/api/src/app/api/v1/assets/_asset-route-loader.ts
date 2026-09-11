import { Effect } from 'effect';
import type { CanonicalAsset, VariantAdvisory } from '@tokens/asset-registry';

import { BadRequestError, NotFoundError } from '@tokens/effect';
import { decodeUnknownOrBadRequest, SolanaAddress } from '@tokens/effect';
import { annotateAssetAdvisories, loadAdvisoriesOrEmpty } from '@/lib/advisories';
import { loadAssetBaseForApi, type GetByAssetIdResult } from '@/lib/cloudrun';

// ponytail: cloud-run return type is unknown post-Convex; keep a nominal alias so
// callers get a stable shape name even though the fields are opaque.
type AssetDocLike = NonNullable<GetByAssetIdResult> extends never ? unknown : NonNullable<GetByAssetIdResult>;

import {
    buildCuratedMintRank,
    executionQualitySnapshotFromConvexFillQuality,
    pickPrimaryVariant,
    tokenMarketSnapshotFromConvexMarket,
    type TokenMarketSnapshot,
    type VariantExecutionQualitySnapshot,
} from './_asset-helpers';
import { resolveAssetRefContext, type AssetRefResolutionContext } from './_resolve-asset-ref';

export type LoadedToken = TokenMarketSnapshot;

export interface LoadedAssetVariantContext {
    assetId: string;
    assetRef: string;
    assetDoc: AssetDocLike;
    /** Variants carry `advisory` (annotated from the API-side advisory cache). */
    canonical: CanonicalAsset;
    /** Mint → active advisory for this request (empty when the cache was unavailable). */
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>;
    tokenByMint: Map<string, LoadedToken>;
    fillQualityByMint: Map<string, VariantExecutionQualitySnapshot>;
    primaryVariant: CanonicalAsset['variants'][number] | null;
    selectedMint: string;
    selectedVariant: CanonicalAsset['variants'][number];
    resolution: AssetRefResolutionContext;
}

export interface LoadAssetWithSelectedVariantOptions {
    request: Request;
    rawAssetId: string;
    mintParamName?: 'mint';
    requireMint?: boolean;
    loadTokens?: boolean;
}

// ponytail: cloud-run wrapper returns `unknown` post-Convex — the shape is enforced by
// the cloudrun-assets handler at runtime. Tighten if a caller needs a specific field.
type AssetVariantRow = {
    variantId: string;
    mint: string;
    kind: CanonicalAsset['variants'][number]['kind'];
    trustTier: CanonicalAsset['variants'][number]['trustTier'];
    tags: string[];
    issuer?: string;
    issuerUrl?: string;
    label?: string;
    stockVariantTier?: CanonicalAsset['variants'][number]['stockVariantTier'];
};

export function toCanonicalVariants(variants: AssetVariantRow[]): CanonicalAsset['variants'] {
    return variants.map(variant => ({
        variantId: variant.variantId,
        mint: variant.mint,
        kind: variant.kind,
        trustTier: variant.trustTier,
        tags: variant.tags,
        ...(variant.issuer ? { issuer: variant.issuer } : {}),
        ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
        ...(variant.label ? { label: variant.label } : {}),
        ...(variant.stockVariantTier ? { stockVariantTier: variant.stockVariantTier } : {}),
    }));
}

export function toCanonicalAsset(
    assetDoc: AssetDocLike,
    variants: CanonicalAsset['variants'],
): CanonicalAsset {
    return {
        assetId: assetDoc.assetId,
        ...(assetDoc.name ? { name: assetDoc.name } : {}),
        ...(assetDoc.symbol ? { symbol: assetDoc.symbol } : {}),
        category: assetDoc.category,
        aliases: assetDoc.aliases,
        ...(assetDoc.coingeckoId ? { coingeckoId: assetDoc.coingeckoId } : {}),
        variants,
    };
}

export function selectMintFromRequest(
    request: Request,
    canonical: CanonicalAsset,
    primaryVariant: CanonicalAsset['variants'][number] | null,
    options: { mintParamName?: 'mint'; requireMint?: boolean; defaultMint?: string | null } = {},
): Effect.Effect<
    { selectedMint: string; selectedVariant: CanonicalAsset['variants'][number] },
    BadRequestError | NotFoundError
> {
    return Effect.gen(function* () {
        const url = new URL(request.url);
        const mintParamName = options.mintParamName ?? 'mint';
        const requestedMintRaw = (url.searchParams.get(mintParamName) ?? '').trim();
        if (options.requireMint && requestedMintRaw.length === 0) {
            return yield* Effect.fail(
                new BadRequestError({
                    message: `\`${mintParamName}\` query parameter is required`,
                    details: { param: mintParamName },
                }),
            );
        }

        const defaultMint =
            options.defaultMint && canonical.variants.some(v => v.mint === options.defaultMint)
                ? options.defaultMint
                : null;
        const selectedMint =
            requestedMintRaw.length > 0
                ? yield* decodeUnknownOrBadRequest(SolanaAddress, requestedMintRaw, 'Invalid mint')
                : (defaultMint ?? primaryVariant?.mint ?? null);

        if (!selectedMint) {
            return yield* Effect.fail(
                new NotFoundError({ message: 'No primary variant available', resource: 'assetVariant' }),
            );
        }

        const selectedVariant = canonical.variants.find(v => v.mint === selectedMint) ?? null;
        if (!selectedVariant) {
            return yield* Effect.fail(
                new BadRequestError({
                    message: '`mint` must be a variant of this asset',
                    details: { mint: selectedMint },
                }),
            );
        }

        return { selectedMint, selectedVariant };
    });
}

export function loadAssetWithSelectedVariant(
    options: LoadAssetWithSelectedVariantOptions,
): Effect.Effect<LoadedAssetVariantContext, BadRequestError | NotFoundError | unknown> {
    return Effect.gen(function* () {
        const assetRef = (options.rawAssetId ?? '').trim();
        if (!assetRef) return yield* Effect.fail(new BadRequestError({ message: 'assetId is required' }));

        const resolution = yield* resolveAssetRefContext(assetRef);
        const assetId = resolution.assetId;
        const loaded = yield* loadAssetBaseForApi({
                assetId,
                includeVariants: true,
                includeVariantMarkets: options.loadTokens !== false,
                includeFillQuality: options.loadTokens !== false,
            });
        const assetDoc = loaded.asset;
        if (!assetDoc) return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));

        const variants = loaded.variants ?? [];
        if (variants.length === 0) {
            return yield* Effect.fail(
                new NotFoundError({ message: 'No variants available', resource: 'assetVariant' }),
            );
        }

        // ponytail: VariantApiResult.kind widens to `string` on the handler; the
        // canonical variant kind is a narrower union enforced downstream. Cast
        // once at the boundary rather than duplicating the union in the wrapper.
        // Annotate before primary selection so a flagged variant is skipped by
        // the ranking itself. Flagged mints are never a 404 here: the selected
        // variant simply carries its advisory.
        const advisoriesByMint = yield* loadAdvisoriesOrEmpty();
        const canonical = annotateAssetAdvisories(
            toCanonicalAsset(assetDoc, toCanonicalVariants(variants as AssetVariantRow[])),
            advisoriesByMint,
        );
        const tokenByMint = new Map<string, LoadedToken>();
        const fillQualityByMint = new Map<string, VariantExecutionQualitySnapshot>();
        if (options.loadTokens !== false) {
            for (const row of loaded.variantMarkets ?? []) {
                if (!row.market) continue;
                tokenByMint.set(row.mint, tokenMarketSnapshotFromConvexMarket(row.mint, row.market));
            }
            for (const row of loaded.fillQuality ?? []) {
                const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
                if (!snapshot) continue;
                fillQualityByMint.set(row.mint, snapshot);
            }
        }
        const primaryVariant = pickPrimaryVariant(canonical, buildCuratedMintRank(), tokenByMint, fillQualityByMint);
        const { selectedMint, selectedVariant } = yield* selectMintFromRequest(
            options.request,
            canonical,
            primaryVariant,
            {
                mintParamName: options.mintParamName,
                requireMint: options.requireMint,
                defaultMint: resolution.mint,
            },
        );

        return {
            assetId,
            assetRef,
            assetDoc,
            canonical,
            advisoriesByMint,
            tokenByMint,
            fillQualityByMint,
            primaryVariant,
            selectedMint,
            selectedVariant,
            resolution,
        };
    });
}
