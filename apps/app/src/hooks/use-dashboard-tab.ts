'use client';

import { useCallback } from 'react';
import { useQueryState } from 'nuqs';

export const DASHBOARD_TABS = [
    { label: 'Overview', id: 'overview' },
    { label: 'API Manager', id: 'api-manager' },
    { label: 'Lists', id: 'lists' },
] as const;

export type DashboardTabId = (typeof DASHBOARD_TABS)[number]['id'];

const DEFAULT_TAB: DashboardTabId = 'overview';

function coerceDashboardTab(raw: string): DashboardTabId {
    if (raw === 'api-manager') return 'api-manager';
    if (raw === 'lists') return 'lists';
    return 'overview';
}

export function useDashboardTab(): {
    tab: DashboardTabId;
    setTab: (tab: DashboardTabId) => void;
} {
    // Shallow (default) keeps tab switches purely client-side — no server round-trip.
    // Restore `shallow: false` if a server component ever starts reading `searchParams.tab`.
    const [rawTab, setRawTab] = useQueryState('tab', {
        defaultValue: DEFAULT_TAB,
    });

    const tab = coerceDashboardTab(rawTab);
    const setTab = useCallback((next: DashboardTabId) => setRawTab(next), [setRawTab]);

    return { tab, setTab };
}
