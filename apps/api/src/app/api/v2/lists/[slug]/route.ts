import { Effect, Schema } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { NotFoundError, decodeLimit, decodeOffset, decodeUnknownOrBadRequest } from '@tokens/effect';
import { tokenListsDelete, tokenListsGetBySlug, tokenListsGetMembers, tokenListsUpdate } from '@/lib/cloudrun';
import { getCuratedTokenList } from '@tokens/asset-registry/compat';

import { getEffectiveCuratedAddresses } from '../../../_curated-addresses';
import {
    CURATED_OWNER,
    hydrateCommunityMembers,
    hydrateCuratedMints,
    normalizeCuratedSlug,
    unwrapOutcome,
} from '../_shared';

interface RouteCtx {
    params: Promise<{ slug: string }>;
    platformAuth: PlatformAuthContext;
}

const STALE_TTL_SECONDS = 10 * 60;

/**
 * GET /api/v2/lists/{slug} — one list ("plugin") with hydrated tokens.
 * Curated slugs read the effective curated membership (registry ∪ admin-added,
 * `verified: true`); community slugs read token_lists (published only).
 */
export const GET = route(
    (request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const { slug: rawSlug } = yield* Effect.tryPromise(() => ctx.params);
            const slug = rawSlug.trim().toLowerCase();
            const url = new URL(request.url);
            const limit = yield* decodeLimit(url.searchParams.get('limit'), { defaultValue: '500', max: 2000 });
            const offset = yield* decodeOffset(url.searchParams.get('offset'));

            const main = Effect.gen(function* () {
                const curatedId = normalizeCuratedSlug(slug);
                if (curatedId) {
                    const list = getCuratedTokenList(curatedId);
                    const { addresses } = yield* Effect.tryPromise(() => getEffectiveCuratedAddresses(curatedId));
                    const page = addresses.slice(offset, offset + limit);
                    const tokens = yield* hydrateCuratedMints(page, offset);
                    return {
                        slug: curatedId,
                        name: list.name.trim() || curatedId,
                        description: list.description.trim() || null,
                        curated: true,
                        owner: CURATED_OWNER,
                        tokenCount: addresses.length,
                        updatedAt: null,
                        tokens,
                    };
                }

                const detail = yield* tokenListsGetBySlug({ slug });
                if (!detail || detail.status !== 'published') {
                    return yield* Effect.fail(new NotFoundError({ message: 'List not found', resource: 'token_list' }));
                }
                const members = yield* tokenListsGetMembers({ slug, limit, offset });
                const tokens = yield* hydrateCommunityMembers(members);
                return {
                    slug: detail.slug,
                    name: detail.name,
                    // Community lists have no descriptions; curated registry lists keep theirs.
                    description: null,
                    curated: false,
                    owner: { projectId: detail.ownerProjectId },
                    tokenCount: detail.tokenCount,
                    updatedAt: detail.updatedAt,
                    tokens,
                };
            });

            return yield* withStaleFallback(
                {
                    operation: 'v2.lists.detail',
                    cacheKey: `v2:lists:detail:${slug}:${limit}:${offset}`,
                    ttlSeconds: STALE_TTL_SECONDS,
                },
                main,
            );
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60 } },
);

const patchBodySchema = Schema.Struct({
    /** Rename. The old path stops resolving immediately and frees the slug. */
    slug: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Literals(['draft', 'published', 'archived'])),
});

/**
 * PATCH /api/v2/lists/{slug} — update metadata, status, or slug of an owned
 * community list. Renaming is a clean cut: consumers pinned to the old path
 * get a 404 once it lands, and the old slug is immediately claimable again.
 */
export const PATCH = route(
    (request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const { slug } = yield* Effect.tryPromise(() => ctx.params);
            const json = yield* Effect.tryPromise(() => request.json());
            const body = yield* decodeUnknownOrBadRequest(patchBodySchema, json, 'Invalid body');

            const outcome = yield* tokenListsUpdate({
                ownerProjectId: ctx.platformAuth.projectId,
                slug: slug.trim().toLowerCase(),
                ...(body.slug !== undefined ? { newSlug: body.slug.trim().toLowerCase() } : {}),
                ...(body.name !== undefined ? { name: body.name } : {}),
                ...(body.status !== undefined ? { status: body.status } : {}),
            });
            const list = yield* unwrapOutcome(outcome);
            return { list };
        }),
    { platform: { requiredScopes: ['lists:write'] } },
);

/**
 * DELETE /api/v2/lists/{slug} — permanently deletes an owned community list
 * and its members, releasing the slug for anyone to claim again. Irreversible;
 * `PATCH { status: 'archived' }` is the reversible hide-it option.
 */
export const DELETE = route(
    (_request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const { slug } = yield* Effect.tryPromise(() => ctx.params);
            const outcome = yield* tokenListsDelete({
                ownerProjectId: ctx.platformAuth.projectId,
                slug: slug.trim().toLowerCase(),
            });
            const list = yield* unwrapOutcome(outcome);
            return { list };
        }),
    { platform: { requiredScopes: ['lists:write'] } },
);
