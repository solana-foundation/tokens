/**
 * Static inputs for deriving EVM variants of canonical assets (the
 * `sync-v2-evm-variants` worker job). Pure data; no behaviour.
 */
import { EVM_NATIVE_ASSET_ADDRESS, type ChainKind } from '../chains';

/**
 * Aggregate canonicals (`usd` = every USD stablecoin, `bitcoin` = every BTC
 * wrapper, …) have no single CoinGecko id, so `assets.coingecko_id` cannot
 * drive them. These coin ids are derived under the asset in addition to its
 * own id; unknown/unsynced ids are skipped. Kind follows the asset category.
 */
export const AGGREGATE_COIN_IDS: Readonly<Record<string, readonly string[]>> = {
    usd: ['usd-coin', 'tether', 'paypal-usd', 'usds', 'dai', 'ethena-usde', 'first-digital-usd', 'usdd'],
    eur: ['euro-coin', 'stasis-eurs'],
    bitcoin: ['wrapped-bitcoin', 'coinbase-wrapped-btc', 'tbtc'],
    solana: ['wrapped-solana'],
    gold: ['pax-gold', 'tether-gold'],
};

export interface NativeCoinDeployment {
    chain: ChainKind;
    /** Normalized (lowercase) address. */
    address: string;
    kind: 'native' | 'wrapped';
    label: string;
}

/**
 * Native coins have no contract, so CoinGecko's `platforms` map never lists
 * them (the `ethereum` coin has an empty map). This table supplies the native
 * deployment (EIP-7528 address) and its canonical wrapped token per chain,
 * keyed by canonical asset id. The native row never gets a market snapshot;
 * the wrapped token carries the coin's market.
 */
export const NATIVE_COIN_DEPLOYMENTS: Readonly<Record<string, readonly NativeCoinDeployment[]>> = {
    ethereum: [
        { chain: 'ethereum', address: EVM_NATIVE_ASSET_ADDRESS, kind: 'native', label: 'ETH' },
        { chain: 'ethereum', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', kind: 'wrapped', label: 'WETH' },
        { chain: 'base', address: EVM_NATIVE_ASSET_ADDRESS, kind: 'native', label: 'ETH' },
        { chain: 'base', address: '0x4200000000000000000000000000000000000006', kind: 'wrapped', label: 'WETH' },
        { chain: 'arbitrum', address: EVM_NATIVE_ASSET_ADDRESS, kind: 'native', label: 'ETH' },
        { chain: 'arbitrum', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', kind: 'wrapped', label: 'WETH' },
    ],
    bnb: [
        { chain: 'bnb', address: EVM_NATIVE_ASSET_ADDRESS, kind: 'native', label: 'BNB' },
        { chain: 'bnb', address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', kind: 'wrapped', label: 'WBNB' },
    ],
    polygon: [
        { chain: 'polygon', address: EVM_NATIVE_ASSET_ADDRESS, kind: 'native', label: 'POL' },
        { chain: 'polygon', address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', kind: 'wrapped', label: 'WPOL' },
    ],
};
