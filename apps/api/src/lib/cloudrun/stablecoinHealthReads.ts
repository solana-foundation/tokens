import type {
    PegHealthRead,
    StablecoinHealthEntry,
    StructuralHealthCategoryRead,
    StructuralHealthRead,
} from '../../../../cloudrun-assets/src/handlers/stablecoinHealthReads';

import type { Effect } from 'effect';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

export type { PegHealthRead, StablecoinHealthEntry, StructuralHealthCategoryRead, StructuralHealthRead };

export type StablecoinHealthGetByMintsArgs = { mints: readonly string[] };
export type StablecoinHealthGetByMintsResult = StablecoinHealthEntry[];

/**
 * Latest Webacy depeg observation + structural-health grade per mint
 * (`webacy_depeg_latest` / `webacy_structural_health_latest`). One entry per
 * requested mint in input order; the RPC caps `mints` at 200 (see
 * `STABLECOIN_HEALTH_MAX_MINTS` in cloudrun-assets), callers chunk above that.
 * Read on hot paths (asset detail, risk routes), so the timeout is short and
 * consumers fail open via `@/lib/stablecoin-health`.
 */
export function stablecoinHealthGetByMints(
    args: StablecoinHealthGetByMintsArgs,
): Effect.Effect<StablecoinHealthGetByMintsResult, CloudRunError> {
    return cloudRunQuery<StablecoinHealthGetByMintsResult>(
        'assets',
        'stablecoinHealthGetByMints',
        { mints: [...args.mints] },
        { maxRetries: 1, timeoutMs: 5_000 },
    );
}
