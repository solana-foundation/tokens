import type {
    AssetRiskDoc,
    AssetSecurityDoc,
    GetLatestByMintsEntry,
} from '../../../../cloudrun-assets/src/handlers/assetRiskReads';

import type { Effect } from 'effect';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

export type { AssetRiskDoc, AssetSecurityDoc };

export type AssetRiskGetLatestByMintsArgs = { mints: string[] };
export type AssetRiskGetLatestByMintsResult = GetLatestByMintsEntry[];

/**
 * Stored Webacy-derived risk rows (holder concentration, mint time, LP lock,
 * authority flags) for curated/registry mints. `risk: null` = no row.
 */
export function assetRiskGetLatestByMints(
    args: AssetRiskGetLatestByMintsArgs,
): Effect.Effect<AssetRiskGetLatestByMintsResult, CloudRunError> {
    return cloudRunQuery<AssetRiskGetLatestByMintsResult>('assets', 'assetRiskGetLatestByMints', { ...args });
}
