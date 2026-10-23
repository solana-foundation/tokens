/**
 * Pure classifier behind `scripts/generate-issuance-overrides.ts`: given our
 * active variants (with the CoinGecko coin each links to) and the coin rows,
 * emit the curated `ISSUANCE_OVERRIDES` entries (`<chain>:<address>` →
 * issuance + reason). The script reads Postgres and prints the data module;
 * the PR diff of that module is the review surface.
 *
 * Rules (audit 2026-10-22 §1, §19; owner decision: CoinGecko's home platform
 * is NOT an input, it records where CoinGecko listed a coin, not who issues it):
 *
 * 1. A coin whose id or name says it is a bridge's or peg's copy of something
 *    (`bridged`, `-peg-`, `-wormhole` / `(Wormhole)`, `-portal` / `(Portal)`,
 *    `(bridged)`, `.e`) is `bridged` on every chain it is deployed on:
 *    Binance-Peg stables on BNB, USDC.e on Polygon, Wormhole wETH on Solana.
 *    The asset's own reference coin is never a copy of itself (Wormhole's W,
 *    Portal's token), so it is exempt, and a bare project name is not a match.
 * 2. For an equity, the registry- or admin-sourced Solana mint is the issuer's
 *    home; the same coin's deployments on other chains are `bridged` (TSLAx on
 *    Arbitrum / BNB / Ethereum are bridged copies of the Solana xStock).
 * 3. Inside a commodity asset, an exchange-traded-fund share token (iShares,
 *    SPDR, "ETF", "Trust") is a `derivative`: shares of a fund, not ounces.
 *
 * Everything else keeps its kind-derived issuance (no entry).
 */
import { CHAINS, type ChainKind } from '@tokens/asset-registry/chains';
import type { VariantIssuance } from '@tokens/asset-registry/issuance';

export interface OverrideVariantInput {
    chain: ChainKind;
    address: string;
    assetId: string;
    category: string;
    kind: string;
    label: string | null;
    /** v1 `asset_variants.source` for mirrored Solana rows (registry | admin | …); origin for derived rows. */
    source: string | null;
    coinId: string | null;
    /** The asset's own reference coin (`assets.coingecko_id`); its deployments are never a bridged copy of itself. */
    assetCoinId?: string | null;
}

export interface OverrideCoinInput {
    coinId: string;
    name: string;
    symbol: string;
    /** CoinGecko platform id → contract address. */
    platforms: Record<string, string>;
}

export interface IssuanceOverrideEntry {
    key: string;
    issuance: VariantIssuance;
    reason: string;
    coinId?: string;
}

const BRIDGED_COIN_PATTERN = /bridged|-peg-|binance-peg|-wormhole\b|\(wormhole\)|-portal\b|\(portal\)|\(bridged?\)|\.e$|\.e\b/i;
const FUND_SHARE_PATTERN = /\b(etf|ishares|spdr|trust|fund)\b/i;
const HOME_SOURCES: ReadonlySet<string> = new Set(['registry', 'admin', 'solana_v1']);

function overrideKey(chain: ChainKind, address: string): string {
    const normalized = CHAINS[chain]?.family === 'evm' ? address.toLowerCase() : address;
    return `${chain}:${normalized}`;
}

export function classifyIssuanceOverrides(
    variants: readonly OverrideVariantInput[],
    coins: readonly OverrideCoinInput[],
): IssuanceOverrideEntry[] {
    const coinById = new Map(coins.map(c => [c.coinId, c] as const));
    const out = new Map<string, IssuanceOverrideEntry>();
    const put = (variant: OverrideVariantInput, issuance: VariantIssuance, reason: string, coinId?: string) => {
        const key = overrideKey(variant.chain, variant.address);
        if (out.has(key)) return;
        out.set(key, { key, issuance, reason, ...(coinId ? { coinId } : {}) });
    };

    // Rule 2 needs, per (asset, coin), whether a registry/admin Solana mint of ours is that coin's Solana contract.
    const homeByAssetCoin = new Set<string>();
    for (const variant of variants) {
        if (variant.chain !== 'solana' || !variant.coinId) continue;
        if (!HOME_SOURCES.has(variant.source ?? '')) continue;
        const coin = coinById.get(variant.coinId);
        if (!coin) continue;
        if ((coin.platforms.solana ?? '') === variant.address) homeByAssetCoin.add(`${variant.assetId}\n${variant.coinId}`);
    }

    for (const variant of variants) {
        const coin = variant.coinId ? coinById.get(variant.coinId) : undefined;
        if (!coin) continue;
        // Rule 1: bridge / peg coins. The asset's own reference coin is the asset, not a copy of it.
        const ownCoin = variant.assetCoinId != null && variant.assetCoinId === coin.coinId;
        if (!ownCoin && (BRIDGED_COIN_PATTERN.test(coin.coinId) || BRIDGED_COIN_PATTERN.test(coin.name))) {
            if (variant.kind !== 'bridged' && variant.kind !== 'wrapped') {
                put(variant, 'bridged', `CoinGecko coin ${coin.coinId} (${coin.name}) is a bridge/peg copy`, coin.coinId);
            }
            continue;
        }
        // Rule 3: fund-share tokens inside a commodity asset.
        if (
            variant.category === 'commodity' &&
            variant.kind !== 'etf' &&
            (FUND_SHARE_PATTERN.test(coin.name) || FUND_SHARE_PATTERN.test(variant.label ?? ''))
        ) {
            put(variant, 'derivative', `${coin.name} is a fund share, not the commodity's own supply`, coin.coinId);
            continue;
        }
        // Rule 2: an equity coin issued on Solana; its other-chain deployments are bridged copies.
        if (
            variant.category === 'equity' &&
            variant.chain !== 'solana' &&
            homeByAssetCoin.has(`${variant.assetId}\n${coin.coinId}`)
        ) {
            put(variant, 'bridged', `${coin.coinId} is issued on Solana; the ${variant.chain} deployment is a bridged copy`, coin.coinId);
        }
    }
    return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Renders the sorted entries as the `issuance-overrides.ts` data module body. */
export function renderIssuanceOverridesModule(entries: readonly IssuanceOverrideEntry[], generatedAt: string): string {
    const lines = entries.map(entry => {
        const fields = [`issuance: '${entry.issuance}'`, `reason: ${JSON.stringify(entry.reason)}`];
        if (entry.coinId) fields.push(`coinId: '${entry.coinId}'`);
        return `    '${entry.key}': { ${fields.join(', ')} },`;
    });
    return `/**
 * Curated issuance overrides, keyed \`<chain>:<address>\` (EVM addresses
 * lowercase). Pure data; consulted by \`resolveVariantIssuance\` after an
 * explicit \`issuance:\` tag and before the kind mapping.
 *
 * Generated by \`scripts/generate-issuance-overrides.ts\` on ${generatedAt}
 * from the live catalog (see apps/cloudrun-assets/src/handlers/issuanceOverridesGenerator.ts
 * for the rules). Re-run after the CoinGecko ids of new issuers are
 * resolved; hand edits are fine but keep the keys sorted.
 */
import type { VariantIssuance } from '../issuance';

export interface IssuanceOverride {
    issuance: VariantIssuance;
    reason: string;
    coinId?: string;
}

export const ISSUANCE_OVERRIDES: Readonly<Record<string, IssuanceOverride>> = {
${lines.join('\n')}
};
`;
}
