import type { CanonicalAsset } from '../types';

/**
 * Canonical assets whose only deployments are the native coins of EVM chains
 * the v2 multichain surface covers. They have no Solana mint, so the usual
 * data files (token-wrappers, manual) cannot express them; the EVM variants
 * are derived by the `sync-v2-evm-variants` job from `coingecko_coins` plus
 * `NATIVE_COIN_DEPLOYMENTS` (chain-deployments.ts). Curated-list membership
 * stays an admin decision in `asset_collections`, as for every asset.
 */
export const CHAIN_NATIVE_ASSETS: CanonicalAsset[] = [
    {
        assetId: 'polygon',
        name: 'Polygon',
        symbol: 'POL',
        category: 'crypto',
        aliases: ['polygon', 'pol', 'matic', 'polygon-ecosystem-token'],
        coingeckoId: 'polygon-ecosystem-token',
        variants: [],
    },
    {
        assetId: 'arbitrum',
        name: 'Arbitrum',
        symbol: 'ARB',
        category: 'crypto',
        aliases: ['arbitrum', 'arb'],
        coingeckoId: 'arbitrum',
        variants: [],
    },
];
