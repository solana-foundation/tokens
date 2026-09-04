/**
 * Curated-list slug constants — the single source of truth for curated list
 * ids, ordering, aliases, and slug reservation.
 *
 * Leaf module on purpose: it imports NO registry data, so services and client
 * bundles can depend on it (via `@tokens/asset-registry/curated-lists`)
 * without pulling in the compiled asset graph.
 *
 * Membership authority note: list MEMBERSHIP lives in the database
 * (`asset_collections` / `asset_collection_members`) and is edited through the
 * admin app. The mint arrays in `data/list-mints.ts` are canonical-asset
 * generation inputs (identity), not live membership. `curated:<slug>` variant
 * tags are seed-time provenance only.
 */

export const CURATED_LIST_SLUGS = ['majors', 'lsts', 'currencies', 'rwas', 'etfs', 'metals', 'stocks'] as const;

export type CuratedListSlug = (typeof CURATED_LIST_SLUGS)[number];

/** Order determines tab order in UI and rank precedence across lists. */
export const CURATED_LIST_ORDER: readonly CuratedListSlug[] = CURATED_LIST_SLUGS;

/** The derived union pseudo-list. Never persisted; computed live from the others. */
export const ALL_PSEUDO_SLUG = 'all';

/** Legacy public aliases that keep normalizing to their current slugs. */
export const CURATED_SLUG_ALIASES: Readonly<Record<string, CuratedListSlug>> = {
    stables: 'currencies',
    xstocks: 'etfs',
};

export function isCuratedListSlug(value: string): value is CuratedListSlug {
    return (CURATED_LIST_SLUGS as readonly string[]).includes(value);
}

export function normalizeCuratedListSlug(raw: string): CuratedListSlug | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const aliased = CURATED_SLUG_ALIASES[trimmed];
    if (aliased) return aliased;
    return isCuratedListSlug(trimmed) ? trimmed : null;
}

/**
 * The curated lists shown as home-page categories. `lsts` is excluded from the
 * home tabs (staking has its own surface) but remains a real curated list.
 */
export const HOME_CATEGORY_SLUGS = ['majors', 'currencies', 'rwas', 'etfs', 'metals', 'stocks'] as const satisfies readonly CuratedListSlug[];

/**
 * The curated lists whose membership the admin app may assign directly.
 *
 * `lsts` is deliberately NOT assignable: its membership is display-dynamic
 * (Sanctum yield variants), and admin `syncCollections` DELETES membership for
 * any assignable slug missing from a request — including `lsts` here would
 * make every admin category edit strip LST membership.
 */
export const ADMIN_ASSIGNABLE_CURATED_SLUGS = ['majors', 'currencies', 'rwas', 'etfs', 'metals', 'stocks'] as const satisfies readonly CuratedListSlug[];

export type AdminAssignableCuratedSlug = (typeof ADMIN_ASSIGNABLE_CURATED_SLUGS)[number];

/**
 * Slugs that community token lists may never claim, beyond the curated slugs
 * and their aliases: route segments and the union pseudo-list.
 */
export const STATIC_RESERVED_LIST_SLUGS: readonly string[] = [
    ALL_PSEUDO_SLUG,
    'lists',
    'curated',
    'tokens',
    'search-tokens',
    'check-slug',
];

/** True when a slug is unavailable for community token lists. */
export function isReservedListSlug(slug: string): boolean {
    const trimmed = slug.trim();
    if (!trimmed) return true;
    if (STATIC_RESERVED_LIST_SLUGS.includes(trimmed)) return true;
    if (isCuratedListSlug(trimmed)) return true;
    return trimmed in CURATED_SLUG_ALIASES;
}

/**
 * Fail-open display names used when the DB is unreachable and no cached
 * summary exists. The DB (`asset_collections.title`) is authoritative.
 */
export const CURATED_LIST_FALLBACK_NAMES: Readonly<Record<CuratedListSlug, string>> = {
    majors: 'Crypto',
    lsts: 'Staking',
    currencies: 'Currencies',
    rwas: 'Treasuries',
    etfs: 'ETFs',
    metals: 'Metals',
    stocks: 'Stocks',
};
