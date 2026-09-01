export const VENUE_IDS = [
    'titan',
    'jupiter',
    'dflow',
    'sunrise',
    'omfg',
    'kamino',
    'orca',
    'raydium',
    'byreal',
] as const;
export type VenueId = (typeof VENUE_IDS)[number];

export type VenueType = 'aggregator' | 'dex';

export interface BuildSwapLinksInput {
    /** Base58 mint of the token being bought. Validation is the caller's job. */
    buyMint: string;
    /** Sell-side mint. Defaults to SOL, or USDC when buying SOL. */
    sellMint?: string;
    /**
     * Display symbol for the buy side, used by symbol-based venues (Sunrise).
     * Falls back to the registry variant/asset symbol for the buy mint.
     */
    buySymbol?: string;
    /**
     * Display symbol for the sell side. Only used when explicitly provided;
     * symbol-based venues otherwise assume USDC (matching the web UI).
     */
    sellSymbol?: string;
    /** Sell-side UI amount, appended only for venues that declare support. */
    amount?: string;
    /** Restrict output to these venues. Defaults to all registered venues. */
    venues?: readonly VenueId[];
}

export interface VenueLink {
    id: VenueId;
    name: string;
    venueType: VenueType;
    url: string;
    /** Site-relative logo path (e.g. `/logos/popular/jupiter.png`) or an absolute favicon URL. */
    iconPath: string | null;
}

export interface SwapLinksResult {
    buyMint: string;
    /** The resolved sell side after defaulting. */
    sellMint: string;
    /** Our global venue recommendation; null when filtered out or unbuildable. */
    primary: VenueId | null;
    /** Buildable venues in registry order; unbuildable venues are omitted. */
    venues: VenueLink[];
}

export interface VenueBuildContext {
    buyMint: string;
    sellMint: string;
    isBuyingSol: boolean;
    buySymbol: string | null;
    sellSymbol: string | null;
}

export interface VenueMeta {
    id: VenueId;
    name: string;
    venueType: VenueType;
    iconPath: string | null;
    /**
     * Declares deep-link amount support. Left undefined until a venue's
     * amount param is manually verified in a browser — never guess these.
     */
    amountParam?: { name: string; unit: 'ui' | 'raw' };
    /** Returns null when the venue has no valid link for this pair. */
    build: (ctx: VenueBuildContext) => string | null;
}
