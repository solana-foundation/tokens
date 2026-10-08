import type { CanonicalAsset } from './types';

/**
 * Every ref an admin hard-delete may have tombstoned for a registry asset:
 * lowercased assetId, name, symbol, coingeckoId, aliases, variant mints and
 * `solana-<mint>` singleton ids. Mirrors cloudrun-admin's
 * `buildDeletionTombstoneRows`, so the nightly seed and every read surface
 * that falls back to the compiled registry agree on what "deleted" means.
 *
 * A surface that checks fewer refs than the seed shows a ghost: the asset is
 * findable but 404s on detail because the seed never re-created it.
 */
export function buildRegistryTombstoneRefs(asset: CanonicalAsset): string[] {
    const refs = new Set<string>();
    const add = (value: string | undefined | null) => {
        const normalized = value?.trim().toLowerCase();
        if (normalized) refs.add(normalized);
    };
    add(asset.assetId);
    add(asset.name);
    add(asset.symbol);
    add(asset.coingeckoId);
    for (const alias of asset.aliases) add(alias);
    for (const variant of asset.variants) {
        add(variant.mint);
        add(`solana-${variant.mint}`);
    }
    return [...refs];
}
