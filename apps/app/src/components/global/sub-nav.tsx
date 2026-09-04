'use client';

import { memo, useCallback } from 'react';

import { TabNavigation } from '@/components/global/tab-navigation';
import { DASHBOARD_TABS, type DashboardTabId, useDashboardTab } from '@/hooks/use-dashboard-tab';

const SubNav = memo(function SubNav() {
    const { tab, setTab } = useDashboardTab();

    const activeIndex = Math.max(
        0,
        DASHBOARD_TABS.findIndex(row => row.id === tab),
    );

    const handleTabClick = useCallback(
        (id: DashboardTabId) => {
            setTab(id);
        },
        [setTab],
    );

    return (
        <div className="w-full border-b border-border bg-zinc-50 pt-2 dark:bg-zinc-900">
            <div className="w-full px-4">
                <TabNavigation
                    tabs={DASHBOARD_TABS}
                    activeIndex={activeIndex}
                    onTabClick={handleTabClick}
                    containerClassName="w-full"
                    wrapperClassName=""
                />
            </div>
        </div>
    );
});

export default SubNav;
