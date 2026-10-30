import type { AssetCategory, AssetVariant, CanonicalAsset } from '../types';
import { CHAIN_NATIVE_ASSETS } from './chain-native-assets';
import { COMMODITY_ASSETS } from './commodities';
import { CRYPTO_ASSETS } from './crypto';
import { EQUITY_ASSETS } from './equities';
import { ETF_ASSETS } from './etfs';
import { LST_ASSETS } from './lsts';
import { MANUAL_ASSETS } from './manual';
import { RWA_ASSETS } from './rwas';
import { STABLECOIN_ASSETS } from './stablecoins';
import { uniqueStrings } from '../utils/unique-strings';

function categoryPriority(category: AssetCategory): number {
    switch (category) {
        case 'stablecoin':
            return 100;
        case 'lst':
            return 90;
        case 'rwa':
            return 80;
        case 'index':
            return 75;
        case 'etf':
            return 70;
        case 'commodity':
            return 60;
        case 'equity':
            return 50;
        case 'crypto':
            return 40;
        default:
            return 0;
    }
}

function mergeVariant(primary: AssetVariant, secondary: AssetVariant): AssetVariant {
    const mergedTags = new Set<string>([...primary.tags, ...secondary.tags]);

    return {
        ...primary,
        symbol: primary.symbol ?? secondary.symbol,
        name: primary.name ?? secondary.name,
        issuer: primary.issuer ?? secondary.issuer,
        issuerUrl: primary.issuerUrl ?? secondary.issuerUrl,
        label: primary.label ?? secondary.label,
        stockVariantTier: primary.stockVariantTier ?? secondary.stockVariantTier,
        tags: Array.from(mergedTags),
    };
}

function mergeAsset(a: CanonicalAsset, b: CanonicalAsset): CanonicalAsset {
    const aPriority = categoryPriority(a.category);
    const bPriority = categoryPriority(b.category);

    const primary = aPriority >= bPriority ? a : b;
    const secondary = aPriority >= bPriority ? b : a;

    const variantsByMint = new Map<string, AssetVariant>();
    for (const variant of primary.variants) variantsByMint.set(variant.mint, variant);
    for (const variant of secondary.variants) {
        const prev = variantsByMint.get(variant.mint);
        variantsByMint.set(variant.mint, prev ? mergeVariant(prev, variant) : variant);
    }

    return {
        assetId: primary.assetId,
        name: primary.name ?? secondary.name,
        symbol: primary.symbol ?? secondary.symbol,
        category: primary.category,
        aliases: uniqueStrings([...primary.aliases, ...secondary.aliases]),
        coingeckoId: primary.coingeckoId ?? secondary.coingeckoId,
        variants: Array.from(variantsByMint.values()),
    };
}

function mergeByAssetId(assets: CanonicalAsset[]): CanonicalAsset[] {
    const byId = new Map<string, CanonicalAsset>();

    for (const asset of assets) {
        const existing = byId.get(asset.assetId);
        byId.set(asset.assetId, existing ? mergeAsset(existing, asset) : asset);
    }

    return Array.from(byId.values());
}

export const CANONICAL_ASSETS: CanonicalAsset[] = mergeByAssetId([
    ...CRYPTO_ASSETS,
    ...MANUAL_ASSETS,
    ...STABLECOIN_ASSETS,
    ...LST_ASSETS,
    ...RWA_ASSETS,
    ...ETF_ASSETS,
    ...COMMODITY_ASSETS,
    ...EQUITY_ASSETS,
    ...CHAIN_NATIVE_ASSETS,
]);
