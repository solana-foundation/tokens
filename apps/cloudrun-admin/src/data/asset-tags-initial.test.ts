import { describe, expect, it } from 'bun:test';

import { isAssetIndustry, isAssetRegion } from '@tokens/asset-registry';

import { ASSET_TAGS_INITIAL } from './asset-tags-initial';

/**
 * Per-mint ids whose human identity is not in the fixture: Ondo `stock-*`
 * singletons are tagged in the admin edit dialog, not here. PreStocks `pre-*`
 * ids are tagged here but may postdate the fixture (e.g. xAI), so they are
 * exempt from the "must be in the fixture" check too.
 */
const OPAQUE_ID = /^(stock|pre)-[a-z0-9]{8}$/;

interface CuratedCollectionsFixture {
    slug: string;
    members: Array<{ assetId: string }>;
}

async function loadCuratedStockIds(): Promise<string[]> {
    const path = new URL('../../../cloudrun-assets/src/data/curated-collections-seed.json', import.meta.url);
    const fixture = (await Bun.file(path).json()) as CuratedCollectionsFixture[];
    const stocks = fixture.find(collection => collection.slug === 'stocks');
    if (!stocks) throw new Error('curated fixture has no stocks collection');
    return stocks.members.map(member => member.assetId);
}

describe('ASSET_TAGS_INITIAL', () => {
    it('only uses vocabulary slugs', () => {
        for (const [assetId, row] of Object.entries(ASSET_TAGS_INITIAL)) {
            expect(isAssetRegion(row.region)).toBe(true);
            expect(isAssetIndustry(row.industry)).toBe(true);
            expect(assetId).toBe(assetId.trim().toLowerCase());
        }
    });

    it('covers every named curated stock and nothing outside the stocks fixture', async () => {
        const stockIds = await loadCuratedStockIds();
        const stockIdSet = new Set(stockIds);

        const unknownKeys = Object.keys(ASSET_TAGS_INITIAL).filter(id => !stockIdSet.has(id) && !OPAQUE_ID.test(id));
        expect(unknownKeys).toEqual([]);

        const missing = stockIds.filter(id => !/^stock-[a-z0-9]{8}$/.test(id) && !(id in ASSET_TAGS_INITIAL));
        expect(missing).toEqual([]);
    });
});
