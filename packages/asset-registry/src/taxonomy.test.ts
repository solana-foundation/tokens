import { describe, expect, test } from 'bun:test';

import {
    ASSET_INDUSTRIES,
    ASSET_INDUSTRY_LABELS,
    ASSET_REGION_LABELS,
    ASSET_REGIONS,
    isAssetIndustry,
    isAssetRegion,
    toAssetIndustryOrNull,
    toAssetRegionOrNull,
} from './taxonomy';

describe('taxonomy', () => {
    test('vocabularies are snake_case slugs with no duplicates', () => {
        for (const list of [ASSET_REGIONS, ASSET_INDUSTRIES]) {
            expect(new Set(list).size).toBe(list.length);
            for (const slug of list) expect(slug).toMatch(/^[a-z]+(_[a-z]+)*$/);
        }
    });

    test('every slug has a label', () => {
        for (const region of ASSET_REGIONS) expect(ASSET_REGION_LABELS[region]).toBeTruthy();
        for (const industry of ASSET_INDUSTRIES) expect(ASSET_INDUSTRY_LABELS[industry]).toBeTruthy();
    });

    test('guards accept every slug and reject everything else', () => {
        for (const region of ASSET_REGIONS) expect(isAssetRegion(region)).toBe(true);
        for (const industry of ASSET_INDUSTRIES) expect(isAssetIndustry(industry)).toBe(true);
        for (const bad of ['', 'ASIA', 'Asia', ' asia', null, undefined, 1, {}]) {
            expect(isAssetRegion(bad)).toBe(false);
            expect(isAssetIndustry(bad)).toBe(false);
        }
        // Cross-vocabulary values do not leak.
        expect(isAssetRegion('software')).toBe(false);
        expect(isAssetIndustry('asia')).toBe(false);
    });

    test('coercers read unknown or legacy stored values as null', () => {
        expect(toAssetRegionOrNull('europe')).toBe('europe');
        expect(toAssetRegionOrNull('mars')).toBeNull();
        expect(toAssetRegionOrNull(null)).toBeNull();
        expect(toAssetIndustryOrNull('defense')).toBe('defense');
        expect(toAssetIndustryOrNull('Defense')).toBeNull();
        expect(toAssetIndustryOrNull(undefined)).toBeNull();
    });
});
