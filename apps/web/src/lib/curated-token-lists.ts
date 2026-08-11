import {
    CURATED_LIST_ORDER,
    getCuratedTokenList,
    getLatestAddedToken,
    type CuratedTokenListId,
} from '@tokens/asset-registry/compat';

export type CuratedTokenListIdWithoutLsts = Exclude<CuratedTokenListId, 'lsts'>;

export const CURATED_LIST_ORDER_WITHOUT_LSTS: CuratedTokenListIdWithoutLsts[] = CURATED_LIST_ORDER.filter(
    (listId): listId is CuratedTokenListIdWithoutLsts => listId !== 'lsts',
);

/**
 * Display name for a curated tab.
 *
 * The platform API's list meta customizes these, but the registry already
 * carries the same names ("Crypto" for `majors`, "Treasuries" for `rwas`), so
 * there is no reason for the tabs to fall back to raw ids when the API is not
 * configured.
 */
export function getCuratedListName(listId: CuratedTokenListId): string {
    const list = getCuratedTokenList(listId) as { name?: string } | undefined;
    return list?.name?.trim() || listId;
}

/**
 * The most recently added mint across every home list, for the "Latest Added"
 * highlight when the platform API is not answering. Derived from the registry's
 * git-history timestamps rather than array position — see
 * `getLatestAddedToken`.
 */
export function findLatestAddedMint(): string | null {
    let bestAddress: string | null = null;
    let bestAddedAt = Number.NEGATIVE_INFINITY;

    for (const listId of CURATED_LIST_ORDER_WITHOUT_LSTS) {
        const list = getCuratedTokenList(listId);
        if (!list) continue;

        const latest = getLatestAddedToken(list);
        if (!latest) continue;

        // A mint missing from the generated map has no timestamp; treat it as
        // newest, matching how `getLatestAddedToken` resolves the same case.
        const addedAt = latest.addedAt ?? Number.POSITIVE_INFINITY;
        if (addedAt >= bestAddedAt) {
            bestAddress = latest.address;
            bestAddedAt = addedAt;
        }
    }

    return bestAddress;
}
