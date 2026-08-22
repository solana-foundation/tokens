'use client';

import { useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { Button } from '@tokens/ui/button';
import { Checkbox } from '@tokens/ui/checkbox';
import { Spinner } from '@tokens/ui/spinner';

import { TrashCanIcon } from './icons';
import type { ListSelection } from './use-list-selection';


/**
 * Floating multi-select dock, styled after svela's bottom-nav selection pill
 * (MIT, stevesarmiento/svela-prod) but standalone: appears bottom-center
 * whenever rows are selected, offers select-all + bulk Remove, and Escape
 * exits selection mode.
 */
export function SelectionDock({
    selection,
    totalCount,
    allMints,
}: {
    selection: ListSelection;
    totalCount: number;
    allMints: string[];
}) {
    const { selected, hasSelected, handleSelectAll, handleRemoveSelected, clear, isRemoving } = selection;
    const shouldReduceMotion = useReducedMotion();

    // Escape exits selection mode (unless a removal is mid-flight).
    useEffect(() => {
        if (!hasSelected) return;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key !== 'Escape' || isRemoving) return;
            event.preventDefault();
            clear();
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [hasSelected, isRemoving, clear]);

    return (
        <AnimatePresence>
            {hasSelected && (
                <div className="pointer-events-none fixed bottom-8 left-0 right-0 z-50 flex justify-center px-4">
                    <motion.div
                        initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.95, y: 8 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={shouldReduceMotion ? undefined : { opacity: 0, scale: 0.95, y: 8 }}
                        transition={{ type: 'tween', duration: 0.2, ease: [0.65, 0, 0.35, 1] }}
                        className="pointer-events-auto flex h-[56px] w-[440px] max-w-[calc(100vw-2rem)] items-center rounded-full bg-zinc-800 px-2 py-1 shadow-[0_3px_8px_rgba(0,0,0,0.2),0_2px_4px_rgba(0,0,0,0.1)]"
                    >
                        <div className="flex h-full w-full items-center justify-between px-4">
                            <div className="flex items-center gap-3">
                                <Checkbox
                                    // Dark pill: the default checked fill (bg-primary) would
                                    // disappear against zinc-800, so invert to white-on-dark.
                                    className="border-white/25 bg-white/10 hover:border-white/40 hover:bg-white/20 focus-visible:ring-white/30 data-[state=checked]:border-white data-[state=checked]:bg-white data-[state=checked]:text-zinc-900 data-[state=checked]:hover:bg-white/90"
                                    checked={selected.size === totalCount && totalCount > 0}
                                    onCheckedChange={checked => handleSelectAll(checked === true, allMints)}
                                    aria-label="Select all tokens"
                                />
                                <span className="font-berkeley-mono text-xs font-medium text-white">
                                    {selected.size} of {totalCount} selected
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button
                                    onClick={() => void handleRemoveSelected()}
                                    disabled={selected.size === 0 || isRemoving}
                                    variant="destructive"
                                    size="sm"
                                    className="h-7 rounded-full px-2 !pr-3 text-xs text-white"
                                >
                                    {isRemoving ? (
                                        <span className="flex items-center gap-1.5 text-white">
                                            <Spinner size="sm" />
                                            Removing…
                                        </span>
                                    ) : (
                                        <span className="flex items-center gap-1.5 text-white">
                                            <TrashCanIcon className="size-4" />
                                            Remove
                                        </span>
                                    )}
                                </Button>
                                <Button
                                    onClick={clear}
                                    disabled={isRemoving}
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 rounded-full px-2.5 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
                                >
                                    Cancel
                                </Button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
