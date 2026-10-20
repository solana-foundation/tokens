import type { LaunchpadTokenResult } from '../../../../cloudrun-assets/src/handlers/launchpadReads';

import type { Effect } from 'effect';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

export type { LaunchpadTokenResult };

export type ListByQuoteMintsArgs = { quoteMints: string[]; limit?: number };
export type ListByQuoteMintsResult = LaunchpadTokenResult[];

export function launchpadListByQuoteMints(
    args: ListByQuoteMintsArgs,
): Effect.Effect<ListByQuoteMintsResult, CloudRunError> {
    return cloudRunQuery<ListByQuoteMintsResult>('assets', 'launchpadListByQuoteMints', { ...args });
}

export type ApprovedMintsArgs = { mints: string[] };
export type ApprovedMintsResult = { mints: string[] };

/** Which of `mints` are admin-approved launch coins still active in the feed (see cloudrun-assets `approvedMints`). */
export function launchpadApprovedMints(args: ApprovedMintsArgs): Effect.Effect<ApprovedMintsResult, CloudRunError> {
    return cloudRunQuery<ApprovedMintsResult>('assets', 'launchpadApprovedMints', { ...args });
}
