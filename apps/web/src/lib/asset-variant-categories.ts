import type { StockVariantTier, VariantKind } from '@tokens/asset-registry';
import { CHAINS, CHAIN_KINDS, isChainKind, type ChainKind } from '@tokens/asset-registry/chains';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

const PRE_IPO_TEXT_PATTERN = /pre[-\s]?stocks?|pre[-\s]?ipo/i;

export interface AssetVariantCategorySource {
    /** Address on `chain` (named `mint` for the Solana-era callers; absent chain = solana). */
    mint: string;
    chain?: ChainKind | string | null;
    kind?: VariantKind;
    tags?: readonly string[];
    label?: string | null;
    name?: string | null;
    symbol?: string | null;
    displayName?: string | null;
    displaySymbol?: string | null;
    isPreIpo?: boolean;
    stockVariantTier?: StockVariantTier | null;
}

export interface AssetVariantCategory {
    id: string;
    label: string;
    order: number;
}

export interface AssetVariantCategoryGroup<T> {
    category: AssetVariantCategory;
    variants: T[];
}

export function isPreIpoVariant(args: {
    tags?: readonly string[];
    labels?: ReadonlyArray<string | undefined | null>;
    isPreIpo?: boolean;
}): boolean {
    if (args.isPreIpo) return true;
    if ((args.tags ?? []).some(tag => PRE_IPO_TEXT_PATTERN.test(tag))) return true;
    return (args.labels ?? []).some(label => Boolean(label && PRE_IPO_TEXT_PATTERN.test(label)));
}

function kindCategory(kind: VariantKind | undefined): AssetVariantCategory {
    switch (kind) {
        case 'native':
            return { id: 'native', label: 'Native', order: 10 };
        case 'stablecoin':
            return { id: 'stablecoin', label: 'Stablecoins', order: 20 };
        case 'lst':
            return { id: 'lsts', label: 'LSTs', order: 30 };
        case 'yield':
            return { id: 'yield-bearing', label: 'Yield-bearing', order: 40 };
        case 'spot':
            return { id: 'spot', label: 'Spot', order: 45 };
        case 'wrapped':
            return { id: 'wrapped', label: 'Wrapped', order: 50 };
        case 'bridged':
            return { id: 'bridged', label: 'Bridged', order: 60 };
        case 'tokenized_equity':
            return { id: 'stocks', label: 'Stocks', order: 70 };
        case 'etf':
            return { id: 'etfs', label: 'ETFs', order: 80 };
        case 'leveraged':
            return { id: 'leveraged', label: 'Leveraged', order: 90 };
        case 'basket':
            return { id: 'baskets', label: 'Baskets', order: 100 };
        default:
            return { id: 'variants', label: 'Variants', order: 1000 };
    }
}

export function getAssetVariantCategory(assetId: string, variant: AssetVariantCategorySource): AssetVariantCategory {
    const normalizedAssetId = assetId.trim().toLowerCase();
    const isPreIpo = isPreIpoVariant({
        tags: variant.tags,
        labels: [variant.label, variant.name, variant.symbol, variant.displayName, variant.displaySymbol],
        isPreIpo: variant.isPreIpo,
    });

    if (normalizedAssetId === 'solana') {
        if (variant.mint === SOL_MINT || variant.kind === 'native') {
            return { id: 'native', label: 'Native', order: 10 };
        }

        return { id: 'yield-bearing', label: 'Yield-bearing', order: 20 };
    }

    if (normalizedAssetId === 'usd' || normalizedAssetId === 'eur') {
        if (variant.kind === 'yield') return { id: 'yield-bearing', label: 'Yield-bearing', order: 20 };
        return { id: 'native', label: 'Native', order: 10 };
    }

    if (isPreIpo) return { id: 'pre-ipo', label: 'Pre-IPO', order: 80 };

    if (variant.kind === 'tokenized_equity' || variant.stockVariantTier) {
        return { id: 'stocks', label: 'Stocks', order: 70 };
    }

    return kindCategory(variant.kind);
}

export function variantChainId(variant: Pick<AssetVariantCategorySource, 'chain'>): ChainKind {
    return isChainKind(variant.chain) ? variant.chain : 'solana';
}

export function chainDisplayLabel(chain: ChainKind | string | null | undefined): string {
    return CHAINS[isChainKind(chain) ? chain : 'solana'].label;
}

/** True once the variants span more than one chain (then sections are chains, not kinds). */
export function hasMultipleChains(variants: ReadonlyArray<Pick<AssetVariantCategorySource, 'chain'>>): boolean {
    const seen = new Set<ChainKind>();
    for (const variant of variants) {
        seen.add(variantChainId(variant));
        if (seen.size > 1) return true;
    }
    return false;
}

export function getAssetVariantChainCategory(variant: Pick<AssetVariantCategorySource, 'chain'>): AssetVariantCategory {
    const chain = variantChainId(variant);
    return { id: `chain:${chain}`, label: CHAINS[chain].label, order: CHAIN_KINDS.indexOf(chain) };
}

export function groupAssetVariantsByDisplayCategory<T extends AssetVariantCategorySource>(
    assetId: string,
    variants: readonly T[],
): Array<AssetVariantCategoryGroup<T>> {
    const groupsById = new Map<string, AssetVariantCategoryGroup<T>>();
    const byChain = hasMultipleChains(variants);

    for (const variant of variants) {
        const category = byChain ? getAssetVariantChainCategory(variant) : getAssetVariantCategory(assetId, variant);
        const existing = groupsById.get(category.id);
        if (existing) {
            existing.variants.push(variant);
        } else {
            groupsById.set(category.id, { category, variants: [variant] });
        }
    }

    return Array.from(groupsById.values()).sort((a, b) => {
        const orderDelta = a.category.order - b.category.order;
        if (orderDelta !== 0) return orderDelta;
        return a.category.label.localeCompare(b.category.label);
    });
}

/**
 * One page of already-grouped rows. Rows are flattened in group order, sliced, and re-grouped
 * by the category they were assigned on the full list, so a page never flips between chain and
 * kind headings based on which rows it happens to contain.
 */
export function paginateAssetVariantGroups<T>(
    groups: ReadonlyArray<AssetVariantCategoryGroup<T>>,
    offset: number,
    limit: number,
): Array<AssetVariantCategoryGroup<T>> {
    const flat = groups.flatMap(group => group.variants.map(variant => ({ category: group.category, variant })));
    const out: Array<AssetVariantCategoryGroup<T>> = [];
    for (const row of flat.slice(offset, offset + limit)) {
        const last = out[out.length - 1];
        if (last && last.category.id === row.category.id) last.variants.push(row.variant);
        else out.push({ category: row.category, variants: [row.variant] });
    }
    return out;
}
