/**
 * Region + industry taxonomy for canonical assets.
 *
 * Both tags are admin-curated, single-valued and nullable. They live on the
 * `assets` table (`region`, `industry`; migration 0032) and are exposed on the
 * public v1 asset endpoints as exact-match, AND-combined filters
 * (`?region=asia&industry=manufacturing`).
 *
 * Leaf module on purpose: it imports NO registry data, so services and client
 * bundles can depend on it (via `@tokens/asset-registry/taxonomy`) without
 * pulling in the compiled asset graph.
 *
 * Vocabulary is enforced in app code, mirroring `category`: there is no CHECK
 * constraint, so growing either list is a code deploy, not a migration. The
 * nightly registry seed never writes these columns; the only writers are the
 * admin edit dialog and the admin bulk import.
 */

export const ASSET_REGIONS = [
    'north_america',
    'latin_america',
    'europe',
    'middle_east',
    'africa',
    'asia',
    'oceania',
    /** Reserved for broad ETFs/indices and instruments with no home geography. */
    'global',
] as const;
export type AssetRegion = (typeof ASSET_REGIONS)[number];

export const ASSET_INDUSTRIES = [
    'software',
    'semiconductors',
    'internet',
    'hardware',
    'defense',
    'aerospace',
    'manufacturing',
    'automotive',
    'energy',
    'materials',
    'utilities',
    'banking',
    'fintech',
    'asset_management',
    'insurance',
    'pharma',
    'biotech',
    'healthcare',
    'retail',
    'consumer_goods',
    'food_beverage',
    'media',
    'telecom',
    'travel_leisure',
    'real_estate',
    'crypto_mining',
    'crypto_exchange',
    /** Companies whose equity story is a digital-asset balance sheet (MicroStrategy, Bitmine, …). */
    'crypto_treasury',
    'conglomerate',
    /** Broad, non-thematic ETFs/index trackers (QQQ, SPY). Thematic ETFs take their theme instead. */
    'index_fund',
] as const;
export type AssetIndustry = (typeof ASSET_INDUSTRIES)[number];

export function isAssetRegion(value: unknown): value is AssetRegion {
    return typeof value === 'string' && (ASSET_REGIONS as readonly string[]).includes(value);
}

export function isAssetIndustry(value: unknown): value is AssetIndustry {
    return typeof value === 'string' && (ASSET_INDUSTRIES as readonly string[]).includes(value);
}

/** Null-safe coercion for DB text columns: unknown/legacy values read as null. */
export function toAssetRegionOrNull(value: unknown): AssetRegion | null {
    return isAssetRegion(value) ? value : null;
}

/** Null-safe coercion for DB text columns: unknown/legacy values read as null. */
export function toAssetIndustryOrNull(value: unknown): AssetIndustry | null {
    return isAssetIndustry(value) ? value : null;
}

/** Human-readable labels for admin UI and docs. */
export const ASSET_REGION_LABELS: Readonly<Record<AssetRegion, string>> = {
    north_america: 'North America',
    latin_america: 'Latin America',
    europe: 'Europe',
    middle_east: 'Middle East',
    africa: 'Africa',
    asia: 'Asia',
    oceania: 'Oceania',
    global: 'Global',
};

/** Human-readable labels for admin UI and docs. */
export const ASSET_INDUSTRY_LABELS: Readonly<Record<AssetIndustry, string>> = {
    software: 'Software',
    semiconductors: 'Semiconductors',
    internet: 'Internet',
    hardware: 'Hardware',
    defense: 'Defense',
    aerospace: 'Aerospace',
    manufacturing: 'Manufacturing',
    automotive: 'Automotive',
    energy: 'Energy',
    materials: 'Materials',
    utilities: 'Utilities',
    banking: 'Banking',
    fintech: 'Fintech',
    asset_management: 'Asset Management',
    insurance: 'Insurance',
    pharma: 'Pharma',
    biotech: 'Biotech',
    healthcare: 'Healthcare',
    retail: 'Retail',
    consumer_goods: 'Consumer Goods',
    food_beverage: 'Food & Beverage',
    media: 'Media',
    telecom: 'Telecom',
    travel_leisure: 'Travel & Leisure',
    real_estate: 'Real Estate',
    crypto_mining: 'Crypto Mining',
    crypto_exchange: 'Crypto Exchange',
    crypto_treasury: 'Crypto Treasury',
    conglomerate: 'Conglomerate',
    index_fund: 'Index Fund',
};
