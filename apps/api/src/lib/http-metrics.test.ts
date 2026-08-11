import { describe, expect, it } from 'bun:test';

import { normalizeEndpointPath, shouldSkipHttpMetrics } from './http-metrics';

describe('shouldSkipHttpMetrics', () => {
    it('skips both public health endpoints', () => {
        expect(shouldSkipHttpMetrics('/api/health')).toBe(true);
        expect(shouldSkipHttpMetrics('/api/v1/health')).toBe(true);
    });

    it('does not skip authenticated or asset routes', () => {
        expect(shouldSkipHttpMetrics('/api/v1/whoami')).toBe(false);
        expect(shouldSkipHttpMetrics('/api/v1/assets/solana')).toBe(false);
    });
});

describe('normalizeEndpointPath', () => {
    it('collapses asset detail paths onto parameterized templates', () => {
        expect(normalizeEndpointPath('/api/v1/assets/solana')).toBe('/api/v1/assets/:assetId');
        expect(normalizeEndpointPath('/api/v1/assets/solana/ohlcv')).toBe('/api/v1/assets/:assetId/ohlcv');
        expect(normalizeEndpointPath('/api/v1/assets/solana/risk-summary')).toBe(
            '/api/v1/assets/:assetId/risk-summary',
        );
    });

    it('keeps named collection routes concrete', () => {
        expect(normalizeEndpointPath('/api/v1/assets/search')).toBe('/api/v1/assets/search');
        expect(normalizeEndpointPath('/api/v1/assets/curated')).toBe('/api/v1/assets/curated');
        expect(normalizeEndpointPath('/api/v1/assets')).toBe('/api/v1/assets');
        expect(normalizeEndpointPath('/api/v1/whoami')).toBe('/api/v1/whoami');
        expect(normalizeEndpointPath('/api/v1/health')).toBe('/api/v1/health');
    });

    it('normalizes legacy token and coingecko routes', () => {
        expect(normalizeEndpointPath('/api/token/So11111111111111111111111111111111111111112')).toBe(
            '/api/token/:address',
        );
        expect(
            normalizeEndpointPath('/api/token/So11111111111111111111111111111111111111112/markets'),
        ).toBe('/api/token/:address/markets');
        expect(normalizeEndpointPath('/api/coingecko/coins/bitcoin')).toBe('/api/coingecko/coins/:id');
        expect(normalizeEndpointPath('/api/coingecko/coins/search')).toBe('/api/coingecko/coins/search');
    });

    it('returns unrecognized paths unchanged', () => {
        expect(normalizeEndpointPath('/custom/path')).toBe('/custom/path');
    });
});
