import { Effect, Schema } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { decodeUnknownOrBadRequest } from '@tokens/effect';
import { tokenListsRemoveMember, tokenListsUpsertMember } from '@/lib/cloudrun';

import { unwrapOutcome } from '../../../_shared';

interface RouteCtx {
    params: Promise<{ slug: string; mint: string }>;
    platformAuth: PlatformAuthContext;
}

const putBodySchema = Schema.Struct({
    rank: Schema.optional(Schema.Number),
    note: Schema.optional(Schema.String),
});

/**
 * PUT /api/v2/lists/{slug}/members/{mint} — add or update a member. The mint
 * must resolve somewhere (registry variant → tokens table → Birdeye); mints
 * unknown everywhere are rejected with `code: unknown_mint`.
 */
export const PUT = route(
    (request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const { slug, mint } = yield* Effect.tryPromise(() => ctx.params);
            const raw = yield* Effect.tryPromise(async () => {
                const text = await request.text();
                return text.trim() ? (JSON.parse(text) as unknown) : {};
            });
            const body = yield* decodeUnknownOrBadRequest(putBodySchema, raw, 'Invalid body');

            const outcome = yield* tokenListsUpsertMember({
                ownerProjectId: ctx.platformAuth.projectId,
                slug: slug.trim().toLowerCase(),
                mint: mint.trim(),
                ...(body.rank !== undefined ? { rank: body.rank } : {}),
                ...(body.note !== undefined ? { note: body.note } : {}),
            });
            const member = yield* unwrapOutcome(outcome);
            return { member };
        }),
    { platform: { requiredScopes: ['lists:write'] } },
);

/** DELETE /api/v2/lists/{slug}/members/{mint} — remove a member. */
export const DELETE = route(
    (_request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const { slug, mint } = yield* Effect.tryPromise(() => ctx.params);
            const outcome = yield* tokenListsRemoveMember({
                ownerProjectId: ctx.platformAuth.projectId,
                slug: slug.trim().toLowerCase(),
                mint: mint.trim(),
            });
            const removed = yield* unwrapOutcome(outcome);
            return { removed };
        }),
    { platform: { requiredScopes: ['lists:write'] } },
);
