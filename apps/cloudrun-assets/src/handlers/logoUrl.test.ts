import { describe, expect, test } from 'bun:test';

import { resolveLogoUri } from './logoUrl';

describe('resolveLogoUri', () => {
    test('prefers the first-party copy when present', () => {
        expect(
            resolveLogoUri({
                logo_uri: 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
                logo_cdn_url: 'https://storage.googleapis.com/tokens-asset-logos-prd/solana/mint.webp',
            }),
        ).toBe('https://storage.googleapis.com/tokens-asset-logos-prd/solana/mint.webp');
    });

    test('falls back to the raw upstream URL when no copy exists', () => {
        expect(resolveLogoUri({ logo_uri: 'https://example.test/a.png', logo_cdn_url: null })).toBe(
            'https://example.test/a.png',
        );
        expect(resolveLogoUri({ logo_uri: 'https://example.test/a.png' })).toBe('https://example.test/a.png');
    });

    test('treats blank values as missing', () => {
        expect(resolveLogoUri({ logo_uri: '   ', logo_cdn_url: '' })).toBeNull();
        expect(resolveLogoUri({ logo_uri: null, logo_cdn_url: null })).toBeNull();
        expect(resolveLogoUri({ logo_uri: ' https://example.test/a.png ', logo_cdn_url: ' ' })).toBe(
            'https://example.test/a.png',
        );
    });
});
