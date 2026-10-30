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
/** Keep the socket open this long after the last subscriber leaves, so a re-sort or page change does not reconnect. */
const IDLE_LINGER_MS = 20_000;
/** A cached JWT is reused until this close to its expiry. */
const TOKEN_REUSE_MARGIN_MS = 90_000;
const TOKEN_STORAGE_KEY = 'TOKENS_PYTH_PRO_JWT_V1';

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

type TokenFetchResult =
    { accessToken: string; expiresAtMs: number } | { rateLimitedForMs: number } | 'unconfigured' | null;

interface CachedToken {
    accessToken: string;
    expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;

function readStoredToken(): CachedToken | null {
    try {
        const raw = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<CachedToken>;
        if (typeof parsed.accessToken !== 'string' || typeof parsed.expiresAtMs !== 'number') return null;
        return { accessToken: parsed.accessToken, expiresAtMs: parsed.expiresAtMs };
    } catch {
        return null;
    }
}

function storeToken(token: CachedToken | null): void {
    cachedToken = token;
    try {
        if (token) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
        else window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
        // Storage may be unavailable (private mode, quota); the in-memory copy still works.
    }
}

function isReusable(token: CachedToken | null): token is CachedToken {
    return !!token && token.expiresAtMs - Date.now() > TOKEN_REUSE_MARGIN_MS;
}

/**
 * A JWT that is still good for a while, minting only when none is. Reconnects
 * (sort changes, page navigation, host failover) therefore do not spend the
 * server's mint budget; a tab mints roughly once per token lifetime.
 */
async function getAccessToken(): Promise<TokenFetchResult> {
    if (isReusable(cachedToken)) return cachedToken;
    const stored = readStoredToken();
    if (isReusable(stored)) {
        cachedToken = stored;
        return stored;
    }
    const minted = await fetchAccessToken();
    if (minted && typeof minted === 'object' && 'accessToken' in minted) storeToken(minted);
    return minted;
}

async function fetchAccessToken(): Promise<TokenFetchResult> {
    try {
        const res = await fetch(TOKEN_ENDPOINT, { method: 'POST', cache: 'no-store' });
        if (res.status === 503) return 'unconfigured';
        if (res.status === 429) {
            const retryAfter = Number(res.headers.get('retry-after'));
            return { rateLimitedForMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000 };
        }
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

    const token = await getAccessToken();
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
    if ('rateLimitedForMs' in token) {
        // The server is protecting the shared quota; wait out the window rather than hammer it.
        connectionState = 'closed';
        scheduleReconnect(token.rateLimitedForMs + Math.random() * 1_000);
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
            storeToken(null);
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

    ws.onclose = event => {
        if (socket !== ws) return;
        // A close before the handshake completed usually means the token was refused; mint anew next time.
        if (connectionState === 'connecting' || event.code === 1002 || event.code === 1008) storeToken(null);
        teardownSocket();
        hostIndex += 1;
        if (subscriptionsByFeed.size > 0) scheduleReconnect(backoffDelay());
    };
}

let idleTimer: number | null = null;

/**
 * When the last subscriber leaves, keep the socket for a short linger before
 * closing it: a table re-sort or a client-side page change unsubscribes
 * everything and resubscribes moments later, and must not cost a reconnect.
 */
function disconnectIfIdle(): void {
    if (subscriptionsByFeed.size > 0) return;
    clearTimer(idleTimer);
    idleTimer = window.setTimeout(() => {
        idleTimer = null;
        if (subscriptionsByFeed.size > 0) return;
        clearTimer(reconnectTimer);
        reconnectTimer = null;
        connectGeneration += 1;
        teardownSocket();
        connectionState = 'idle';
    }, IDLE_LINGER_MS);
}

/**
 * Subscribe to a Pyth feed. Returns an unsubscribe function. Subscriptions are
 * ref-counted per feed; the socket opens on the first subscriber and closes when
 * the last one leaves.
 */
export function subscribePythFeed(feedId: number, listener: PythFeedListener): () => void {
    if (typeof window === 'undefined' || !Number.isInteger(feedId)) return () => {};

    clearTimer(idleTimer);
    idleTimer = null;

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
