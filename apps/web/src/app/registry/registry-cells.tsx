'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

import { cn, truncateAddress } from '@tokens/ui/cn';
import { Button } from '@tokens/ui/button';
import { formatLargeNumber } from '@/lib/format';
import { tokenHref } from './lib/registry-row';
import type { RegistryRow } from './lib/types';

/** Cell renderers shared by the desktop table and the phone list (registry-mobile-list.tsx). */
/** Asset-page link when the Tokens API knows the mint, otherwise a plain block. */
export function TokenLink({
    row,
    className,
    children,
}: {
    row: RegistryRow;
    className?: string;
    children: React.ReactNode;
}) {
    if (!row.hasTokenPage) return <div className={className}>{children}</div>;
    return (
        <Link href={tokenHref(row)} prefetch={false} className={cn(className, 'hover:opacity-80 transition-opacity')}>
            {children}
        </Link>
    );
}

export function AddressLink({ address, className }: { address: string; className?: string }) {
    return (
        <a
            href={`https://explorer.solana.com/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
                'inline-flex items-center gap-1 font-mono text-[13px] text-text-medium transition-colors hover:text-text-extra-high',
                className,
            )}
            title={address}
        >
            {truncateAddress(address)}
            <ArrowUpRight className="h-3 w-3 text-text-extra-low" />
        </a>
    );
}

export function EmptyValue() {
    return <span className="block text-[14px] text-text-extra-low">—</span>;
}

export function TextCell({ value }: { value: string | null }) {
    return value ? <span className="whitespace-nowrap text-[14px] text-text-high">{value}</span> : <EmptyValue />;
}

export function UsdCell({ value }: { value: number | null }) {
    return value == null ? (
        <EmptyValue />
    ) : (
        <span className="block text-[14px] text-[#2D2D2D] font-medium tabular-nums">{formatLargeNumber(value)}</span>
    );
}

const PROVIDERS = [
    { label: 'Allium', key: 'alliumValueUsd' },
    { label: 'RWA.xyz', key: 'rwaValueUsd' },
] as const satisfies ReadonlyArray<{ label: string; key: keyof RegistryRow }>;

/**
 * The one on-chain value cell: both providers, always both lines, so coverage
 * gaps read as a dimmed dash instead of a missing row. Sorting stays on the
 * coalesced `providerValueUsd`.
 */
export function ProviderValues({
    row,
    align = 'left',
    className,
}: {
    row: RegistryRow;
    align?: 'left' | 'right';
    className?: string;
}) {
    return (
        <dl
            className={cn(
                'grid grid-cols-[auto_auto] gap-x-2 gap-y-0.5 leading-tight tabular-nums',
                align === 'right' ? 'justify-end text-right' : 'justify-start',
                className,
            )}
        >
            {PROVIDERS.map(provider => {
                const value = row[provider.key];
                return (
                    <div key={provider.key} className="contents">
                        <dt className="min-w-[52px] self-center text-left text-[11px] font-medium text-text-extra-low">
                            {provider.label}
                        </dt>
                        <dd
                            className={cn(
                                'text-[14px] font-medium',
                                value == null ? 'text-text-extra-low' : 'text-[#2D2D2D]',
                            )}
                        >
                            {formatLargeNumber(value)}
                        </dd>
                    </div>
                );
            })}
        </dl>
    );
}

export function RegistryEmptyState({ onClear }: { onClear: () => void }) {
    return (
        <div className="px-6 py-12 text-center">
            <p className="text-text-low text-[14px] md:text-[16px]">No assets match your filters</p>
            <p className="text-text-extra-low text-[12px] md:text-[14px] mt-2">
                Try a different symbol, name, or mint address, or loosen a filter
            </p>
            <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4 h-9 rounded-full border-border-medium bg-white px-4 font-sans text-[13px] text-text-extra-high shadow-none hover:bg-gray-50/60"
                onClick={onClear}
            >
                Clear filters
            </Button>
        </div>
    );
}
