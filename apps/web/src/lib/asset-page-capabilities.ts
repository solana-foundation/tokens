import { chainSupports, chainsSupporting, type ChainKind } from '@tokens/asset-registry/chains';

/**
 * Which Solana-era sections the asset page may mount for the active variant.
 * Every gate reads from here so "is this a variant view" never stands in for
 * "does this chain have the data".
 */
export interface AssetPageCapabilities {
    /** Price chart source: the variant's own OHLCV, the asset's canonical series, or nothing. */
    chart: 'variant' | 'canonical' | 'none';
    /** Per-pool DEX markets for the active variant (variant view only). */
    dexMarkets: boolean;
    /** Top markets across variants (canonical view only). */
    marketsOverview: boolean;
    /** Security / risk details + header risk popover. */
    risk: boolean;
    executionQuality: boolean;
    /** Swap CTA on the active variant. */
    swap: boolean;
    /** A chain the asset trades on when the active one cannot swap; null when none or not needed. */
    tradeOnChain: ChainKind | null;
}

export function resolveAssetPageCapabilities(args: {
    activeChain: ChainKind | null;
    isVariantView: boolean;
    assetChains: readonly ChainKind[];
    isStablecoin: boolean;
    variantCount: number;
}): AssetPageCapabilities {
    const { activeChain, isVariantView, assetChains } = args;
    const supports = (capability: Parameters<typeof chainSupports>[1]) =>
        activeChain !== null && chainSupports(activeChain, capability);
    const swap = supports('swap');
    const swapChains = chainsSupporting('swap');
    const tradeOnChain =
        activeChain !== null && !swap
            ? (swapChains.find(chain => chain !== activeChain && assetChains.includes(chain)) ?? null)
            : null;
    return {
        chart: activeChain === null ? 'none' : isVariantView && supports('ohlcv') ? 'variant' : 'canonical',
        dexMarkets: isVariantView && supports('dexMarkets'),
        marketsOverview: !isVariantView && assetChains.some(chain => chainSupports(chain, 'dexMarkets')),
        risk: supports('risk') && (isVariantView || (args.isStablecoin && args.variantCount === 1)),
        executionQuality: supports('executionQuality'),
        swap,
        tradeOnChain,
    };
}
