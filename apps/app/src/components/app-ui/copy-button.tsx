'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
    textToCopy: string;
    displayText?: string | React.ReactNode;
    className?: string;
    iconClassName?: string;
    iconClassNameCheck?: string;
    showText?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    onCopied?: () => void;
}

export function CopyButton({
    textToCopy,
    displayText,
    className,
    iconClassName,
    iconClassNameCheck,
    showText = true,
    disabled,
    ariaLabel,
    onCopied,
}: CopyButtonProps) {
    const [copied, setCopied] = useState(false);
    const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const computedAriaLabel = ariaLabel ?? (showText ? undefined : 'Copy to clipboard');

    useEffect(() => {
        return () => {
            if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
        };
    }, []);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(textToCopy);
            setCopied(true);
            onCopied?.();
            if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
            resetTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
        } catch (error) {
            console.error('Failed to copy:', error);
        }
    };

    return (
        <button
            type="button"
            onClick={handleCopy}
            disabled={disabled}
            aria-label={computedAriaLabel}
            className={cn(
                'group flex items-center justify-center gap-2 hover:opacity-80 hover:cursor-pointer',
                className,
                disabled && 'opacity-50 cursor-not-allowed',
            )}
        >
            {showText && (
                <span className="font-berkeley-mono text-sm font-medium text-text-extra-high">
                    {displayText || textToCopy}
                </span>
            )}
            <div className="relative h-3.5 w-3.5 flex items-center justify-center">
                <AnimatePresence initial={false}>
                    {copied ? (
                        <motion.div
                            key="checkmark"
                            className="absolute inset-0 flex items-center justify-center"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            transition={{ duration: 0.18, ease: 'easeOut' }}
                        >
                            <Check
                                className={cn('h-3.5 w-3.5 text-green-500 dark:text-green-300', iconClassNameCheck)}
                            />
                        </motion.div>
                    ) : (
                        <motion.div
                            key="copy"
                            className="absolute inset-0 flex items-center justify-center"
                            initial={{ opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            transition={{ duration: 0.18, ease: 'easeOut' }}
                        >
                            <Copy
                                className={cn(
                                    'h-3.5 w-3.5 text-text-extra-low group-hover:text-text-medium',
                                    iconClassName,
                                )}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </button>
    );
}
