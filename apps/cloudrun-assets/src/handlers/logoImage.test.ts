import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';

import { LOGO_SIZE, makeSharpLogoNormalizer, sniffImageContentType } from './logoImage';

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" width="100" height="40">
  <rect width="100" height="40" fill="#5b2fd6"/>
  <circle cx="20" cy="20" r="12" fill="#fff"/>
</svg>`;

describe('sniffImageContentType', () => {
    test('detects raster formats by magic bytes', async () => {
        const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#f00' } }).png().toBuffer();
        const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#0f0' } }).jpeg().toBuffer();
        const webp = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#00f' } }).webp().toBuffer();
        const gif = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#0ff' } }).gif().toBuffer();
        expect(sniffImageContentType(new Uint8Array(png))).toBe('image/png');
        expect(sniffImageContentType(new Uint8Array(jpeg))).toBe('image/jpeg');
        expect(sniffImageContentType(new Uint8Array(webp))).toBe('image/webp');
        expect(sniffImageContentType(new Uint8Array(gif))).toBe('image/gif');
    });

    test('detects SVG from text regardless of the prolog', () => {
        expect(sniffImageContentType(new TextEncoder().encode(SVG))).toBe('image/svg+xml');
        expect(sniffImageContentType(new TextEncoder().encode('\uFEFF  <svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
            'image/svg+xml',
        );
    });

    test('rejects html, json and short/garbage bodies', () => {
        expect(sniffImageContentType(new TextEncoder().encode('<!doctype html><html><body>429</body></html>'))).toBeNull();
        expect(sniffImageContentType(new TextEncoder().encode('{"error":"rate limited"}'))).toBeNull();
        expect(sniffImageContentType(new Uint8Array([1, 2, 3]))).toBeNull();
    });
});

describe('makeSharpLogoNormalizer', () => {
    const normalizer = makeSharpLogoNormalizer();

    test('rasterises SVG into a 256x256 WebP', async () => {
        const out = await normalizer.normalize(new TextEncoder().encode(SVG), 'image/svg+xml');
        expect(out.width).toBe(LOGO_SIZE);
        expect(out.height).toBe(LOGO_SIZE);
        const meta = await sharp(Buffer.from(out.webp)).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.width).toBe(LOGO_SIZE);
        expect(meta.height).toBe(LOGO_SIZE);
        // Non-square art is letterboxed with transparency, so the output keeps an alpha channel.
        expect(meta.hasAlpha).toBe(true);
    });

    test('upscales a tiny PNG to the fixed size and re-encodes as WebP', async () => {
        const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#123456' } })
            .png()
            .toBuffer();
        const out = await normalizer.normalize(new Uint8Array(png), 'image/png');
        const meta = await sharp(Buffer.from(out.webp)).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.width).toBe(LOGO_SIZE);
        expect(meta.height).toBe(LOGO_SIZE);
    });

    test('downsizes large art and keeps a single frame from animated GIFs', async () => {
        const big = await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#abcdef' } })
            .jpeg()
            .toBuffer();
        const out = await normalizer.normalize(new Uint8Array(big), 'image/jpeg');
        const meta = await sharp(Buffer.from(out.webp)).metadata();
        expect(meta.width).toBe(LOGO_SIZE);
        expect(meta.height).toBe(LOGO_SIZE);
        expect(meta.pages ?? 1).toBe(1);
    });

    test('throws LogoNormalizeError on undecodable bytes', async () => {
        await expect(normalizer.normalize(new TextEncoder().encode('definitely not an image'), 'image/png')).rejects.toThrow();
    });
});
