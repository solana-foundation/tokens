'use client';

import { useMemo } from 'react';
import { SegmentedControl } from '@solana/design-system/segmented-control';

import { cn } from '@tokens/ui/cn';
import { trackEvent } from '@/lib/posthog-client';
import { ALL_GROUPS_TAB } from './lib/group-tabs';

/**
 * Group pills above the registry table, styled like the explore page's
 * category tabs (`components/home/category-tabs.tsx`): the same segmented
 * control, same 22px labels, transparent track with a soft selected pill.
 */
export function RegistryGroupTabs({
    groups,
    value,
    onValueChange,
}: {
    /** Distinct `group` values in upstream order; "All" is prepended here. */
    groups: readonly string[];
    value: string;
    onValueChange: (next: string) => void;
}) {
    const items = useMemo(
        () => [{ value: ALL_GROUPS_TAB, label: 'All' }, ...groups.map(group => ({ value: group, label: group }))],
        [groups],
    );

    return (
        <SegmentedControl
            className={cn(
                'w-max min-w-0 [&_button]:!text-[22px]',
                'bg-transparent',
                '[&_span.absolute.inset-0]:!bg-black/[0.04] dark:[&_span.absolute.inset-0]:!bg-white/[0.08] [&_span.absolute.inset-0]:!shadow-none',
            )}
            items={items}
            value={value}
            onValueChange={next => {
                if (next === value) return;
                trackEvent('registry_group_switched', { group: next, previous_group: value });
                onValueChange(next);
            }}
            aria-label="Registry group"
        />
    );
}
