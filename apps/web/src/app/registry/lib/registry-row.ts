import { buildCoinHref } from '@/lib/coin-href';
import { cleanTokenName } from '@/lib/logo-overrides';
import type { RegistryRow } from './types';

/** Row-level helpers shared by the registry table, phone list and drawer. */

export function displayNameOf(row: RegistryRow): string {
    return row.name ? cleanTokenName(row.name) : row.symbol;
}

/**
 * Direct asset-page link (`/{assetId}?solana={mint}`), the same the home table builds;
 * the mint redirect only covers a cached payload from before the API carried assetId.
 */
export function tokenHref(row: RegistryRow): string {
    return row.assetId ? buildCoinHref(row.assetId, row.mintAddress) : `/token/${row.mintAddress}`;
}
