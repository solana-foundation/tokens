'use client';

import { Tab, TabList, Tabs } from '@solana/design-system/tabs';
import { useCallback, useMemo } from 'react';

interface TabConfig<T = string> {
    label: string;
    id: T;
}

interface TabNavigationProps<T = string> {
    tabs: ReadonlyArray<TabConfig<T>>;
    activeIndex: number;
    onTabClick: (id: T, index: number) => void;
    onHover?: (index: number | null) => void;
    containerClassName?: string;
    wrapperClassName?: string;
    /** Extra classes on the TabList (e.g. `gap-4` once tab padding is removed). */
    listClassName?: string;
}

function getTabValue(id: unknown): string {
    return String(id);
}

export function TabNavigation<T = string>({
    tabs,
    activeIndex,
    onTabClick,
    onHover: _onHover,
    containerClassName = 'w-full flex justify-start px-0 border-b border-border',
    wrapperClassName = 'p-0',
    listClassName = 'w-max',
}: TabNavigationProps<T>) {
    const activeValue = useMemo(() => {
        const activeTab = tabs[activeIndex] ?? tabs[0];
        return activeTab ? getTabValue(activeTab.id) : undefined;
    }, [activeIndex, tabs]);

    const handleValueChange = useCallback(
        (nextValue: string) => {
            const nextIndex = tabs.findIndex(tab => getTabValue(tab.id) === nextValue);
            if (nextIndex < 0) return;
            const nextTab = tabs[nextIndex];
            if (!nextTab) return;
            onTabClick(nextTab.id, nextIndex);
        },
        [onTabClick, tabs],
    );

    if (tabs.length === 0) return null;

    return (
        <div className={containerClassName}>
            <div className={wrapperClassName}>
                <Tabs size="md" bordered={false} fullWidth value={activeValue} onValueChange={handleValueChange}>
                    <TabList className={listClassName}>
                        {tabs.map(tab => (
                            <Tab key={getTabValue(tab.id)} value={getTabValue(tab.id)} className="whitespace-nowrap">
                                {tab.label}
                            </Tab>
                        ))}
                    </TabList>
                </Tabs>
            </div>
        </div>
    );
}

export type { TabConfig };
