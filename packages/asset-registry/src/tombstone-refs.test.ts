import { describe, expect, it } from 'bun:test';

import type { CanonicalAsset } from './types';
import { buildRegistryTombstoneRefs } from './tombstone-refs';

const asset: CanonicalAsset = {
    assetId: 'ripple',
    name: 'XRP',
    symbol: 'XRP',
    category: 'crypto',
    coingeckoId: 'ripple',
    aliases: ['wXRP', ' Ripple '],
    variants: [
        {
            variantId: 'ripple:wXRP',
            mint: '6UpQcMAb5xMzxc7ZfPaVMgx3KqsvKZdT5U718BzD5We2',
            kind: 'wrapped',
            trustTier: 'tier3',
            tags: [],
        },
    ],
};

describe('buildRegistryTombstoneRefs', () => {
    it('includes identity refs, aliases, variant mints and singleton ids, lowercased and deduped', () => {
        const refs = buildRegistryTombstoneRefs(asset);
        expect(refs).toEqual([
            'ripple',
            'xrp',
            'wxrp',
            '6upqcmab5xmzxc7zfpavmgx3kqsvkzdt5u718bzd5we2',
            'solana-6upqcmab5xmzxc7zfpavmgx3kqsvkzdt5u718bzd5we2',
        ]);
    });

    it('skips empty optional fields', () => {
        const refs = buildRegistryTombstoneRefs({ ...asset, name: undefined, symbol: undefined, coingeckoId: undefined, aliases: [] });
        expect(refs).toEqual([
            'ripple',
            '6upqcmab5xmzxc7zfpavmgx3kqsvkzdt5u718bzd5we2',
            'solana-6upqcmab5xmzxc7zfpavmgx3kqsvkzdt5u718bzd5we2',
        ]);
    });
});
