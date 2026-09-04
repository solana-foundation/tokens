import type { CanonicalAsset } from '../types';
import { LST_MINTS } from './list-mints';

interface LstOverride {
    name: string;
    symbol: string;
    aliases?: string[];
}

const LST_OVERRIDES: Record<string, LstOverride> = {
    sctmWXGT7L75psrUHV2xxyTQKndE7ZcCQRHy2z6D5ER: { name: 'honestSOL', symbol: 'honestSOL' },
    StPsoHokZryePePFV8N7iXvfEmgUoJ87rivABX7gaW6: { name: 'stepSOL', symbol: 'stepSOL' },
    BPSoLzmLQn47EP5aa7jmFngRL8KC3TWAeAwXwZD8ip3P: { name: 'bpSOL', symbol: 'bpSOL' },
    '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': { name: 'stSOL', symbol: 'stSOL' },
    J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { name: 'JitoSOL', symbol: 'JitoSOL' },
    mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { name: 'mSOL', symbol: 'mSOL' },
    BNso1VUJnh4zcfpZa6986Ea66P6TCp59hvtNJ8b1X85: { name: 'BNSOL', symbol: 'BNSOL' },
    Bybit2vBJGhPF52GBdNaQfUJ6ZpThSgHBobjWZpLPb4B: { name: 'bbSOL', symbol: 'bbSOL' },
    jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: { name: 'JupSOL', symbol: 'JupSOL' },
    pSo1f9nQXWgXibFtKf7NWYxb5enAM4qfP6UJSiXRQfL: { name: 'PSOL', symbol: 'PSOL' },
    hy1oXYgrBW6PVcJ4s6s2FKavRdwgWTXdfE69AxT7kPT: { name: 'hyloSOL', symbol: 'hyloSOL' },
    sctmB7GPi5L2Q5G9tUSzXvhZ4YiDMEGcRov9KfArQpx: { name: 'dfdvSOL', symbol: 'dfdvSOL' },
    sctmAy9zFfZznZUWxEMgGtF6PHZ3gwoiCGcfwRua1AZ: { name: 'sctmSOL', symbol: 'sctmSOL' },
};

function normalizeVariantIdSuffix(value: string): string {
    return value.trim().replace(/\s+/g, '_');
}

function fallbackYieldVariantIdSuffix(mint: string): string {
    return `yield-${mint.slice(0, 8).toLowerCase()}`;
}

export const LST_ASSETS: CanonicalAsset[] = [
    {
        // Re-home liquid staking tokens as SOL yield-bearing variants.
        assetId: 'solana',
        category: 'crypto',
        aliases: [],
        variants: LST_MINTS.map(mint => {
            const override = LST_OVERRIDES[mint];
            const suffix = override?.symbol
                ? normalizeVariantIdSuffix(override.symbol)
                : fallbackYieldVariantIdSuffix(mint);

            return {
                variantId: `solana:${suffix}`,
                mint,
                kind: 'yield',
                trustTier: 'tier3',
                tags: ['curated:lsts'],
                ...(override ? { name: override.name, symbol: override.symbol } : {}),
            };
        }),
    } satisfies CanonicalAsset,
];
