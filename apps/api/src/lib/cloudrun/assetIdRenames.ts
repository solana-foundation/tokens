import type { Effect } from 'effect';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

/** An admin rename: `from` is the former asset id (lowercased), `to` the current one. */
export type AssetIdRename = { from: string; to: string };
export type ListAssetIdRenamesResult = AssetIdRename[];

export function listAssetIdRenames(): Effect.Effect<ListAssetIdRenamesResult, CloudRunError> {
    return cloudRunQuery<ListAssetIdRenamesResult>('assets', 'listAssetIdRenames', {});
}
