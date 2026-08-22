import { Effect, Schema } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { decodeUnknownOrBadRequest } from '@tokens/effect';
import { tokenListsAddMembersBatch } from '@/lib/cloudrun';

import { unwrapOutcome } from '../../_shared';

interface RouteCtx {
    params: Promise<{ slug: string }>;
    platformAuth: PlatformAuthContext;
}

const bodySchema = Schema.Struct({
    mints: Schema.Array(Schema.String),
});

/**
 * POST /api/v2/lists/{slug}/members — bulk add (≤100 mints per call, for
 * onboarding an existing list). Per-mint failures are reported in `failed`
 * without failing the batch.
 */
export const POST = route(
    (request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const { slug } = yield* Effect.tryPromise(() => ctx.params);
            const json = yield* Effect.tryPromise(() => request.json());
            const body = yield* decodeUnknownOrBadRequest(bodySchema, json, 'Invalid body');

            const outcome = yield* tokenListsAddMembersBatch({
                ownerProjectId: ctx.platformAuth.projectId,
                slug: slug.trim().toLowerCase(),
                mints: [...body.mints],
            });
            return yield* unwrapOutcome(outcome);
        }),
    { platform: { requiredScopes: ['lists:write'] } },
);
