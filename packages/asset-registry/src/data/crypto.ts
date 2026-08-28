import type { AssetVariant, CanonicalAsset, TrustTier, VariantKind } from '../types';
import { MAJORS_MINTS } from './list-mints';
import { MANUAL_ASSET_DEFINITIONS } from './manual';
import { TOKEN_WRAPPER_GROUPS } from './token-wrappers';
import { BITCOIN_VARIANT_GROUP } from './token-variants';
import { uniqueStrings } from '../utils/unique-strings';

function isWormhole(deployer: string): boolean {
    return deployer.toLowerCase().includes('wormhole');
}

function mergeVariants(a: AssetVariant, b: AssetVariant): AssetVariant {
    const mergedTags = new Set<string>([...a.tags, ...b.tags]);

    return {
        variantId: a.variantId,
        mint: a.mint,
        symbol: a.symbol ?? b.symbol,
        name: a.name ?? b.name,
        kind: a.kind,
        issuer: a.issuer ?? b.issuer,
        issuerUrl: a.issuerUrl ?? b.issuerUrl,
        trustTier: a.trustTier,
        tags: Array.from(mergedTags),
        label: a.label ?? b.label,
    };
}

function defaultTrustTier(): TrustTier {
    return 'tier3';
}

function kindForSingletonCryptoMint(mint: string): VariantKind {
    // `So111...` is the canonical wrapped SOL mint; treat as "native" for grouping.
    if (mint === 'So11111111111111111111111111111111111111112') return 'native';
    return 'wrapped';
}

const MANUAL_CRYPTO_MINTS_IN_REGISTRY = new Set(
    MANUAL_ASSET_DEFINITIONS.filter(item => item.category === 'crypto').map(item => item.mint),
);

function buildWrapperGroupAssets(): CanonicalAsset[] {
    return TOKEN_WRAPPER_GROUPS.map(group => {
        const assetId = (group.assetId ?? group.coingeckoId).trim();
        const symbolCounts = group.wrappers.reduce((counts, wrapper) => {
            counts.set(wrapper.symbol, (counts.get(wrapper.symbol) ?? 0) + 1);
            return counts;
        }, new Map<string, number>());
        const usedVariantSuffixes = new Set<string>();

        function variantSuffixFor(wrapper: (typeof group.wrappers)[number]): string {
            const base =
                (symbolCounts.get(wrapper.symbol) ?? 0) > 1 ? `${wrapper.symbol}_${wrapper.deployer}` : wrapper.symbol;
            const suffix = base.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || wrapper.address;
            if (!usedVariantSuffixes.has(suffix)) {
                usedVariantSuffixes.add(suffix);
                return suffix;
            }
            const cleanAddress = wrapper.address.replace(/[^a-zA-Z0-9]+/g, '_');
            let fallback = `${suffix}_${cleanAddress.slice(0, 8)}`;
            let prefixLength = 8;
            while (usedVariantSuffixes.has(fallback) && prefixLength < cleanAddress.length) {
                prefixLength += 4;
                fallback = `${suffix}_${cleanAddress.slice(0, prefixLength)}`;
            }
            let index = 2;
            while (usedVariantSuffixes.has(fallback)) {
                fallback = `${suffix}_${cleanAddress}_${index}`;
                index += 1;
            }
            usedVariantSuffixes.add(fallback);
            return fallback;
        }

        const variants: AssetVariant[] = group.wrappers.map(wrapper => ({
            variantId: `${assetId}:${variantSuffixFor(wrapper)}`,
            mint: wrapper.address,
            symbol: wrapper.symbol,
            name: wrapper.name,
            kind: group.coingeckoId === 'solana' ? 'native' : isWormhole(wrapper.deployer) ? 'bridged' : 'wrapped',
            issuer: wrapper.deployer,
            issuerUrl: wrapper.deployerUrl,
            trustTier: defaultTrustTier(),
            tags: [wrapper.deployer],
        }));

        const aliases = uniqueStrings([
            group.baseAsset,
            group.baseSymbol,
            assetId,
            group.coingeckoId,
            ...group.wrappers.flatMap(w => [w.symbol, w.address]),
        ]);

        return {
            assetId,
            name: group.baseAsset,
            symbol: group.baseSymbol,
            category: 'crypto',
            aliases,
            coingeckoId: group.coingeckoId,
            variants,
        };
    });
}

function mergeBitcoinVariantsFromGroup(bitcoin: CanonicalAsset): CanonicalAsset {
    const variantsByMint = new Map<string, AssetVariant>(bitcoin.variants.map(v => [v.mint, v]));

    for (const item of BITCOIN_VARIANT_GROUP.addresses) {
        const variantIdSuffix = item.label ? item.label.replaceAll(' ', '_') : item.address;
        const next: AssetVariant = {
            variantId: `${bitcoin.assetId}:${variantIdSuffix}`,
            mint: item.address,
            kind: 'wrapped',
            trustTier: defaultTrustTier(),
            tags: item.label ? [item.label] : [],
            label: item.label,
        };

        const prev = variantsByMint.get(next.mint);
        variantsByMint.set(next.mint, prev ? mergeVariants(prev, next) : next);
    }

    const variants = Array.from(variantsByMint.values());
    return {
        ...bitcoin,
        variants,
        aliases: uniqueStrings([...bitcoin.aliases, ...variants.flatMap(v => [v.mint, v.symbol ?? '', v.label ?? ''])]),
    };
}

function buildMajorsSingletonAssets(groupedMints: Set<string>): CanonicalAsset[] {
    return MAJORS_MINTS
        .filter(
            mint =>
                !groupedMints.has(mint) &&
                !MANUAL_CRYPTO_MINTS_IN_REGISTRY.has(mint) &&
                !MANUAL_CRYPTO_MINTS_SET.has(mint),
        )
        .map(
            mint =>
                ({
                    assetId: `solana-${mint}`,
                    category: 'crypto',
                    aliases: [`solana-${mint}`, mint],
                    variants: [
                        {
                            variantId: `solana-${mint}:mint`,
                            mint,
                            kind: kindForSingletonCryptoMint(mint),
                            trustTier: defaultTrustTier(),
                            tags: ['curated:majors'],
                        },
                    ],
                }) satisfies CanonicalAsset,
        );
}

interface ManualCryptoMint {
    mint: string;
    symbol?: string;
    name?: string;
}

const MANUAL_CRYPTO_MINTS: ManualCryptoMint[] = [
    {
        mint: 'BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy',
        symbol: 'BP',
        name: 'Backpack',
    },
    {
        mint: '3ywtR9qQH4BuA7LSfLvEuW1gh6ha7EK18XwLbHvhryPZ',
        symbol: 'DIME',
        name: 'DIME',
    },
];

const MANUAL_CRYPTO_MINTS_SET = new Set(MANUAL_CRYPTO_MINTS.map(item => item.mint));

function manualCryptoAssetId(mint: string): string {
    return `crypto-${mint.slice(0, 8).toLowerCase()}`;
}

function buildManualCryptoAssets(existingMints: ReadonlySet<string>): CanonicalAsset[] {
    return MANUAL_CRYPTO_MINTS.filter(item => !existingMints.has(item.mint)).map(item => {
        const assetId = manualCryptoAssetId(item.mint);

        return {
            assetId,
            name: item.name,
            symbol: item.symbol,
            category: 'crypto',
            aliases: uniqueStrings([assetId, item.mint, item.symbol ?? '', item.name ?? '']),
            variants: [
                {
                    variantId: `${assetId}:mint`,
                    mint: item.mint,
                    symbol: item.symbol,
                    name: item.name,
                    label: item.symbol ?? item.name,
                    kind: kindForSingletonCryptoMint(item.mint),
                    trustTier: defaultTrustTier(),
                    tags: ['manual'],
                },
            ],
        } satisfies CanonicalAsset;
    });
}

export const CRYPTO_ASSETS: CanonicalAsset[] = (() => {
    const wrapperAssets = buildWrapperGroupAssets().map(asset =>
        asset.assetId === 'bitcoin' ? mergeBitcoinVariantsFromGroup(asset) : asset,
    );

    const groupedMints = new Set<string>();
    for (const asset of wrapperAssets) for (const variant of asset.variants) groupedMints.add(variant.mint);

    const majorsSingletons = buildMajorsSingletonAssets(groupedMints);

    const existingMints = new Set<string>();
    for (const asset of wrapperAssets) for (const variant of asset.variants) existingMints.add(variant.mint);
    for (const asset of majorsSingletons) for (const variant of asset.variants) existingMints.add(variant.mint);

    const manualAssets = buildManualCryptoAssets(existingMints);

    return [...wrapperAssets, ...majorsSingletons, ...manualAssets];
})();
