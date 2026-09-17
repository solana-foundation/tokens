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
