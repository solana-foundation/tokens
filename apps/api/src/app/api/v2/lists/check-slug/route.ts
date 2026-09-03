import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError } from '@tokens/effect';
import { tokenListsGetBySlug, tokenListsGetSlugHold } from '@/lib/cloudrun';

import { normalizeCuratedSlug } from '../_shared';

/**
 * Mirrors the write-side rules in cloudrun-assets `tokenListsMutations`
 * (TOKEN_LIST_SLUG_REGEX / isReservedTokenListSlug). Duplicated rather than
 * shared because the API and the assets service are separate deployables —
 * keep the two in sync when either changes.
 */
const SLUG_REGEX = /^[a-z][a-z0-9-]{2,62}$/;
const RESERVED_SEGMENTS = new Set(['all', 'lists', 'curated', 'tokens', 'search-tokens', 'check-slug']);

export type SlugUnavailableReason = 'invalid' | 'reserved' | 'taken' | 'held';

/** Mirrors TOKEN_LIST_SLUG_HOLD_DAYS on cloudrun-assets (default 30). */
const SLUG_HOLD_MS = (Number(process.env.TOKEN_LIST_SLUG_HOLD_DAYS) || 30) * 24 * 60 * 60 * 1000;

/**
 * GET /api/v2/lists/check-slug?slug=… — is this slug claimable right now?
 *
 * Lets curator UIs validate before submitting instead of surfacing a 400 from
 * POST /v2/lists. Existence is checked across every status (a draft or archived
 * list still holds its slug), so this answers the same question the unique
 * index will. Advisory only: the answer can go stale between check and create,
 * so the create path stays authoritative.
 */
export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const raw = (new URL(request.url).searchParams.get('slug') ?? '').trim().toLowerCase();
            if (!raw) {
                return yield* Effect.fail(new BadRequestError({ message: 'Missing required query param: slug' }));
            }
            if (raw.length > 100) {
                return yield* Effect.fail(new BadRequestError({ message: 'Slug too long' }));
            }

            const unavailable = (reason: SlugUnavailableReason) => ({ slug: raw, available: false, reason });

            if (!SLUG_REGEX.test(raw)) return unavailable('invalid');
            if (RESERVED_SEGMENTS.has(raw) || normalizeCuratedSlug(raw) !== null) return unavailable('reserved');

            const existing = yield* tokenListsGetBySlug({ slug: raw });
            if (existing) return unavailable('taken');

            // Freed slugs stay reserved for their previous owner for a window.
            const { hold } = yield* tokenListsGetSlugHold({ slug: raw });
            if (hold && Date.now() - hold.releasedAt < SLUG_HOLD_MS) return unavailable('held');

            return { slug: raw, available: true };
        }),
    // No cache: a slug freed by a delete must read as available immediately.
    { platform: { requiredScopes: ['assets:read'] } },
);
