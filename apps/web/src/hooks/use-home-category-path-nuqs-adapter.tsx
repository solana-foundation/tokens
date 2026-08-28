'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import {
    renderQueryString,
    unstable_createAdapterProvider as createAdapterProvider,
    type unstable_AdapterInterface as AdapterInterface,
    type unstable_UpdateUrlFunction as UpdateUrlFunction,
} from 'nuqs/adapters/custom';

import { CURATED_LIST_ORDER_WITHOUT_LSTS, type CuratedTokenListIdWithoutLsts } from '@/lib/curated-lists';

export const HOME_CATEGORY_PARAM_KEY = 'category';

type HomeTabId = 'trending' | CuratedTokenListIdWithoutLsts;

function normalizeHomeCategoryId(raw: string): HomeTabId | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed === 'trending') return 'trending';
    const normalized = trimmed === 'stables' ? 'currencies' : trimmed;
    return CURATED_LIST_ORDER_WITHOUT_LSTS.includes(normalized as CuratedTokenListIdWithoutLsts)
        ? (normalized as CuratedTokenListIdWithoutLsts)
        : null;
}

function deriveSearchParams(queryString: string): URLSearchParams {
    const search = new URLSearchParams(queryString);

    const categoryFromQueryRaw = search.get(HOME_CATEGORY_PARAM_KEY);
    const categoryFromQuery = categoryFromQueryRaw ? normalizeHomeCategoryId(categoryFromQueryRaw) : null;
    if (categoryFromQuery) {
        search.set(HOME_CATEGORY_PARAM_KEY, categoryFromQuery);
        return search;
    }

    search.delete(HOME_CATEGORY_PARAM_KEY);
    return search;
}

function useHomeCategoryPathAdapter(_watchKeys: string[]): AdapterInterface {
    const nextSearchParams = useSearchParams();
    const queryString = nextSearchParams.toString();

    const derivedSearchParams = React.useMemo(() => deriveSearchParams(queryString), [queryString]);
    const [optimisticSearchParams, setOptimisticSearchParams] = React.useOptimistic(derivedSearchParams);

    const updateUrl: UpdateUrlFunction = React.useCallback(
        (search, options) => {
            React.startTransition(() => {
                const normalizedCategoryId = (() => {
                    const raw = search.get(HOME_CATEGORY_PARAM_KEY);
                    return raw ? normalizeHomeCategoryId(raw) : null;
                })();
                const normalizedSearch = new URLSearchParams(search);
                if (normalizedCategoryId) normalizedSearch.set(HOME_CATEGORY_PARAM_KEY, normalizedCategoryId);
                else normalizedSearch.delete(HOME_CATEGORY_PARAM_KEY);

                setOptimisticSearchParams(normalizedSearch);

                const url = new URL(window.location.href);
                const nextSearch = new URLSearchParams(normalizedSearch);
                url.search = renderQueryString(nextSearch);

                if (options.shallow === false) {
                    if (options.history === 'push') {
                        window.location.assign(url.toString());
                    } else {
                        window.location.replace(url.toString());
                    }
                    return;
                }

                const updateMethod =
                    options.history === 'push' ? window.history.pushState : window.history.replaceState;
                updateMethod.call(window.history, null, '', url.toString());

                if (options.scroll) window.scrollTo(0, 0);
            });
        },
        [setOptimisticSearchParams],
    );

    return {
        searchParams: optimisticSearchParams,
        updateUrl,
    };
}

export const HomeCategoryPathNuqsAdapter = createAdapterProvider(useHomeCategoryPathAdapter);
