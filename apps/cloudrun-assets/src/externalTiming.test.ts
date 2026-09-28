import { afterEach, describe, expect, test } from 'bun:test';

import { withExternalTiming } from './externalTiming';
import { fetchLogoBytes } from './handlers/logoFetch';

const ORIGINAL_LOG = console.log;

function captureEvents(): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    console.log = (line: string) => {
        events.push(JSON.parse(line));
    };
    return events;
}

afterEach(() => {
    console.log = ORIGINAL_LOG;
});

describe('withExternalTiming ok flag', () => {
    test.each([
        [200, true],
        [301, false],
        [404, false],
        [500, false],
    ])('default derivation: status %d logs ok=%p', async (status, ok) => {
        const events = captureEvents();
        await withExternalTiming('logo_test', 'https://example.com/img.png', async () => new Response(null, { status }));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ event: 'external_call', provider: 'logo_test', status, ok });
    });

    test('deriveOutcome overrides the default', async () => {
        const events = captureEvents();
        await withExternalTiming(
            'logo_test',
            'https://example.com/img.png',
            async () => ({ ok: false as const, status: 301 }),
            result => ({ ok: result.ok, status: result.status }),
        );
        expect(events[0]).toMatchObject({ status: 301, ok: false });
    });

    test('thrown fetch logs ok=false and rethrows', async () => {
        const events = captureEvents();
        await expect(
            withExternalTiming('logo_test', 'https://example.com/img.png', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(events[0]).toMatchObject({ ok: false, status: null });
    });
});

describe('fetchLogoBytes external_call events', () => {
    const RESOLVE_PUBLIC = async () => ['93.184.216.34'];
    const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    function opts(fetchImpl: typeof fetch) {
        return { provider: 'logo_origin', timeoutMs: 5_000, fetchImpl, resolveHost: RESOLVE_PUBLIC };
    }

    test('redirect chain that lands logs one event with ok=true', async () => {
        const events = captureEvents();
        let call = 0;
        const fetchImpl = (async () => {
            call += 1;
            if (call === 1) return new Response(null, { status: 301, headers: { location: 'https://example.com/real.png' } });
            return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
        }) as unknown as typeof fetch;

        const result = await fetchLogoBytes('https://example.com/img.png', opts(fetchImpl));
        expect(result.ok).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ provider: 'logo_origin', status: 200, ok: true });
    });

    test('redirect without a location header logs one event with ok=false', async () => {
        const events = captureEvents();
        const fetchImpl = (async () => new Response(null, { status: 301 })) as unknown as typeof fetch;

        const result = await fetchLogoBytes('https://example.com/img.png', opts(fetchImpl));
        expect(result.ok).toBe(false);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ provider: 'logo_origin', status: 301, ok: false });
    });

    test('redirect loop past the hop limit logs one event with ok=false', async () => {
        const events = captureEvents();
        const fetchImpl = (async () =>
            new Response(null, { status: 302, headers: { location: 'https://example.com/loop.png' } })) as unknown as typeof fetch;

        const result = await fetchLogoBytes('https://example.com/img.png', opts(fetchImpl));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('redirect');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ provider: 'logo_origin', ok: false });
    });
});
