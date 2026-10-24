import type { LiquidityTier, StockVariantTier, TrustTier, VariantKind } from '@tokens/asset-registry';
import type { ChainKind } from '@tokens/asset-registry/chains';

import { normalizeAdvisory, type AssetAdvisory } from '@/lib/asset-advisory';
import type {
    V2ExecutionQuality,
    V2Market,
    V2PegHealth,
    V2Variant,
    V2VariantPreStocks,
    VariantIssuance,
} from '@/lib/api-v2-types';

export type AssetPageVariantReference = V2Variant['reference'];
import { normalizeCompactPegHealth } from '@/lib/stablecoin-health';

/**
 * The asset page's variant model, built from a v2 variant. Pure TS so the
 * client list, the header badge and bun tests share it. There is no `mint`
 * field: a variant is `(chain, address)`; Solana callers that need a mint
 * use `chain === 'solana' ? address : undefined`.
 */
export interface AssetPageVariant {
    key: string;
    chain: ChainKind;
    address: string;
    variantId: string;
    kind: VariantKind;
    issuance: VariantIssuance;
    symbol: string | null;
    name: string | null;
    label: string | null;
    decimals: number | null;
    logoURI: string | null;
    issuer: string | null;
    issuerUrl: string | null;
    trustTier: TrustTier;
    liquidityTier: LiquidityTier;
    stockVariantTier: StockVariantTier | null;
    tags: string[];
    rank: number | null;
    explorerUrl: string;
    market: V2Market | null;
    /** The variant's own CoinGecko coin figures (per issuer / wrapper), when linked and loaded. */
    reference: AssetPageVariantReference;
    advisory: AssetAdvisory | null;
    /** Best-effort display strings (provider-label rules applied). */
    displaySymbol: string;
    displayName: string;
    /** `include=` enrichments; absent when not requested, `null` when the chain lacks the capability. */
    executionQuality?: V2ExecutionQuality | null;
    pegHealth?: V2PegHealth | null;
    preStocks?: V2VariantPreStocks | null;
}

export type AssetPageVariantLite = Pick<
    AssetPageVariant,
    | 'key'
    | 'chain'
    | 'address'
    | 'kind'
    | 'trustTier'
    | 'liquidityTier'
    | 'label'
    | 'tags'
    | 'stockVariantTier'
    | 'market'
    | 'executionQuality'
    | 'displaySymbol'
    | 'displayName'
    | 'advisory'
    | 'pegHealth'
    | 'explorerUrl'
    | 'logoURI'
>;

function cleanText(value: string | null | undefined): string {
    const trimmed = (value ?? '').trim();
    return trimmed === '???' || trimmed === '—' ? '' : trimmed;
}

export function getProviderOnlyLabel(value: string | undefined | null): 'xstock' | 'ondo' | null {
    const normalized = (value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    if (normalized === 'xstock') return 'xstock';
    if (normalized === 'ondo') return 'ondo';
    return null;
}

function isCanonicalSymbolMatch(value: string | undefined | null, canonicalSymbol: string): boolean {
    const normalizedValue = (value ?? '').trim();
    const normalizedCanonical = canonicalSymbol.trim();
    return Boolean(
        normalizedValue && normalizedCanonical && normalizedValue.toLowerCase() === normalizedCanonical.toLowerCase(),
    );
}

function deriveProviderVariantSymbol(
    provider: 'xstock' | 'ondo' | null,
    canonicalSymbol: string,
    symbol: string,
): string {
    if (!provider || !canonicalSymbol) return '';
    const looksCanonical = !symbol || symbol.toLowerCase() === canonicalSymbol.trim().toLowerCase();
    if (!looksCanonical) return '';
    return provider === 'xstock' ? `${canonicalSymbol.trim()}x` : `${canonicalSymbol.trim()}on`;
}

/**
 * Display symbol / name for a variant. v2 already resolves `symbol`/`name`
 * (registry → market → label), so the only page-side rule left is the
 * xStock / Ondo issuer marker: a label that is literally "xStock" or "Ondo"
 * synthesizes "{ASSET}x" / "{ASSET}on" when the variant symbol is just the
 * asset's own symbol.
 */
export function resolveVariantDisplay(
    variant: Pick<V2Variant, 'symbol' | 'name' | 'label'>,
    asset: { symbol: string | null | undefined; name: string | null | undefined },
): { displaySymbol: string; displayName: string } {
    const assetSymbol = cleanText(asset.symbol);
    const assetName = cleanText(asset.name) || assetSymbol;
    const providerLabel = isCanonicalSymbolMatch(variant.label, assetSymbol)
        ? null
        : getProviderOnlyLabel(variant.label);
    const labelFallback = providerLabel ? '' : cleanText(variant.label);
    const symbol = cleanText(variant.symbol);
    const symbolFallback =
        providerLabel && (isCanonicalSymbolMatch(symbol, assetSymbol) || getProviderOnlyLabel(symbol)) ? '' : symbol;
    const providerSymbol = deriveProviderVariantSymbol(providerLabel, assetSymbol, symbol);
    const displaySymbol = symbolFallback || providerSymbol || labelFallback || assetSymbol || '???';
    const displayName = cleanText(variant.name) || assetName || labelFallback || displaySymbol;
    return { displaySymbol, displayName };
}

export function toAssetPageVariant(
    variant: V2Variant,
    asset: { symbol: string | null | undefined; name: string | null | undefined },
): AssetPageVariant {
    const { displaySymbol, displayName } = resolveVariantDisplay(variant, asset);
    return {
        key: variant.key,
        chain: variant.chain,
        address: variant.address,
        variantId: variant.variantId,
        kind: variant.kind,
        issuance: variant.issuance,
        symbol: variant.symbol,
        name: variant.name,
        label: variant.label,
        decimals: variant.decimals,
        logoURI: variant.logoURI,
        issuer: variant.issuer,
        issuerUrl: variant.issuerUrl,
        trustTier: variant.trustTier,
        liquidityTier: variant.liquidityTier,
        stockVariantTier: variant.stockVariantTier,
        tags: variant.tags,
        rank: variant.rank,
        explorerUrl: variant.explorerUrl,
        market: variant.market,
        reference: variant.reference ?? null,
        advisory: normalizeAdvisory(variant.advisory),
        displaySymbol,
        displayName,
        ...(variant.executionQuality !== undefined ? { executionQuality: variant.executionQuality } : {}),
        ...(variant.pegHealth !== undefined
            ? { pegHealth: normalizeCompactPegHealth(variant.pegHealth) as V2PegHealth | null }
            : {}),
        ...(variant.preStocks !== undefined ? { preStocks: variant.preStocks } : {}),
    };
}

/** The Solana mint of a variant, or undefined off-Solana (for mint-keyed v1 pipelines). */
export function solanaMintOf(
    variant: Pick<AssetPageVariant, 'chain' | 'address'> | null | undefined,
): string | undefined {
    return variant?.chain === 'solana' ? variant.address : undefined;
}
