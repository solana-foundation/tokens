'use client';

import { CopyButton } from '@/components/copy-button';
import { MobileDetailDrawer } from '@/components/mobile-detail-drawer';
import { SplitBadge } from '@/components/split-badge';
import { formatLargeNumber } from '@/lib/format';
import type { RegistryRow } from './lib/types';
import { AddressLink, displayNameOf, tokenHref } from './registry-cells';
import { RegistryTokenLogo } from './registry-token-logo';

const PROVIDER_LABELS = { allium: 'Allium', rwa: 'RWA.xyz' } as const;

/**
 * The drawer a registry phone row opens: headline value with its source, the
 * taxonomy badge, the mint address, the three numbers, and "View more" only
 * when the asset has a tokens.xyz page.
 */
export function RegistryDetailDrawer({
    row,
    onOpenChange,
    onOpenResponse,
}: {
    row: RegistryRow | null;
    onOpenChange: (open: boolean) => void;
    onOpenResponse: (row: RegistryRow) => void;
}) {
    if (!row) return null;

    const headline =
        row.providerValueUsd != null && row.providerValueSource
            ? { value: row.providerValueUsd, caption: `on-chain value · ${PROVIDER_LABELS[row.providerValueSource]}` }
            : row.marketCapUsd != null
              ? { value: row.marketCapUsd, caption: 'market cap' }
              : null;
    const taxonomy = [row.group, row.category, row.assetClass].filter((value): value is string => !!value);

    return (
        <MobileDetailDrawer
            open
            onOpenChange={onOpenChange}
            logo={<RegistryTokenLogo row={row} size={40} />}
            title={displayNameOf(row)}
            subtitle={row.name ? row.symbol : undefined}
            stats={[
                { label: 'Allium', value: formatLargeNumber(row.alliumValueUsd) },
                { label: 'RWA.xyz', value: formatLargeNumber(row.rwaValueUsd) },
                { label: 'Market cap', value: formatLargeNumber(row.marketCapUsd) },
            ]}
            action={row.hasTokenPage ? { label: 'View more', href: tokenHref(row) } : undefined}
            secondary={{
                label: 'View API response',
                onClick: () => {
                    onOpenChange(false);
                    onOpenResponse(row);
                },
            }}
        >
            <div className="flex flex-col gap-1">
                <span className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-text-extra-high">
                    {headline ? formatLargeNumber(headline.value) : '—'}
                </span>
                <span className="text-[14px] text-text-low">{headline ? headline.caption : 'no value reported'}</span>
            </div>
            <div className="mt-4 flex flex-col gap-3">
                {taxonomy.length > 0 ? (
                    <div className="flex">
                        <SplitBadge segments={taxonomy} title={taxonomy.join(' · ')} />
                    </div>
                ) : null}
                <div className="flex items-center gap-2">
                    <AddressLink address={row.mintAddress} />
                    <CopyButton
                        textToCopy={row.mintAddress}
                        showText={false}
                        ariaLabel="Copy mint address"
                        className="size-6 rounded-md text-text-extra-low hover:text-text-medium"
                        iconClassName="size-3.5"
                    />
                </div>
            </div>
        </MobileDetailDrawer>
    );
}
