import { applyLiveChangePercent } from '@/lib/realtime-prices/live-change';
import { getLiveSpotPrice, isFreshLiveSpot } from '@/lib/realtime-prices/live-spot-store';
import { buildLiveQuoteKey } from '@/lib/realtime-prices/pyth-feed-batch';
import type { Token } from '@/lib/types';

/** Non-React helpers behind the home table's live cells (kept out of the component file for Fast Refresh). */

/** A live tick older than this falls back to the snapshot price. */
export const LIVE_PRICE_STALE_MS = 10_000;

export type LiveChangeField = 'priceChange1hPercent' | 'priceChange24hPercent';

/** Same value `TokenTablePriceCell` displays right now, for sorting: live when fresh, else the snapshot. */
export function rowPriceForSort(token: Token): number | null {
    const liveSpot = getLiveSpotPrice(buildLiveQuoteKey(token));
    if (isFreshLiveSpot(liveSpot, LIVE_PRICE_STALE_MS)) return liveSpot!.priceUsd;
    return typeof token.price === 'number' && Number.isFinite(token.price) ? token.price : null;
}

/** Same value `LivePercentChangeCell` displays right now, for sorting. */
export function rowChangeForSort(token: Token, field: LiveChangeField): number | null {
    const liveSpot = getLiveSpotPrice(buildLiveQuoteKey(token));
    const livePrice = isFreshLiveSpot(liveSpot, LIVE_PRICE_STALE_MS) ? liveSpot!.priceUsd : null;
    return applyLiveChangePercent(token.price, token[field], livePrice);
}
