'use client';

import {
    PYTH_PRO_AUTH_SUBPROTOCOL,
    PYTH_PRO_STREAM_HOSTS,
    type PythPriceTick,
    type PythUnavailableReason,
    buildPythSubscribeMessage,
    buildPythUnsubscribeMessage,
    parsePythStreamMessage,
} from '@/lib/realtime-prices/pyth-pro-protocol';

/**
 * One Pyth Pro websocket per tab, multiplexing every live quote on the page.
 *
 * Auth: the browser asks our server for a short-lived JWT (/api/realtime/pyth-token)
 * and presents it as a websocket subprotocol, per Pyth's frontend-auth guide.
 * The socket is reopened with a fresh token shortly before the JWT expires and
 * with exponential backoff after failures, rotating across Pyth's three hosts.
 */

const TOKEN_ENDPOINT = '/api/realtime/pyth-token';
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_MIN_LIFETIME_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const UNCONFIGURED_RETRY_MS = 5 * 60_000;

export type PythSubscriptionStatus =
    { kind: 'subscribed' } | { kind: 'unavailable'; reason: PythUnavailableReason } | { kind: 'disconnected' };

export interface PythFeedListener {
    onTick: (tick: PythPriceTick) => void;
    onStatus?: (status: PythSubscriptionStatus) => void;
}

interface FeedSubscription {
    feedId: number;
    subscriptionId: number;
    listeners: Set<PythFeedListener>;
    lastStatus: PythSubscriptionStatus | null;
}

type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

const subscriptionsByFeed = new Map<number, FeedSubscription>();
const feedBySubscriptionId = new Map<number, number>();
let nextSubscriptionId = 1;

let socket: WebSocket | null = null;
let connectionState: ConnectionState = 'idle';
let reconnectAttempt = 0;
let hostIndex = 0;
let reconnectTimer: number | null = null;
let tokenRefreshTimer: number | null = null;
let connectGeneration = 0;

function clearTimer(id: number | null): void {
    if (id != null) window.clearTimeout(id);
}

function notifyStatus(sub: FeedSubscription, status: PythSubscriptionStatus): void {
    sub.lastStatus = status;
    for (const listener of Array.from(sub.listeners)) listener.onStatus?.(status);
}

async function fetchAccessToken(): Promise<{ accessToken: string; expiresAtMs: number } | 'unconfigured' | null> {
    try {
        const res = await fetch(TOKEN_ENDPOINT, { method: 'POST', cache: 'no-store' });
        if (res.status === 503) return 'unconfigured';
        if (!res.ok) return null;
        const json = (await res.json()) as { accessToken?: unknown; expiresAt?: unknown };
        if (typeof json.accessToken !== 'string') return null;
        const expiresAtMs = typeof json.expiresAt === 'string' ? Date.parse(json.expiresAt) : NaN;
        return {
            accessToken: json.accessToken,
            expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 10 * 60_000,
        };
    } catch {
        return null;
    }
}

function scheduleReconnect(delayMs: number): void {
    clearTimer(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
    }, delayMs);
}

function backoffDelay(): number {
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
    reconnectAttempt = Math.min(reconnectAttempt + 1, 10);
    return base + Math.random() * 250;
}

function teardownSocket(): void {
    clearTimer(tokenRefreshTimer);
    tokenRefreshTimer = null;
    if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
            socket.close();
        } catch {
            // ignore
        }
    }
    socket = null;
    connectionState = 'closed';
    for (const sub of subscriptionsByFeed.values()) {
        if (sub.lastStatus?.kind !== 'unavailable') notifyStatus(sub, { kind: 'disconnected' });
    }
}

function sendSubscribe(sub: FeedSubscription): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(buildPythSubscribeMessage(sub.subscriptionId, [sub.feedId]));
}

function handleMessage(raw: string): void {
    for (const event of parsePythStreamMessage(raw)) {
        if (event.type === 'ignored') continue;
        const feedId = feedBySubscriptionId.get(event.subscriptionId);
        if (feedId == null) continue;
        const sub = subscriptionsByFeed.get(feedId);
        if (!sub) continue;

        switch (event.type) {
            case 'ticks':
                if (sub.lastStatus?.kind !== 'subscribed') notifyStatus(sub, { kind: 'subscribed' });
                for (const tick of event.ticks) {
                    if (tick.feedId !== sub.feedId) continue;
                    for (const listener of Array.from(sub.listeners)) listener.onTick(tick);
                }
                break;
            case 'subscribed':
                if (event.feedIds.includes(sub.feedId)) notifyStatus(sub, { kind: 'subscribed' });
                break;
            case 'unavailable':
                if (event.feedId === sub.feedId) notifyStatus(sub, { kind: 'unavailable', reason: event.reason });
                break;
            case 'subscriptionError':
                notifyStatus(sub, { kind: 'unavailable', reason: event.reason });
                break;
            case 'unsubscribed':
                break;
        }
    }
}

async function connect(): Promise<void> {
    if (typeof window === 'undefined') return;
    if (connectionState === 'connecting' || connectionState === 'open') return;
    if (subscriptionsByFeed.size === 0) return;

    connectionState = 'connecting';
    const generation = ++connectGeneration;

    const token = await fetchAccessToken();
    if (generation !== connectGeneration) return;
    if (token === 'unconfigured') {
        connectionState = 'closed';
        scheduleReconnect(UNCONFIGURED_RETRY_MS);
        return;
    }
    if (!token) {
        connectionState = 'closed';
        scheduleReconnect(backoffDelay());
        return;
    }

    const url = PYTH_PRO_STREAM_HOSTS[hostIndex % PYTH_PRO_STREAM_HOSTS.length]!;
    let ws: WebSocket;
    try {
        ws = new WebSocket(url, [PYTH_PRO_AUTH_SUBPROTOCOL, token.accessToken]);
    } catch {
        connectionState = 'closed';
        hostIndex += 1;
        scheduleReconnect(backoffDelay());
        return;
    }
    socket = ws;

    ws.onopen = () => {
        if (socket !== ws) return;
        connectionState = 'open';
        reconnectAttempt = 0;
        for (const sub of subscriptionsByFeed.values()) sendSubscribe(sub);

        // Reopen with a fresh JWT before this one expires (Pyth caps the TTL at 15 minutes).
        const lifetime = token.expiresAtMs - Date.now();
        const refreshIn = Math.max(TOKEN_MIN_LIFETIME_MS, lifetime - TOKEN_REFRESH_MARGIN_MS);
        clearTimer(tokenRefreshTimer);
        tokenRefreshTimer = window.setTimeout(() => {
            tokenRefreshTimer = null;
            if (socket !== ws) return;
            teardownSocket();
            void connect();
        }, refreshIn);
    };

    ws.onmessage = event => {
        if (socket !== ws) return;
        if (typeof event.data === 'string') handleMessage(event.data);
    };

    ws.onerror = () => {
        // onclose follows; nothing to do here.
    };

    ws.onclose = () => {
        if (socket !== ws) return;
        teardownSocket();
        hostIndex += 1;
        if (subscriptionsByFeed.size > 0) scheduleReconnect(backoffDelay());
    };
}

function disconnectIfIdle(): void {
    if (subscriptionsByFeed.size > 0) return;
    clearTimer(reconnectTimer);
    reconnectTimer = null;
    connectGeneration += 1;
    teardownSocket();
    connectionState = 'idle';
}

/**
 * Subscribe to a Pyth feed. Returns an unsubscribe function. Subscriptions are
 * ref-counted per feed; the socket opens on the first subscriber and closes when
 * the last one leaves.
 */
export function subscribePythFeed(feedId: number, listener: PythFeedListener): () => void {
    if (typeof window === 'undefined' || !Number.isInteger(feedId)) return () => {};

    let sub = subscriptionsByFeed.get(feedId);
    if (!sub) {
        sub = { feedId, subscriptionId: nextSubscriptionId++, listeners: new Set(), lastStatus: null };
        subscriptionsByFeed.set(feedId, sub);
        feedBySubscriptionId.set(sub.subscriptionId, feedId);
        if (connectionState === 'open') sendSubscribe(sub);
        else void connect();
    } else if (sub.lastStatus) {
        listener.onStatus?.(sub.lastStatus);
    }
    sub.listeners.add(listener);

    return () => {
        const current = subscriptionsByFeed.get(feedId);
        if (!current) return;
        current.listeners.delete(listener);
        if (current.listeners.size > 0) return;

        subscriptionsByFeed.delete(feedId);
        feedBySubscriptionId.delete(current.subscriptionId);
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(buildPythUnsubscribeMessage(current.subscriptionId));
        }
        disconnectIfIdle();
    };
}
