import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { v2AssetsGetMarketsByKeys } from '@/lib/cloudrun';

import { loadAdvisories } from '../_assets-loader';
import { buildStandaloneV2Variant, decodeKeysParam, type V2VariantsBatchResponse } from '../_shared-assets';

/**
 * GET /api/v2/variants?keys=<chain>:<address>,… — batch identity + market
 * lookup for up to 50 keys in request order. Keys the data layer does not
 * know come back in `missing` rather than failing the call. Each variant is
 * returned on its own (`rank` is null); the asset-level view is
 * /v2/assets/{assetId}.
 */
export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const keys = yield* decodeKeysParam(new URL(request.url).searchParams);
            const [entries, advisoriesByMint] = yield* Effect.all([
                v2AssetsGetMarketsByKeys({ keys: keys.map(({ chain, address }) => ({ chain, address })) }),
                loadAdvisories(),
            ], { concurrency: 'unbounded' });
            const byKey = new Map(entries.map(entry => [entry.key, entry] as const));
            const response: V2VariantsBatchResponse = { variants: [], missing: [], total: 0 };
            for (const { chain, address, key } of keys) {
                const entry = byKey.get(key);
                const owner = entry?.variants[0];
                if (!entry || !owner) {
                    response.missing.push({ key, chain, address });
                    continue;
                }
                response.variants.push(
                    buildStandaloneV2Variant({
                        request,
                        variant: owner,
                        market: entry.market,
                        advisoriesByMint,
                        canonicalSymbol: null,
                    }),
                );
            }
            response.total = response.variants.length;
            return response;
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 30, staleWhileRevalidate: 60 } },
);
