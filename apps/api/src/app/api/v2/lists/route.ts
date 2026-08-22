import { Effect, Schema } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { decodeLimit, decodeOffset, decodeUnknownOrBadRequest, tapErrorAndDefault } from '@tokens/effect';
import { tokenListsCreate, tokenListsList, type TokenListSummary } from '@/lib/cloudrun';

import { curatedListSummaries, unwrapOutcome, type V2ListSummary } from './_shared';

/**
 * GET /api/v2/lists — the list catalog ("plugin discovery"): every curated
 * list plus every published community list, metadata only. Apps browse here,
 * then pull contents via /api/v2/lists/{slug} or compose several via
 * /api/v2/lists/tokens?lists=a,b,c.
 */
export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const limit = yield* decodeLimit(url.searchParams.get('limit'), { defaultValue: '100', max: 500 });
            const offset = yield* decodeOffset(url.searchParams.get('offset'));

            const curated = yield* curatedListSummaries();
            // Fail-open: a cloudrun blip must not empty the catalog of curated lists.
            const community = yield* tokenListsList({ limit, offset }).pipe(
                tapErrorAndDefault('v2.lists.community', [] as TokenListSummary[]),
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
            return { lists, total: lists.length };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 300 } },
);

const createBodySchema = Schema.Struct({
    slug: Schema.String,
    name: Schema.String,
    status: Schema.optional(Schema.Literals(['draft', 'published'])),
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
    { platform: { requiredScopes: ['lists:write'] } },
);
