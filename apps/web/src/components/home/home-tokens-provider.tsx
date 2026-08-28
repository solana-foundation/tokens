'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';

import { HomeCategoryPathNuqsAdapter, HOME_CATEGORY_PARAM_KEY } from '@/hooks/use-home-category-path-nuqs-adapter';
import { useCuratedTokens, useTrendingTokens, type TrendingMode } from '@/hooks/queries/use-token-search';
import type { CuratedTokenListIdWithoutLsts } from '@/lib/curated-lists';
import type { HomeTabId } from '@/lib/home-highlights';
import type { Token, TrendingWindow } from '@/lib/types';
import { HOME_TAB_IDS, TRENDING_MODE_IDS, TRENDING_WINDOW_IDS } from './home-tokens-constants';

export interface HomeCategoryTab {
    id: HomeTabId;
    name: string;
}

const categoryIdParser = parseAsStringEnum<HomeTabId>(HOME_TAB_IDS).withOptions({
    history: 'replace',
    scroll: false,
});
const trendingModeParser = parseAsStringEnum<TrendingMode>(TRENDING_MODE_IDS).withOptions({
    history: 'replace',
    scroll: false,
});
const trendingWindowParser = parseAsStringEnum<TrendingWindow>(TRENDING_WINDOW_IDS).withOptions({
    history: 'replace',
    scroll: false,
});

interface HomeTokensContextValue {
    categories: HomeCategoryTab[];
    defaultCategoryId: HomeTabId;
    activeCategoryId: HomeTabId;
    isTrending: boolean;
    trendingMode: TrendingMode;
    trendingWindow: TrendingWindow;
    /** Tokens for the active tab (SSR-provided for the initial tab, fetched after). */
    tokens: Token[];
    isLoading: boolean;
    error: unknown;
    setActiveCategoryId: (id: HomeTabId) => void;
    setTrendingMode: (mode: TrendingMode) => void;
    setTrendingWindow: (window: TrendingWindow) => void;
}

const HomeTokensContext = createContext<HomeTokensContextValue | null>(null);

interface HomeTokensProviderProps {
    categories: HomeCategoryTab[];
    initialCategoryId: HomeTabId;
    initialTokens: Token[];
    children: ReactNode;
}

function HomeTokensProviderInner({ categories, initialCategoryId, initialTokens, children }: HomeTokensProviderProps) {
    // When `initialTokens` were (approximately) fetched, so staleTime applies accurately.
    // Captured on first client render: the server can't stamp Date.now() because that
    // would block the prerendered shell under cacheComponents.
    const [initialFetchedAt] = useState(() => Date.now());
    const defaultCategoryId = categories.some(category => category.id === 'majors')
        ? 'majors'
        : (categories[0]?.id ?? initialCategoryId);
    const [activeTab, setActiveTab] = useQueryState(
        HOME_CATEGORY_PARAM_KEY,
        categoryIdParser.withDefault(defaultCategoryId),
    );
    const [trendingMode, setTrendingModeState] = useQueryState('trendingMode', trendingModeParser.withDefault('fresh'));
    const [trendingWindow, setTrendingWindowState] = useQueryState(
        'trendingWindow',
        trendingWindowParser.withDefault('1h'),
    );

    const activeCategory = categories.find(c => c.id === activeTab) ?? categories[0];
    const activeCategoryId = activeCategory?.id ?? initialCategoryId;

    const isTrending = activeCategoryId === 'trending';

    // Seed react-query with the SSR snapshot for the initial category only. `initialData`
    // is only consumed when the cache entry is empty, and `initialDataUpdatedAt` lets the
    // hooks' normal staleTime drive revalidation instead of pinning the snapshot forever.
    // The SSR trending fetch always uses the default 'fresh' mode, so only that query is seeded.
    const seedCurated = !isTrending && activeCategoryId === initialCategoryId;
    const seedTrending = isTrending && initialCategoryId === 'trending' && trendingMode === 'fresh';

    const {
        data: fetchedTokens = [],
        isLoading,
        error,
    } = useCuratedTokens(activeCategoryId as CuratedTokenListIdWithoutLsts, {
        enabled: Boolean(activeCategoryId) && !isTrending,
        ...(seedCurated ? { initialData: initialTokens, initialDataUpdatedAt: initialFetchedAt } : {}),
    });

    const {
        data: fetchedTrendingTokens = [],
        isLoading: isTrendingLoading,
        error: trendingError,
    } = useTrendingTokens({
        mode: trendingMode,
        enabled: isTrending,
        ...(seedTrending ? { initialData: initialTokens, initialDataUpdatedAt: initialFetchedAt } : {}),
    });

    const tokens = isTrending ? fetchedTrendingTokens : fetchedTokens;
    const activeError = isTrending ? trendingError : error;
    const activeIsLoading = isTrending ? isTrendingLoading : isLoading;

    const setActiveCategoryId = useCallback(
        (id: HomeTabId) => {
            void setActiveTab(id === defaultCategoryId ? null : id, { history: 'replace', scroll: false });
        },
        [defaultCategoryId, setActiveTab],
    );

    const setTrendingMode = useCallback(
        (mode: TrendingMode) => {
            void setTrendingModeState(mode === 'fresh' ? null : mode, { history: 'replace', scroll: false });
        },
        [setTrendingModeState],
    );

    const setTrendingWindow = useCallback(
        (window: TrendingWindow) => {
            void setTrendingWindowState(window === '1h' ? null : window, { history: 'replace', scroll: false });
        },
        [setTrendingWindowState],
    );

    const value = useMemo<HomeTokensContextValue>(
        () => ({
            categories,
            defaultCategoryId,
            activeCategoryId,
            isTrending,
            trendingMode,
            trendingWindow,
            tokens,
            isLoading: activeIsLoading,
            error: activeError,
            setActiveCategoryId,
            setTrendingMode,
            setTrendingWindow,
        }),
        [
            categories,
            defaultCategoryId,
            activeCategoryId,
            isTrending,
            trendingMode,
            trendingWindow,
            tokens,
            activeIsLoading,
            activeError,
            setActiveCategoryId,
            setTrendingMode,
            setTrendingWindow,
        ],
    );

    return <HomeTokensContext.Provider value={value}>{children}</HomeTokensContext.Provider>;
}

/**
 * Shared home-page token state: the selected tab (URL-backed) and that tab's tokens.
 * Both the highlight cards and the token table consume this, so switching tabs updates
 * everything in place — no page load required.
 */
export function HomeTokensProvider(props: HomeTokensProviderProps) {
    return (
        <HomeCategoryPathNuqsAdapter>
            <HomeTokensProviderInner {...props} />
        </HomeCategoryPathNuqsAdapter>
    );
}

export function useHomeTokens(): HomeTokensContextValue {
    const context = useContext(HomeTokensContext);
    if (!context) throw new Error('useHomeTokens must be used within a HomeTokensProvider');
    return context;
}
