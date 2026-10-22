/**
 * Issuance: whether a variant is the supply an asset issued on that chain, or
 * a claim on supply that lives somewhere else. It drives what counts toward
 * supply, market cap and FDV in the v2 API's `chainStats` / `aggregate`.
 *
 * - `native`     the issuer's own deployment; counted.
 * - `bridged`    a bridge's claim on supply issued on another chain; not counted.
 * - `wrapped`    a wrapper's claim on the underlying (WBTC, WETH, wSOL); not counted.
 * - `derivative` a token whose value derives from the asset but is not the
 *                asset's supply (liquid staking tokens, ETF shares, leveraged
 *                and basket products); not counted.
 *
 * Precedence: an explicit `issuance:<x>` tag (admin-set) wins, then the
 * curated override table keyed `<chain>:<address>`, then the variant kind.
 * CoinGecko's home-platform field is deliberately not an input: it records
 * where CoinGecko first listed a coin, not where it is issued.
 */
import { CHAINS, type ChainKind } from './chains';
import { ISSUANCE_OVERRIDES } from './data/issuance-overrides';

export const VARIANT_ISSUANCE = ['native', 'bridged', 'wrapped', 'derivative'] as const;
export type VariantIssuance = (typeof VARIANT_ISSUANCE)[number];

export function isVariantIssuance(value: unknown): value is VariantIssuance {
    return typeof value === 'string' && (VARIANT_ISSUANCE as readonly string[]).includes(value);
}

/** Kinds that represent exposure to the asset rather than its supply. */
export const DERIVATIVE_KINDS: ReadonlySet<string> = new Set(['yield', 'lst', 'etf', 'leveraged', 'basket']);

export const ISSUANCE_TAG_PREFIX = 'issuance:';

/** `<chain>:<address>` with EVM addresses lowercased, the key of `ISSUANCE_OVERRIDES`. */
export function issuanceOverrideKey(chain: ChainKind, address: string): string {
    const normalized = CHAINS[chain]?.family === 'evm' ? address.toLowerCase() : address;
    return `${chain}:${normalized}`;
}

export function issuanceFromKind(kind: string): VariantIssuance {
    if (kind === 'bridged') return 'bridged';
    if (kind === 'wrapped') return 'wrapped';
    if (DERIVATIVE_KINDS.has(kind)) return 'derivative';
    return 'native';
}

export function resolveVariantIssuance(variant: {
    chain: ChainKind;
    address: string;
    kind: string;
    tags: readonly string[];
}): VariantIssuance {
    for (const tag of variant.tags) {
        if (!tag.startsWith(ISSUANCE_TAG_PREFIX)) continue;
        const value = tag.slice(ISSUANCE_TAG_PREFIX.length);
        if (isVariantIssuance(value)) return value;
    }
    const override = ISSUANCE_OVERRIDES[issuanceOverrideKey(variant.chain, variant.address)];
    if (override) return override.issuance;
    return issuanceFromKind(variant.kind);
}
