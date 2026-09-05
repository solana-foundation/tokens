import type { CanonicalAsset, TrustTier, VariantKind } from '../types';
import { RWA_MINTS } from './list-mints';
import { uniqueStrings } from '../utils/unique-strings';

interface RwaOverride {
    name: string;
    symbol?: string;
    kind: VariantKind;
    trustTier?: TrustTier;
    aliases?: string[];
}

const RWA_OVERRIDES: Record<string, RwaOverride> = {
    // Yield / treasury tokens.
    '4MmJVdwYN8LwvbGeCowYjSx7KoEi6BJWg8XXnW4fDDp6': { name: 'OpenEden T-Bills', symbol: 'TBILL', kind: 'yield' },
    '34mJztT9am2jybSukvjNqRjgJBZqHJsHnivArx1P4xy1': { name: 'VanEck Treasury Fund', symbol: 'VBILL', kind: 'yield' },
    i7u4r16TcsJTgq1kAG8opmVZyVnAKBwLKu6ZPMwzxNc: {
        name: 'Ondo Short-Term US Gov Bond Fund',
        symbol: 'OUSG',
        kind: 'yield',
    },
    CCz3SGVziFeLYk2xfEstkiqJfYkjaSWb2GCABYsVcjo2: {
        name: 'Superstate Short Duration US Government Securities Fund',
        symbol: 'USTB',
        kind: 'yield',
    },
    USTRYnGgcHAhdWsanv8BG6vHGd4p7UGgoB9NRd8ei7j: { name: 'Etherfuse USTRY', symbol: 'USTRY', kind: 'yield' },
    '5Tu84fKBpe9vfXeotjvfvWdWbAjy3hqsExvuHgFqFxA1': { name: 'BENJI', symbol: 'BENJI', kind: 'yield' },
    XsqBC5tcVQLYt8wqGCHRnAUUecbRYXoJCReD6w7QEKp: { name: 'TBLL', symbol: 'TBLL', kind: 'yield' },

    // Treasury / credit ETFs (Ondo).
    '13qTjKx53y6LKGGStiKeieGbnVx3fx1bbwopKFb3ondo': { name: 'iShares Core US Aggregate Bond ETF', kind: 'etf' },
    KaSLSWByKy6b9FrCYXPEJoHmLpuFZtTCJk1F1Z9ondo: { name: 'iShares 20+ Year Treasury Bond ETF', kind: 'etf' },
    o6U1Sm6Vd7EofMyCrL28mrp2QLzgYGgjveHiEQ5ondo: { name: 'WisdomTree Floating Rate Treasury Fund', kind: 'etf' },
    t71FyTYHVkPAb5g48adDHmkVxXYbUuP2eq6jDZLondo: { name: 'iShares AAA CLO Active ETF', kind: 'etf' },
    ucQ3VfWAx9pkCN4Kg84zE56FtB4FJN2kQH4ArYYondo: { name: 'VanEck CLO ETF', kind: 'etf' },
};

function slugify(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replaceAll('&', 'and')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

function fallbackRwaAssetId(mint: string): string {
    return `rwa-${mint.slice(0, 8).toLowerCase()}`;
}

function defaultTrustTierForMint(_mint: string): TrustTier {
    return 'tier3';
}

export const RWA_ASSETS: CanonicalAsset[] = RWA_MINTS.map(mint => {
    const override = RWA_OVERRIDES[mint];
    const assetId = override ? slugify(override.symbol ?? override.name) : fallbackRwaAssetId(mint);
    const kind: VariantKind = override?.kind ?? 'wrapped';
    const trustTier: TrustTier = override?.trustTier ?? defaultTrustTierForMint(mint);

    return {
        assetId,
        category: 'rwa',
        ...(override ? { name: override.name, ...(override.symbol ? { symbol: override.symbol } : {}) } : {}),
        aliases: uniqueStrings([
            assetId,
            mint,
            override?.symbol ?? '',
            override?.name ?? '',
            ...(override?.aliases ?? []),
        ]),
        variants: [
            {
                variantId: `${assetId}:${mint}`,
                mint,
                kind,
                trustTier,
                tags: ['curated:rwas'],
            },
        ],
    } satisfies CanonicalAsset;
});
