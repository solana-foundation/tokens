import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError, NotFoundError } from '@tokens/effect';
import { decodeUnknownOrBadRequest, SolanaAddress } from '@tokens/effect';
import { tapErrorAndDefault } from '@tokens/effect';
import { loadAdvisoriesOrEmpty } from '@/lib/advisories';
import { getByAssetId as cloudRunGetByAssetId } from '@/lib/cloudrun/assets';
import {
    assetVariantsGetByMint,
    assetVariantsListByAssetIds,
    listDeletedRefs,
    tokensGetByAddress,
    stockInstrumentsGetByAssetId,
    variantMarketsGetLatestByMints,
} from '@/lib/cloudrun';
import {
    buildCuratedMintRank,
    optionalSymbol,
    optionalText,
    pickPrimaryVariant,
    toFiniteNumberOrNull,
    withDerivedVariantTier,
    type TokenMarketSnapshot,
} from '../_asset-helpers';
import type { CanonicalAsset } from '@tokens/asset-registry';
import {
    getAsset,
    getAssetByCoingeckoId,
    getVariantByMint,
    resolveAlias as resolveRegistryAlias,
} from '@tokens/asset-registry';
import { canonicalizeAsset, canonicalizeAssetVariants } from '../_canonical-overrides';
import { resolveAssetRefContext, type AssetRefResolutionContext } from '../_resolve-asset-ref';
import { looksLikeSolanaMintAddress, mintToSingletonAssetId, singletonAssetIdToMint } from '../_singleton-asset-id';

function registryAssetFromRef(ref: string): CanonicalAsset | null {
    const trimmed = ref.trim();
    if (!trimmed) return null;

    if (looksLikeSolanaMintAddress(trimmed)) {
        return getVariantByMint(trimmed)?.asset ?? resolveRegistryAlias(trimmed) ?? getAsset(trimmed);
    }

    return getAssetByCoingeckoId(trimmed) ?? resolveRegistryAlias(trimmed) ?? getAsset(trimmed);
}

function normalizeDeletedRef(ref: string): string {
    return ref.trim().toLowerCase();
}

export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const deletedRefCache = new Map<string, boolean>();
            const isDeletedRef = (ref: string) =>
                Effect.gen(function* () {
                    const normalizedRef = normalizeDeletedRef(ref);
                    if (!normalizedRef) return false;

                    const cached = deletedRefCache.get(normalizedRef);
                    if (cached !== undefined) return cached;

                    const deletedRefs = yield* listDeletedRefs({ refs: [normalizedRef] }).pipe(Effect.catch(() => Effect.succeed([] as string[])));
                    const isDeleted = deletedRefs.includes(normalizedRef);
                    deletedRefCache.set(normalizedRef, isDeleted);
                    return isDeleted;
                });

            const url = new URL(request.url);
            const mintRaw = (url.searchParams.get('mint') ?? '').trim();
            const refRaw = (url.searchParams.get('ref') ?? '').trim();
            if (!mintRaw && !refRaw) {
                return yield* Effect.fail(new BadRequestError({ message: 'mint or ref is required' }));
            }

            // Every emitted `variant` carries `advisory` (null when none). Flagged
            // mints still resolve — the advisory travels with the variant.
            const advisoriesByMint = yield* loadAdvisoriesOrEmpty();
            const advisoryFor = (mint: string) => advisoriesByMint.get(mint) ?? null;

            const deletedRef = mintRaw || refRaw;
            if (deletedRef) {
                const isDeleted = yield* isDeletedRef(deletedRef);
                if (isDeleted) {
                    return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));
                }
            }

            function buildSingletonResponse(
                mint: string,
                meta: Pick<AssetRefResolutionContext, 'ref' | 'resolvedBy' | 'mint'> = {
                    ref: mint,
                    resolvedBy: 'singleton',
                    mint,
                },
            ) {
                const singletonAssetId = mintToSingletonAssetId(mint);
                return Effect.gen(function* () {
                    const token = yield* tokensGetByAddress({ address: mint }).pipe(tapErrorAndDefault('assets.resolve.singletonToken', null, { mint }));
                    const marketRows = yield* variantMarketsGetLatestByMints({ mints: [mint] }).pipe(tapErrorAndDefault('assets.resolve.singletonMarket', [], { mint }));
                    const market = marketRows[0]?.market ?? null;

                    const symbol = optionalSymbol(token?.symbol);
                    const name = optionalText(token?.name);

                    return {
                        assetId: singletonAssetId,
                        resolvedBy: meta.resolvedBy,
                        mint: meta.mint,
                        asset: {
                            assetId: singletonAssetId,
                            name,
                            symbol,
                            category: 'crypto' as const,
                            aliases: [mint],
                        },
                        variant: withDerivedVariantTier(
                            {
                                mint,
                                chain: 'solana',
                                kind: 'native' as const,
                                tags: [],
                                ...(symbol ? { label: symbol } : {}),
                                advisory: advisoryFor(mint),
                            },
                            market?.liquidity ?? null,
                        ),
                    };
                });
            }

            if (!mintRaw) {
                const resolved = yield* resolveAssetRefContext(refRaw, { deletedRefCache });

                const singletonMint = singletonAssetIdToMint(resolved.assetId);
                if (singletonMint) {
                    return yield* buildSingletonResponse(singletonMint, resolved);
                }

                const assetDoc = yield* cloudRunGetByAssetId({ assetId: resolved.assetId });
                if (!assetDoc) {
                    const registryAsset = registryAssetFromRef(resolved.assetId) ?? registryAssetFromRef(refRaw);
                    if (!registryAsset) {
                        return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));
                    }

                    const registryVariant = resolved.mint
                        ? (getVariantByMint(resolved.mint)?.variant ??
                          registryAsset.variants.find(v => v.mint === resolved.mint) ??
                          registryAsset.variants[0] ??
                          null)
                        : (registryAsset.variants[0] ?? null);

                    return {
                        assetId: registryAsset.assetId,
                        resolvedBy: resolved.resolvedBy,
                        mint: resolved.mint,
                        asset: {
                            assetId: registryAsset.assetId,
                            name: registryAsset.name ?? null,
                            symbol: registryAsset.symbol ?? null,
                            category: registryAsset.category,
                            aliases: registryAsset.aliases,
                        },
                        variant: registryVariant
                            ? {
                                  mint: registryVariant.mint,
                                  kind: registryVariant.kind,
                                  trustTier: registryVariant.trustTier,
                                  tags: registryVariant.tags,
                                  ...(registryVariant.issuer ? { issuer: registryVariant.issuer } : {}),
                                  ...(registryVariant.issuerUrl ? { issuerUrl: registryVariant.issuerUrl } : {}),
                                  ...(registryVariant.label ? { label: registryVariant.label } : {}),
                                  ...(registryVariant.stockVariantTier
                                      ? { stockVariantTier: registryVariant.stockVariantTier }
                                      : {}),
                              }
                            : null,
                    };
                }

                const stockInstrument =
                    assetDoc.category === 'equity'
                        ? yield* stockInstrumentsGetByAssetId({ assetId: assetDoc.assetId }).pipe(
                              tapErrorAndDefault('assets.resolve.stockInstrument', null, {
                                  assetId: assetDoc.assetId,
                              }),
                          )
                        : null;

                const variantsRows = yield* assetVariantsListByAssetIds({ assetIds: [assetDoc.assetId] });
                const variants = variantsRows[0]?.variants ?? [];

                const tokenByMint = new Map<string, TokenMarketSnapshot>();
                if (variants.length > 0) {
                    const mints: string[] = [];
                    for (const variant of variants) mints.push(variant.mint);
                    const rows = yield* variantMarketsGetLatestByMints({ mints });

                    const fallbackSymbol = (assetDoc.symbol ?? '').trim();
                    const fallbackName = (assetDoc.name ?? '').trim() || fallbackSymbol;

                    for (const row of rows) {
                        const market = row.market;
                        if (!market) continue;
                        const symbol = (market.symbol ?? fallbackSymbol).trim() || fallbackSymbol || '—';
                        const name = (market.name ?? fallbackName).trim() || fallbackName || symbol;
                        const decimals =
                            typeof market.decimals === 'number' && Number.isFinite(market.decimals)
                                ? market.decimals
                                : 9;
                        tokenByMint.set(row.mint, {
                            address: row.mint,
                            symbol: optionalSymbol(market.symbol) ?? optionalSymbol(symbol) ?? null,
                            name: optionalText(market.name) ?? optionalText(name) ?? null,
                            decimals: toFiniteNumberOrNull(market.decimals) ?? toFiniteNumberOrNull(decimals),
                            logoURI: optionalText(market.logoURI),
                            liquidity: toFiniteNumberOrNull(market.liquidity),
                            volume24hUSD: toFiniteNumberOrNull(market.volume24hUSD),
                            price: toFiniteNumberOrNull(market.price),
                            priceChange24hPercent: toFiniteNumberOrNull(market.priceChange24hPercent),
                            priceChange1hPercent: toFiniteNumberOrNull(market.priceChange1hPercent),
                            marketCap: toFiniteNumberOrNull(market.marketCap),
                            fdv: toFiniteNumberOrNull(market.fdv),
                            holder: toFiniteNumberOrNull(market.holder),
                            totalSupply: toFiniteNumberOrNull(market.totalSupply),
                            circulatingSupply: toFiniteNumberOrNull(market.circulatingSupply),
                        });
                    }
                }

                const mintRank = buildCuratedMintRank();
                const canonicalVariants: CanonicalAsset['variants'] = [];
                for (const variant of variants) {
                    const variantWithIdentity = variant as typeof variant & {
                        symbol?: string | null;
                        name?: string | null;
                    };
                    canonicalVariants.push({
                        variantId: variant.variantId,
                        mint: variant.mint,
                        kind: variant.kind,
                        trustTier: variant.trustTier,
                        tags: variant.tags,
                        ...(variant.issuer ? { issuer: variant.issuer } : {}),
                        ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
                        ...(variant.label ? { label: variant.label } : {}),
                        ...(variant.stockVariantTier ? { stockVariantTier: variant.stockVariantTier } : {}),
                        ...(variantWithIdentity.symbol ? { symbol: variantWithIdentity.symbol } : {}),
                        ...(variantWithIdentity.name ? { name: variantWithIdentity.name } : {}),
                    });
                }
                const canonicalVariantsFixed = canonicalizeAssetVariants(assetDoc.assetId, canonicalVariants);
                const canonical: CanonicalAsset = canonicalizeAsset({
                    assetId: assetDoc.assetId,
                    ...(assetDoc.name ? { name: assetDoc.name } : {}),
                    ...(assetDoc.symbol ? { symbol: assetDoc.symbol } : {}),
                    category: assetDoc.category,
                    aliases: assetDoc.aliases,
                    ...(assetDoc.coingeckoId ? { coingeckoId: assetDoc.coingeckoId } : {}),
                    variants: canonicalVariantsFixed,
                });

                const primary = pickPrimaryVariant(canonical, mintRank, tokenByMint);

                return {
                    assetId: assetDoc.assetId,
                    resolvedBy: resolved.resolvedBy,
                    mint: resolved.mint,
                    asset: {
                        assetId: assetDoc.assetId,
                        name: assetDoc.name ?? stockInstrument?.name,
                        symbol: stockInstrument?.symbol ?? assetDoc.symbol,
                        category: assetDoc.category,
                        aliases: assetDoc.aliases,
                    },
                    variant: primary
                        ? withDerivedVariantTier(
                              {
                                  mint: primary.mint,
                                  chain: 'solana',
                                  kind: primary.kind,
                                  tags: primary.tags,
                                  ...(primary.issuer ? { issuer: primary.issuer } : {}),
                                  ...(primary.issuerUrl ? { issuerUrl: primary.issuerUrl } : {}),
                                  ...(primary.label ? { label: primary.label } : {}),
                                  ...(primary.stockVariantTier ? { stockVariantTier: primary.stockVariantTier } : {}),
                                  ...(primary.symbol ? { symbol: primary.symbol } : {}),
                                  ...(primary.name ? { name: primary.name } : {}),
                                  advisory: advisoryFor(primary.mint),
                              },
                              tokenByMint.get(primary.mint)?.liquidity ?? null,
                          )
                        : null,
                };
            }

            const mint = yield* decodeUnknownOrBadRequest(SolanaAddress, mintRaw, 'Invalid mint');

            const variant = yield* assetVariantsGetByMint({ mint });
            if (!variant) {
                const registryMatch = getVariantByMint(mint);
                if (registryMatch) {
                    const registryDeleted = yield* isDeletedRef(registryMatch.asset.coingeckoId ?? registryMatch.asset.assetId);
                    if (!registryDeleted) {
                        return {
                            assetId: registryMatch.asset.assetId,
                            resolvedBy: 'mint' as const,
                            mint,
                            asset: {
                                assetId: registryMatch.asset.assetId,
                                name: registryMatch.asset.name ?? null,
                                symbol: registryMatch.asset.symbol ?? null,
                                category: registryMatch.asset.category,
                                aliases: registryMatch.asset.aliases,
                            },
                            variant: {
                                mint: registryMatch.variant.mint,
                                kind: registryMatch.variant.kind,
                                trustTier: registryMatch.variant.trustTier,
                                tags: registryMatch.variant.tags,
                                ...(registryMatch.variant.issuer ? { issuer: registryMatch.variant.issuer } : {}),
                                ...(registryMatch.variant.issuerUrl
                                    ? { issuerUrl: registryMatch.variant.issuerUrl }
                                    : {}),
                                ...(registryMatch.variant.label ? { label: registryMatch.variant.label } : {}),
                                ...(registryMatch.variant.stockVariantTier
                                    ? { stockVariantTier: registryMatch.variant.stockVariantTier }
                                    : {}),
                                advisory: advisoryFor(registryMatch.variant.mint),
                            },
                        };
                    }
                }
                return yield* buildSingletonResponse(mint, { ref: mint, resolvedBy: 'singleton', mint });
            }

            const assetDoc = yield* cloudRunGetByAssetId({ assetId: variant.assetId });
            if (!assetDoc) {
                return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));
            }

            if (looksLikeSolanaMintAddress(assetDoc.assetId)) {
                return yield* buildSingletonResponse(assetDoc.assetId);
            }

            const stockInstrument =
                assetDoc.category === 'equity'
                    ? yield* stockInstrumentsGetByAssetId({ assetId: assetDoc.assetId }).pipe(tapErrorAndDefault('assets.resolve.stockInstrument', null, { assetId: assetDoc.assetId }))
                    : null;

            const marketRows = yield* variantMarketsGetLatestByMints({ mints: [variant.mint] }).pipe(tapErrorAndDefault('assets.resolve.variantMarket', [], { mint: variant.mint }));
            const market = marketRows[0]?.market ?? null;
            const variantWithIdentity = variant as typeof variant & {
                symbol?: string | null;
                name?: string | null;
            };

            return {
                assetId: assetDoc.assetId,
                resolvedBy: 'mint' as const,
                mint,
                asset: {
                    assetId: assetDoc.assetId,
                    name: assetDoc.name ?? stockInstrument?.name,
                    symbol: stockInstrument?.symbol ?? assetDoc.symbol,
                    category: assetDoc.category,
                    aliases: assetDoc.aliases,
                },
                variant: withDerivedVariantTier(
                    {
                        mint: variant.mint,
                        chain: variant.chain,
                        kind: variant.kind,
                        tags: variant.tags,
                        ...(variant.issuer ? { issuer: variant.issuer } : {}),
                        ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
                        ...(variant.label ? { label: variant.label } : {}),
                        ...(variant.stockVariantTier ? { stockVariantTier: variant.stockVariantTier } : {}),
                        ...(variantWithIdentity.symbol ? { symbol: variantWithIdentity.symbol } : {}),
                        ...(variantWithIdentity.name ? { name: variantWithIdentity.name } : {}),
                        ...(!variantWithIdentity.symbol && market?.symbol ? { symbol: market.symbol } : {}),
                        ...(!variantWithIdentity.name && market?.name ? { name: market.name } : {}),
                        advisory: advisoryFor(variant.mint),
                    },
                    market?.liquidity ?? null,
                ),
            };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 120 } },
);
