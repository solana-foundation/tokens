// Per-venue swap URL builders, ported 1:1 from the web swap action area.
// Behavior parity with the web UI is load-bearing (golden tests pin it):
// keep format quirks (unencoded Titan pair string, Raydium `sol` alias,
// Kamino symbol/mint hybrid) exactly as-is.

export function getJupiterSwapUrl(args: { sell: string; buy: string }): string {
    const url = new URL('https://jup.ag/swap');
    url.searchParams.set('sell', args.sell);
    url.searchParams.set('buy', args.buy);
    return url.toString();
}

export function getTitanSwapUrl(args: { sell: string; buy: string }): string {
    return `https://titan.exchange/swap?${args.sell}-${args.buy}`;
}

export function getDflowSwapUrl(args: { sendToken: string; receiveToken: string }): string {
    const url = new URL('https://dflow.net/');
    url.searchParams.set('sendToken', args.sendToken);
    url.searchParams.set('receiveToken', args.receiveToken);
    return url.toString();
}

export function getOrcaSwapUrl(args: { tokenIn: string; tokenOut: string }): string {
    const url = new URL('https://www.orca.so/');
    url.searchParams.set('tokenIn', args.tokenIn);
    url.searchParams.set('tokenOut', args.tokenOut);
    return url.toString();
}

export function getRaydiumSwapUrl(args: { inputMint: string; outputMint: string }): string {
    const url = new URL('https://raydium.io/swap/');
    url.searchParams.set('inputMint', args.inputMint);
    url.searchParams.set('outputMint', args.outputMint);
    return url.toString();
}

export function getByrealSwapUrl(args: { inputMint: string; outputMint: string }): string {
    const url = new URL('https://www.byreal.io/en/swap');
    url.searchParams.set('inputMint', args.inputMint);
    url.searchParams.set('outputMint', args.outputMint);
    return url.toString();
}

export function normalizeSwapSymbol(value: string | undefined | null): string | null {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;
    if (/^\?+$/.test(trimmed)) return null;
    return trimmed.replace(/\s+/g, '');
}

export function getKaminoSwapUrl(args: { aSymbol: string; bSymbol: string }): string {
    const a = normalizeSwapSymbol(args.aSymbol);
    const b = normalizeSwapSymbol(args.bSymbol);
    if (!a || !b) return 'https://kamino.com/swap/SOL-USDC';

    // Match Kamino's commonly shared canonical route for SOL/USDC.
    const aUpper = a.toUpperCase();
    const bUpper = b.toUpperCase();
    const isSolUsdc =
        (aUpper === 'SOL' && bUpper === 'USDC') ||
        (aUpper === 'USDC' && bUpper === 'SOL') ||
        (aUpper === 'WSOL' && bUpper === 'USDC') ||
        (aUpper === 'USDC' && bUpper === 'WSOL');
    if (isSolUsdc) return 'https://kamino.com/swap/SOL-USDC';

    return `https://kamino.com/swap/${encodeURIComponent(a)}-${encodeURIComponent(b)}`;
}

export function getSunriseSwapUrl(args: { fromToken: string; toToken: string | undefined | null }): string | null {
    const fromToken = normalizeSwapSymbol(args.fromToken);
    const toToken = normalizeSwapSymbol(args.toToken);
    if (!fromToken || !toToken) return null;
    if (fromToken.toUpperCase() === toToken.toUpperCase()) return null;

    const url = new URL('https://sunrise.xyz/');
    url.searchParams.set('fromToken', fromToken);
    url.searchParams.set('toToken', toToken);
    return url.toString();
}

export function getOmfgSwapUrl(args: { from: string; to: string }): string | null {
    const from = args.from.trim();
    const to = args.to.trim();
    if (!from || !to) return null;
    if (from === to) return null;

    const url = new URL('https://www.omnipair.fi/trade');
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    return url.toString();
}
