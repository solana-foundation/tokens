import type { TrendingMode } from '@/hooks/queries/use-token-search';
import { CURATED_LIST_ORDER_WITHOUT_LSTS } from '@/lib/curated-lists';
import type { HomeTabId } from '@/lib/home-highlights';
import type { TrendingWindow } from '@/lib/types';

export const HOME_TAB_IDS: HomeTabId[] = [...CURATED_LIST_ORDER_WITHOUT_LSTS, 'trending'];
export const TRENDING_MODE_IDS: TrendingMode[] = ['fresh', 'flow'];
export const TRENDING_WINDOW_IDS: TrendingWindow[] = ['5m', '15m', '1h', '6h'];
