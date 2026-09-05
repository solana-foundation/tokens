import type { Effect } from 'effect';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

/** Mirrors `handlers/curatedMembershipReads.ts` in cloudrun-assets. */
export type CuratedMembershipEntry = {
    assetId: string | null;
    listSlugs: string[];
    symbol: string | null;
};

export type CuratedMembershipSnapshot = {
    loadedAt: number;
    mintsByList: Record<string, string[]>;
    allMints: string[];
    entriesByMint: Record<string, CuratedMembershipEntry>;
};

/** Effective DB-backed curated membership (the single membership authority). */
export function curatedMembershipGetSnapshot(): Effect.Effect<CuratedMembershipSnapshot, CloudRunError> {
    return cloudRunQuery<CuratedMembershipSnapshot>('assets', 'curatedMembershipGetSnapshot', {});
}
