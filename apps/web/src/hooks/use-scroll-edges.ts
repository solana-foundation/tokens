'use client';

import * as React from 'react';

export interface ScrollEdges {
    /** Content is hidden past the left edge (the user has scrolled right). */
    left: boolean;
    /** Content is hidden past the right edge (there is more to scroll to). */
    right: boolean;
}

/**
 * Which edges of a horizontally scrolling element currently clip content, kept
 * current on scroll and resize. Lets the caller fade the clipped edge instead
 * of cutting it off hard, and drop the fade once the end is reached.
 */
export function useScrollEdges(ref: React.RefObject<HTMLElement | null>): ScrollEdges {
    const [edges, setEdges] = React.useState<ScrollEdges>({ left: false, right: false });

    React.useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const update = () => {
            const max = el.scrollWidth - el.clientWidth;
            const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 };
            setEdges(current => (current.left === next.left && current.right === next.right ? current : next));
        };

        update();
        el.addEventListener('scroll', update, { passive: true });
        const observer = new ResizeObserver(update);
        observer.observe(el);
        for (const child of el.children) observer.observe(child);
        return () => {
            el.removeEventListener('scroll', update);
            observer.disconnect();
        };
    }, [ref]);

    return edges;
}
