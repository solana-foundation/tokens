import { Effect, Schema } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { decodeLimit, decodeOffset, decodeUnknownOrBadRequest, tapErrorAndDefault } from '@tokens/effect';
import {
    tokenListsCountPublished,
    tokenListsCreate,
    tokenListsList,
    tokenListsListByOwner,
    type TokenListSummary,
} from '@/lib/cloudrun';

import { curatedListSummaries, unwrapOutcome, type V2ListSummary } from './_shared';

/**
 * GET /api/v2/lists — the list catalog ("plugin discovery"): every curated
 * list plus every published community list, metadata only. Apps browse here,
 * then pull contents via /api/v2/lists/{slug} or compose several via
 * /api/v2/lists/tokens?lists=a,b,c.
 */
export const GET = route(
    (request: Request, ctx: { platformAuth: PlatformAuthContext }) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const limit = yield* decodeLimit(url.searchParams.get('limit'), { defaultValue: '100', max: 500 });
            const offset = yield* decodeOffset(url.searchParams.get('offset'));

            // Owner-scoped catalog: the caller's own lists in any status except
            // archived, `status` included so dashboards can label private
            // (unlisted) lists. No curated rows, and no stale-fallback cache —
            // the shared catalog cache key has no project dimension.
            if (url.searchParams.get('mine') === 'true') {
                const mine = yield* tokenListsListByOwner({
                    ownerProjectId: ctx.platformAuth.projectId,
                    limit,
                    offset,
                });
                const lists: V2ListSummary[] = mine.map(list => ({
                    slug: list.slug,
                    name: list.name,
                    description: null,
                    curated: false,
                    owner: { projectId: list.ownerProjectId },
                    tokenCount: list.tokenCount,
                    updatedAt: list.updatedAt,
                    status: list.status,
                }));
                return { lists, total: lists.length };
            }

            const main = Effect.gen(function* () {
                // Membership failures propagate to the stale-fallback wrapper —
                // a hollow catalog must never overwrite the last good one.
                const curated = yield* curatedListSummaries();
                // Fail-open: a cloudrun blip must not empty the catalog of curated lists.
                const community = yield* tokenListsList({ limit, offset }).pipe(
                    tapErrorAndDefault('v2.lists.community', [] as TokenListSummary[]),
                );
                // Real catalog total, not the page length; fail-open to the page size.
                const communityTotal = yield* tokenListsCountPublished().pipe(
                    tapErrorAndDefault('v2.lists.communityTotal', { total: community.length }),
                );

                const communitySummaries: V2ListSummary[] = community.map(list => ({
                    slug: list.slug,
                    name: list.name,
                    // Community lists have no descriptions; curated registry lists keep theirs.
                    description: null,
                    curated: false,
                    owner: { projectId: list.ownerProjectId },
                    tokenCount: list.tokenCount,
                    updatedAt: list.updatedAt,
                }));

                // Curated lists lead the catalog; pagination applies to community lists
                // (the curated set is small and fixed).
                const lists = offset === 0 ? [...curated, ...communitySummaries] : communitySummaries;
                return { lists, total: curated.length + communityTotal.total };
            });

            return yield* withStaleFallback(
                {
                    operation: 'v2.lists.catalog',
                    cacheKey: `v2:lists:catalog:${limit}:${offset}`,
                    ttlSeconds: 10 * 60,
                },
                main,
            );

        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 300 } },
);

const createBodySchema = Schema.Struct({
    slug: Schema.String,
    name: Schema.String.check(Schema.isMaxLength(80)),
    /** `unlisted` = hidden from the catalog, still readable at the direct URL. */
    status: Schema.optional(Schema.Literals(['draft', 'unlisted', 'published'])),
});

/** POST /api/v2/lists — create a community list, owned by the caller's project. */
export const POST = route(
    (request: Request, ctx: { platformAuth: PlatformAuthContext }) =>
        Effect.gen(function* () {
            const json = yield* Effect.tryPromise(() => request.json());
            const body = yield* decodeUnknownOrBadRequest(createBodySchema, json, 'Invalid body');

            const outcome = yield* tokenListsCreate({
                ownerProjectId: ctx.platformAuth.projectId,
                slug: body.slug,
                name: body.name,
                ...(body.status !== undefined ? { status: body.status } : {}),
            });
            const list = yield* unwrapOutcome(outcome);
            return { list };
        }),
    { platform: { requiredScopes: ['assets:read'] } },
);
