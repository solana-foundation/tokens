/**
 * Pyth Pro websocket protocol helpers shared by the browser client and tests.
 * Message shapes follow https://docs.pyth.network/pro/subscribe-to-prices and
 * the payload reference; everything here is pure.
 */

export const PYTH_PRO_STREAM_HOSTS = [
    'wss://pyth-lazer-0.dourolabs.app/v1/stream',
    'wss://pyth-lazer-1.dourolabs.app/v1/stream',
    'wss://pyth-lazer-2.dourolabs.app/v1/stream',
] as const;

/** Browsers cannot set headers on a WebSocket; Pyth reads the JWT from this subprotocol pair. */
export const PYTH_PRO_AUTH_SUBPROTOCOL = 'pyth-lazer-auth';

/**
 * Slowest channel Pyth offers; it is also the fastest the Starter plan allows
 * ("Minimum allowed channel is 1000ms"). Faster plans can lower this.
 */
export const PYTH_PRO_CHANNEL = 'fixed_rate@1000ms';

export const PYTH_PRO_PROPERTIES = ['price', 'exponent', 'marketSession', 'feedUpdateTimestamp'] as const;

export type PythMarketSession = 'regular' | 'preMarket' | 'postMarket' | 'overNight' | 'closed';

export interface PythPriceTick {
    feedId: number;
    priceUsd: number;
    /** Wall-clock time Pyth produced this price, in ms. */
    publishTimeMs: number | null;
    marketSession: PythMarketSession | null;
}

export type PythUnavailableReason = 'not_entitled' | 'not_found' | 'unsupported_channel' | 'unstable' | 'error';

export type PythStreamEvent =
    | { type: 'ticks'; subscriptionId: number; ticks: PythPriceTick[] }
    | { type: 'subscribed'; subscriptionId: number; feedIds: number[] }
    | { type: 'unavailable'; subscriptionId: number; feedId: number; reason: PythUnavailableReason }
    | { type: 'subscriptionError'; subscriptionId: number; message: string; reason: PythUnavailableReason }
    | { type: 'unsubscribed'; subscriptionId: number }
    | { type: 'ignored' };

export function buildPythSubscribeMessage(subscriptionId: number, feedIds: readonly number[]): string {
    return JSON.stringify({
        type: 'subscribe',
        subscriptionId,
        priceFeedIds: [...feedIds],
        properties: [...PYTH_PRO_PROPERTIES],
        formats: [],
        deliveryFormat: 'json',
        parsed: true,
        channel: PYTH_PRO_CHANNEL,
        ignoreInvalidFeeds: true,
    });
}

export function buildPythUnsubscribeMessage(subscriptionId: number): string {
    return JSON.stringify({ type: 'unsubscribe', subscriptionId });
}

/** `price × 10^exponent`, with Pyth's i64 mantissa delivered as a JSON string. */
export function pythPriceToNumber(price: unknown, exponent: unknown): number | null {
    const mantissa = typeof price === 'string' || typeof price === 'number' ? Number(price) : NaN;
    const expo = typeof exponent === 'number' ? exponent : NaN;
    if (!Number.isFinite(mantissa) || !Number.isFinite(expo)) return null;
    const value = mantissa * Math.pow(10, expo);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function asInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function asIntegerArray(value: unknown): number[] {
    return Array.isArray(value) ? value.flatMap(v => (asInteger(v) == null ? [] : [v as number])) : [];
}

function asMarketSession(value: unknown): PythMarketSession | null {
    switch (value) {
        case 'regular':
        case 'preMarket':
        case 'postMarket':
        case 'overNight':
        case 'closed':
            return value;
        default:
            return null;
    }
}

function microsToMs(value: unknown): number | null {
    const micros = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
    return Number.isFinite(micros) && micros > 0 ? Math.floor(micros / 1000) : null;
}

/**
 * A subscription with a single bad feed fails outright instead of being
 * reported under `ignoredInvalidFeedIds`; classify the error text so callers
 * can tell "plan does not cover this" from a real failure.
 */
export function classifySubscriptionError(message: string): PythUnavailableReason {
    const text = message.toLowerCase();
    if (text.includes('not entitled')) return 'not_entitled';
    if (text.includes('unknown')) return 'not_found';
    if (text.includes('channel')) return 'unsupported_channel';
    if (text.includes('unstable') || text.includes('coming soon')) return 'unstable';
    return 'error';
}

export function parsePythStreamMessage(raw: string): PythStreamEvent[] {
    let message: unknown;
    try {
        message = JSON.parse(raw);
    } catch {
        return [{ type: 'ignored' }];
    }
    if (!message || typeof message !== 'object') return [{ type: 'ignored' }];
    const m = message as Record<string, unknown>;
    const subscriptionId = asInteger(m.subscriptionId);

    switch (m.type) {
        case 'streamUpdated': {
            if (subscriptionId == null) return [{ type: 'ignored' }];
            const parsed = (m.parsed ?? null) as Record<string, unknown> | null;
            const feeds = Array.isArray(parsed?.priceFeeds) ? (parsed!.priceFeeds as unknown[]) : [];
            const fallbackTimeMs = microsToMs(parsed?.timestampUs);
            const ticks: PythPriceTick[] = [];
            for (const entry of feeds) {
                if (!entry || typeof entry !== 'object') continue;
                const feed = entry as Record<string, unknown>;
                const feedId = asInteger(feed.priceFeedId);
                if (feedId == null) continue;
                const priceUsd = pythPriceToNumber(feed.price, feed.exponent);
                if (priceUsd == null) continue;
                ticks.push({
                    feedId,
                    priceUsd,
                    publishTimeMs: microsToMs(feed.feedUpdateTimestamp) ?? fallbackTimeMs,
                    marketSession: asMarketSession(feed.marketSession),
                });
            }
            return ticks.length > 0 ? [{ type: 'ticks', subscriptionId, ticks }] : [{ type: 'ignored' }];
        }
        case 'subscribed':
        case 'subscribedWithInvalidFeedIdsIgnored': {
            if (subscriptionId == null) return [{ type: 'ignored' }];
            const events: PythStreamEvent[] = [
                { type: 'subscribed', subscriptionId, feedIds: asIntegerArray(m.subscribedFeedIds) },
            ];
            const ignored = (m.ignoredInvalidFeedIds ?? null) as Record<string, unknown> | null;
            if (ignored) {
                const buckets: Array<[string, PythUnavailableReason]> = [
                    ['notEntitled', 'not_entitled'],
                    ['unknownIds', 'not_found'],
                    ['unsupportedChannels', 'unsupported_channel'],
                    ['unstable', 'unstable'],
                ];
                for (const [key, reason] of buckets) {
                    for (const feedId of asIntegerArray(ignored[key])) {
                        events.push({ type: 'unavailable', subscriptionId, feedId, reason });
                    }
                }
            }
            return events;
        }
        case 'subscriptionError': {
            if (subscriptionId == null) return [{ type: 'ignored' }];
            const error = typeof m.error === 'string' ? m.error : 'subscription error';
            return [
                { type: 'subscriptionError', subscriptionId, message: error, reason: classifySubscriptionError(error) },
            ];
        }
        case 'unsubscribed':
            return subscriptionId == null ? [{ type: 'ignored' }] : [{ type: 'unsubscribed', subscriptionId }];
        default:
            return [{ type: 'ignored' }];
    }
}
