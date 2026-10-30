'use client';

import { useCallback, useMemo } from 'react';
import { createParser, parseAsString, useQueryStates } from 'nuqs';

import {
    decodeFilters,
    decodeSort,
    encodeFilters,
    encodeSort,
    type RegistryFilter,
    type RegistrySort,
} from './lib/filters';

/**
 * URL IS THE STORE for the registry toolbar:
 *   q    — free-text search (symbol / name / mint)
 *   f    — filters as compact [field, op, value] tuples; fail-closed to none
 *   sort — explicit header-click sort ("marketCapUsd.desc"); null = canonical order
 * Everything is shareable/bookmarkable; reload restores the exact view.
 */

const filtersParser = createParser<RegistryFilter[]>({
    parse: value => decodeFilters(value),
    serialize: value => encodeFilters(value),
    eq: (a, b) => encodeFilters(a) === encodeFilters(b),
});

const sortParser = createParser<RegistrySort>({
    parse: value => decodeSort(value),
    serialize: value => encodeSort(value),
    eq: (a, b) => a.id === b.id && a.desc === b.desc,
});

export interface RegistryUrlState {
    q: string;
    filters: RegistryFilter[];
    sort: RegistrySort | null;
    hasActive: boolean;
    setQ: (q: string) => void;
    setFilters: (filters: RegistryFilter[]) => void;
    addFilter: (filter: RegistryFilter) => void;
    updateFilter: (index: number, filter: RegistryFilter) => void;
    removeFilter: (index: number) => void;
    setSort: (sort: RegistrySort | null) => void;
    clearAll: () => void;
}

export function useRegistryUrlState(): RegistryUrlState {
    const [state, setState] = useQueryStates(
        {
            q: parseAsString.withDefault(''),
            f: filtersParser,
            sort: sortParser,
        },
        { history: 'replace', scroll: false },
    );

    const filters = useMemo(() => state.f ?? [], [state.f]);

    const setFilters = useCallback(
        (next: RegistryFilter[]) => void setState({ f: next.length > 0 ? next : null }),
        [setState],
    );

    return {
        q: state.q,
        filters,
        sort: state.sort,
        hasActive: state.q.trim().length > 0 || filters.length > 0 || state.sort !== null,
        setQ: q => void setState({ q: q || null }),
        setFilters,
        addFilter: filter => setFilters([...filters, filter]),
        updateFilter: (index, filter) => setFilters(filters.map((current, i) => (i === index ? filter : current))),
        removeFilter: index => setFilters(filters.filter((_, i) => i !== index)),
        setSort: sort => void setState({ sort }),
        clearAll: () => void setState({ q: null, f: null, sort: null }),
    };
}
