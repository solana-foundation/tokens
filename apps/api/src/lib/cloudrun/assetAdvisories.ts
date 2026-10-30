import type { Effect } from 'effect';
import type { AdvisorySource, AdvisoryStatus } from '@tokens/asset-registry';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

/** Mirrors `handlers/assetAdvisoriesReads.ts` in cloudrun-assets. */
export type AssetAdvisoryRow = {
    mint: string;
    status: AdvisoryStatus;
    reason: string;
    url: string | null;
    /** Unix ms when the current status was set. */
    since: number;
    /** Absent from cloudrun-assets builds that predate 0019. */
    source?: AdvisorySource;
};

export type AssetAdvisoriesListResult = {
    /** `max(updated_at)` over the live table (0 when empty) — bumps on every set/clear. */
    revision: number;
    advisories: AssetAdvisoryRow[];
};

/**
 * Every active admin advisory (`asset_variant_advisories`). The set is tiny
 * (<100 rows) and read on hot paths through the API-side cache in
 * `@/lib/advisories`; a short timeout keeps a cold-cache outage from
 * stalling read routes for the default 15s.
 */
export function assetAdvisoriesList(): Effect.Effect<AssetAdvisoriesListResult, CloudRunError> {
    return cloudRunQuery<AssetAdvisoriesListResult>(
        'assets',
        'assetAdvisoriesList',
        {},
        { maxRetries: 1, timeoutMs: 5_000 },
    );
}
