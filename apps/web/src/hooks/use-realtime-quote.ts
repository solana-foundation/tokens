'use client';

import { useEffect, useRef, useState } from 'react';

import { setLiveSpotPrice } from '@/lib/realtime-prices/live-spot-store';
import { resolvePythFeed, type ResolvedPythFeedStatus } from '@/lib/realtime-prices/pyth-feed-resolver';
import type { PythFeedMode } from '@/lib/realtime-prices/pyth-feed-selection';
import { subscribePythFeed } from '@/lib/realtime-prices/pyth-pro-client';
import type { PythUnavailableReason } from '@/lib/realtime-prices/pyth-pro-protocol';

const UI_THROTTLE_MS = 1_000;
const REALTIME_STALE_MS = 7_500;

export interface UseRealtimeQuoteArgs {
    /**
     * Stable key for the live store (prefer `coingeckoId` when available, else `assetId`).
     * This keeps live prices scoped and prevents unrelated rerenders.
     */
    quoteKey: string;
    /** Ticker to resolve on Pyth: the asset symbol (canonical) or the token's own symbol (variant). */
    symbol?: string;
    /** Asset category; picks the Pyth namespace (Crypto, Equity.US, Metal, ...). */
    category?: string | null;
    /** Canonical assets resolve by category; variants are always the token's own crypto feed. */
    mode?: PythFeedMode;
    enabled?: boolean;
    /** If false, do not open the price stream yet. */
    streamEnabled?: boolean;
    /** Optional warm-start (e.g. cached price/DB price) to seed the live store. */
    seedPriceUsd?: number | null;
}

export type RealtimeQuoteStatusKind = 'realtime' | 'last-known' | 'fallback' | 'disabled';

export type RealtimeQuoteReason =
    Exclude<ResolvedPythFeedStatus, 'ok'> | PythUnavailableReason | 'market_closed' | 'disconnected' | 'stale';

export interface RealtimeQuoteStatus {
    kind: RealtimeQuoteStatusKind;
    updatedAtMs: number | null;
    source: 'pyth' | 'seed' | 'none';
    /** Why the quote is not realtime, when known. */
    reason?: RealtimeQuoteReason;
}

const INITIAL_STATUS: RealtimeQuoteStatus = { kind: 'fallback', updatedAtMs: null, source: 'seed' };
const DISABLED_STATUS: RealtimeQuoteStatus = { kind: 'disabled', updatedAtMs: null, source: 'none' };

function normalizeText(value: string | null | undefined): string {
    return (value ?? '').trim();
}

function shouldAcceptSeed(priceUsd: number | null | undefined): priceUsd is number {
    return typeof priceUsd === 'number' && Number.isFinite(priceUsd) && priceUsd > 0;
}

interface ResolvedFeedState {
    key: string;
    feedId: number | null;
    reason: RealtimeQuoteReason | null;
}

export function useRealtimeQuote(args: UseRealtimeQuoteArgs): RealtimeQuoteStatus {
    const enabled = (args.enabled ?? true) && normalizeText(args.quoteKey).length > 0;
    const streamEnabled = enabled && (args.streamEnabled ?? true);

    const symbolUpper = normalizeText(args.symbol).toUpperCase();
    const category = normalizeText(args.category).toLowerCase();
    const mode: PythFeedMode = args.mode ?? 'canonical';
    const resolveKey = `${mode}:${category}:${symbolUpper}`;

    const [resolved, setResolved] = useState<ResolvedFeedState | null>(null);
    const feedId = resolved?.key === resolveKey ? resolved.feedId : null;
    const resolveReason = resolved?.key === resolveKey ? resolved.reason : null;

    // `disabled` is derived from `enabled` at return time; state only tracks the live quote.
    const [status, setStatus] = useState<RealtimeQuoteStatus>(INITIAL_STATUS);

    const lastRealtimeTickAtRef = useRef<number | null>(null);
    const lastUiUpdateAtRef = useRef(0);

    // Reset live-status bookkeeping whenever the quote identity (or enablement) changes.
    useEffect(() => {
        lastRealtimeTickAtRef.current = null;
        lastUiUpdateAtRef.current = 0;
        setStatus(INITIAL_STATUS);
    }, [enabled, args.quoteKey, resolveKey]);

    // Resolve the Pyth feed for this ticker/category.
    useEffect(() => {
        if (!enabled || !symbolUpper) {
            setResolved(null);
            return;
        }

        let cancelled = false;
        void (async () => {
            const result = await resolvePythFeed({ symbol: symbolUpper, category: category || null, mode });
            if (cancelled) return;
            const ok = result.status === 'ok' && result.feed;
            setResolved({
                key: resolveKey,
                feedId: ok ? result.feed!.feedId : null,
                reason: result.status === 'ok' ? null : result.status,
            });
        })();

        return () => {
            cancelled = true;
        };
    }, [enabled, symbolUpper, category, mode, resolveKey]);

    // Surface resolution failures (no feed, plan not entitled, key missing) on the status.
    useEffect(() => {
        if (!enabled || !resolveReason) return;
        setStatus(prev =>
            prev.kind === 'realtime' || prev.reason === resolveReason ? prev : { ...prev, reason: resolveReason },
        );
    }, [enabled, resolveReason]);

    // Warm-start the live store so UI can read a value before realtime connects.
    useEffect(() => {
        if (!enabled) return;
        if (!shouldAcceptSeed(args.seedPriceUsd)) return;

        const now = Date.now();
        setLiveSpotPrice(args.quoteKey, { priceUsd: args.seedPriceUsd, updatedAtMs: now, source: 'seed' });
        setStatus(prev =>
            prev.kind === 'realtime'
                ? prev
                : { kind: 'last-known', updatedAtMs: now, source: 'seed', reason: prev.reason },
        );
    }, [enabled, args.quoteKey, args.seedPriceUsd]);

    // Stream realtime ticks into the live store (throttled).
    useEffect(() => {
        if (!streamEnabled) return;
        if (feedId == null) return;

        const quoteKey = args.quoteKey;
        const unsubscribe = subscribePythFeed(feedId, {
            onStatus: next => {
                if (next.kind === 'subscribed') return;
                const reason: RealtimeQuoteReason = next.kind === 'unavailable' ? next.reason : 'disconnected';
                setStatus(prev =>
                    prev.kind === 'fallback' && prev.reason === reason
                        ? prev
                        : {
                              kind: prev.kind === 'realtime' ? 'fallback' : prev.kind,
                              updatedAtMs: prev.updatedAtMs,
                              source: prev.source,
                              reason,
                          },
                );
            },
            onTick: tick => {
                const now = Date.now();
                const updatedAtMs = tick.publishTimeMs ?? now;

                // Outside market hours Pyth keeps repeating the last session price: show it as last-known, not live.
                if (tick.marketSession === 'closed') {
                    setLiveSpotPrice(quoteKey, { priceUsd: tick.priceUsd, updatedAtMs, source: 'last-known' });
                    setStatus(prev =>
                        prev.kind === 'last-known' && prev.reason === 'market_closed'
                            ? prev
                            : { kind: 'last-known', updatedAtMs, source: 'pyth', reason: 'market_closed' },
                    );
                    return;
                }

                lastRealtimeTickAtRef.current = now;
                if (now - lastUiUpdateAtRef.current < UI_THROTTLE_MS) return;
                lastUiUpdateAtRef.current = now;

                setLiveSpotPrice(quoteKey, { priceUsd: tick.priceUsd, updatedAtMs, source: 'pyth' });
                setStatus(prev =>
                    prev.kind === 'realtime' ? prev : { kind: 'realtime', updatedAtMs, source: 'pyth' },
                );
            },
        });

        return () => unsubscribe();
    }, [streamEnabled, feedId, args.quoteKey]);

    // Degrade realtime status if ticks go stale.
    useEffect(() => {
        if (!streamEnabled) return;
        if (feedId == null) return;

        const intervalId = window.setInterval(() => {
            const lastAt = lastRealtimeTickAtRef.current;
            if (lastAt == null) return;
            if (Date.now() - lastAt <= REALTIME_STALE_MS) return;

            setStatus(prev => {
                if (prev.kind !== 'realtime') return prev;
                return { kind: 'fallback', updatedAtMs: prev.updatedAtMs, source: prev.source, reason: 'stale' };
            });
        }, 1_000);

        return () => window.clearInterval(intervalId);
    }, [streamEnabled, feedId]);

    return enabled ? status : DISABLED_STATUS;
}
