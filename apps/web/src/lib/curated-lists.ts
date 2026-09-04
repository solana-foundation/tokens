import { CURATED_LIST_ORDER, type CuratedListSlug } from '@tokens/asset-registry/curated-lists';

export type CuratedTokenListIdWithoutLsts = Exclude<CuratedListSlug, 'lsts'>;

export const CURATED_LIST_ORDER_WITHOUT_LSTS: CuratedTokenListIdWithoutLsts[] = CURATED_LIST_ORDER.filter(
    (listId): listId is CuratedTokenListIdWithoutLsts => listId !== 'lsts',
);
