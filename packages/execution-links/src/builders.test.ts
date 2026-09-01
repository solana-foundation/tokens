import { describe, expect, test } from 'bun:test';

import {
    getByrealSwapUrl,
    getDflowSwapUrl,
    getJupiterSwapUrl,
    getKaminoSwapUrl,
    getOmfgSwapUrl,
    getOrcaSwapUrl,
    getRaydiumSwapUrl,
    getSunriseSwapUrl,
    getTitanSwapUrl,
    normalizeSwapSymbol,
} from './builders';
import { RAYDIUM_SOL_ALIAS, SOL_MINT, USDC_MINT } from './constants';

const CBBTC_MINT = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';

// Golden URLs: these are the exact strings the web swap action area produced
// before extraction. Do not "fix" encoding or formats — parity is the contract.
describe('golden swap URLs', () => {
    test('jupiter', () => {
        expect(getJupiterSwapUrl({ sell: SOL_MINT, buy: CBBTC_MINT })).toBe(
            `https://jup.ag/swap?sell=${SOL_MINT}&buy=${CBBTC_MINT}`,
        );
    });

    test('titan uses an unencoded pair string', () => {
        expect(getTitanSwapUrl({ sell: SOL_MINT, buy: CBBTC_MINT })).toBe(
            `https://titan.exchange/swap?${SOL_MINT}-${CBBTC_MINT}`,
        );
    });

    test('dflow', () => {
        expect(getDflowSwapUrl({ sendToken: SOL_MINT, receiveToken: CBBTC_MINT })).toBe(
            `https://dflow.net/?sendToken=${SOL_MINT}&receiveToken=${CBBTC_MINT}`,
        );
    });

    test('orca', () => {
        expect(getOrcaSwapUrl({ tokenIn: SOL_MINT, tokenOut: CBBTC_MINT })).toBe(
            `https://www.orca.so/?tokenIn=${SOL_MINT}&tokenOut=${CBBTC_MINT}`,
        );
    });

    test('raydium', () => {
        expect(getRaydiumSwapUrl({ inputMint: RAYDIUM_SOL_ALIAS, outputMint: CBBTC_MINT })).toBe(
            `https://raydium.io/swap/?inputMint=${RAYDIUM_SOL_ALIAS}&outputMint=${CBBTC_MINT}`,
        );
    });

    test('byreal', () => {
        expect(getByrealSwapUrl({ inputMint: SOL_MINT, outputMint: CBBTC_MINT })).toBe(
            `https://www.byreal.io/en/swap?inputMint=${SOL_MINT}&outputMint=${CBBTC_MINT}`,
        );
    });
});

describe('normalizeSwapSymbol', () => {
    test('trims and strips inner whitespace', () => {
        expect(normalizeSwapSymbol('  cb BTC ')).toBe('cbBTC');
    });

    test('rejects empty and placeholder values', () => {
        expect(normalizeSwapSymbol('')).toBeNull();
        expect(normalizeSwapSymbol('   ')).toBeNull();
        expect(normalizeSwapSymbol('???')).toBeNull();
        expect(normalizeSwapSymbol(undefined)).toBeNull();
        expect(normalizeSwapSymbol(null)).toBeNull();
    });
});

describe('kamino', () => {
    test('mint-in-path hybrid for regular tokens', () => {
        expect(getKaminoSwapUrl({ aSymbol: 'SOL', bSymbol: CBBTC_MINT })).toBe(
            `https://kamino.com/swap/SOL-${CBBTC_MINT}`,
        );
    });

    test('canonicalizes SOL/USDC in either order, including wSOL', () => {
        expect(getKaminoSwapUrl({ aSymbol: 'SOL', bSymbol: 'USDC' })).toBe('https://kamino.com/swap/SOL-USDC');
        expect(getKaminoSwapUrl({ aSymbol: 'USDC', bSymbol: 'SOL' })).toBe('https://kamino.com/swap/SOL-USDC');
        expect(getKaminoSwapUrl({ aSymbol: 'wSOL', bSymbol: 'USDC' })).toBe('https://kamino.com/swap/SOL-USDC');
    });

    test('falls back to SOL-USDC when a symbol is missing', () => {
        expect(getKaminoSwapUrl({ aSymbol: 'SOL', bSymbol: '' })).toBe('https://kamino.com/swap/SOL-USDC');
        expect(getKaminoSwapUrl({ aSymbol: '??', bSymbol: 'cbBTC' })).toBe('https://kamino.com/swap/SOL-USDC');
    });
});

describe('sunrise', () => {
    test('symbol-based link', () => {
        expect(getSunriseSwapUrl({ fromToken: 'USDC', toToken: 'cbBTC' })).toBe(
            'https://sunrise.xyz/?fromToken=USDC&toToken=cbBTC',
        );
    });

    test('null on missing or equal symbols', () => {
        expect(getSunriseSwapUrl({ fromToken: 'USDC', toToken: undefined })).toBeNull();
        expect(getSunriseSwapUrl({ fromToken: 'USDC', toToken: '' })).toBeNull();
        expect(getSunriseSwapUrl({ fromToken: 'USDC', toToken: 'usdc' })).toBeNull();
    });
});

describe('omfg', () => {
    test('mint-based link', () => {
        expect(getOmfgSwapUrl({ from: USDC_MINT, to: CBBTC_MINT })).toBe(
            `https://www.omnipair.fi/trade?from=${USDC_MINT}&to=${CBBTC_MINT}`,
        );
    });

    test('null on same mint or empty side', () => {
        expect(getOmfgSwapUrl({ from: USDC_MINT, to: USDC_MINT })).toBeNull();
        expect(getOmfgSwapUrl({ from: '', to: CBBTC_MINT })).toBeNull();
    });
});
