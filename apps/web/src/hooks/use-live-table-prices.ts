'use client';

import { useEffect, useMemo } from 'react';

import { setLiveSpotPrice } from '@/lib/realtime-prices/live-spot-store';
import {
    type PythFeedRequestItem,
    buildLiveQuoteKey,
    pythFeedResolutionKey,
} from '@/lib/realtime-prices/pyth-feed-batch';
import { resolvePythFeedsBatch } from '@/lib/realtime-prices/pyth-feed-resolver';
import { subscribePythFeed } from '@/lib/realtime-prices/pyth-pro-client';
import type { Token } from '@/lib/types';

/** Rows past this many are left on their snapshot price; one socket still carries them all. */
export const LIVE_TABLE_PRICE_LIMIT = 120;

interface LiveRow {
    quoteKey: string;
    item: PythFeedRequestItem;
}

/**
 * Streams live prices for the rows of a token table into the shared live store.
 * Rows resolve by asset category (canonical mode), so an equity row only goes live
 * when the plan covers its own feed; rows without a category are left alone rather
 * than risk matching an unrelated crypto feed with the same ticker.
 */
export function useLiveTablePrices(tokens: readonly Token[], enabled = true): void {
    const rows = useMemo<LiveRow[]>(() => {
        if (!enabled) return [];
        const out: LiveRow[] = [];
        const seen = new Set<string>();
        for (const token of tokens) {
            if (out.length >= LIVE_TABLE_PRICE_LIMIT) break;
            const category = (token.category ?? '').trim().toLowerCase();
            const quoteKey = buildLiveQuoteKey(token);
            if (!category || !quoteKey || seen.has(quoteKey)) continue;
            seen.add(quoteKey);
            out.push({ quoteKey, item: { ticker: token.symbol, category, mode: 'canonical' } });
        }
        return out;
    }, [tokens, enabled]);

    // Stable identity for the effect: only re-resolve when the set of rows actually changes.
    const signature = useMemo(() => rows.map(r => `${r.quoteKey}|${pythFeedResolutionKey(r.item)}`).join(','), [rows]);

    useEffect(() => {
        if (rows.length === 0) return;
        let cancelled = false;
        const unsubscribes: Array<() => void> = [];

        void (async () => {
            const resolved = await resolvePythFeedsBatch(rows.map(r => r.item));
            if (cancelled) return;

            // Several rows can share one feed (e.g. two listings of the same asset).
            const quoteKeysByFeed = new Map<number, string[]>();
            for (const row of rows) {
                const result = resolved.get(pythFeedResolutionKey(row.item));
                if (!result || result.status !== 'ok' || !result.feed) continue;
                const list = quoteKeysByFeed.get(result.feed.feedId) ?? [];
                list.push(row.quoteKey);
                quoteKeysByFeed.set(result.feed.feedId, list);
            }

            for (const [feedId, quoteKeys] of quoteKeysByFeed) {
                unsubscribes.push(
                    subscribePythFeed(feedId, {
                        onTick: tick => {
                            const updatedAtMs = tick.publishTimeMs ?? Date.now();
                            const source = tick.marketSession === 'closed' ? 'last-known' : 'pyth';
                            for (const quoteKey of quoteKeys) {
                                setLiveSpotPrice(quoteKey, { priceUsd: tick.priceUsd, updatedAtMs, source });
                            }
                        },
                    }),
                );
            }
        })();

        return () => {
            cancelled = true;
            for (const unsubscribe of unsubscribes) unsubscribe();
        };
        // `signature` captures everything in `rows` that matters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature]);
}
