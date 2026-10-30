import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError, NotFoundError, SolanaAddress, decodeUnknownOrBadRequest } from '@tokens/effect';
import { getAsset, getVariantByMint, pickPrimaryVariantWithRanking, resolveAlias } from '@tokens/asset-registry';
import { buildSwapLinks, VENUE_IDS, type VenueId } from '@tokens/execution-links';

import { buildCuratedMintRank } from '../../../v1/assets/_asset-helpers';

const SUPPORTED_LINK_KINDS = ['swap'] as const;
type LinkKind = (typeof SUPPORTED_LINK_KINDS)[number];

const VALID_VENUE_IDS = new Set<string>(VENUE_IDS);
const VALID_LINK_KINDS = new Set<string>(SUPPORTED_LINK_KINDS);
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

// Registry data is static per deploy; the curated rank never changes at runtime.
const CURATED_MINT_RANK = buildCuratedMintRank();

function iconBaseUrl(): string {
    return (process.env.EXECUTION_LINKS_ICON_BASE_URL ?? 'https://tokens.xyz').replace(/\/+$/, '');
}

function absolutizeIcon(iconPath: string | null): string | null {
    if (!iconPath) return null;
    return iconPath.startsWith('/') ? `${iconBaseUrl()}${iconPath}` : iconPath;
}

function decodeCsvParam(args: {
    raw: string | null;
    key: string;
    valid: ReadonlySet<string>;
    validLabel: string;
}): Effect.Effect<string[] | null, BadRequestError> {
    if (args.raw == null) return Effect.succeed(null);
    const values = [...new Set(args.raw.split(',').map(value => value.trim()).filter(Boolean))];
    if (values.length === 0) {
        return Effect.fail(new BadRequestError({ message: `${args.key} must name at least one value` }));
    }
    const unknown = values.filter(value => !args.valid.has(value));
    if (unknown.length > 0) {
        return Effect.fail(
            new BadRequestError({
                message: `Unknown ${args.key} value(s): ${unknown.join(', ')}. Valid: ${args.validLabel}`,
            }),
        );
    }
    return Effect.succeed(values);
}

function resolveBuyMint(args: {
    mint: string | null;
    assetId: string | null;
}): Effect.Effect<string, BadRequestError | NotFoundError> {
    return Effect.gen(function* () {
        if (args.mint && args.assetId) {
            return yield* Effect.fail(new BadRequestError({ message: 'Provide either mint or assetId, not both' }));
        }
        if (args.mint) return args.mint;
        if (!args.assetId) {
            return yield* Effect.fail(new BadRequestError({ message: 'Missing required query param: mint or assetId' }));
        }

        const asset = getAsset(args.assetId) ?? resolveAlias(args.assetId);
        if (!asset) {
            return yield* Effect.fail(new NotFoundError({ message: `Unknown asset: ${args.assetId}` }));
        }
        const { variant } = pickPrimaryVariantWithRanking({ asset, mintRank: CURATED_MINT_RANK });
        if (!variant) {
            return yield* Effect.fail(new NotFoundError({ message: `Asset has no Solana variant: ${asset.assetId}` }));
        }
        return variant.mint;
    });
}

/**
 * GET /api/v2/execution/links — venue deep links for buying a token.
 *
 * Generic execution-link contract: every link carries a `kind`; this
 * deployment supports `swap` only (perps/pools extend the same shape later —
 * see `meta.kinds`). `primary` is our global venue recommendation, null when
 * filtered out. Output is deterministic from inputs + deployed code, so the
 * cache window is wide and no stale fallback is needed.
 */
export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const params = url.searchParams;

            const mint = params.get('mint')
                ? yield* decodeUnknownOrBadRequest(SolanaAddress, params.get('mint'), 'Invalid mint')
                : null;
            const assetId = params.get('assetId')?.trim() || null;
            const sellMint = params.get('sellMint')
                ? yield* decodeUnknownOrBadRequest(SolanaAddress, params.get('sellMint'), 'Invalid sellMint')
                : null;

            const venues = yield* decodeCsvParam({
                raw: params.get('venues'),
                key: 'venues',
                valid: VALID_VENUE_IDS,
                validLabel: VENUE_IDS.join(', '),
            });
            const kinds = yield* decodeCsvParam({
                raw: params.get('kinds'),
                key: 'kinds',
                valid: VALID_LINK_KINDS,
                validLabel: SUPPORTED_LINK_KINDS.join(', '),
            });

            const rawAmount = params.get('amount')?.trim() || null;
            if (rawAmount && !AMOUNT_PATTERN.test(rawAmount)) {
                return yield* Effect.fail(
                    new BadRequestError({ message: 'Invalid amount: expected a positive decimal string' }),
                );
            }

            const buyMint = yield* resolveBuyMint({ mint, assetId });

            const includeSwap = !kinds || kinds.includes('swap');
            const result = includeSwap
                ? buildSwapLinks({
                      buyMint,
                      ...(sellMint ? { sellMint } : {}),
                      ...(rawAmount ? { amount: rawAmount } : {}),
                      ...(venues ? { venues: venues as VenueId[] } : {}),
                  })
                : null;

            const variantMatch = getVariantByMint(result?.buyMint ?? buyMint);

            return {
                buyMint: result?.buyMint ?? buyMint,
                sellMint: result?.sellMint ?? null,
                asset: variantMatch
                    ? {
                          assetId: variantMatch.asset.assetId,
                          symbol: variantMatch.variant.symbol ?? variantMatch.asset.symbol ?? null,
                      }
                    : null,
                primary: result?.primary ?? null,
                links: (result?.venues ?? []).map(venue => ({
                    id: venue.id,
                    name: venue.name,
                    kind: 'swap' as LinkKind,
                    venueType: venue.venueType,
                    url: venue.url,
                    iconUrl: absolutizeIcon(venue.iconPath),
                })),
                meta: { kinds: [...SUPPORTED_LINK_KINDS] },
            };
        }),
    { platform: { requiredScopes: ['execution:read'] }, cache: { maxAge: 3600 } },
);
