import { describe, expect, it } from 'bun:test';

import { getProtocolTokenFallback, POOL_PROTOCOL_TOKENS } from './_protocol-tokens';

describe('getProtocolTokenFallback', () => {
    it('returns null for empty input', () => {
        expect(getProtocolTokenFallback('')).toBe(null);
        expect(getProtocolTokenFallback('   ')).toBe(null);
    });

    it('matches by protocol source name', () => {
        expect(getProtocolTokenFallback('Orca Whirlpool')?.source).toBe('orca');
        expect(getProtocolTokenFallback('raydium-clmm')?.symbol).toBe('RAY');
        expect(getProtocolTokenFallback('Marindade Finance')?.source).toBe('marinade');
    });

    it('matches by known protocol mint address', () => {
        const orca = POOL_PROTOCOL_TOKENS.find(token => token.source === 'orca');
        expect(orca).toBeTruthy();
        expect(getProtocolTokenFallback(orca!.address)?.symbol).toBe('ORCA');
    });

    it('returns null for unknown sources', () => {
        expect(getProtocolTokenFallback('unknown-dex')).toBe(null);
    });
});
