'use client';

import { useEffect, useMemo } from 'react';

import { setLiveSpotPrice } from '@/lib/realtime-prices/live-spot-store';
import {
    type PythFeedRequestItem,
    buildLiveQuoteKey,
    pythFeedResolutionKey,
} from '@/lib/realtime-prices/pyth-feed-batch';
import { resolvePythFeedsBatch, resolveRetryDelayMs } from '@/lib/realtime-prices/pyth-feed-resolver';
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
        let retryTimer: number | null = null;
        let attempt = 0;
        const unsubscribes: Array<() => void> = [];
        const subscribedFeeds = new Set<number>();

        // Resolve `pending`, subscribe what resolved, and retry only the rows whose lookup
        // failed transiently (network error, directory load failure) with backoff.
        const run = async (pending: LiveRow[]) => {
            const resolved = await resolvePythFeedsBatch(pending.map(r => r.item));
            if (cancelled) return;

            // Several rows can share one feed (e.g. two listings of the same asset).
            const quoteKeysByFeed = new Map<number, string[]>();
            const errored: LiveRow[] = [];
            for (const row of pending) {
                const result = resolved.get(pythFeedResolutionKey(row.item));
                if (!result || result.status === 'error') {
                    errored.push(row);
                    continue;
                }
                if (result.status !== 'ok' || !result.feed) continue;
                const { feedId } = result.feed;
                if (subscribedFeeds.has(feedId)) continue;
                const list = quoteKeysByFeed.get(feedId) ?? [];
                list.push(row.quoteKey);
                quoteKeysByFeed.set(feedId, list);
            }

            for (const [feedId, quoteKeys] of quoteKeysByFeed) {
                subscribedFeeds.add(feedId);
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

            if (errored.length > 0) {
                retryTimer = window.setTimeout(() => void run(errored), resolveRetryDelayMs(attempt++));
            }
        };
        void run(rows);

        return () => {
            cancelled = true;
            if (retryTimer != null) window.clearTimeout(retryTimer);
            for (const unsubscribe of unsubscribes) unsubscribe();
        };
        // `signature` captures everything in `rows` that matters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature]);
}
