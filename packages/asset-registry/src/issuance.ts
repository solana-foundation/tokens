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

export interface IssuanceInput {
    chain: ChainKind;
    address: string;
    kind: string;
    tags: readonly string[];
}

/** Where a variant's issuance came from, in precedence order. */
export type IssuanceSource = 'tag' | 'override' | 'kind';

export function resolveVariantIssuanceDetailed(variant: IssuanceInput): { issuance: VariantIssuance; source: IssuanceSource } {
    for (const tag of variant.tags) {
        if (!tag.startsWith(ISSUANCE_TAG_PREFIX)) continue;
        const value = tag.slice(ISSUANCE_TAG_PREFIX.length);
        if (isVariantIssuance(value)) return { issuance: value, source: 'tag' };
    }
    const override = ISSUANCE_OVERRIDES[issuanceOverrideKey(variant.chain, variant.address)];
    if (override) return { issuance: override.issuance, source: 'override' };
    return { issuance: issuanceFromKind(variant.kind), source: 'kind' };
}

export function resolveVariantIssuance(variant: IssuanceInput): VariantIssuance {
    return resolveVariantIssuanceDetailed(variant).issuance;
}

export interface AssetIssuanceOptions {
    /** The asset's category; ETF shares under a `commodity` are never the commodity itself. */
    category?: string | null;
}

/** Categories whose asset is a thing (an ounce, a barrel) no tokenized fund share can be the supply of. */
export const NEVER_STANDALONE_PRODUCT_CATEGORIES: ReadonlySet<string> = new Set(['commodity']);

/**
 * Issuance across one asset's variants, in input order.
 *
 * A derivative kind marks a claim on *another* asset's supply: an LST under
 * `solana`, an ETF-share token under `gold`. When an asset has no deployment
 * of any other class (a standalone treasury fund whose only variant is
 * `yield`, a leveraged ETF registered as its own asset, a basket) those
 * variants are not derivatives of anything else: they are the asset, and
 * their supply is its supply. So when every variant resolves to `derivative`
 * from its kind, they are all promoted to `native`. Explicit `issuance:` tags
 * and curated overrides are never promoted: an operator who marked a variant
 * `derivative` meant it. A single native, bridged or wrapped sibling keeps the
 * derivative class for everyone else (an LST next to SOL stays derivative).
 * A `commodity` is never promoted: `silver`'s only token may be an ETF share,
 * but the asset is the metal and its supply comes from the per-ounce reference.
 */
export function resolveAssetIssuance(
    variants: readonly IssuanceInput[],
    options: AssetIssuanceOptions = {},
): VariantIssuance[] {
    const detailed = variants.map(resolveVariantIssuanceDetailed);
    const standaloneProduct =
        detailed.length > 0 &&
        !NEVER_STANDALONE_PRODUCT_CATEGORIES.has(options.category ?? '') &&
        detailed.every(entry => entry.issuance === 'derivative');
    return detailed.map(entry =>
        standaloneProduct && entry.source === 'kind' ? 'native' : entry.issuance,
    );
}
