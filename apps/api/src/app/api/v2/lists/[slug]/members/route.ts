import { Effect, Schema } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { BadRequestError, decodeUnknownOrBadRequest } from '@tokens/effect';
import { tokenListsAddMembersBatch } from '@/lib/cloudrun';

import { unwrapOutcome } from '../../_shared';

interface RouteCtx {
    params: Promise<{ slug: string }>;
    platformAuth: PlatformAuthContext;
}

const bodySchema = Schema.Struct({
    mints: Schema.optional(Schema.Array(Schema.String)),
    /** CSV-shaped alternative: row order becomes rank order, `note` lands on the member. */
    members: Schema.optional(
        Schema.Array(Schema.Struct({ mint: Schema.String, note: Schema.optional(Schema.String) })),
    ),
});

/**
 * POST /api/v2/lists/{slug}/members — bulk add (≤1000 mints per call, for
 * onboarding an existing list). Body is `{ mints: string[] }` or
 * `{ members: [{ mint, note? }] }` (or both). Per-mint failures are reported
 * in `failed` without failing the batch.
 */
export const POST = route(
    (request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const { slug } = yield* Effect.tryPromise(() => ctx.params);
            const json = yield* Effect.tryPromise(() => request.json());
            const body = yield* decodeUnknownOrBadRequest(bodySchema, json, 'Invalid body');
            if (body.mints === undefined && body.members === undefined) {
                return yield* Effect.fail(new BadRequestError({ message: 'Body needs `mints` or `members`' }));
            }

            const outcome = yield* tokenListsAddMembersBatch({
                ownerProjectId: ctx.platformAuth.projectId,
                slug: slug.trim().toLowerCase(),
                ...(body.mints ? { mints: [...body.mints] } : {}),
                ...(body.members
                    ? { members: body.members.map(m => ({ mint: m.mint, ...(m.note ? { note: m.note } : {}) })) }
                    : {}),
            });
            return yield* unwrapOutcome(outcome);
        }),
    { platform: { requiredScopes: ['assets:read'] } },
);
