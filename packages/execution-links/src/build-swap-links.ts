import { getVariantByMint } from '@tokens/asset-registry';

import { SOL_MINT, USDC_MINT } from './constants';
import { PRIMARY_VENUE_ID, VENUES } from './venues';
import type { BuildSwapLinksInput, SwapLinksResult, VenueBuildContext, VenueId, VenueLink } from './types';

function appendAmountParam(url: string, name: string, amount: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set(name, amount);
    return parsed.toString();
}

export function buildSwapLinks(input: BuildSwapLinksInput): SwapLinksResult {
    const buyMint = input.buyMint.trim() || SOL_MINT;
    const isBuyingSol = buyMint === SOL_MINT;
    const sellMint = input.sellMint?.trim() || (isBuyingSol ? USDC_MINT : SOL_MINT);

    const variantMatch = getVariantByMint(buyMint);
    const buySymbol = input.buySymbol ?? variantMatch?.variant.symbol ?? variantMatch?.asset.symbol ?? null;
    const sellSymbol = input.sellSymbol ?? null;

    const requested = input.venues ? new Set<VenueId>(input.venues) : null;
    const amount = input.amount?.trim() || null;

    const ctx: VenueBuildContext = { buyMint, sellMint, isBuyingSol, buySymbol, sellSymbol };

    const venues: VenueLink[] = [];
    for (const venue of VENUES) {
        if (requested && !requested.has(venue.id)) continue;

        let url = venue.build(ctx);
        if (!url) continue;
        if (amount && venue.amountParam) url = appendAmountParam(url, venue.amountParam.name, amount);

        venues.push({
            id: venue.id,
            name: venue.name,
            venueType: venue.venueType,
            url,
            iconPath: venue.iconPath,
        });
    }

    const primary = venues.some(venue => venue.id === PRIMARY_VENUE_ID) ? PRIMARY_VENUE_ID : null;

    return { buyMint, sellMint, primary, venues };
}
