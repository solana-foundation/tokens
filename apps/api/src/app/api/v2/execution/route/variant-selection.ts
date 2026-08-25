/**
 * Which of a canonical asset's variants get quoted, and which of those may be
 * allocated across. Pure so the policy — the part that decides whether gold's
 * 1/10-oz ETF wrapper can ever be summed with 1-oz spot — is unit-testable
 * without market data or HTTP.
 */

import {
    rankVariantsWithReasons,
    type AssetVariant,
    type CanonicalAsset,
    type RankedVariantEntry,
    type VariantFillQualityRankingSnapshot,
    type VariantMarketRankingSnapshot,
} from '@tokens/asset-registry';

import type { ExcludedVariant, ParityBasis, VariantExclusionReason } from './contract';

/**
 * Kinds with 1:1 exposure to the underlying. `spot` (commodity claims like
 * XAUT/PAXG, nominally one unit each) is admitted because the allocator now
 * verifies parity at runtime via base-price clustering — a "1-oz" variant
 * priced like a tenth of an ounce gets ejected by the data, not by a static
 * list. Everything else either accrues (yield/lst), levers (leveraged),
 * blends (basket), tracks a different unit (etf), or has no conversion-ratio
 * data at all.
 */
const UNIT_PARITY_KINDS = new Set(['native', 'wrapped', 'bridged', 'spot']);

/** Issuer-asserted 1 token = 1 share; redeemability is the only equivalence marker we have. */
const REDEEMABLE_STOCK_TIERS = new Set(['share_redeemable', 'cash_redeemable']);

export function parityBasisOf(variant: AssetVariant): ParityBasis {
    if (UNIT_PARITY_KINDS.has(variant.kind)) return 'kind';
    if (variant.kind === 'tokenized_equity' && REDEEMABLE_STOCK_TIERS.has(variant.stockVariantTier ?? '')) {
        return 'issuer_assertion';
    }
    return 'none';
}

export interface SelectedVariant {
    variant: AssetVariant;
    rank: number;
    parityBasis: ParityBasis;
    decimals: number;
    symbol: string;
    name: string;
    market: { price: number | null; liquidity: number | null; volume24hUSD: number | null } | null;
}

export interface VariantSelection {
    selected: SelectedVariant[];
    excluded: ExcludedVariant[];
}

function excludedFrom(variant: AssetVariant, reason: VariantExclusionReason): ExcludedVariant {
    return {
        variantId: variant.variantId,
        mint: variant.mint,
        symbol: variant.symbol ?? variant.label ?? null,
        kind: variant.kind,
        issuer: variant.issuer ?? null,
        reason,
    };
}

export interface VariantDisplay {
    symbol?: string | null;
    name?: string | null;
    decimals?: number | null;
    price?: number | null;
    liquidity?: number | null;
    volume24hUSD?: number | null;
}

/**
 * Rank, floor, and truncate an asset's variants for the probe fanout.
 *
 * The liquidity floor scales with the target — quoting a $5M ladder against a
 * $60k pool spends real quotes to learn nothing — but never drops below $50k.
 * Excluded variants are returned with reasons; silence about why a variant is
 * missing reads as a bug to the caller who expected it.
 */
export function selectVariants(args: {
    asset: CanonicalAsset;
    mintRank: ReadonlyMap<string, number>;
    marketByMint: ReadonlyMap<string, VariantMarketRankingSnapshot | null | undefined>;
    fillQualityByMint: ReadonlyMap<string, VariantFillQualityRankingSnapshot | null | undefined>;
    displayByMint: ReadonlyMap<string, VariantDisplay | null | undefined>;
    targetUsd: number;
    maxVariants: number;
}): VariantSelection {
    const ranked: RankedVariantEntry[] = rankVariantsWithReasons({
        asset: args.asset,
        mintRank: args.mintRank,
        marketByMint: args.marketByMint,
        fillQualityByMint: args.fillQualityByMint,
    });

    const liquidityFloorUsd = Math.max(50_000, Math.ceil(args.targetUsd * 0.01));
    const selected: SelectedVariant[] = [];
    const excluded: ExcludedVariant[] = [];

    for (const entry of ranked) {
        const { variant } = entry;
        const display = args.displayByMint.get(variant.mint) ?? null;

        if (!entry.isPrimaryCandidate) {
            excluded.push(
                excludedFrom(
                    variant,
                    entry.reason === 'non_spot_like' ? 'non_spot_like' : 'excluded_by_activity_filter',
                ),
            );
            continue;
        }
        // Non-redeemable equity claims (pre-IPO wrappers) are different
        // instruments, not the stock — never quoted as siblings.
        if (variant.kind === 'tokenized_equity' && !REDEEMABLE_STOCK_TIERS.has(variant.stockVariantTier ?? '')) {
            excluded.push(excludedFrom(variant, 'not_redeemable'));
            continue;
        }
        const liquidity = display?.liquidity ?? null;
        if (liquidity !== null && liquidity < liquidityFloorUsd) {
            excluded.push(excludedFrom(variant, 'below_liquidity_floor'));
            continue;
        }
        const decimals = display?.decimals ?? null;
        if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 18) {
            // Raw-amount math is impossible without decimals; the long tail of
            // unlabeled variants can miss market rows entirely.
            excluded.push(excludedFrom(variant, 'missing_decimals'));
            continue;
        }
        if (selected.length >= args.maxVariants) {
            excluded.push(excludedFrom(variant, 'beyond_max_variants'));
            continue;
        }
        const symbol = display?.symbol ?? variant.symbol ?? variant.label ?? variant.mint.slice(0, 4);
        selected.push({
            variant,
            rank: selected.length + 1,
            parityBasis: parityBasisOf(variant),
            decimals: decimals as number,
            symbol,
            name: display?.name ?? variant.name ?? symbol,
            market: display
                ? {
                      price: display.price ?? null,
                      liquidity: display.liquidity ?? null,
                      volume24hUSD: display.volume24hUSD ?? null,
                  }
                : null,
        });
    }

    return { selected, excluded };
}

/**
 * The probe ladder, scaled to the target: [T/125, T/25, T/5, T], floored at
 * $1k, whole dollars, deduped ascending. Including T itself makes "best
 * single variant" an exact quote rather than an extrapolation, and caps every
 * variant's allocation at proven depth.
 */
export function buildProbeLadderUsd(targetUsd: number): number[] {
    const rungs = [targetUsd / 125, targetUsd / 25, targetUsd / 5, targetUsd].map(value =>
        Math.max(1_000, Math.round(value)),
    );
    return [...new Set(rungs)].sort((a, b) => a - b);
}
