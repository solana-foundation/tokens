import { Effect } from 'effect';

import { variantMarketsGetLatestByMints, type CloudRunError } from '@/lib/cloudrun';
import { cleanTokenName, getTokenLogoURL } from '@/lib/logo-overrides';

export interface PoolProtocolTokenConfig {
    source: string;
    address: string;
    symbol: string;
    name: string;
    logoURI?: string;
    match: RegExp;
}

export const POOL_PROTOCOL_TOKENS: readonly PoolProtocolTokenConfig[] = [
    {
        source: 'orca',
        match: /orca/i,
        address: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
        symbol: 'ORCA',
        name: 'Orca',
    },
    {
        source: 'raydium',
        match: /raydium/i,
        address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
        symbol: 'RAY',
        name: 'Raydium',
    },
    {
        source: 'meteora',
        match: /meteora/i,
        address: 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL',
        symbol: 'MET',
        name: 'Meteora',
    },
    {
        source: 'lifinity',
        match: /lifinity|lfinity/i,
        address: 'LFNTYraetVioAPnGJht4yNg2aUZFXR776cMeN9VMjXp',
        symbol: 'LFNTY',
        name: 'Lifinity',
    },
    {
        source: 'humidifi',
        match: /humidifi/i,
        address: 'WETZjtprkDMCcUxPi9PfWnowMRZkiGGHDb9rABuRZ2U',
        symbol: 'WET',
        name: 'WET',
    },
    {
        source: 'marinade',
        match: /marinade|marindade/i,
        address: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey',
        symbol: 'MNDE',
        name: 'Marinade',
    },
] as const;

export function getProtocolTokenFallback(sourceOrAddress: string): PoolProtocolTokenConfig | null {
    const value = sourceOrAddress.trim();
    if (!value) return null;
    return POOL_PROTOCOL_TOKENS.find(config => config.address === value || config.match.test(value)) ?? null;
}

/** Display fields for a market's protocol token (matches `TokenMarketToken` in `@/lib/birdeye`). */
export interface ProtocolTokenDisplay {
    address: string;
    decimals?: number;
    symbol?: string;
    icon?: string;
    name?: string;
}

/**
 * Resolve the protocol token (ORCA, RAY, ...) behind each market's `source`,
 * keyed by market address, with the latest variant-market metadata layered over
 * the static fallback. One batched Cloud Run read; runs in the caller's fiber.
 */
export function loadProtocolTokensByMarketAddress(
    markets: ReadonlyArray<{ address: string; source?: string }>,
): Effect.Effect<Record<string, ProtocolTokenDisplay | undefined>, CloudRunError> {
    const marketToMint: Array<{ marketAddress: string; mint: string }> = [];
    const mintToFallback = new Map<string, PoolProtocolTokenConfig>();

    for (const market of markets) {
        const config = market.source ? getProtocolTokenFallback(market.source) : null;
        if (!config) continue;

        marketToMint.push({ marketAddress: market.address, mint: config.address });
        mintToFallback.set(config.address, config);
    }

    const uniqueMints = Array.from(mintToFallback.keys());
    if (uniqueMints.length === 0) return Effect.succeed({});

    return variantMarketsGetLatestByMints({ mints: uniqueMints }).pipe(
        Effect.map(rows => {
            const marketByMint = new Map<string, (typeof rows)[number]['market']>();
            for (const row of rows) marketByMint.set(row.mint, row.market);

            const tokensByMint = new Map<string, ProtocolTokenDisplay | undefined>();
            for (const mint of uniqueMints) {
                const fallback = mintToFallback.get(mint);
                const market = marketByMint.get(mint) ?? null;
                if (!market) {
                    tokensByMint.set(mint, {
                        address: mint,
                        symbol: fallback?.symbol,
                        name: fallback?.name,
                        icon: undefined,
                    });
                    continue;
                }

                const symbol = market.symbol ?? fallback?.symbol ?? '???';
                const cleanedName = cleanTokenName(market.name);
                tokensByMint.set(mint, {
                    address: mint,
                    symbol,
                    name: cleanedName === 'Unknown' ? fallback?.name : cleanedName,
                    icon: getTokenLogoURL(symbol, market.logoURI),
                });
            }

            const tokensByMarket: Record<string, ProtocolTokenDisplay | undefined> = {};
            for (const { marketAddress, mint } of marketToMint) {
                tokensByMarket[marketAddress] = tokensByMint.get(mint);
            }
            return tokensByMarket;
        }),
    );
}
