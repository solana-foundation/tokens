import { afterEach, describe, expect, test } from 'bun:test';

import { IMAGE_CONTENT_SECURITY_POLICY } from '@/lib/image-response-headers';
import { GET } from './route';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';

describe('image-proxy response headers', () => {
    const originalFetch = globalThis.fetch;

    function stubUpstream(body: BodyInit, contentType: string | null): void {
        globalThis.fetch = (async () =>
            new Response(body, {
                status: 200,
                headers: contentType ? { 'content-type': contentType } : {},
            })) as typeof fetch;
    }

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    async function proxy(src: string, extra = ''): Promise<Response> {
        return GET(new Request(`https://www.tokens.xyz/api/image-proxy?src=${encodeURIComponent(src)}${extra}`));
    }

    test('serves svg with the same inert-document policy as next/image', async () => {
        stubUpstream(SVG_BODY, 'image/svg+xml');

        const response = await proxy('https://storage.googleapis.com/bucket/logo.svg');

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/svg+xml');
        expect(response.headers.get('content-security-policy')).toBe(IMAGE_CONTENT_SECURITY_POLICY);
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="image.svg"');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });

    test('applies the policy when svg is only detected by sniffing', async () => {
        stubUpstream(SVG_BODY, 'application/octet-stream');

        const response = await proxy('https://raw.githubusercontent.com/org/repo/logo');

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/svg+xml');
        expect(response.headers.get('content-security-policy')).toBe(IMAGE_CONTENT_SECURITY_POLICY);
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="image.svg"');
    });

    test('applies the policy to raster images too', async () => {
        stubUpstream(PNG_HEADER, 'image/png');

        const response = await proxy('https://assets.coingecko.com/coins/images/1/large/bitcoin.png', '&fresh=1');

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(response.headers.get('content-security-policy')).toBe(IMAGE_CONTENT_SECURITY_POLICY);
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="image.png"');
        expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
    });

    test('still rejects hosts outside the allowlist before fetching', async () => {
        let called = false;
        globalThis.fetch = (async () => {
            called = true;
            return new Response(SVG_BODY, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
        }) as typeof fetch;

        const response = await proxy('https://evil.example/logo.svg');

        expect(response.status).toBe(403);
        expect(called).toBe(false);
    });
});
