import { describe, expect, it } from 'bun:test';

import type { AdminVariantRow } from './admin-types';
import { addressError, editorRef, isDerivedOrigin, originLabel, rowRef, variantKey } from './variant-ref';

const USDC_SOL = 'EPjFWdd5AuFqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('addressError', () => {
    it('accepts a base58 mint on solana and rejects 0x there', () => {
        expect(addressError('solana', USDC_SOL)).toBeNull();
        expect(addressError('solana', USDC_ETH)).toBe('Not a valid Solana mint address.');
    });

    it('accepts a 0x address on EVM chains regardless of casing and rejects base58 there', () => {
        expect(addressError('ethereum', USDC_ETH)).toBeNull();
        expect(addressError('base', USDC_ETH.toLowerCase())).toBeNull();
        expect(addressError('ethereum', USDC_SOL)).toContain('Ethereum contract address');
    });

    it('treats an empty field as not-yet-an-error', () => {
        expect(addressError('ethereum', '   ')).toBeNull();
    });
});

describe('rowRef / editorRef', () => {
    const base: AdminVariantRow = {
        assetId: 'usdc',
        mint: USDC_SOL,
        variantId: 'usdc:native',
        kind: 'stablecoin',
        liquidityTier: 'tier1',
        trustTier: 'tier1',
        storedTrustTier: 'tier1',
        tags: [],
        isActive: true,
    };

    it('defaults rows from pre-multichain backends to solana + mint', () => {
        expect(rowRef(base)).toEqual({ chain: 'solana', address: USDC_SOL, assetId: 'usdc' });
        expect(variantKey(rowRef(base))).toBe(`solana:${USDC_SOL}`);
    });

    it('uses chain + address when the backend sends them', () => {
        const evm = { ...base, chain: 'ethereum' as const, address: USDC_ETH.toLowerCase(), mint: USDC_ETH.toLowerCase() };
        expect(rowRef(evm)).toEqual({ chain: 'ethereum', address: USDC_ETH.toLowerCase(), assetId: 'usdc' });
    });

    it('builds the same ref from an editor payload', () => {
        expect(
            editorRef({
                variant: { ...base, chain: 'arbitrum', address: '0xabc' },
                canonical: { assetId: 'usdc' },
                market: null,
            }),
        ).toEqual({ chain: 'arbitrum', address: '0xabc', assetId: 'usdc' });
    });
});

describe('origin helpers', () => {
    it('labels derived and admin rows and hides plain v1 rows', () => {
        expect(originLabel('v1')).toBeNull();
        expect(originLabel(undefined)).toBeNull();
        expect(originLabel('coingecko')).toBe('derived · CoinGecko');
        expect(originLabel('config')).toBe('derived · native');
        expect(originLabel('admin')).toBe('admin');
    });

    it('only coingecko/config count as derived', () => {
        expect(isDerivedOrigin('coingecko')).toBe(true);
        expect(isDerivedOrigin('config')).toBe(true);
        expect(isDerivedOrigin('admin')).toBe(false);
        expect(isDerivedOrigin('v1')).toBe(false);
    });
});
