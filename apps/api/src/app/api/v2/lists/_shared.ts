import { Effect } from 'effect';

import { BadRequestError, ForbiddenError, NotFoundError, tapErrorAndDefault } from '@tokens/effect';
import {
    assetCollectionsGetSummaries,
    tokensGetSearchTokensByAddresses,
    type AssetCollectionSummary,
    type TokenListMember,
    type TokenListMutationErrorCode,
    type TokenListMutationOutcome,
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

/**
 * Shared shapes + helpers for the /api/v2/lists surface. Curated lists and
 * community lists present as one "lists" concept here: curated ids are just
 * the first lists, owned by the Solana Foundation.
 */

export const CURATED_OWNER = { name: 'Solana Foundation' } as const;

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
 * Summaries for every curated list. DB counts (admin-added members included)
 * fail open to the compiled registry — one RPC failure never empties the
 * catalog (same posture as v1/assets/curated/lists).
 */
export function curatedListSummaries(): Effect.Effect<V2ListSummary[], never> {
    return Effect.gen(function* () {
        const dbSummaries = yield* assetCollectionsGetSummaries({ slugs: [...CURATED_LIST_ORDER] }).pipe(
            tapErrorAndDefault('v2.lists.curatedSummaries', null as AssetCollectionSummary[] | null),
        );
        const dbBySlug = new Map((dbSummaries ?? []).map(summary => [summary.slug, summary] as const));
        return CURATED_LIST_ORDER.map(id => {
            const list = getCuratedTokenList(id);
            const staticCount = getCuratedTokenAddresses(list).length;
            const db = dbBySlug.get(id);
            return {
                slug: id,
                name: list.name.trim() || id,
                description: list.description.trim() || null,
                curated: true,
                owner: CURATED_OWNER,
                tokenCount: db && db.count > 0 ? db.count : staticCount,
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

/**
 * Batch-hydrate mints from the tokens table, falling back to per-member
 * snapshot columns (Birdeye-only mints snapshot metadata at add time), then
 * to the compiled registry for registry-known mints.
 */
export function hydrateCommunityMembers(members: TokenListMember[]): Effect.Effect<V2ListToken[], never> {
    return Effect.gen(function* () {
        const entries =
            members.length === 0
                ? []
                : yield* tokensGetSearchTokensByAddresses({ addresses: members.map(m => m.mint) }).pipe(
                      tapErrorAndDefault('v2.lists.hydrateMembers', []),
                  );
        const byMint = new Map(entries.map(entry => [entry.address, entry.token] as const));
        return members.map(member => {
            const token = byMint.get(member.mint) ?? null;
            const registry = registryMeta(member.mint);
            return {
                mint: member.mint,
                symbol: token?.symbol ?? member.symbol ?? registry.symbol,
                name: token?.name ?? member.name ?? registry.name,
                decimals: token?.decimals ?? member.decimals,
                logoURI: token?.logoURI ?? member.logoUri,
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
        const entries =
            mints.length === 0
                ? []
                : yield* tokensGetSearchTokensByAddresses({ addresses: mints }).pipe(
                      tapErrorAndDefault('v2.lists.hydrateCurated', []),
                  );
        const byMint = new Map(entries.map(entry => [entry.address, entry.token] as const));
        return mints.map((mint, index) => {
            const token = byMint.get(mint) ?? null;
            const registry = registryMeta(mint);
            return {
                mint,
                symbol: token?.symbol ?? registry.symbol,
                name: token?.name ?? registry.name,
                decimals: token?.decimals ?? null,
                logoURI: token?.logoURI ?? null,
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
        case 'slug_held':
            return Effect.fail(
                new BadRequestError({
                    message:
                        'This slug was recently released and is reclaimable only by its previous owner for a hold-down period',
                    details: { code },
                }),
            );
        case 'admin_locked':
            return Effect.fail(new ForbiddenError({ message: 'This list has been locked by moderators' }));
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
