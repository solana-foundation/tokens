'use client';

import * as React from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';

import { cn } from '@tokens/ui/cn';
import {
    Drawer,
    DrawerClose,
    DrawerContent,
    DrawerDescription,
    DrawerFooter,
    DrawerHeader,
    DrawerTitle,
} from '@tokens/ui/drawer';

export interface MobileDetailStat {
    label: string;
    value: React.ReactNode;
}

export interface MobileDetailAction {
    label: string;
    href?: string;
    onClick?: () => void;
}

/**
 * The bottom sheet a phone list row opens: identity header, a page-specific
 * hero (price, chart…), a short label/value list, and one full-width action
 * when the row has somewhere to go. Shared by the home table and the registry
 * so both lists feel the same.
 */
export function MobileDetailDrawer({
    open,
    onOpenChange,
    logo,
    title,
    subtitle,
    children,
    stats,
    action,
    secondary,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    logo: React.ReactNode;
    title: string;
    subtitle?: string;
    children?: React.ReactNode;
    stats: MobileDetailStat[];
    action?: MobileDetailAction;
    /** A quiet text link under the action (or alone when there is no action). */
    secondary?: MobileDetailAction;
}) {
    return (
        <Drawer open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
            <DrawerContent className="border-border-light">
                <DrawerHeader className="px-6 pb-3 pt-4 text-left">
                    <div className="flex items-center gap-3">
                        <span className="shrink-0">{logo}</span>
                        <div className="min-w-0 flex-1">
                            <DrawerTitle className="truncate text-[18px] font-semibold leading-tight text-text-extra-high">
                                {title}
                            </DrawerTitle>
                            {subtitle ? (
                                <DrawerDescription className="mt-0.5 truncate text-[13px] font-medium text-text-low">
                                    {subtitle}
                                </DrawerDescription>
                            ) : (
                                <DrawerDescription className="sr-only">{title}</DrawerDescription>
                            )}
                        </div>
                        <DrawerClose
                            aria-label="Close"
                            className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border-medium bg-white text-text-medium transition-colors hover:bg-gray-50/60 hover:text-text-extra-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium"
                        >
                            <X className="size-4" aria-hidden />
                        </DrawerClose>
                    </div>
                </DrawerHeader>

                <div className="min-h-0 overflow-y-auto px-6 pb-2">
                    {children}
                    {stats.length > 0 ? (
                        <dl className="mt-4 divide-y divide-border-extra-light border-t border-border-extra-light">
                            {stats.map(stat => (
                                <div key={stat.label} className="flex items-center justify-between gap-4 py-3">
                                    <dt className="text-[14px] text-text-low">{stat.label}</dt>
                                    <dd className="text-[14px] font-medium tabular-nums text-text-extra-high">
                                        {stat.value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    ) : null}
                </div>

                {action || secondary ? (
                    <DrawerFooter className="gap-3 px-6 pb-2 pt-2">
                        {action ? <ActionButton action={action} /> : null}
                        {secondary ? (
                            <button
                                type="button"
                                onClick={secondary.onClick}
                                className="mx-auto text-[13px] font-medium text-text-low underline-offset-4 hover:text-text-extra-high hover:underline"
                            >
                                {secondary.label}
                            </button>
                        ) : null}
                    </DrawerFooter>
                ) : null}
            </DrawerContent>
        </Drawer>
    );
}

const ACTION_CLASS =
    'inline-flex h-12 w-full items-center justify-center rounded-full bg-text-extra-high px-6 text-[15px] font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium';

function ActionButton({ action }: { action: MobileDetailAction }) {
    if (action.href) {
        return (
            <Link href={action.href} prefetch={false} onClick={action.onClick} className={cn(ACTION_CLASS)}>
                {action.label}
            </Link>
        );
    }
    return (
        <button type="button" onClick={action.onClick} className={ACTION_CLASS}>
            {action.label}
        </button>
    );
}
