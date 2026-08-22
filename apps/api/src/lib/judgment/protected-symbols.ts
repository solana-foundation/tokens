/**
 * Protected-symbol collision index.
 *
 * The single worst failure mode in token search: user types `USDC`, gets a
 * fake. We maintain an index of symbols claimed by curated/registry assets
 * (homoglyph-normalized) and flag candidates whose claims collide with a
 * protected symbol while the protected mint is a *different* token.
 */

import { getCuratedTokenList, CURATED_TOKEN_LISTS } from '@tokens/asset-registry/compat';
import { getVariantByMint, listAssets } from '@tokens/asset-registry';

import { normalizeClaim, tokenAgeDays } from './claims';
import type { EnrichedCandidate } from './types';

export interface ProtectedSymbolEntry {
    normalizedSymbol: string;
    mints: Set<string>;
    /** e.g. `curated:majors`, `registry:usd-coin` */
    protectedBy: string[];
}

/** Variant kinds that are derivatives of the asset, not the asset itself. */
const DERIVATIVE_VARIANT_KINDS = new Set([
    'yield',
    'lst',
    'etf',
    'leveraged',
    'basket',
    'tokenized_equity',
]);

/**
 * The symbol a registry variant legitimately claims. A derivative variant
 * (LST, ETF, …) without its own symbol must NOT inherit the asset's symbol:
 * bSOL is not `SOL`. Inheriting poisoned both exact-symbol matching and the
 * protected index (the real wrapped SOL was demoted as a `symbol_collision`
 * against its own LSTs).
 */
export function registryClaimedSymbol(
    variant: { symbol?: string | null; kind?: string | null },
    asset: { symbol?: string | null },
): string | null {
    if (variant.symbol) return variant.symbol;
    if (variant.kind && DERIVATIVE_VARIANT_KINDS.has(variant.kind)) return null;
    return asset.symbol ?? null;
}

/**
 * All symbols a variant legitimately claims for protection purposes. Identity
 * variants (native/wrapped/bridged) also claim the asset-level symbol: wrapped
 * SOL's variant symbol is `wSOL`, but it IS `SOL` — the protected `SOL` entry
 * must point at it, not at fallback-inheriting LSTs.
 */
export function registryProtectedSymbols(
    variant: { symbol?: string | null; kind?: string | null },
    asset: { symbol?: string | null },
): string[] {
    const symbols: string[] = [];
    const claimed = registryClaimedSymbol(variant, asset);
    if (claimed) symbols.push(claimed);
    const identity = variant.kind === 'native' || variant.kind === 'wrapped' || variant.kind === 'bridged';
    if (identity && asset.symbol && asset.symbol !== claimed) symbols.push(asset.symbol);
    return symbols;
}

export type ProtectedSymbolIndex = Map<string, ProtectedSymbolEntry>;

function addEntry(index: ProtectedSymbolIndex, symbol: string | null | undefined, mint: string | null, source: string): void {
    const { normalized } = normalizeClaim(symbol);
    if (!normalized) return;

    const existing = index.get(normalized);
    if (existing) {
        if (mint) existing.mints.add(mint);
        if (!existing.protectedBy.includes(source)) existing.protectedBy.push(source);
        return;
    }

    index.set(normalized, {
        normalizedSymbol: normalized,
        mints: new Set(mint ? [mint] : []),
        protectedBy: [source],
    });
}

let cachedIndex: ProtectedSymbolIndex | null = null;

/** Build (and memoize) the protected-symbol index from curated lists + registry. */
export function getProtectedSymbolIndex(): ProtectedSymbolIndex {
    if (cachedIndex) return cachedIndex;

    const index: ProtectedSymbolIndex = new Map();

    for (const listId of Object.keys(CURATED_TOKEN_LISTS) as Array<keyof typeof CURATED_TOKEN_LISTS>) {
        const list = getCuratedTokenList(listId);
        for (const mint of list.addresses) {
            const match = getVariantByMint(mint);
            if (!match) continue;
            for (const symbol of registryProtectedSymbols(match.variant, match.asset)) {
                addEntry(index, symbol, mint, `curated:${list.id}`);
            }
        }
    }

    for (const asset of listAssets()) {
        for (const variant of asset.variants) {
            for (const symbol of registryProtectedSymbols(variant, asset)) {
                addEntry(index, symbol, variant.mint, `registry:${asset.assetId}`);
            }
        }
    }

    cachedIndex = index;
    return index;
}

/** Test seam: inject a custom index (pure pipeline stays network/registry free). */
export function buildIndexFromEntries(
    entries: Array<{ symbol: string; mints: string[]; protectedBy?: string[] }>,
): ProtectedSymbolIndex {
    const index: ProtectedSymbolIndex = new Map();
    for (const entry of entries) {
        for (const mint of entry.mints.length > 0 ? entry.mints : [null]) {
            addEntry(index, entry.symbol, mint, entry.protectedBy?.[0] ?? 'test');
        }
    }
    return index;
}

export type CollisionVerdict =
    | { kind: 'none' }
    | { kind: 'protected_holder' }
    | { kind: 'collision'; protectedBy: string[] }
    | { kind: 'impersonation'; protectedBy: string[] };

const IMPERSONATION_MAX_AGE_DAYS = 90;
const IMPERSONATION_MAX_LIQUIDITY_USD = 250_000;

/**
 * Verdict for a candidate whose (normalized) symbol claim matches a protected
 * symbol:
 * - the actual protected mint → `protected_holder` (positive signal)
 * - a different mint that is young or shallow → `impersonation`
 * - a different mint with real standing → `collision` (warn, demote)
 */
export function checkSymbolCollision(
    candidate: EnrichedCandidate,
    index: ProtectedSymbolIndex,
    nowMs: number,
): CollisionVerdict {
    const { normalized } = normalizeClaim(candidate.symbol);
    if (!normalized) return { kind: 'none' };

    const entry = index.get(normalized);
    if (!entry) return { kind: 'none' };

    if (entry.mints.has(candidate.mint)) return { kind: 'protected_holder' };

    const ageDays = tokenAgeDays(candidate, nowMs);
    const liquidity = candidate.liquidityUsd ?? 0;
    const young = ageDays === null || ageDays < IMPERSONATION_MAX_AGE_DAYS;
    const shallow = liquidity < IMPERSONATION_MAX_LIQUIDITY_USD;
    const unattested = !candidate.registry;

    if (unattested && (young || shallow)) {
        return { kind: 'impersonation', protectedBy: entry.protectedBy };
    }

    return { kind: 'collision', protectedBy: entry.protectedBy };
}
