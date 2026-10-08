import { Effect } from 'effect';

import { tapErrorAndDefault } from '@tokens/effect';
import { getProviderTokenMetadataByMints, type ProviderTokenMetadata } from '@/lib/birdeye-search';
import { tokensGetByAddress, variantMarketsGetLatestByMints } from '@/lib/cloudrun';

import { optionalSymbol, optionalText } from './_asset-helpers';

/**
 * Display identity for a `solana-<mint>` singleton: a mint that is not a
 * curated variant and so has no asset document to take `name`/`symbol` from.
 *
 * Source order, cheapest first:
 *  1. legacy `tokens` row — only populated for mints the old token-price cron
 *     or the curated write-through has seen;
 *  2. variant-market snapshot — present when the mint was ever curated or
 *     warmed; a `touch`-only row (no symbol/name) counts as missing;
 *  3. live provider metadata — one bounded Birdeye call, same exposure the v2
 *     list hydration already has. Only reached when both caches miss, and the
 *     calling routes cache their responses, so a hot mint pays this once.
 *
 * Never fails: every error resolves to the next source, and `null` means no
 * source knew the mint.
 */
export interface SingletonIdentity {
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    logoURI: string | null;
    source: 'tokens' | 'variant_market' | 'provider';
}

export interface IdentityLike {
    symbol?: string | null | undefined;
    name?: string | null | undefined;
    decimals?: number | null | undefined;
    logoURI?: string | null | undefined;
    logoUri?: string | null | undefined;
}

export interface SingletonIdentityDeps {
    loadToken: (mint: string) => Effect.Effect<IdentityLike | null, unknown>;
    loadVariantMarket: (mint: string) => Effect.Effect<IdentityLike | null, unknown>;
    loadProviderMetadata: (mint: string) => Effect.Effect<ProviderTokenMetadata | null, unknown>;
}

export interface SingletonIdentityOptions {
    /**
     * A variant-market snapshot the caller already fetched for this mint
     * (`null` when it fetched and found none). Skips the second lookup.
     */
    variantMarket?: IdentityLike | null;
}

const defaultDeps: SingletonIdentityDeps = {
    loadToken: mint => tokensGetByAddress({ address: mint }),
    loadVariantMarket: mint =>
        variantMarketsGetLatestByMints({ mints: [mint] }).pipe(Effect.map(rows => rows[0]?.market ?? null)),
    loadProviderMetadata: mint =>
        getProviderTokenMetadataByMints([mint]).pipe(
            Effect.map(items => items.find(item => item.address === mint) ?? items[0] ?? null),
        ),
};

function finiteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toIdentity(like: IdentityLike | null | undefined, source: SingletonIdentity['source']): SingletonIdentity | null {
    if (!like) return null;
    const symbol = optionalSymbol(like.symbol);
    const name = optionalText(like.name);
    // Identity needs at least a symbol; a snapshot with neither is a touch row.
    if (!symbol && !name) return null;
    return {
        symbol,
        name,
        decimals: finiteOrNull(like.decimals),
        logoURI: optionalText(like.logoURI) ?? optionalText(like.logoUri),
        source,
    };
}

export function loadSingletonIdentity(
    mint: string,
    options: SingletonIdentityOptions = {},
    deps: SingletonIdentityDeps = defaultDeps,
): Effect.Effect<SingletonIdentity | null, never> {
    return Effect.gen(function* () {
        const token = yield* deps
            .loadToken(mint)
            .pipe(tapErrorAndDefault('assets.singletonIdentity.token', null, { mint }));
        const fromToken = toIdentity(token, 'tokens');
        if (fromToken) return fromToken;

        const market =
            options.variantMarket !== undefined
                ? options.variantMarket
                : yield* deps
                      .loadVariantMarket(mint)
                      .pipe(tapErrorAndDefault('assets.singletonIdentity.variantMarket', null, { mint }));
        const fromMarket = toIdentity(market, 'variant_market');
        if (fromMarket) return fromMarket;

        const provider = yield* deps
            .loadProviderMetadata(mint)
            .pipe(tapErrorAndDefault('assets.singletonIdentity.provider', null, { mint }));
        return toIdentity(provider, 'provider');
    });
}
