import { describe, expect, test } from 'bun:test';

import { getVariantByMint } from '@tokens/asset-registry';

import { buildSwapLinks } from './build-swap-links';
import { RAYDIUM_SOL_ALIAS, SOL_MINT, USDC_MINT } from './constants';
import { listVenueIds } from './venues';

const CBBTC_MINT = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
// A mint the registry does not know, so no symbol fallback exists.
const UNKNOWN_MINT = '11111111111111111111111111111111';

function urlById(result: ReturnType<typeof buildSwapLinks>, id: string): string | undefined {
    return result.venues.find(venue => venue.id === id)?.url;
}

describe('sell-side defaulting', () => {
    test('defaults to selling SOL', () => {
        const result = buildSwapLinks({ buyMint: CBBTC_MINT });
        expect(result.sellMint).toBe(SOL_MINT);
        expect(result.buyMint).toBe(CBBTC_MINT);
    });

    test('sells USDC when buying SOL', () => {
        const result = buildSwapLinks({ buyMint: SOL_MINT });
        expect(result.sellMint).toBe(USDC_MINT);
    });

    test('blank buy mint falls back to SOL (web parity)', () => {
        const result = buildSwapLinks({ buyMint: '  ' });
        expect(result.buyMint).toBe(SOL_MINT);
        expect(result.sellMint).toBe(USDC_MINT);
    });

    test('explicit sellMint overrides defaulting', () => {
        const result = buildSwapLinks({ buyMint: CBBTC_MINT, sellMint: USDC_MINT });
        expect(result.sellMint).toBe(USDC_MINT);
        expect(urlById(result, 'jupiter')).toBe(`https://jup.ag/swap?sell=${USDC_MINT}&buy=${CBBTC_MINT}`);
    });
});

describe('web parity for a regular token buy', () => {
    const result = buildSwapLinks({ buyMint: CBBTC_MINT, buySymbol: 'cbBTC' });

    test('titan pair string', () => {
        expect(urlById(result, 'titan')).toBe(`https://titan.exchange/swap?${SOL_MINT}-${CBBTC_MINT}`);
    });

    test('jupiter', () => {
        expect(urlById(result, 'jupiter')).toBe(`https://jup.ag/swap?sell=${SOL_MINT}&buy=${CBBTC_MINT}`);
    });

    test('dflow', () => {
        expect(urlById(result, 'dflow')).toBe(`https://dflow.net/?sendToken=${SOL_MINT}&receiveToken=${CBBTC_MINT}`);
    });

    test('sunrise is USDC-denominated regardless of sell mint', () => {
        expect(urlById(result, 'sunrise')).toBe('https://sunrise.xyz/?fromToken=USDC&toToken=cbBTC');
    });

    test('omfg is USDC-denominated regardless of sell mint', () => {
        expect(urlById(result, 'omfg')).toBe(`https://www.omnipair.fi/trade?from=${USDC_MINT}&to=${CBBTC_MINT}`);
    });

    test('kamino uses the mint-in-path hybrid', () => {
        expect(urlById(result, 'kamino')).toBe(`https://kamino.com/swap/SOL-${CBBTC_MINT}`);
    });

    test('orca', () => {
        expect(urlById(result, 'orca')).toBe(`https://www.orca.so/?tokenIn=${SOL_MINT}&tokenOut=${CBBTC_MINT}`);
    });

    test('raydium replaces SOL with the sol alias', () => {
        expect(urlById(result, 'raydium')).toBe(
            `https://raydium.io/swap/?inputMint=${RAYDIUM_SOL_ALIAS}&outputMint=${CBBTC_MINT}`,
        );
    });

    test('byreal', () => {
        expect(urlById(result, 'byreal')).toBe(
            `https://www.byreal.io/en/swap?inputMint=${SOL_MINT}&outputMint=${CBBTC_MINT}`,
        );
    });

    test('deterministic registry order', () => {
        expect(result.venues.map(venue => venue.id)).toEqual([
            'titan',
            'jupiter',
            'dflow',
            'sunrise',
            'omfg',
            'kamino',
            'orca',
            'raydium',
            'byreal',
        ]);
    });
});

describe('web parity when buying SOL', () => {
    const result = buildSwapLinks({ buyMint: SOL_MINT, buySymbol: 'SOL' });

    test('raydium aliases the SOL side of the output', () => {
        expect(urlById(result, 'raydium')).toBe(
            `https://raydium.io/swap/?inputMint=${USDC_MINT}&outputMint=${RAYDIUM_SOL_ALIAS}`,
        );
    });

    test('kamino canonicalizes to SOL-USDC', () => {
        expect(urlById(result, 'kamino')).toBe('https://kamino.com/swap/SOL-USDC');
    });

    test('omfg drops out (USDC to USDC-equivalent same-mint rule does not apply, SOL differs)', () => {
        expect(urlById(result, 'omfg')).toBe(`https://www.omnipair.fi/trade?from=${USDC_MINT}&to=${SOL_MINT}`);
    });
});

describe('symbol fallback chain', () => {
    test('falls back to the registry symbol when buySymbol is omitted', () => {
        const match = getVariantByMint(CBBTC_MINT);
        const expected = match?.variant.symbol ?? match?.asset.symbol ?? null;
        expect(expected).not.toBeNull();

        const result = buildSwapLinks({ buyMint: CBBTC_MINT });
        expect(urlById(result, 'sunrise')).toBe(`https://sunrise.xyz/?fromToken=USDC&toToken=${expected}`);
    });

    test('sunrise is omitted when no symbol can be resolved', () => {
        const result = buildSwapLinks({ buyMint: UNKNOWN_MINT });
        expect(urlById(result, 'sunrise')).toBeUndefined();
        // The other venues are mint-based and unaffected.
        expect(urlById(result, 'jupiter')).toBeDefined();
    });

    test('sunrise is omitted when buy and sell symbols match', () => {
        const result = buildSwapLinks({ buyMint: UNKNOWN_MINT, buySymbol: 'USDC' });
        expect(urlById(result, 'sunrise')).toBeUndefined();
    });
});

describe('venue filtering and primary semantics', () => {
    test('filter restricts output while preserving registry order', () => {
        const result = buildSwapLinks({ buyMint: CBBTC_MINT, venues: ['orca', 'jupiter'] });
        expect(result.venues.map(venue => venue.id)).toEqual(['jupiter', 'orca']);
    });

    test('primary is the global recommendation when present', () => {
        const result = buildSwapLinks({ buyMint: CBBTC_MINT });
        expect(result.primary).toBe('titan');
    });

    test('primary is null when the recommended venue is filtered out', () => {
        const result = buildSwapLinks({ buyMint: CBBTC_MINT, venues: ['orca', 'raydium'] });
        expect(result.primary).toBeNull();
    });

    test('empty filter yields no venues and a null primary', () => {
        const result = buildSwapLinks({ buyMint: CBBTC_MINT, venues: [] });
        expect(result.venues).toEqual([]);
        expect(result.primary).toBeNull();
    });
});

describe('amount passthrough', () => {
    test('amount is a no-op while no venue declares support', () => {
        const withAmount = buildSwapLinks({ buyMint: CBBTC_MINT, amount: '1.5' });
        const withoutAmount = buildSwapLinks({ buyMint: CBBTC_MINT });
        expect(withAmount.venues).toEqual(withoutAmount.venues);
    });
});

describe('venue registry surface', () => {
    test('listVenueIds matches the registry order', () => {
        expect(listVenueIds()).toEqual([
            'titan',
            'jupiter',
            'dflow',
            'sunrise',
            'omfg',
            'kamino',
            'orca',
            'raydium',
            'byreal',
        ]);
    });
});
