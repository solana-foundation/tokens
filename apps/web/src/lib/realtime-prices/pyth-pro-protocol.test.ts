import { describe, expect, test } from 'bun:test';

import {
    buildPythSubscribeMessage,
    classifySubscriptionError,
    buildPythUnsubscribeMessage,
    parsePythStreamMessage,
    pythPriceToNumber,
} from './pyth-pro-protocol';

describe('pythPriceToNumber', () => {
    test('scales the string mantissa by the exponent', () => {
        expect(pythPriceToNumber('9434838140', -8)).toBeCloseTo(94.3483814, 6);
        expect(pythPriceToNumber('7706588208239', -8)).toBeCloseTo(77065.88208239, 6);
    });

    test('rejects missing, non-finite and non-positive prices', () => {
        expect(pythPriceToNumber(undefined, -8)).toBeNull();
        expect(pythPriceToNumber('abc', -8)).toBeNull();
        expect(pythPriceToNumber('0', -8)).toBeNull();
        expect(pythPriceToNumber('100', undefined)).toBeNull();
    });
});

describe('buildPythSubscribeMessage', () => {
    test('asks for parsed JSON on the plan-safe channel with invalid feeds ignored', () => {
        const message = JSON.parse(buildPythSubscribeMessage(7, [6, 1847]));
        expect(message).toMatchObject({
            type: 'subscribe',
            subscriptionId: 7,
            priceFeedIds: [6, 1847],
            formats: [],
            deliveryFormat: 'json',
            parsed: true,
            channel: 'fixed_rate@1000ms',
            ignoreInvalidFeeds: true,
        });
        expect(message.properties).toContain('price');
        expect(message.properties).toContain('exponent');
        expect(JSON.parse(buildPythUnsubscribeMessage(7))).toEqual({ type: 'unsubscribe', subscriptionId: 7 });
    });
});

describe('parsePythStreamMessage', () => {
    // Captured from wss://pyth-lazer-1.dourolabs.app/v1/stream on 2026-10-30.
    const STREAM_UPDATED = JSON.stringify({
        type: 'streamUpdated',
        subscriptionId: 7,
        parsed: {
            timestampUs: '1793384266000000',
            priceFeeds: [
                {
                    priceFeedId: 6,
                    price: '9411937170',
                    exponent: -8,
                    marketSession: 'regular',
                    feedUpdateTimestamp: 1793384266000000,
                },
                {
                    priceFeedId: 1847,
                    price: '39491447933',
                    exponent: -8,
                    marketSession: 'regular',
                    feedUpdateTimestamp: 1793384266000000,
                },
                { priceFeedId: 9999, exponent: -8, marketSession: 'closed' },
            ],
        },
    });

    const SUBSCRIBED_PARTIAL = JSON.stringify({
        type: 'subscribedWithInvalidFeedIdsIgnored',
        subscriptionId: 7,
        subscribedFeedIds: [6, 1847, 3128],
        ignoredInvalidFeedIds: {
            unknownIds: [42],
            unknownSymbols: [],
            unsupportedChannels: [],
            unstable: [],
            notEntitled: [1435, 1157, 346, 3619],
        },
    });

    test('turns streamUpdated into ticks, skipping feeds without a price', () => {
        const events = parsePythStreamMessage(STREAM_UPDATED);
        expect(events).toHaveLength(1);
        const event = events[0]!;
        expect(event.type).toBe('ticks');
        if (event.type !== 'ticks') return;
        expect(event.subscriptionId).toBe(7);
        expect(event.ticks.map(t => t.feedId)).toEqual([6, 1847]);
        expect(event.ticks[0]!.priceUsd).toBeCloseTo(94.1193717, 6);
        expect(event.ticks[0]!.publishTimeMs).toBe(1793384266000);
        expect(event.ticks[0]!.marketSession).toBe('regular');
    });

    test('reports entitlement and unknown-id rejections per feed', () => {
        const events = parsePythStreamMessage(SUBSCRIBED_PARTIAL);
        expect(events[0]).toEqual({ type: 'subscribed', subscriptionId: 7, feedIds: [6, 1847, 3128] });
        const unavailable = events.filter(e => e.type === 'unavailable');
        expect(unavailable).toHaveLength(5);
        const byFeed = (feedId: number) => unavailable.find(e => e.type === 'unavailable' && e.feedId === feedId);
        expect(byFeed(1435)).toEqual({ type: 'unavailable', subscriptionId: 7, feedId: 1435, reason: 'not_entitled' });
        expect(byFeed(42)).toEqual({ type: 'unavailable', subscriptionId: 7, feedId: 42, reason: 'not_found' });
    });

    test('surfaces subscription errors and unsubscribes, ignores noise', () => {
        expect(
            parsePythStreamMessage(
                JSON.stringify({
                    type: 'subscriptionError',
                    subscriptionId: 1,
                    error: 'No valid feeds to subscribe to',
                }),
            ),
        ).toEqual([
            {
                type: 'subscriptionError',
                subscriptionId: 1,
                message: 'No valid feeds to subscribe to',
                reason: 'error',
            },
        ]);
        // Captured 2026-10-30 when subscribing to a single equity feed on the Starter plan.
        const entitlement = parsePythStreamMessage(
            JSON.stringify({
                type: 'subscriptionError',
                subscriptionId: 2,
                error: 'No valid feeds to subscribe to: Not entitled: feed 1435 (no grant accepts this feed)',
            }),
        );
        expect(entitlement[0]).toMatchObject({ type: 'subscriptionError', subscriptionId: 2, reason: 'not_entitled' });
        expect(classifySubscriptionError('Channel real_time violates rate limit')).toBe('unsupported_channel');
        expect(parsePythStreamMessage(JSON.stringify({ type: 'unsubscribed', subscriptionId: 7 }))).toEqual([
            { type: 'unsubscribed', subscriptionId: 7 },
        ]);
        expect(parsePythStreamMessage('not json')).toEqual([{ type: 'ignored' }]);
        expect(parsePythStreamMessage(JSON.stringify({ type: 'streamUpdated' }))).toEqual([{ type: 'ignored' }]);
    });
});
