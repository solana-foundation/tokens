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
} from './builders';
import { RAYDIUM_SOL_ALIAS, SOL_MINT, USDC_MINT } from './constants';
import type { VenueId, VenueMeta } from './types';

/**
 * Ordered venue registry. Order is the web UI's presentation order
 * (aggregators, then individual venues); the first entry is our global
 * recommendation (`PRIMARY_VENUE_ID`).
 */
export const VENUES: readonly VenueMeta[] = [
    {
        id: 'titan',
        name: 'Titan',
        venueType: 'aggregator',
        iconPath: '/logos/popular/titan.png',
        build: ctx => getTitanSwapUrl({ sell: ctx.sellMint, buy: ctx.buyMint }),
    },
    {
        id: 'jupiter',
        name: 'Jupiter',
        venueType: 'aggregator',
        iconPath: '/logos/popular/jupiter.png',
        build: ctx => getJupiterSwapUrl({ sell: ctx.sellMint, buy: ctx.buyMint }),
    },
    {
        id: 'dflow',
        name: 'DFlow',
        venueType: 'aggregator',
        iconPath: '/logos/popular/dflow.png',
        build: ctx => getDflowSwapUrl({ sendToken: ctx.sellMint, receiveToken: ctx.buyMint }),
    },
    {
        id: 'sunrise',
        name: 'Sunrise',
        venueType: 'dex',
        iconPath: '/logos/popular/sunrise.svg',
        // Sunrise deep links are symbol-based and USDC-denominated in the web
        // UI regardless of the sell mint; an explicit sellSymbol overrides.
        build: ctx => getSunriseSwapUrl({ fromToken: ctx.sellSymbol ?? 'USDC', toToken: ctx.buySymbol }),
    },
    {
        id: 'omfg',
        name: 'OMFG',
        venueType: 'dex',
        iconPath: '/logos/popular/omfg.svg',
        // OMFG links are USDC-denominated in the web UI regardless of the sell mint.
        build: ctx => getOmfgSwapUrl({ from: USDC_MINT, to: ctx.buyMint }),
    },
    {
        id: 'kamino',
        name: 'Kamino',
        venueType: 'dex',
        iconPath: '/logos/popular/kamino.png',
        build: ctx =>
            getKaminoSwapUrl({
                aSymbol: 'SOL',
                bSymbol: ctx.buyMint === SOL_MINT || ctx.buyMint === USDC_MINT ? 'USDC' : ctx.buyMint,
            }),
    },
    {
        id: 'orca',
        name: 'Orca',
        venueType: 'dex',
        iconPath: 'https://www.orca.so/favicon.ico',
        build: ctx => getOrcaSwapUrl({ tokenIn: ctx.sellMint, tokenOut: ctx.buyMint }),
    },
    {
        id: 'raydium',
        name: 'Raydium',
        venueType: 'dex',
        iconPath: 'https://raydium.io/favicon.ico',
        build: ctx =>
            getRaydiumSwapUrl({
                inputMint: ctx.sellMint === SOL_MINT ? RAYDIUM_SOL_ALIAS : ctx.sellMint,
                outputMint: ctx.buyMint === SOL_MINT ? RAYDIUM_SOL_ALIAS : ctx.buyMint,
            }),
    },
    {
        id: 'byreal',
        name: 'Byreal',
        venueType: 'dex',
        iconPath: 'https://www.byreal.io/favicon.ico',
        build: ctx => getByrealSwapUrl({ inputMint: ctx.sellMint, outputMint: ctx.buyMint }),
    },
];

export const PRIMARY_VENUE_ID: VenueId = 'titan';

export function listVenueIds(): VenueId[] {
    return VENUES.map(venue => venue.id);
}
