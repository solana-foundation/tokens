'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export type LiveSpotSource = 'pyth' | 'seed' | 'last-known';

export interface LiveSpotPrice {
    priceUsd: number;
    updatedAtMs: number;
    source: LiveSpotSource;
}

const liveByKey = new Map<string, LiveSpotPrice>();
const listenersByKey = new Map<string, Set<() => void>>();

function normalizeKey(key: string): string {
    return (key ?? '').trim();
}

function emit(key: string): void {
    const k = normalizeKey(key);
    if (!k) return;
    const listeners = listenersByKey.get(k);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) listener();
}

export function getLiveSpotPrice(key: string): LiveSpotPrice | null {
    const k = normalizeKey(key);
    if (!k) return null;
    return liveByKey.get(k) ?? null;
}

export function setLiveSpotPrice(key: string, next: LiveSpotPrice): void {
    const k = normalizeKey(key);
    if (!k) return;

    if (!Number.isFinite(next.priceUsd) || next.priceUsd <= 0) return;
    if (!Number.isFinite(next.updatedAtMs) || next.updatedAtMs <= 0) return;

    const prev = liveByKey.get(k) ?? null;
    if (prev && prev.priceUsd === next.priceUsd && prev.updatedAtMs === next.updatedAtMs && prev.source === next.source)
        return;

    liveByKey.set(k, next);
    emit(k);
}

function subscribeKey(key: string, onStoreChange: () => void): () => void {
    const k = normalizeKey(key);
    if (!k) return () => {};

    const set = listenersByKey.get(k) ?? new Set<() => void>();
    set.add(onStoreChange);
    listenersByKey.set(k, set);

    return () => {
        const current = listenersByKey.get(k);
        if (!current) return;
        current.delete(onStoreChange);
        if (current.size === 0) listenersByKey.delete(k);
    };
}

export function useLiveSpotPrice(key: string): LiveSpotPrice | null {
    const k = normalizeKey(key);
    const subscribe = useCallback((onStoreChange: () => void) => subscribeKey(k, onStoreChange), [k]);

    return useSyncExternalStore(
        subscribe,
        () => getLiveSpotPrice(k),
        () => null,
    );
}

/**
 * The live price for `key` only while it is fresh: a `pyth` tick no older than
 * `maxAgeMs`. Unlike reading the store and checking the age inline, this hook
 * schedules a re-render at the moment the tick expires, so a row whose stream
 * went quiet drops back to its snapshot instead of pinning the last live value.
 */
export function useFreshLiveSpotPrice(key: string, maxAgeMs: number): number | null {
    const liveSpot = useLiveSpotPrice(key);
    const [, forceRender] = useState(0);

    const expiresAtMs = liveSpot && liveSpot.source === 'pyth' ? liveSpot.updatedAtMs + maxAgeMs : null;
    useEffect(() => {
        if (expiresAtMs == null) return;
        const delay = expiresAtMs - Date.now();
        if (delay <= 0) return;
        const id = window.setTimeout(() => forceRender(n => n + 1), delay + 1);
        return () => window.clearTimeout(id);
    }, [expiresAtMs]);

    return isFreshLiveSpot(liveSpot, maxAgeMs) ? liveSpot!.priceUsd : null;
}

/** Synchronous freshness check for non-React callers (e.g. table sorting). */
export function isFreshLiveSpot(liveSpot: LiveSpotPrice | null, maxAgeMs: number): boolean {
    return (
        !!liveSpot &&
        liveSpot.source === 'pyth' &&
        Number.isFinite(liveSpot.priceUsd) &&
        liveSpot.priceUsd > 0 &&
        Date.now() - liveSpot.updatedAtMs <= maxAgeMs
    );
}
