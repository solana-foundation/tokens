import { afterEach, describe, expect, test } from 'bun:test';

import { withExternalTiming } from './externalTiming';

const ORIGINAL_LOG = console.log;

function captureEvent(): { events: Array<Record<string, unknown>> } {
    const captured: { events: Array<Record<string, unknown>> } = { events: [] };
    console.log = (line: string) => {
        captured.events.push(JSON.parse(line));
    };
    return captured;
}

describe('withExternalTiming ok flag', () => {
    afterEach(() => {
        console.log = ORIGINAL_LOG;
    });

    test.each([
        [200, true],
        [301, true],
        [302, true],
        [404, false],
        [500, false],
    ])('status %d logs ok=%p', async (status, ok) => {
        const captured = captureEvent();
        await withExternalTiming('logo_test', 'https://example.com/img.png', async () => new Response(null, { status }));
        expect(captured.events).toHaveLength(1);
        expect(captured.events[0]).toMatchObject({ event: 'external_call', provider: 'logo_test', status, ok });
    });

    test('thrown fetch logs ok=false and rethrows', async () => {
        const captured = captureEvent();
        await expect(
            withExternalTiming('logo_test', 'https://example.com/img.png', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(captured.events[0]).toMatchObject({ ok: false, status: null });
    });
});
