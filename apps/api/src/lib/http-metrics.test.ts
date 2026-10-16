import { describe, expect, test } from 'bun:test';

import { normalizeEndpointPath } from './http-metrics';

describe('normalizeEndpointPath (v2)', () => {
    test('collapses path params so usage keys stay bounded', () => {
        expect(normalizeEndpointPath('/api/v2/chains')).toBe('/api/v2/chains');
        expect(normalizeEndpointPath('/api/v2/assets')).toBe('/api/v2/assets');
        expect(normalizeEndpointPath('/api/v2/assets/bitcoin')).toBe('/api/v2/assets/:assetId');
        expect(normalizeEndpointPath('/api/v2/assets/bitcoin/variants')).toBe('/api/v2/assets/:assetId/variants');
        expect(normalizeEndpointPath('/api/v2/assets/bitcoin/ohlcv')).toBe('/api/v2/assets/:assetId/:sub');
        expect(normalizeEndpointPath('/api/v2/variants')).toBe('/api/v2/variants');
        expect(normalizeEndpointPath('/api/v2/variants/base/0xabc')).toBe('/api/v2/variants/:chain/:address');
        expect(normalizeEndpointPath('/api/v2/variants/base/0xabc/markets')).toBe(
            '/api/v2/variants/:chain/:address/markets',
        );
        expect(normalizeEndpointPath('/api/v2/lists/majors')).toBe('/api/v2/lists/:slug');
        expect(normalizeEndpointPath('/api/v2/lists/majors/members')).toBe('/api/v2/lists/:slug/members');
        expect(normalizeEndpointPath('/api/v2/lists/majors/members/EPjF')).toBe('/api/v2/lists/:slug/members/:mint');
        expect(normalizeEndpointPath('/api/v2/lists/check-slug')).toBe('/api/v2/lists/check-slug');
        expect(normalizeEndpointPath('/api/v2/search')).toBe('/api/v2/search');
    });
});
