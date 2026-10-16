import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { tapErrorAndDefault } from '@tokens/effect';
import { CHAIN_KINDS } from '@tokens/asset-registry/chains';
import { v2AssetsChains } from '@/lib/cloudrun';

import { toV2Chain, type V2ChainsResponse } from '../_shared-assets';

/**
 * GET /api/v2/chains — the chains the v2 asset surface covers, with their
 * CAIP-2 ids, explorer templates, capability flags and live variant counts.
 * The list comes from the registry's compiled CHAINS table (adding a chain is
 * a code change, never DDL); the counts come from the data layer and default
 * to null when it is unreachable so the metadata still serves.
 */
export const GET = route(
    (_request: Request) =>
        Effect.gen(function* () {
            const summary = yield* v2AssetsChains().pipe(tapErrorAndDefault('v2.chains.summary', null));
            const byId = new Map((summary?.chains ?? []).map(chain => [chain.id, chain] as const));
            const chains = CHAIN_KINDS.map(id =>
                toV2Chain(id, {
                    variantCount: byId.get(id)?.activeVariants ?? null,
                    assetCount: byId.get(id)?.assetCount ?? null,
                }),
            );
            const response: V2ChainsResponse = { chains, total: chains.length };
            return response;
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 3600, staleWhileRevalidate: 86400 } },
);
