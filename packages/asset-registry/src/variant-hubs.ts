import type { ChainKind } from './chains';
import { getAsset, getVariantByMint, listAssets } from './registry';

export interface VariantHub {
    id: string;
    label: string;
    /** `chain` absent = solana (static registry hubs are Solana-only). */
    addresses: Array<{ address: string; label?: string; chain?: ChainKind }>;
}

function normalizeOptionalLabel(value: string | undefined): string | undefined {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function getVariantHubById(assetId: string): VariantHub | null {
    const asset = getAsset(assetId);
    if (!asset) return null;
    if (asset.variants.length <= 1) return null;

    const labelBase = normalizeOptionalLabel(asset.name) ?? normalizeOptionalLabel(asset.symbol) ?? asset.assetId;

    return {
        id: asset.assetId,
        label: `${labelBase} variants`,
        addresses: asset.variants.map(v => ({
            address: v.mint,
            ...(normalizeOptionalLabel(v.label ?? v.symbol ?? v.name)
                ? { label: normalizeOptionalLabel(v.label ?? v.symbol ?? v.name) }
                : {}),
        })),
    };
}

export function getVariantHubByAssetId(assetId: string): VariantHub | null {
    return getVariantHubById(assetId);
}

export function getVariantHubByMint(mint: string): VariantHub | null {
    const match = getVariantByMint(mint);
    if (!match) return null;
    return getVariantHubById(match.asset.assetId);
}

export function listVariantHubs(opts: { includeSingletons?: boolean } = {}): VariantHub[] {
    const includeSingletons = opts.includeSingletons ?? false;
    const hubs: VariantHub[] = [];

    for (const asset of listAssets()) {
        if (!includeSingletons && asset.variants.length <= 1) continue;

        const labelBase = normalizeOptionalLabel(asset.name) ?? normalizeOptionalLabel(asset.symbol) ?? asset.assetId;
        hubs.push({
            id: asset.assetId,
            label: `${labelBase} variants`,
            addresses: asset.variants.map(v => ({
                address: v.mint,
                ...(normalizeOptionalLabel(v.label ?? v.symbol ?? v.name)
                    ? { label: normalizeOptionalLabel(v.label ?? v.symbol ?? v.name) }
                    : {}),
            })),
        });
    }

    return hubs;
}
