// Logo override system for tokens with custom/curated logos
// - Popular token logos are stored in /public/logos/popular/*.png
// - xStock logos are stored in /public/logos/xstocks/{symbol}.png
/// - Prestock logos are stored in /public/logos/prestocks/{slug}.png

// Set of available xStock logo symbols (filename without extension)
const XSTOCK_LOGOS = new Set([
    'AAPLx',
    'ABBVx',
    'ABTx',
    'ACNx',
    'ADBEx',
    'AMBRx',
    'AMDx',
    'AMZNx',
    'APPx',
    'ASMLx',
    'ASTSx',
    'AVGOx',
    'AXPx',
    'AZNx',
    'BACx',
    'BKNGx',
    'BLKx',
    'BLSHx',
    'BMNRx',
    'BRK_Bx',
    'BTBTx',
    'CLSKx',
    'CMCSAx',
    'COINx',
    'CORZx',
    'COSTx',
    'CRCLx',
    'CRMx',
    'CRWDx',
    'CSCOx',
    'CVXx',
    'DFDVx',
    'DHRx',
    'DUOLx',
    'EBAYx',
    'EXPEx',
    'FIGx',
    'FUFUx',
    'GLDx',
    'GLXYx',
    'GMEx',
    'GOOGLx',
    'GSx',
    'HDx',
    'HONx',
    'HOODx',
    'HSDTx',
    'HUTx',
    'IBMx',
    'IJRx',
    'INTCx',
    'IWMx',
    'JNJx',
    'JPMx',
    'KOx',
    'LINx',
    'LLYx',
    'LULUx',
    'MARAx',
    'MAx',
    'MCDx',
    'MDTx',
    'METAx',
    'MNSTx',
    'MRKx',
    'MRVLx',
    'MSFTx',
    'MSTRx',
    'MUx',
    'NFLXx',
    'NVDAx',
    'NVOx',
    'OKLOx',
    'OPENx',
    'ORCLx',
    'PANWx',
    'PEPx',
    'PFEx',
    'PGx',
    'PLTRx',
    'PLx',
    'PMx',
    'PYPLx',
    'QQQx',
    'RBLXx',
    'RIOTx',
    'RKLBx',
    'SBETx',
    'SCHFx',
    'SPCEx',
    'SPYx',
    'STRCx',
    'SUIGx',
    'TBLLx',
    'TEMx',
    'TGTx',
    'TMOx',
    'TMUSx',
    'TONXx',
    'TQQQx',
    'TRONx',
    'TSLAx',
    'TSMx',
    'Tx',
    'UBERx',
    'UNHx',
    'VSTx',
    'VTIx',
    'VTx',
    'Vx',
    'WBDx',
    'WENx',
    'WMTx',
    'WULFx',
    'XOMx',
]);

// Alternative symbol mappings for symbols that might differ from filenames
const SYMBOL_TO_FILENAME: Record<string, string> = {
    // Map any different API symbols to their filename
    IEMGx: 'IJRx', // Core MSCI EM might have different symbol
    SPGIx: 'SPYx', // S&P Global might map differently
    STRKx: 'STRCx', // Strategy PP Fixed
    // (GLD → GLDx removed: the gold canonical now has a dedicated commodity
    // logo via POPULAR_LOGO_BY_SYMBOL, which is checked before this map.)
};

const POPULAR_LOGO_BY_SYMBOL: Record<string, string> = {
    // Canonical base asset logos for popular bridged/wrapped variants.
    // Keyed by UPPERCASE symbol for case-insensitive matching.
    // Commodity canonicals (gold/silver/copper/oil) — same images as the
    // assets API serves for these asset ids, so the pre-stream shell matches.
    GLD: '/logos/commodities/gold.png',
    SLV: '/logos/commodities/silver.png',
    COPPER: '/logos/commodities/copper.png',
    USO: '/logos/commodities/oil.png',
    APT: '/logos/popular/aptos.png',
    APTOS: '/logos/popular/aptos.png',
    BTC: '/logos/popular/bitcoin.png',
    WBTC: '/logos/popular/bitcoin.png',
    ETH: '/logos/popular/ethereum.png',
    WETH: '/logos/popular/ethereum.png',
    XRP: '/logos/popular/xrp.png',
    WXRP: '/logos/popular/xrp.png',
    BNB: '/logos/popular/bnb.png',
    HYPE: '/logos/popular/hyperliquid.png',
    HYPERLIQUID: '/logos/popular/hyperliquid.png',
    MON: '/logos/popular/monad.png',
    MONAD: '/logos/popular/monad.png',
    WMON: '/logos/popular/monad.png',
    SUI: '/logos/currencies/sui.png',
    TETHER: '/logos/popular/tether.png',
    USDT: '/logos/popular/tether.png',
};

const POPULAR_LOGO_BY_MINT: Record<string, string> = {
    // Hex Trust wXRP (Solana mint)
    '6UpQcMAb5xMzxc7ZfPaVMgx3KqsvKZdT5U718BzD5We2': '/logos/popular/xrp.png',

    // OKX xBTC (Solana mint)
    CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn: '/logos/popular/okxbtc.png',

    // Coinbase Wrapped BTC — market data only offers an unreliable ipfs.io URL.
    cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: '/logos/popular/cbbtc.png',

    // SpaceX (Ondo Tokenized) — SPCXon. Market data sources have no icon for this mint yet;
    // same Ondo CDN pattern as their other tokenized equities (tslaon, nvdaon, ...).
    wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo: 'https://cdn.ondo.finance/tokens/logos/spcxon_160x160.png',
};

/**
 * Mint-keyed logo override only — no symbol-based heuristics.
 * Use for surfaces that must not re-map logos by symbol (e.g. variant lists).
 */
export function getMintLogoOverride(mint: string | undefined): string | undefined {
    const trimmed = (mint ?? '').trim();
    if (!trimmed) return undefined;
    return POPULAR_LOGO_BY_MINT[trimmed];
}

// Set of available prestock logo slugs (filename without extension).
// Stored as lowercase because prestock filenames are lowercase.
const PRESTOCK_LOGO_SLUGS = new Set(['anduril', 'anthropic', 'kalshi', 'openai', 'polymarket', 'spacex', 'xai']);

function toAlnumLower(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getPrestockLogoURL(symbolOrName: string): string | null {
    const alnum = toAlnumLower(symbolOrName.trim());
    if (!alnum) return null;

    const candidates = new Set<string>();
    candidates.add(alnum);

    const withoutPrestocks = alnum.replace(/pre\s*stocks?/g, '').replace(/prestocks?/g, '');
    candidates.add(withoutPrestocks);

    if (alnum.startsWith('pre')) candidates.add(alnum.slice(3));
    if (withoutPrestocks.startsWith('pre')) candidates.add(withoutPrestocks.slice(3));

    if (alnum.endsWith('pre')) candidates.add(alnum.slice(0, -3));
    if (withoutPrestocks.endsWith('pre')) candidates.add(withoutPrestocks.slice(0, -3));

    for (const candidate of candidates) {
        if (PRESTOCK_LOGO_SLUGS.has(candidate)) return `/logos/prestocks/${candidate}.png`;
    }

    return null;
}

function getXStockLogoForCanonicalSymbol(symbol: string): string | null {
    const normalized = symbol.trim();
    if (!normalized) return null;

    const candidates = [
        `${normalized}x`,
        `${normalized.toUpperCase()}x`,
        `${normalized.replace(/[.]/g, '_')}x`,
        `${normalized.toUpperCase().replace(/[.]/g, '_')}x`,
    ];

    for (const candidate of candidates) {
        if (XSTOCK_LOGOS.has(candidate)) return `/logos/xstocks/${candidate}.png`;
    }

    for (const logo of XSTOCK_LOGOS) {
        if (candidates.some(candidate => logo.toLowerCase() === candidate.toLowerCase())) {
            return `/logos/xstocks/${logo}.png`;
        }
    }

    return null;
}

/**
 * Get the logo URL for a token, using local override if available
 * @param symbol - Token symbol (e.g., "AAPLx")
 * @param fallbackLogoURI - Fallback logo URI from API
 * @returns Logo URL to use
 */
export function getTokenLogoURL(symbol: string | undefined, fallbackLogoURI: string | undefined): string | undefined {
    if (!symbol) return fallbackLogoURI;

    // Normalize symbol (handle case variations)
    const normalizedSymbol = symbol.trim();

    const popularLogo = POPULAR_LOGO_BY_SYMBOL[normalizedSymbol.toUpperCase()];
    if (popularLogo) return popularLogo;

    const prestockLogo = getPrestockLogoURL(normalizedSymbol);
    if (prestockLogo) return prestockLogo;

    const canonicalStockLogo = getXStockLogoForCanonicalSymbol(normalizedSymbol);
    if (canonicalStockLogo) return canonicalStockLogo;

    // Check for direct match
    if (XSTOCK_LOGOS.has(normalizedSymbol)) {
        return `/logos/xstocks/${normalizedSymbol}.png`;
    }

    // Check for mapped symbol
    const mappedFilename = SYMBOL_TO_FILENAME[normalizedSymbol];
    if (mappedFilename && XSTOCK_LOGOS.has(mappedFilename)) {
        return `/logos/xstocks/${mappedFilename}.png`;
    }

    // Check case-insensitive match
    for (const logo of XSTOCK_LOGOS) {
        if (logo.toLowerCase() === normalizedSymbol.toLowerCase()) {
            return `/logos/xstocks/${logo}.png`;
        }
    }

    // Return fallback
    return fallbackLogoURI;
}

/**
 * Like `getTokenLogoURLWithSecondarySymbol`, but checks mint overrides first.
 */
export function getTokenLogoURLForMintWithSecondarySymbol(
    mint: string | undefined,
    primarySymbol: string | undefined,
    secondarySymbol: string | undefined,
    fallbackLogoURI: string | undefined,
): string | undefined {
    const trimmedMint = (mint ?? '').trim();
    if (trimmedMint) {
        const mintLogo = POPULAR_LOGO_BY_MINT[trimmedMint];
        if (mintLogo) return mintLogo;
    }

    return getTokenLogoURLWithSecondarySymbol(primarySymbol, secondarySymbol, fallbackLogoURI);
}

/**
 * Prefer a local override for the primary symbol, then the secondary symbol.
 * Falls back to the provided remote/logo URI when no local override exists.
 */
export function getTokenLogoURLWithSecondarySymbol(
    primarySymbol: string | undefined,
    secondarySymbol: string | undefined,
    fallbackLogoURI: string | undefined,
): string | undefined {
    const primaryLocal = getTokenLogoURL(primarySymbol, undefined);
    if (primaryLocal) return primaryLocal;

    const secondaryLocal = getTokenLogoURL(secondarySymbol, undefined);
    if (secondaryLocal) return secondaryLocal;

    return fallbackLogoURI;
}

/**
 * Clean token name by removing common suffixes/prefixes.
 *
 * - xStocks: "Nasdaq xStock" → "Nasdaq"
 * - Prestocks: "SpaceX Prestock" → "SpaceX"
 * - LSTs: "Jupiter Staked SOL" → "Jupiter", "Marinade staked SOL (mSOL)" → "Marinade"
 * - Wrapped tokens: "Wrapped Ether" → "Ether", "Coinbase Wrapped BTC" → "BTC"
 * - Bridge markers: "(Wormhole)", "(Bridged)", etc.
 */
export function cleanTokenName(name: string | undefined): string {
    if (!name) return 'Unknown';
    return (
        name
            // xStocks
            .replace(/\s*xStock\s*$/i, '')
            // Prestocks
            .replace(/\s*\(\s*pre\s*stocks?\s*\)\s*/gi, ' ')
            .replace(/\s*[-–—]?\s*pre\s*stocks?\s*$/i, '')
            // Bridge/origin markers in parens
            .replace(/\s*\(\s*(wormhole|bridged|wrapped|omnibridge|coinbase|ondo\s+tokenized)\s*\)\s*/gi, ' ')
            // Remove (mSOL) and similar LST markers
            .replace(/\s*\(\s*mSOL\s*\)\s*/gi, ' ')
            // Wrapped variants
            .replace(/^\s*coinbase\s+wrapped\s+/i, '')
            .replace(/^\s*wrapped\s+/i, '')
            .replace(/\s+wrapped\s+/gi, ' ')
            .replace(/\s+wrapped\s*$/i, '')
            // LST suffixes
            .replace(/\s+staked\s+sol(?=\s*(\(|$))/i, '')
            // Normalize whitespace
            .replace(/\s{2,}/g, ' ')
            .trim() || 'Unknown'
    );
}
