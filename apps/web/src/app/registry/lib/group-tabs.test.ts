import { describe, expect, it } from 'bun:test';

import type { RegistryFilter } from './filters';
import { ALL_GROUPS_TAB, activeGroupTab, filtersForGroupTab, listGroupTabs } from './group-tabs';
import type { RegistryRow } from './types';

function row(group: string | null): RegistryRow {
    return {
        symbol: 'X',
        mintAddress: 'mint',
        name: null,
        logoURI: null,
        hasTokenPage: false,
        group,
        category: null,
        assetClass: null,
        rwaClass: null,
        alliumClass: null,
        rwaValueUsd: null,
        alliumValueUsd: null,
        marketCapUsd: null,
        valueUsd: null,
    };
}

const GROUPS = ['Stablecoins', 'RWA', 'Crypto Native'];

describe('listGroupTabs', () => {
    it('returns distinct groups in first-appearance order and skips nulls', () => {
        const rows = [row('Stablecoins'), row(null), row('RWA'), row('Stablecoins'), row('Crypto Native'), row('RWA')];
        expect(listGroupTabs(rows)).toEqual(GROUPS);
    });
});

describe('activeGroupTab', () => {
    it('is "all" with no group filter', () => {
        expect(activeGroupTab([], GROUPS)).toBe(ALL_GROUPS_TAB);
        expect(activeGroupTab([{ field: 'category', op: 'is', value: 'Equities' }], GROUPS)).toBe(ALL_GROUPS_TAB);
    });

    it('mirrors a single "group is X" chip', () => {
        expect(activeGroupTab([{ field: 'group', op: 'is', value: 'RWA' }], GROUPS)).toBe('RWA');
    });

    it('falls back to "all" for is_not, several group chips, or an unknown group', () => {
        expect(activeGroupTab([{ field: 'group', op: 'is_not', value: 'RWA' }], GROUPS)).toBe(ALL_GROUPS_TAB);
        expect(
            activeGroupTab(
                [
                    { field: 'group', op: 'is', value: 'RWA' },
                    { field: 'group', op: 'is', value: 'Stablecoins' },
                ],
                GROUPS,
            ),
        ).toBe(ALL_GROUPS_TAB);
        expect(activeGroupTab([{ field: 'group', op: 'is', value: 'Nope' }], GROUPS)).toBe(ALL_GROUPS_TAB);
    });
});

describe('filtersForGroupTab', () => {
    const others: RegistryFilter[] = [
        { field: 'category', op: 'is', value: 'Equities' },
        { field: 'marketCapUsd', op: 'gte', value: 1_000_000 },
    ];

    it('replaces every group filter with one "is" filter and keeps the rest', () => {
        const current = [{ field: 'group', op: 'is_not', value: 'RWA' } as RegistryFilter, ...others];
        expect(filtersForGroupTab(current, 'Stablecoins')).toEqual([
            ...others,
            { field: 'group', op: 'is', value: 'Stablecoins' },
        ]);
    });

    it('"all" drops the group filters only', () => {
        const current = [...others, { field: 'group', op: 'is', value: 'RWA' } as RegistryFilter];
        expect(filtersForGroupTab(current, ALL_GROUPS_TAB)).toEqual(others);
    });
});
