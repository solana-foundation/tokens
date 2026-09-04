import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { BadRequestError, decodeLimit, decodeOffset, tapErrorAndDefault } from '@tokens/effect';
import { tokenListsGetBySlug, tokenListsGetMembers, type TokenListMember } from '@/lib/cloudrun';

import { getEffectiveCuratedAddresses } from '../../../_curated-addresses';
import {
    CURATED_OWNER,
    curatedListMeta,
    hydrateCommunityMembers,
    normalizeCuratedSlug,
    type V2ListSummary,
    type V2ListToken,
} from '../_shared';

const MAX_COMPOSED_LISTS = 10;
const STALE_TTL_SECONDS = 10 * 60;

interface ResolvedList {
    summary: V2ListSummary;
    /** Mints in list-rank order, plus member rows for community lists. */
    mints: string[];
    membersByMint: Map<string, TokenListMember>;
}

/**
 * A curated slug resolves from the effective DB-backed membership. Membership
 * failures propagate to the stale-fallback wrapper (a hollow list must not
 * overwrite the last good composition).
 */
function resolveCurated(curatedId: NonNullable<ReturnType<typeof normalizeCuratedSlug>>) {
    return Effect.gen(function* () {
        const meta = yield* curatedListMeta(curatedId);
        const { addresses } = yield* Effect.tryPromise({
            try: () => getEffectiveCuratedAddresses(curatedId),
            catch: error => (error instanceof Error ? error : new Error(String(error))),
        });
        const resolved: ResolvedList = {
            summary: {
                slug: curatedId,
                name: meta.name,
                description: meta.description,
                curated: true,
                owner: CURATED_OWNER,
                tokenCount: addresses.length,
                updatedAt: null,
            },
            mints: addresses,
            membersByMint: new Map(),
        };
        return resolved;
    });
}

/** Hard ceiling on members fetched per composed list (matches the members-per-list cap). */
const COMPOSE_MEMBER_FETCH_CAP = 5000;
const COMPOSE_MEMBER_PAGE = 2000;

function resolveCommunity(slug: string) {
    return Effect.gen(function* () {
        const detail = yield* tokenListsGetBySlug({ slug });
        // Unlisted lists compose by direct slug — hidden from discovery only.
        if (!detail || (detail.status !== 'published' && detail.status !== 'unlisted')) return null;
        // Page until the list's full membership (or the hard cap) is covered —
        // a single fixed-limit fetch silently truncated large lists.
        let members: TokenListMember[] = [];
        for (
            let offset = 0;
            offset < Math.min(detail.tokenCount, COMPOSE_MEMBER_FETCH_CAP);
            offset += COMPOSE_MEMBER_PAGE
        ) {
            const page = yield* tokenListsGetMembers({ slug, limit: COMPOSE_MEMBER_PAGE, offset });
            members.push(...page);
            if (page.length < COMPOSE_MEMBER_PAGE) break;
        }
        // The loop reads whole pages, so trim the tail past the ceiling and
        // say so instead of silently under-reporting membership.
        const truncated = detail.tokenCount > COMPOSE_MEMBER_FETCH_CAP;
        if (members.length > COMPOSE_MEMBER_FETCH_CAP) members = members.slice(0, COMPOSE_MEMBER_FETCH_CAP);
        const resolved: ResolvedList = {
            summary: {
                slug: detail.slug,
                name: detail.name,
                // Community lists have no descriptions; curated registry lists keep theirs.
                description: null,
                curated: false,
                owner: { projectId: detail.ownerProjectId },
                tokenCount: detail.tokenCount,
                updatedAt: detail.updatedAt,
                ...(truncated ? { truncated: true } : {}),
            },
            mints: members.map(m => m.mint),
            membersByMint: new Map(members.map(m => [m.mint, m] as const)),
        };
        return resolved;
    });
}

/**
 * GET /api/v2/lists/tokens?lists=slug1,slug2 — the plugin-composition call: the
 * union of the named lists, deduped by mint, each token annotated with which of
 * the requested lists contains it. `lists` is required and capped at 10 —
 * there is deliberately no "all lists" union; consuming apps must name the
 * curators they trust. Unknown/archived slugs land in `notFound` instead of
 * failing the call.
 */
export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const rawLists = (url.searchParams.get('lists') ?? '').trim();
            if (!rawLists) {
                return yield* Effect.fail(
                    new BadRequestError({ message: 'Missing required query param: lists (comma-separated slugs)' }),
                );
            }
            const slugs = [
                ...new Set(
                    rawLists
                        .split(',')
                        .map(s => s.trim().toLowerCase())
                        .filter(Boolean),
                ),
            ];
            if (slugs.length === 0) {
                return yield* Effect.fail(new BadRequestError({ message: 'lists must name at least one slug' }));
            }
            if (slugs.length > MAX_COMPOSED_LISTS) {
                return yield* Effect.fail(
                    new BadRequestError({ message: `lists is capped at ${MAX_COMPOSED_LISTS} slugs per call` }),
                );
            }
            const limit = yield* decodeLimit(url.searchParams.get('limit'), { defaultValue: '500', max: 2000 });
            const offset = yield* decodeOffset(url.searchParams.get('offset'));

            const main = Effect.gen(function* () {
                const resolved: Array<{ slug: string; list: ResolvedList | null }> = [];
                for (const slug of slugs) {
                    const curatedId = normalizeCuratedSlug(slug);
                    const list = curatedId
                        ? yield* resolveCurated(curatedId)
                        : yield* resolveCommunity(slug).pipe(tapErrorAndDefault(`v2.lists.compose.${slug}`, null));
                    resolved.push({ slug, list });
                }

                const found = resolved.filter((r): r is { slug: string; list: ResolvedList } => r.list !== null);
                const notFound = resolved.filter(r => r.list === null).map(r => r.slug);

                // Union in request order, deduped by mint; membership annotations
                // accumulate across every requested list containing the mint.
                const order: string[] = [];
                const listsByMint = new Map<string, string[]>();
                const memberByMint = new Map<string, TokenListMember>();
                for (const { list } of found) {
                    for (const mint of list.mints) {
                        let membership = listsByMint.get(mint);
                        if (!membership) {
                            membership = [];
                            listsByMint.set(mint, membership);
                            order.push(mint);
                        }
                        membership.push(list.summary.slug);
                        const member = list.membersByMint.get(mint);
                        if (member && !memberByMint.has(mint)) memberByMint.set(mint, member);
                    }
                }

                const page = order.slice(offset, offset + limit);
                // One hydration pass across the page: community member rows carry
                // their own verified flag/snapshot; curated-only mints are verified
                // by construction.
                const pageMembers: TokenListMember[] = page.map(mint => {
                    const member = memberByMint.get(mint);
                    const curatedMember = listsByMint.get(mint)!.some(slug => normalizeCuratedSlug(slug) !== null);
                    if (member) {
                        return curatedMember ? { ...member, verified: true } : member;
                    }
                    return {
                        mint,
                        rank: 0,
                        note: null,
                        addedAt: 0,
                        symbol: null,
                        name: null,
                        logoUri: null,
                        decimals: null,
                        verified: true,
                    };
                });
                const hydrated = yield* hydrateCommunityMembers(pageMembers);
                const tokens = hydrated.map((token, index): V2ListToken & { lists: string[] } => {
                    const { note: _note, addedAt: _addedAt, ...rest } = token;
                    return {
                        ...rest,
                        rank: offset + index,
                        lists: listsByMint.get(token.mint) ?? [],
                    };
                });

                return {
                    lists: found.map(r => r.list.summary),
                    notFound,
                    total: order.length,
                    tokens,
                };
            });

            return yield* withStaleFallback(
                {
                    operation: 'v2.lists.compose',
                    cacheKey: `v2:lists:compose:${slugs.join(',')}:${limit}:${offset}`,
                    ttlSeconds: STALE_TTL_SECONDS,
                },
                main,
            );
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60 } },
);
