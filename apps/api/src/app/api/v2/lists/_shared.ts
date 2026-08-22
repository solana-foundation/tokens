import { Effect } from 'effect';

import { BadRequestError, ForbiddenError, NotFoundError, tapErrorAndDefault } from '@tokens/effect';
import {
    assetCollectionsGetSummaries,
    variantMarketsGetLatestByMints,
    type AssetCollectionSummary,
    type TokenListMember,
    type TokenListMutationErrorCode,
    type TokenListMutationOutcome,
    type VariantMarketsGetLatestByMintsResult,
} from '@/lib/cloudrun';
import { getVariantByMint } from '@tokens/asset-registry';
import {
    CURATED_LIST_ORDER,
    getCuratedTokenAddresses,
    getCuratedTokenList,
    normalizeCuratedTokenListId,
    type CuratedTokenListId,
} from '@tokens/asset-registry/compat';
import { registryClaimedSymbol } from '@/lib/judgment/protected-symbols';
import { getProviderTokenMetadataByMints, type ProviderTokenMetadata } from '@/lib/birdeye-search';
import { getEffectiveCuratedAddresses } from '../../_curated-addresses';

/**
 * Shared shapes + helpers for the /api/v2/lists surface. Curated lists and
 * community lists present as one "lists" concept here: curated ids are just
 * the first lists, owned by the Solana Foundation.
 */

export const CURATED_OWNER = { name: 'Solana Foundation' } as const;
const PUBLIC_API_ORIGIN = 'https://api.tokens.xyz';

export interface V2ListSummary {
    slug: string;
    name: string;
    description: string | null;
    curated: boolean;
    owner: { name: string } | { projectId: string };
    tokenCount: number;
    updatedAt: number | null;
}

export interface V2ListToken {
    mint: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    logoURI: string | null;
    verified: boolean;
    rank: number;
    note?: string;
    addedAt?: number;
}

export function normalizeCuratedSlug(slug: string): CuratedTokenListId | null {
    return normalizeCuratedTokenListId(slug);
}

/**
 * Summaries for every curated list. Counts use the exact effective mint set
 * shown by the detail table (compiled registry + admin additions, with the
 * dynamic LST view where applicable), not canonical collection row counts.
 */
export function curatedListSummaries(): Effect.Effect<V2ListSummary[], never> {
    return Effect.gen(function* () {
        const dbSummaries = yield* assetCollectionsGetSummaries({ slugs: [...CURATED_LIST_ORDER] }).pipe(
            tapErrorAndDefault('v2.lists.curatedSummaries', null as AssetCollectionSummary[] | null),
        );
        const dbBySlug = new Map((dbSummaries ?? []).map(summary => [summary.slug, summary] as const));
        const effectiveCounts = yield* Effect.all(
            CURATED_LIST_ORDER.map(id => {
                const staticAddresses = getCuratedTokenAddresses(getCuratedTokenList(id));
                return Effect.tryPromise(() => getEffectiveCuratedAddresses(id)).pipe(
                    tapErrorAndDefault(
                        'v2.lists.curatedSummaryMints',
                        { addresses: staticAddresses, sanctumLstMints: new Set<string>() },
                        { listId: id },
                    ),
                    Effect.map(({ addresses }) => [id, addresses.length] as const),
                );
            }),
            { concurrency: 3 },
        );
        const countBySlug = new Map(effectiveCounts);

        return CURATED_LIST_ORDER.map(id => {
            const list = getCuratedTokenList(id);
            const db = dbBySlug.get(id);
            return {
                slug: id,
                name: list.name.trim() || id,
                description: list.description.trim() || null,
                curated: true,
                owner: CURATED_OWNER,
                tokenCount: countBySlug.get(id) ?? getCuratedTokenAddresses(list).length,
                updatedAt: db?.lastAddedAt ?? null,
            };
        });
    });
}

/** Compiled-registry metadata fallback — zero-RPC, covers registry-known mints
 * when the tokens index has no row (fresh environments, degraded reads). */
function registryMeta(mint: string): { symbol: string | null; name: string | null } {
    const match = getVariantByMint(mint);
    if (!match) return { symbol: null, name: null };
    return {
        symbol: registryClaimedSymbol(match.variant, match.asset),
        name: match.variant.name ?? match.asset.name ?? null,
    };
}

/** Keep provider images mint-specific while making rare local mint fallbacks portable. */
function normalizeLogoURI(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    if (!normalized) return null;
    return normalized.startsWith('/') ? `${PUBLIC_API_ORIGIN}${normalized}` : normalized;
}

type MintMarket = NonNullable<VariantMarketsGetLatestByMintsResult[number]['market']>;

/**
 * The Cloud Run query caps requests at 250 mints. Chunk here so large curated
 * lists still receive the Birdeye-first identity snapshot for every row.
 */
function loadMintMarkets(mints: string[], operation: string): Effect.Effect<Map<string, MintMarket>, never> {
    return Effect.gen(function* () {
        const batches = yield* Effect.all(
            Array.from({ length: Math.ceil(mints.length / 250) }, (_, index) =>
                mints.slice(index * 250, (index + 1) * 250),
            ).map(chunk =>
                variantMarketsGetLatestByMints({ mints: chunk }).pipe(
                    tapErrorAndDefault(operation, [] as VariantMarketsGetLatestByMintsResult, {
                        count: chunk.length,
                    }),
                ),
            ),
            { concurrency: 3 },
        );
        const byMint = new Map<string, MintMarket>();
        for (const row of batches.flat()) {
            if (row.market) byMint.set(row.mint, row.market);
        }
        return byMint;
    });
}

/** Fill only missing cached images from Birdeye's exact-mint metadata endpoint. */
function loadMissingMintMetadata(
    mints: string[],
    markets: Map<string, MintMarket>,
    operation: string,
): Effect.Effect<Map<string, ProviderTokenMetadata>, never> {
    return Effect.gen(function* () {
        const missing = mints.filter(mint => !markets.get(mint)?.logoURI?.trim());
        const chunks = Array.from({ length: Math.ceil(missing.length / 50) }, (_, index) =>
            missing.slice(index * 50, (index + 1) * 50),
        );
        const batches = yield* Effect.all(
            chunks.map(chunk =>
                getProviderTokenMetadataByMints(chunk).pipe(
                    tapErrorAndDefault(operation, [] as ProviderTokenMetadata[], { count: chunk.length }),
                ),
            ),
            { concurrency: 2 },
        );
        return new Map(batches.flat().map(metadata => [metadata.address, metadata] as const));
    });
}

/**
 * Batch-hydrate mints from Birdeye-first market snapshots, falling back to
 * per-member snapshots and then compiled registry text metadata.
 */
export function hydrateCommunityMembers(members: TokenListMember[]): Effect.Effect<V2ListToken[], never> {
    return Effect.gen(function* () {
        const byMint = yield* loadMintMarkets(
            members.map(member => member.mint),
            'v2.lists.hydrateMembers',
        );
        const providerByMint = yield* loadMissingMintMetadata(
            members.map(member => member.mint),
            byMint,
            'v2.lists.hydrateMembers.metadata',
        );
        return members.map(member => {
            const market = byMint.get(member.mint) ?? null;
            const provider = providerByMint.get(member.mint) ?? null;
            const registry = registryMeta(member.mint);
            const symbol = provider?.symbol ?? market?.symbol ?? member.symbol ?? registry.symbol;
            return {
                mint: member.mint,
                symbol,
                name: provider?.name ?? market?.name ?? member.name ?? registry.name,
                decimals: provider?.decimals ?? market?.decimals ?? member.decimals,
                logoURI: normalizeLogoURI(provider?.logoURI ?? market?.logoURI ?? member.logoUri),
                verified: member.verified,
                rank: member.rank,
                ...(member.note !== null ? { note: member.note } : {}),
                addedAt: member.addedAt,
            };
        });
    });
}

/** Hydrate curated-list mints (registry-known, so `verified: true`). */
export function hydrateCuratedMints(mints: string[], rankOffset: number): Effect.Effect<V2ListToken[], never> {
    return Effect.gen(function* () {
        const byMint = yield* loadMintMarkets(mints, 'v2.lists.hydrateCurated');
        const providerByMint = yield* loadMissingMintMetadata(mints, byMint, 'v2.lists.hydrateCurated.metadata');
        return mints.map((mint, index) => {
            const market = byMint.get(mint) ?? null;
            const provider = providerByMint.get(mint) ?? null;
            const registry = registryMeta(mint);
            const symbol = provider?.symbol ?? market?.symbol ?? registry.symbol;
            return {
                mint,
                symbol,
                name: provider?.name ?? market?.name ?? registry.name,
                decimals: provider?.decimals ?? market?.decimals ?? null,
                logoURI: normalizeLogoURI(provider?.logoURI ?? market?.logoURI),
                verified: true,
                rank: rankOffset + index,
            };
        });
    });
}

/**
 * Domain error codes from the Cloud Run mutation handlers → HTTP taxonomy.
 * The code is echoed in `details.code` so clients can branch without parsing
 * messages (the taxonomy has no 409/422 variants; those map to 400).
 */
export function failMutationError(
    code: TokenListMutationErrorCode,
): Effect.Effect<never, BadRequestError | ForbiddenError | NotFoundError> {
    switch (code) {
        case 'not_found':
            return Effect.fail(new NotFoundError({ message: 'List not found', resource: 'token_list' }));
        case 'forbidden':
            return Effect.fail(new ForbiddenError({ message: 'This API key’s project does not own the list' }));
        case 'slug_conflict':
            return Effect.fail(
                new BadRequestError({ message: 'A list with this slug already exists', details: { code } }),
            );
        case 'reserved_slug':
            return Effect.fail(new BadRequestError({ message: 'This slug is reserved', details: { code } }));
        case 'invalid_slug':
            return Effect.fail(
                new BadRequestError({
                    message: 'Slug must match ^[a-z][a-z0-9-]{2,62}$',
                    details: { code },
                }),
            );
        case 'invalid_mint':
            return Effect.fail(new BadRequestError({ message: 'Not a valid Solana mint address', details: { code } }));
        case 'unknown_mint':
            return Effect.fail(
                new BadRequestError({
                    message: 'Mint could not be resolved from the registry, token index, or provider',
                    details: { code },
                }),
            );
        case 'batch_too_large':
            return Effect.fail(new BadRequestError({ message: 'Batch exceeds the 100-mint cap', details: { code } }));
    }
}

/** Unwrap a mutation outcome, converting domain error codes to typed failures. */
export function unwrapOutcome<T>(
    outcome: TokenListMutationOutcome<T>,
): Effect.Effect<T, BadRequestError | ForbiddenError | NotFoundError> {
    if (outcome.ok) return Effect.succeed(outcome.value);
    return failMutationError(outcome.error);
}
