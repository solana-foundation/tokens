'use client';

import * as React from 'react';
import {
    renderQueryString,
    unstable_createAdapterProvider as createAdapterProvider,
    type unstable_AdapterInterface as AdapterInterface,
    type unstable_UpdateUrlFunction as UpdateUrlFunction,
} from 'nuqs/adapters/custom';

/**
 * nuqs adapter for the registry that reads the query string from
 * `window.location` instead of Next's `useSearchParams`.
 *
 * `useSearchParams` suspends while the route is prerendered, which would put
 * the whole table behind its Suspense fallback and ship a skeleton in the
 * static HTML. With an empty server snapshot the prerender carries the
 * canonical, unfiltered first page; a bookmarked `?q`/`?f`/`?sort` applies as
 * soon as the page hydrates. Writes go through the native history API, which
 * Next patches to keep its router in sync.
 */

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    window.addEventListener('popstate', onChange);
    return () => {
        listeners.delete(onChange);
        window.removeEventListener('popstate', onChange);
    };
}

function getSnapshot(): string {
    return window.location.search;
}

function getServerSnapshot(): string {
    return '';
}

function notify(): void {
    for (const listener of listeners) listener();
}

function readSearchParams(): URLSearchParams {
    return new URLSearchParams(window.location.search);
}

function useRegistryUrlAdapter(_watchKeys: string[]): AdapterInterface {
    const search = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    const searchParams = React.useMemo(() => new URLSearchParams(search), [search]);

    const updateUrl: UpdateUrlFunction = React.useCallback((next, options) => {
        const url = new URL(window.location.href);
        url.search = renderQueryString(new URLSearchParams(next));

        // A non-shallow update asks for a server round trip; the registry has no
        // server-side URL state, so a full navigation is the honest equivalent.
        if (options.shallow === false) {
            if (options.history === 'push') window.location.assign(url.toString());
            else window.location.replace(url.toString());
            return;
        }

        if (options.history === 'push') window.history.pushState(null, '', url.toString());
        else window.history.replaceState(null, '', url.toString());
        notify();

        if (options.scroll) window.scrollTo(0, 0);
    }, []);

    return { searchParams, updateUrl, getSearchParamsSnapshot: readSearchParams };
}

export const RegistryNuqsAdapter = createAdapterProvider(useRegistryUrlAdapter);
