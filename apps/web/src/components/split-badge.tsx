import * as React from 'react';

import { cn } from '@tokens/ui/cn';

/**
 * One outlined pill with several segments joined by hatched dividers, so a
 * pair like "Equities ▨ ETF / Indices" or "24h Vol $2.4B ▨ Liq $6.3B" reads
 * as one unit instead of dotted text. Segments truncate independently.
 */
export function SplitBadge({
    segments,
    className,
    title,
}: {
    segments: React.ReactNode[];
    className?: string;
    title?: string;
}) {
    if (segments.length === 0) return null;
    // Keys from the segment text, disambiguated when a pair repeats ("Real Estate › Real Estate").
    const seen = new Map<string, number>();
    const keys = segments.map(segment => {
        const text = typeof segment === 'string' || typeof segment === 'number' ? String(segment) : 'node';
        const count = seen.get(text) ?? 0;
        seen.set(text, count + 1);
        return count === 0 ? text : `${text}#${count}`;
    });
    return (
        <span
            className={cn(
                'inline-flex min-w-0 max-w-full items-stretch overflow-hidden rounded-md border border-border-medium text-[11px] font-medium leading-none text-text-medium',
                className,
            )}
            title={title}
        >
            {segments.map((segment, index) => (
                <span key={keys[index]} className="contents">
                    {index > 0 ? (
                        <span
                            aria-hidden
                            className="w-2.5 shrink-0 border-x border-border-medium bg-[repeating-linear-gradient(135deg,var(--color-border-medium)_0_1px,transparent_1px_4px)]"
                        />
                    ) : null}
                    <span className="min-w-0 truncate whitespace-nowrap px-1.5 py-1 tabular-nums">{segment}</span>
                </span>
            ))}
        </span>
    );
}
