/**
 * Static canonical-logo fallback table.
 *
 * Moved from the retired Convex backend (`convex/canonicalLogoFallbacks.ts`)
 * so the Cloud Run admin service resolves fallback logos identically.
 */

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

const SYMBOL_TO_FILENAME: Record<string, string> = {
    IEMGx: 'IJRx',
    SPGIx: 'SPYx',
    STRKx: 'STRCx',
    GLD: 'GLDx',
};

const POPULAR_LOGO_BY_SYMBOL: Record<string, string> = {
    APT: '/logos/popular/aptos.png',
    APTOS: '/logos/popular/aptos.png',
    BTC: '/logos/popular/bitcoin.png',
    WBTC: '/logos/popular/bitcoin.png',
    ETH: '/logos/popular/ethereum.png',
    WETH: '/logos/popular/ethereum.png',
    BNB: '/logos/popular/bnb.png',
    HYPE: '/logos/popular/hyperliquid.png',
    HYPERLIQUID: '/logos/popular/hyperliquid.png',
    MON: '/logos/popular/monad.png',
    MONAD: '/logos/popular/monad.png',
    WMON: '/logos/popular/monad.png',
    SUI: '/logos/currencies/sui.png',
    SOL: '/logos/popular/solana.png',
    WSOL: '/logos/popular/solana.png',
    TETHER: '/logos/popular/tether.png',
    USDT: '/logos/popular/tether.png',
};

const CANONICAL_LOGO_BY_ASSET_ID: Record<string, string> = {
    aptos: '/logos/popular/aptos.png',
    bitcoin: '/logos/popular/bitcoin.png',
    bnb: '/logos/popular/bnb.png',
    binancecoin: '/logos/popular/bnb.png',
    ethereum: '/logos/popular/ethereum.png',
    eur: '/logos/currencies/euro.png',
    hyperliquid: '/logos/popular/hyperliquid.png',
    monad: '/logos/popular/monad.png',
    solana: '/logos/popular/solana.png',
    sui: '/logos/currencies/sui.png',
    tether: '/logos/popular/tether.png',
    uniswap: '/logos/popular/uniswap.png',
    usd: '/logos/currencies/usd.png',
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

export function getCanonicalFallbackLogoPath(params: {
    assetId?: string | null;
    symbol?: string | null;
    name?: string | null;
}): string | null {
    const assetId = (params.assetId ?? '').trim().toLowerCase();
    const assetLogo = CANONICAL_LOGO_BY_ASSET_ID[assetId];
    if (assetLogo) return assetLogo;

    const symbol = (params.symbol ?? '').trim();
    if (symbol) {
        const popularLogo = POPULAR_LOGO_BY_SYMBOL[symbol.toUpperCase()];
        if (popularLogo) return popularLogo;

        const xstockLogo = getXStockLogoForCanonicalSymbol(symbol);
        if (xstockLogo) return xstockLogo;

        const mapped = SYMBOL_TO_FILENAME[symbol];
        if (mapped && XSTOCK_LOGOS.has(mapped)) return `/logos/xstocks/${mapped}.png`;

        const prestockBySymbol = getPrestockLogoURL(symbol);
        if (prestockBySymbol) return prestockBySymbol;
    }

    const name = (params.name ?? '').trim();
    if (name) {
        const prestockByName = getPrestockLogoURL(name);
        if (prestockByName) return prestockByName;
    }

    return null;
}
