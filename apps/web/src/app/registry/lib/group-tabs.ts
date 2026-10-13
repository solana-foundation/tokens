import type { RegistryFilter } from './filters';
import type { RegistryRow } from './types';

/**
 * Group tabs above the registry table (the explore page's category pills).
 * They are a view onto the URL-backed `group` filter rather than separate
 * state: picking a tab replaces any `group` chips with one `group is <tab>`
 * filter, and a chip the user edits by hand moves the tab accordingly.
 */

export const ALL_GROUPS_TAB = 'all';

/** Distinct `group` values in first-appearance (upstream rank) order. */
export function listGroupTabs(rows: readonly RegistryRow[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of rows) {
        if (row.group && !seen.has(row.group)) {
            seen.add(row.group);
            out.push(row.group);
        }
    }
    return out;
}

/**
 * The tab that matches the current filters: exactly one `group is X` and no
 * other `group` filter selects X; anything else (none, several, `is_not`)
 * is "all" so the pills never claim more than the chips enforce.
 */
export function activeGroupTab(filters: readonly RegistryFilter[], groups: readonly string[]): string {
    const groupFilters = filters.filter(filter => filter.field === 'group');
    if (groupFilters.length !== 1) return ALL_GROUPS_TAB;
    const only = groupFilters[0]!;
    if (only.op !== 'is' || typeof only.value !== 'string') return ALL_GROUPS_TAB;
    return groups.includes(only.value) ? only.value : ALL_GROUPS_TAB;
}

/** Filters after choosing a tab: every `group` filter dropped, then one `is` filter unless "all". */
export function filtersForGroupTab(filters: readonly RegistryFilter[], tab: string): RegistryFilter[] {
    const rest = filters.filter(filter => filter.field !== 'group');
    if (tab === ALL_GROUPS_TAB) return rest;
    return [...rest, { field: 'group', op: 'is', value: tab }];
}
