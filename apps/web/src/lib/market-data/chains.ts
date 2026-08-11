export const CHAIN_IDS = ['solana', 'base', 'stellar', 'robinhood'] as const;

export type ChainId = (typeof CHAIN_IDS)[number];

export function isChainId(value: string): value is ChainId {
    return (CHAIN_IDS as readonly string[]).includes(value);
}

export interface ChainDefinition {
    id: ChainId;
    label: string;
    /** Network segment used by the GeckoTerminal DEX API. */
    geckoterminalNetwork: string;
    /**
     * Chain name as DefiLlama spells it, or null when DefiLlama does not track
     * the chain yet. Robinhood Chain is new enough that it has no TVL entry,
     * so its overview falls back to DEX reserves alone.
     */
    defillamaChain: string | null;
    /**
     * CoinGecko asset-platform id, used to resolve the same asset's contract
     * address on this chain. Stellar assets are issuer-scoped rather than
     * contract-addressed, so CoinGecko does not expose a platform id for it.
     */
    coingeckoPlatform: string | null;
    nativeSymbol: string;
    explorerUrl: string;
}

export const CHAINS: Record<ChainId, ChainDefinition> = {
    solana: {
        id: 'solana',
        label: 'Solana',
        geckoterminalNetwork: 'solana',
        defillamaChain: 'Solana',
        coingeckoPlatform: 'solana',
        nativeSymbol: 'SOL',
        explorerUrl: 'https://solscan.io',
    },
    base: {
        id: 'base',
        label: 'Base',
        geckoterminalNetwork: 'base',
        defillamaChain: 'Base',
        coingeckoPlatform: 'base',
        nativeSymbol: 'ETH',
        explorerUrl: 'https://basescan.org',
    },
    stellar: {
        id: 'stellar',
        label: 'Stellar',
        geckoterminalNetwork: 'stellar',
        defillamaChain: 'Stellar',
        coingeckoPlatform: null,
        nativeSymbol: 'XLM',
        explorerUrl: 'https://stellar.expert/explorer/public',
    },
    robinhood: {
        id: 'robinhood',
        label: 'Robinhood',
        geckoterminalNetwork: 'robinhood',
        defillamaChain: null,
        coingeckoPlatform: null,
        nativeSymbol: 'ETH',
        explorerUrl: 'https://robinhood.com',
    },
};

export const CHAIN_LIST: ChainDefinition[] = CHAIN_IDS.map(id => CHAINS[id]);

/**
 * DEX reserves are occasionally reported negative by upstream indexers (Robinhood
 * pools have returned `-86346`). Negative depth is meaningless, so it is treated
 * as missing rather than folded into a total.
 */
export function sanitizeLiquidity(value: unknown): number | null {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) return null;
    return parsed;
}
