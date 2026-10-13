import type {
    SolanaDataAssetResult,
    SolanaDataAssetsListResult,
} from '../../../../cloudrun-assets/src/handlers/solanaDataReads';

import type { Effect } from 'effect';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

export type { SolanaDataAssetResult, SolanaDataAssetsListResult };

export type SolanaDataAssetsListArgs = {
    limit?: number;
    offset?: number;
    group?: string;
    category?: string;
    class?: string;
};

/** Project Canon asset registry rows (`solana_data_assets_latest`), upstream order, DB-resolved identity. */
export function solanaDataAssetsList(
    args: SolanaDataAssetsListArgs = {},
): Effect.Effect<SolanaDataAssetsListResult, CloudRunError> {
    return cloudRunQuery<SolanaDataAssetsListResult>('assets', 'solanaDataAssetsList', { ...args });
}
