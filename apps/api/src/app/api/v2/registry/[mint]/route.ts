import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { BadRequestError, NotFoundError } from '@tokens/effect';
import { solanaDataAssetsGetByMint } from '@/lib/cloudrun';

import { toRegistryItem, type V2RegistryAssetResponse } from '../_shared';

/**
 * GET /api/v2/registry/{mint} — one registry asset: the same item shape as the
 * list plus `upstream`, the data.solana.com row exactly as the data team
 * delivered it (their snake_case keys, numerics as strings), and the sync and
 * provider-fallback metadata. tokens.xyz's /registry "Response" sheet shows this.
 */

interface RouteCtx {
    params: Promise<{ mint: string }>;
}

const STALE_TTL_SECONDS = 60 * 60;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const GET = route(
    (_request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const { mint: rawMint } = yield* Effect.tryPromise(() => ctx.params);
            const mint = rawMint.trim();
            if (!MINT_RE.test(mint)) {
                return yield* Effect.fail(
                    new BadRequestError({ message: 'mint must be a base58 Solana mint address' }),
                );
            }

            const main = Effect.gen(function* () {
                const detail = yield* solanaDataAssetsGetByMint({ mint });
                if (!detail) {
                    return yield* Effect.fail(
                        new NotFoundError({ message: 'Asset not in registry', resource: 'registry_asset' }),
                    );
                }
                const response: V2RegistryAssetResponse = {
                    ...toRegistryItem(detail),
                    upstream: detail.upstream,
                    generatedAt: detail.generatedAt,
                    syncedAt: detail.syncedAt,
                    provider: detail.provider,
                };
                return response;
            });

            // Last-good per mint; a 404 is a real answer and propagates (never cached as good).
            return yield* withStaleFallback(
                {
                    operation: 'v2.registry.asset',
                    cacheKey: `v2:registry:asset:${mint}`,
                    ttlSeconds: STALE_TTL_SECONDS,
                },
                main,
            );
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 300, staleWhileRevalidate: 600 } },
);
