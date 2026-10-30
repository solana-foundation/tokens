// Token wrapper configuration
// Maps base assets to their various wrapped versions on Solana

export interface TokenWrapper {
    address: string;
    symbol: string;
    name: string;
    deployer: string;
    deployerUrl?: string;
}

export interface TokenWrapperGroup {
    /**
     * Canonical `assetId` used throughout the app/DB.
     * Defaults to `coingeckoId` when omitted.
     *
     * This exists because some assets have a stable/common slug that differs
     * from CoinGecko's coin id (e.g. `bnb` vs `binancecoin`).
     */
    assetId?: string;
    baseAsset: string;
    baseSymbol: string;
    coingeckoId: string;
    description: string;
    wrappers: TokenWrapper[];
}

// Configuration for wrapped assets on Solana
export const TOKEN_WRAPPER_GROUPS: TokenWrapperGroup[] = [
    {
        baseAsset: 'Solana',
        baseSymbol: 'SOL',
        coingeckoId: 'solana',
        description: 'Solana wrapped for use on Solana',
        wrappers: [
            {
                address: 'So11111111111111111111111111111111111111112',
                symbol: 'wSOL',
                name: 'Wrapped SOL',
                deployer: 'Solana',
            },
        ],
    },
    {
        baseAsset: 'Bitcoin',
        baseSymbol: 'BTC',
        coingeckoId: 'bitcoin',
        description: 'Bitcoin wrapped for use on Solana',
        wrappers: [
            {
                address: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
                symbol: 'wBTC',
                name: 'Wrapped Bitcoin (Wormhole)',
                deployer: 'Wormhole',
                deployerUrl: 'https://wormhole.com',
            },
            {
                address: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
                symbol: 'cbBTC',
                name: 'Coinbase Wrapped BTC',
                deployer: 'Coinbase',
                deployerUrl: 'https://coinbase.com',
            },
        ],
    },
    {
        baseAsset: 'Ethereum',
        baseSymbol: 'ETH',
        coingeckoId: 'ethereum',
        description: 'Ethereum wrapped for use on Solana',
        wrappers: [
            {
                address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
                symbol: 'wETH',
                name: 'Wrapped Ether (Wormhole)',
                deployer: 'Wormhole',
                deployerUrl: 'https://wormhole.com',
            },
        ],
    },
    {
        baseAsset: 'Uniswap',
        baseSymbol: 'UNI',
        assetId: 'uniswap',
        coingeckoId: 'uniswap',
        description: 'Uniswap token variants on Solana',
        wrappers: [
            {
                address: 'uniHfuPhEQSrtpzXpJZDCSq53yaejKKpNhFUiKoHKHV',
                symbol: 'UNI',
                name: 'Uniswap',
                deployer: 'Bridge',
            },
            {
                address: '8FU95xFJhUUkyyCLU13HSzDLs7oC4QZdXQHL6SCeab36',
                symbol: 'UNI',
                name: 'Uniswap (Portal)',
                deployer: 'Wormhole',
                deployerUrl: 'https://portalbridge.com',
            },
        ],
    },
    {
        baseAsset: 'Avalanche',
        baseSymbol: 'AVAX',
        coingeckoId: 'avalanche-2',
        description: 'Avalanche wrapped for use on Solana',
        wrappers: [
            {
                address: 'avaxGHCq3T7hoxd73oY2KY9hJSTaeMibXvHy5KNzh5D',
                symbol: 'wAVAX',
                name: 'Wrapped AVAX (Wormhole)',
                deployer: 'Wormhole',
                deployerUrl: 'https://wormhole.com',
            },
        ],
    },
    {
        baseAsset: 'Monad',
        baseSymbol: 'MON',
        coingeckoId: 'monad',
        description: 'Monad token on Solana',
        wrappers: [
            {
                address: 'CrAr4RRJMBVwRsZtT62pEhfA9H5utymC2mVx8e7FreP2',
                symbol: 'wMON',
                name: 'Wrapped MON',
                deployer: 'Monad',
                deployerUrl: 'https://monad.xyz',
            },
        ],
    },
    {
        baseAsset: 'Zcash',
        baseSymbol: 'ZEC',
        coingeckoId: 'zcash',
        description: 'Zcash bridged for use on Solana',
        wrappers: [
            {
                address: 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS',
                symbol: 'ZEC',
                name: 'Zcash (OmniBridge)',
                deployer: 'OmniBridge',
            },
        ],
    },
    {
        baseAsset: 'Hyperliquid',
        baseSymbol: 'HYPE',
        coingeckoId: 'hyperliquid',
        description: 'Hyperliquid token bridged for use on Solana',
        wrappers: [
            {
                address: '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g',
                symbol: 'HYPE',
                name: 'HYPE (Wormhole)',
                deployer: 'Wormhole',
                deployerUrl: 'https://wormhole.com',
            },
        ],
    },
    {
        baseAsset: 'TRON',
        baseSymbol: 'TRX',
        coingeckoId: 'tron',
        description: 'TRON token bridged for use on Solana',
        wrappers: [
            {
                address: 'GbbesPbaYh5uiAZSYNXTc7w9jty1rpg3P9L4JeN4LkKc',
                symbol: 'TRX',
                name: 'TRON (Bridged)',
                deployer: 'Bridge',
            },
        ],
    },
    {
        baseAsset: 'BNB',
        baseSymbol: 'BNB',
        assetId: 'bnb',
        coingeckoId: 'binancecoin',
        description: 'BNB bridged for use on Solana',
        wrappers: [
            {
                address: '9gP2kCy3wA1ctvYWQk75guqXuHfrEomqydHLtcTCqiLa',
                symbol: 'BNB',
                name: 'BNB (Wormhole)',
                deployer: 'Wormhole',
                deployerUrl: 'https://wormhole.com',
            },
        ],
    },
    {
        baseAsset: 'NEAR Protocol',
        baseSymbol: 'NEAR',
        coingeckoId: 'near',
        description: 'NEAR bridged for use on Solana',
        wrappers: [
            {
                address: '3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG',
                symbol: 'NEAR',
                name: 'NEAR (Bridged)',
                deployer: 'Bridge',
            },
        ],
    },
    {
        baseAsset: 'Zora',
        baseSymbol: 'ZORA',
        coingeckoId: 'zora',
        description: 'ZORA token on Solana',
        wrappers: [
            {
                address: 'soKqZS9pASwBNS46G388nhK7XVtPaTyReffXEd3zora',
                symbol: 'ZORA',
                name: 'ZORA',
                deployer: 'Zora',
            },
        ],
    },
    {
        baseAsset: 'Starknet',
        baseSymbol: 'STRK',
        coingeckoId: 'starknet',
        description: 'Starknet token on Solana',
        wrappers: [
            {
                address: 'HsRpHQn6VbyMs5b5j5SV6xQ2VvpvvCCzu19GjytVSCoz',
                symbol: 'STRK',
                name: 'Starknet',
                deployer: 'Starknet',
            },
        ],
    },
    {
        baseAsset: 'Sui',
        baseSymbol: 'SUI',
        coingeckoId: 'sui',
        description: 'Sui token on Solana',
        wrappers: [
            {
                address: 'suifhC9gU1VbJAPYPTBkHJyyyStKGLLYPVDTmPoqbvA',
                symbol: 'SUI',
                name: 'Sui',
                deployer: 'xStock',
            },
        ],
    },
];

// Helper functions
export function getWrapperGroupByCoingeckoId(coingeckoId: string): TokenWrapperGroup | null {
    for (const group of TOKEN_WRAPPER_GROUPS) {
        if (group.coingeckoId === coingeckoId) return group;
    }
    return null;
}

export function getWrapperGroupByAddress(address: string): TokenWrapperGroup | null {
    for (const group of TOKEN_WRAPPER_GROUPS) {
        if (group.wrappers.some(w => w.address === address)) {
            return group;
        }
    }
    return null;
}

export function getWrapperByAddress(address: string): TokenWrapper | null {
    for (const group of TOKEN_WRAPPER_GROUPS) {
        const wrapper = group.wrappers.find(w => w.address === address);
        if (wrapper) return wrapper;
    }
    return null;
}

export function getSiblingWrappers(address: string): TokenWrapper[] {
    const group = getWrapperGroupByAddress(address);
    if (!group) return [];
    return group.wrappers.filter(w => w.address !== address);
}

export function getAllWrappersForGroup(address: string): TokenWrapper[] {
    const group = getWrapperGroupByAddress(address);
    return group?.wrappers ?? [];
}
