/**
 * Chains a canonical asset's variants can live on — the single source of truth
 * for the v2 multichain surface.
 *
 * Adding a chain = one id in `CHAIN_KINDS` plus one entry in `CHAINS` (the
 * compiler rejects a missing or partial entry). Address validation, explorer
 * links, provider slugs (CoinGecko platform, Birdeye `x-chain`) and which
 * features the chain supports are all read from that entry; nothing in the
 * repo should branch on `chain === 'solana'` for v2 data.
 *
 * Public chain ids are our own short, stable slugs; provider slugs are
 * internal and may differ (CoinGecko `arbitrum-one`, Birdeye `arbitrum`).
 * Solana addresses are case-sensitive base58; EVM addresses are stored and
 * compared lowercase so one contract never appears twice under EIP-55 casing.
 *
 * There is deliberately no default chain and no "missing chain means Solana"
 * fallback: every v2 variant carries an explicit chain.
 */

export const CHAIN_KINDS = ['solana', 'ethereum', 'base', 'arbitrum', 'polygon', 'bnb'] as const;
export type ChainKind = (typeof CHAIN_KINDS)[number];

export const EVM_CHAIN_KINDS = [
    'ethereum',
    'base',
    'arbitrum',
    'polygon',
    'bnb',
] as const satisfies readonly ChainKind[];
export type EvmChainKind = (typeof EVM_CHAIN_KINDS)[number];

export type ChainFamily = 'svm' | 'evm';

/**
 * What the platform supports for variants on a chain. Solana-only pipelines
 * (Jupiter swaps, fill quality, DEX market lists, OHLCV, first-party logos,
 * Webacy risk wiring) gate on these instead of comparing chain ids.
 */
export interface ChainCapabilities {
    /** Per-variant Birdeye token-overview market snapshot (price, liquidity, volume). */
    markets: boolean;
    /** Per-pool DEX market lists. */
    dexMarkets: boolean;
    ohlcv: boolean;
    /** Risk summary / details. */
    risk: boolean;
    /** Fill-quality / execution-quality snapshots. */
    executionQuality: boolean;
    /** Swap/trade links and execution routing. */
    swap: boolean;
    /** First-party logo sync (GCS mirror). */
    firstPartyLogos: boolean;
}

export interface ChainProviders {
    /** CoinGecko `platforms` key (derivation source for EVM variants). */
    coingeckoPlatform: string;
    /** Birdeye `x-chain` header value; absent = no Birdeye market data. */
    birdeyeChain?: string;
    /** Webacy `chain` query value; absent = no Webacy risk. */
    webacyChain?: string;
}

export interface ChainConfig {
    /** Public chain id: the `chain` value on variants and the `chain` params. */
    id: ChainKind;
    /** CAIP-2 chain id (https://chainagnostic.org/CAIPs/caip-2). */
    caip2: string;
    family: ChainFamily;
    /** EVM chain id; absent for non-EVM chains. */
    evmChainId?: number;
    label: string;
    explorer: { name: string; tokenUrl: (address: string) => string };
    providers: ChainProviders;
    capabilities: ChainCapabilities;
}

const EVM_BASELINE: ChainCapabilities = {
    markets: true,
    dexMarkets: false,
    ohlcv: false,
    risk: false,
    executionQuality: false,
    swap: false,
    firstPartyLogos: false,
};

export const CHAINS: Readonly<Record<ChainKind, ChainConfig>> = {
    solana: {
        id: 'solana',
        caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        family: 'svm',
        label: 'Solana',
        explorer: { name: 'Solana Explorer', tokenUrl: address => `https://explorer.solana.com/address/${address}` },
        providers: { coingeckoPlatform: 'solana', birdeyeChain: 'solana', webacyChain: 'sol' },
        capabilities: {
            markets: true,
            dexMarkets: true,
            ohlcv: true,
            risk: true,
            executionQuality: true,
            swap: true,
            firstPartyLogos: true,
        },
    },
    ethereum: {
        id: 'ethereum',
        caip2: 'eip155:1',
        family: 'evm',
        evmChainId: 1,
        label: 'Ethereum',
        explorer: { name: 'Etherscan', tokenUrl: address => `https://etherscan.io/token/${address}` },
        providers: { coingeckoPlatform: 'ethereum', birdeyeChain: 'ethereum' },
        capabilities: EVM_BASELINE,
    },
    base: {
        id: 'base',
        caip2: 'eip155:8453',
        family: 'evm',
        evmChainId: 8453,
        label: 'Base',
        explorer: { name: 'Basescan', tokenUrl: address => `https://basescan.org/token/${address}` },
        providers: { coingeckoPlatform: 'base', birdeyeChain: 'base' },
        capabilities: EVM_BASELINE,
    },
    arbitrum: {
        id: 'arbitrum',
        caip2: 'eip155:42161',
        family: 'evm',
        evmChainId: 42161,
        label: 'Arbitrum',
        explorer: { name: 'Arbiscan', tokenUrl: address => `https://arbiscan.io/token/${address}` },
        providers: { coingeckoPlatform: 'arbitrum-one', birdeyeChain: 'arbitrum' },
        capabilities: EVM_BASELINE,
    },
    polygon: {
        id: 'polygon',
        caip2: 'eip155:137',
        family: 'evm',
        evmChainId: 137,
        label: 'Polygon',
        explorer: { name: 'Polygonscan', tokenUrl: address => `https://polygonscan.com/token/${address}` },
        providers: { coingeckoPlatform: 'polygon-pos', birdeyeChain: 'polygon' },
        capabilities: EVM_BASELINE,
    },
    bnb: {
        id: 'bnb',
        caip2: 'eip155:56',
        family: 'evm',
        evmChainId: 56,
        label: 'BNB',
        explorer: { name: 'BscScan', tokenUrl: address => `https://bscscan.com/token/${address}` },
        providers: { coingeckoPlatform: 'binance-smart-chain', birdeyeChain: 'bsc' },
        capabilities: EVM_BASELINE,
    },
};

export function isChainKind(value: unknown): value is ChainKind {
    return typeof value === 'string' && (CHAIN_KINDS as readonly string[]).includes(value);
}

export function isEvmChainKind(value: unknown): value is EvmChainKind {
    return typeof value === 'string' && (EVM_CHAIN_KINDS as readonly string[]).includes(value);
}

/** Whether variants on `chain` support `capability`. */
export function chainSupports(chain: ChainKind, capability: keyof ChainCapabilities): boolean {
    return CHAINS[chain].capabilities[capability];
}

/** Chain ids that support `capability`, in canonical order. */
export function chainsSupporting(capability: keyof ChainCapabilities): ChainKind[] {
    return CHAIN_KINDS.filter(chain => CHAINS[chain].capabilities[capability]);
}

/** Chains Birdeye covers (have a `providers.birdeyeChain` slug). */
export function birdeyeChains(): ChainKind[] {
    return CHAIN_KINDS.filter(chain => CHAINS[chain].providers.birdeyeChain !== undefined);
}

/**
 * EIP-7528: the conventional address for an EVM chain's native asset (ETH on
 * Ethereum, Base and Arbitrum; BNB on BNB Smart Chain; POL on Polygon). It is
 * not a contract, so the same address appears on every EVM chain and
 * token-level market APIs have no real data for it.
 */
export const EVM_NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Base58 (no 0, O, I, l), 32–44 chars: the shape of a Solana mint address. */
export function looksLikeSolanaAddress(value: string): boolean {
    return SOLANA_ADDRESS_RE.test(value.trim());
}

/** `0x` + 40 hex chars, any casing. */
export function looksLikeEvmAddress(value: string): boolean {
    return EVM_ADDRESS_RE.test(value.trim());
}

/**
 * Which address family a raw string belongs to, from its shape alone. An EVM
 * address cannot tell you *which* EVM chain it lives on — callers must pair
 * it with an explicit chain.
 */
export function inferAddressFamily(value: string): ChainFamily | null {
    if (looksLikeSolanaAddress(value)) return 'svm';
    if (looksLikeEvmAddress(value)) return 'evm';
    return null;
}

/**
 * Canonical storage form of an address on `chain`, or null when the raw value
 * is not a valid address for that chain's family.
 */
export function normalizeAddressForChain(chain: ChainKind, raw: string): string | null {
    const trimmed = raw.trim();
    switch (CHAINS[chain].family) {
        case 'svm':
            return looksLikeSolanaAddress(trimmed) ? trimmed : null;
        case 'evm':
            return looksLikeEvmAddress(trimmed) ? trimmed.toLowerCase() : null;
    }
}

/**
 * Lookup form of an address when the chain is unknown: EVM addresses are
 * lowercased, everything else is trimmed. Never rejects; use
 * `normalizeAddressForChain` when you need validation.
 */
export function normalizeAddressForLookup(raw: string): string {
    const trimmed = raw.trim();
    return looksLikeEvmAddress(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/**
 * The one identifier for a token on a chain: `<chain>:<address>` (e.g.
 * `base:0x8335…`, `solana:EPjF…`). The address must already be normalized.
 */
export function chainAddressKey(chain: ChainKind, address: string): string {
    return `${chain}:${address}`;
}

declare const VARIANT_KEY_BRAND: unique symbol;

/**
 * Map key for per-variant data (market snapshots, ranks): `<chain>:<address>`
 * for every chain, Solana included. Branded so a bare address string cannot
 * be used to read or write such a map by mistake.
 */
export type VariantKey = string & { readonly [VARIANT_KEY_BRAND]: true };

/** `VariantKey` for an address on `chain` (address must be normalized). */
export function variantKeyFor(chain: ChainKind, address: string): VariantKey {
    return chainAddressKey(chain, address) as VariantKey;
}

/**
 * Parse a `<chain>:<address>` key into a normalized `{ chain, address }`, or
 * null when the chain is unknown or the address is not valid for it. Chain
 * ids never contain `:`, so the first `:` splits unambiguously.
 */
export function parseChainAddressKey(raw: string): { chain: ChainKind; address: string } | null {
    const trimmed = raw.trim();
    const colon = trimmed.indexOf(':');
    if (colon <= 0) return null;
    const chain = trimmed.slice(0, colon);
    if (!isChainKind(chain)) return null;
    const address = normalizeAddressForChain(chain, trimmed.slice(colon + 1));
    return address ? { chain, address } : null;
}

/** Explorer URL for a token on `chain`. */
export function explorerTokenUrl(chain: ChainKind, address: string): string {
    return CHAINS[chain].explorer.tokenUrl(address);
}
