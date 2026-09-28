import { Effect } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { loadAssetWithSelectedVariant } from '../../_asset-route-loader';
import { loadAssetRisk, toRiskDetails } from '../../_risk-loader';

export const GET = route(
    (request: Request, ctx: { params: Promise<{ assetId: string }>; platformAuth: PlatformAuthContext }) =>
        Effect.gen(function* () {
            const { assetId: rawAssetId } = yield* Effect.tryPromise(() => ctx.params);
            const loaded = yield* loadAssetWithSelectedVariant({ request, rawAssetId });
            return toRiskDetails(yield* loadAssetRisk(loaded, { operation: 'details', auth: ctx.platformAuth }));
        }),
    { platform: { requiredScopes: ['assets:read'] } },
);
