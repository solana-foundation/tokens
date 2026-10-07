// Logo override system for tokens with custom/curated logos
// - Popular token logos are stored in /public/logos/popular/*.png
// - xStock logos are stored in /public/logos/xstocks/{symbol}.png
// - Prestock logos are stored in /public/logos/prestocks/{slug}.png

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
    'MRNAx',
    'MSTRx',
    'MUx',
    'NBISx',
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
    IEMGx: 'IJRx',
    SPGIx: 'SPYx',
    STRKx: 'STRCx',
    GLD: 'GLDx',
    // Backpack-led listings with no xStock variant; logo files follow the
    // xstocks naming so the canonical-symbol mapper (<SYM>x) finds them.
    MRNA: 'MRNAx',
    NBIS: 'NBISx',
};

const POPULAR_LOGO_BY_SYMBOL: Record<string, string> = {
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
    SOL: '/logos/popular/solana.png',
    WSOL: '/logos/popular/solana.png',
    SUI: '/logos/currencies/sui.png',
    TETHER: '/logos/popular/tether.png',
    USDT: '/logos/popular/tether.png',
};

const POPULAR_LOGO_BY_MINT: Record<string, string> = {
    '6UpQcMAb5xMzxc7ZfPaVMgx3KqsvKZdT5U718BzD5We2': '/logos/popular/xrp.png',
    CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn: '/logos/popular/okxbtc.png',
};

const PRESTOCK_LOGO_SLUGS = new Set([
    'anduril',
    'anthropic',
    'figureai',
    'kalshi',
    'neuralink',
    'openai',
    'polymarket',
    'spacex',
]);

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

export function getTokenLogoURL(symbol: string | undefined, fallbackLogoURI: string | undefined): string | undefined {
    if (!symbol) return fallbackLogoURI;

    const normalizedSymbol = symbol.trim();

    const popularLogo = POPULAR_LOGO_BY_SYMBOL[normalizedSymbol.toUpperCase()];
    if (popularLogo) return popularLogo;

    const prestockLogo = getPrestockLogoURL(normalizedSymbol);
    if (prestockLogo) return prestockLogo;

    const canonicalStockLogo = getXStockLogoForCanonicalSymbol(normalizedSymbol);
    if (canonicalStockLogo) return canonicalStockLogo;

    if (XSTOCK_LOGOS.has(normalizedSymbol)) {
        return `/logos/xstocks/${normalizedSymbol}.png`;
    }

    const mappedFilename = SYMBOL_TO_FILENAME[normalizedSymbol];
    if (mappedFilename && XSTOCK_LOGOS.has(mappedFilename)) {
        return `/logos/xstocks/${mappedFilename}.png`;
    }

    for (const logo of XSTOCK_LOGOS) {
        if (logo.toLowerCase() === normalizedSymbol.toLowerCase()) {
            return `/logos/xstocks/${logo}.png`;
        }
    }

    return fallbackLogoURI;
}

export function getTokenLogoURLForMint(
    mint: string | undefined,
    symbol: string | undefined,
    fallbackLogoURI: string | undefined,
): string | undefined {
    const trimmedMint = (mint ?? '').trim();
    if (trimmedMint) {
        const mintLogo = POPULAR_LOGO_BY_MINT[trimmedMint];
        if (mintLogo) return mintLogo;
    }

    return getTokenLogoURL(symbol, fallbackLogoURI);
}

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

export function hasLocalLogo(symbol: string | undefined): boolean {
    if (!symbol) return false;
    const normalized = symbol.trim();
    if (POPULAR_LOGO_BY_SYMBOL[normalized.toUpperCase()]) return true;
    if (getPrestockLogoURL(normalized)) return true;
    return (
        XSTOCK_LOGOS.has(normalized) ||
        Object.keys(SYMBOL_TO_FILENAME).includes(normalized) ||
        Array.from(XSTOCK_LOGOS).some(logo => logo.toLowerCase() === normalized.toLowerCase())
    );
}

export function cleanTokenName(name: string | undefined): string {
    if (!name) return 'Unknown';
    return (
        name
            .replace(/\s*xStock\s*$/i, '')
            .replace(/\s*\(\s*pre\s*stocks?\s*\)\s*/gi, ' ')
            .replace(/\s*[-–—]?\s*pre\s*stocks?\s*$/i, '')
            .replace(/\s*\(\s*(wormhole|bridged|wrapped|omnibridge|coinbase|ondo\s+tokenized)\s*\)\s*/gi, ' ')
            .replace(/\s*\(\s*mSOL\s*\)\s*/gi, ' ')
            .replace(/^\s*coinbase\s+wrapped\s+/i, '')
            .replace(/^\s*wrapped\s+/i, '')
            .replace(/\s+wrapped\s+/gi, ' ')
            .replace(/\s+wrapped\s*$/i, '')
            .replace(/\s+staked\s+sol(?=\s*(\(|$))/i, '')
            .replace(/\s{2,}/g, ' ')
            .trim() || 'Unknown'
    );
}
