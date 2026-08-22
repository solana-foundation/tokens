'use client';

import { useCallback, useMemo, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { toast } from 'sonner';

/**
 * Row multi-selection + bulk removal for the member table, ported from the
 * svela screener/watchlist selection hook (MIT, stevesarmiento/svela-prod)
 * minus its bottom-nav bridge — the Lists tab renders a standalone
 * SelectionDock instead.
 */

/**
 * Thrown by `removeSelected` implementations when a bulk removal partially
 * succeeds (per-mint fan-out), so the toast can say exactly how many rows
 * were removed vs failed.
 */
export class BulkRemoveError extends Error {
    readonly removedCount: number;
    readonly failedCount: number;

    constructor(args: { removedCount: number; failedCount: number }) {
        super(`Removed ${args.removedCount}, failed ${args.failedCount}`);
        this.name = 'BulkRemoveError';
        this.removedCount = args.removedCount;
        this.failedCount = args.failedCount;
    }
}

/**
 * Hover-revealed row-selection motion (same implementation as svela's token
 * tables): the checkbox sits absolutely at the cell's left edge and slides in
 * while the cell content shifts right. When any row is selected the reveal
 * state is locked open for all rows (selection mode).
 */
export const SELECT_CELL_VARIANTS = {
    rest: {},
    revealed: {},
} as const;

export const SELECT_CHECKBOX_VARIANTS = {
    rest: { opacity: 0, x: -20, pointerEvents: 'none' as const },
    revealed: { opacity: 1, x: 0, pointerEvents: 'auto' as const },
} as const;

export const SELECT_CONTENT_VARIANTS = {
    rest: { x: 0, opacity: 1 },
    revealed: { x: 40, opacity: 0.9 },
} as const;

const EASE_IN_OUT_CUBIC = [0.65, 0, 0.35, 1] as const;

/** Tween used by the hover-reveal checkbox/content slide. */
export function useSelectRevealTransition() {
    const shouldReduceMotion = useReducedMotion();
    return useMemo(
        () => ({
            type: 'tween' as const,
            duration: shouldReduceMotion ? 0 : 0.2,
            ease: EASE_IN_OUT_CUBIC,
        }),
        [shouldReduceMotion],
    );
}

export interface ListSelection {
    selected: Set<string>;
    handleSelect: (mint: string, selected: boolean) => void;
    handleSelectAll: (checked: boolean, mints?: string[]) => void;
    handleRemoveSelected: () => Promise<void>;
    clear: () => void;
    isRemoving: boolean;
    hasSelected: boolean;
}

export function useListSelection({
    /** Perform the actual bulk removal for the selected mints; throw on failure. */
    removeSelected,
}: {
    removeSelected: (mints: string[]) => Promise<void>;
}): ListSelection {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [isRemoving, setIsRemoving] = useState(false);

    const handleSelect = useCallback((mint: string, isSelected: boolean) => {
        setSelected(previous => {
            const next = new Set(previous);
            if (isSelected) next.add(mint);
            else next.delete(mint);
            return next;
        });
    }, []);

    const handleSelectAll = useCallback((checked: boolean, mints?: string[]) => {
        setSelected(checked && mints ? new Set(mints) : new Set());
    }, []);

    const clear = useCallback(() => {
        setSelected(previous => (previous.size > 0 ? new Set<string>() : previous));
    }, []);

    const handleRemoveSelected = useCallback(async () => {
        const mints = Array.from(selected);
        if (mints.length === 0) return;
        setIsRemoving(true);
        try {
            await removeSelected(mints);
            setSelected(new Set());
            toast.success(`Removed ${mints.length} token${mints.length === 1 ? '' : 's'}`);
        } catch (error) {
            if (error instanceof BulkRemoveError && error.removedCount > 0) {
                // Partial success: keep the selection (removed mints get pruned
                // as data refetches) and report exact counts.
                toast.error(`Removed ${error.removedCount}, failed ${error.failedCount}`, {
                    description: 'Some tokens could not be removed — try again.',
                });
            } else {
                toast.error('Failed to remove selected tokens');
            }
        } finally {
            setIsRemoving(false);
        }
    }, [selected, removeSelected]);

    return {
        selected,
        handleSelect,
        handleSelectAll,
        handleRemoveSelected,
        clear,
        isRemoving,
        hasSelected: selected.size > 0,
    };
}
