'use client';

import { useState } from 'react';

import { CopyButton } from '@/components/copy-button';
import { MobileDetailDrawer } from '@/components/mobile-detail-drawer';
import { SplitBadge } from '@/components/split-badge';
import { formatLargeNumber } from '@/lib/format';
import type { RegistryRow } from './lib/types';
import { AddressLink } from './registry-cells';
import { displayNameOf, tokenHref } from './lib/registry-row';
import { RegistryTokenLogo } from './registry-token-logo';

/**
 * The drawer a registry phone row opens: the taxonomy badge, the mint
 * address, the three numbers, and "View more" only when the asset has a
 * tokens.xyz page.
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
    // Keep the last row mounted while the drawer animates closed (same as the home drawer).
    const [lastRow, setLastRow] = useState<RegistryRow | null>(row);
    if (row && row !== lastRow) setLastRow(row);
    const shown = row ?? lastRow;
    if (!shown) return null;

    const taxonomy = [shown.group, shown.category, shown.assetClass].filter((value): value is string => !!value);

    return (
        <MobileDetailDrawer
            open={row !== null}
            onOpenChange={onOpenChange}
            logo={<RegistryTokenLogo row={shown} size={40} />}
            title={displayNameOf(shown)}
            subtitle={shown.name ? shown.symbol : undefined}
            stats={[
                { label: 'Allium', value: formatLargeNumber(shown.alliumValueUsd) },
                { label: 'RWA.xyz', value: formatLargeNumber(shown.rwaValueUsd) },
                { label: 'Market cap', value: formatLargeNumber(shown.marketCapUsd) },
            ]}
            action={shown.hasTokenPage ? { label: 'View more', href: tokenHref(shown) } : undefined}
            secondary={{
                label: 'View API response',
                onClick: () => {
                    onOpenChange(false);
                    onOpenResponse(shown);
                },
            }}
        >
            <div className="flex flex-col gap-3 pt-1">
                {taxonomy.length > 0 ? (
                    <div className="flex">
                        <SplitBadge segments={taxonomy} title={taxonomy.join(' · ')} />
                    </div>
                ) : null}
                <div className="flex items-center gap-2">
                    <AddressLink address={shown.mintAddress} />
                    <CopyButton
                        textToCopy={shown.mintAddress}
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
